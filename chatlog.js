// Channel awareness: a local log of every message the bot can see, hourly summaries written by a
// cheap model, and search over the log. Nothing here is sent anywhere except the summary requests.
import fs from "node:fs";

const DIR = new URL("./chatlog/", import.meta.url);
const SUMMARIES = new URL("./summaries.json", import.meta.url);
const SUMMARIES_TMP = new URL("./summaries.json.tmp", import.meta.url);
const KEEP_DAYS = 14;

fs.mkdirSync(DIR, { recursive: true });

/** Local calendar date (the bot machine's time zone), e.g. "2026-11-24". */
function dayOf(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fileFor(day) {
  return new URL(`${day}.jsonl`, DIR);
}

const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** One message as a line for Claude to read. */
export function formatLine(entry, { withDate = false, withChannel = false } = {}) {
  const when = (withDate ? dateTimeFormat : timeFormat).format(new Date(entry.ts));
  return `${when}${withChannel ? ` #${entry.channelName}` : ""} ${entry.name}: ${entry.text}`;
}

/** Append a message to today's log. `entry` = { ts, channelId, channelName, userId, name, text, bot }. */
export function logMessage(entry) {
  if (!entry.text) return;
  fs.appendFileSync(fileFor(dayOf(entry.ts)), JSON.stringify(entry) + "\n");
}

function readDay(day) {
  let raw;
  try {
    raw = fs.readFileSync(fileFor(day), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // a half-written line from a crash; skip it
    }
  }
  // Backfilled messages are appended after live ones, so order by time rather than by line.
  return entries.sort((a, b) => a.ts - b.ts);
}

function lastDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(dayOf(Date.now() - i * 86400000));
  return days;
}

/** The newest logged message time per channel, so a restart knows what it missed. */
export function lastLoggedByChannel() {
  const last = new Map();
  for (const day of lastDays(KEEP_DAYS)) {
    for (const entry of readDay(day)) last.set(entry.channelId, Math.max(last.get(entry.channelId) ?? 0, entry.ts));
  }
  return last;
}

/** Delete log files and summaries older than KEEP_DAYS. */
export function prune() {
  const keep = new Set(lastDays(KEEP_DAYS));
  for (const name of fs.readdirSync(DIR)) {
    const day = name.replace(/\.jsonl$/, "");
    if (name.endsWith(".jsonl") && !keep.has(day)) fs.rmSync(new URL(name, DIR));
  }
  for (const channel of Object.values(summaries.channels)) {
    for (const day of Object.keys(channel.days)) if (!keep.has(day)) delete channel.days[day];
  }
  saveSummaries();
}

/**
 * Search the log. Every filter is optional; words must all appear (any order, any case).
 * Returns formatted lines, oldest first, capped at `limit` (the most recent matches win).
 */
export function searchLog({ query, userId, channelId, daysBack = 7, sinceTs = null, limit = 40 }) {
  if (sinceTs) daysBack = Math.ceil((Date.now() - sinceTs) / 86400000) + 1;
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = [];
  for (const day of lastDays(Math.min(Math.max(daysBack, 1), KEEP_DAYS))) {
    for (const entry of readDay(day)) {
      if (sinceTs && entry.ts < sinceTs) continue;
      if (userId && entry.userId !== userId) continue;
      if (channelId && entry.channelId !== channelId) continue;
      const text = entry.text.toLowerCase();
      if (words.every((w) => text.includes(w))) matches.push(entry);
    }
  }
  return { total: matches.length, lines: matches.slice(-limit).map((e) => formatLine(e, { withDate: true, withChannel: true })) };
}

// ---------- summaries ----------

/** summaries = { channels: { [channelId]: { name, lastTs, days: { [day]: text } } } } */
let summaries = { channels: {} };
try {
  summaries = { ...summaries, ...JSON.parse(fs.readFileSync(SUMMARIES, "utf8")) };
} catch (err) {
  if (err.code !== "ENOENT") console.error("Couldn't read summaries.json, starting fresh:", err.message);
}

function saveSummaries() {
  fs.writeFileSync(SUMMARIES_TMP, JSON.stringify(summaries, null, 2));
  fs.renameSync(SUMMARIES_TMP, SUMMARIES);
}

/** The last few days of summaries for one channel, oldest first, as text for the system prompt. */
export function channelSummaries(channelId, days = 3) {
  const channel = summaries.channels[channelId];
  if (!channel) return "";
  return lastDays(days)
    .filter((day) => channel.days[day])
    .map((day) => `${day}:\n${channel.days[day]}`)
    .join("\n\n");
}

/**
 * Fold every message logged since the last run into each channel's summary for that day.
 * `summarize(previousSummary, newLines, channelName, day)` returns the updated summary text.
 * Only channels with new messages cost anything.
 */
export async function updateSummaries(summarize) {
  const startedAt = Date.now();
  const groups = new Map(); // "channelId|day" -> entries
  for (const day of lastDays(KEEP_DAYS)) {
    for (const entry of readDay(day)) {
      if (entry.ts <= (summaries.channels[entry.channelId]?.lastTs ?? 0) || entry.ts > startedAt) continue;
      const key = `${entry.channelId}|${day}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
  }

  // Groups are in day order, so a channel's yesterday is folded in before its today.
  const failed = new Set();
  for (const [key, entries] of groups) {
    const [channelId, day] = key.split("|");
    if (failed.has(channelId)) continue;
    const channel = (summaries.channels[channelId] ??= { name: entries[0].channelName, days: {}, lastTs: 0 });
    channel.name = entries.at(-1).channelName;
    try {
      channel.days[day] = await summarize(channel.days[day] ?? "", entries.map((e) => formatLine(e)), channel.name, day);
      channel.lastTs = entries.at(-1).ts;
      saveSummaries();
    } catch (err) {
      // lastTs stays put, so these messages are retried next run
      failed.add(channelId);
      console.error(`[summaries] Failed for #${channel.name} ${day}:`, err.message);
    }
  }
  if (groups.size) console.log(`[summaries] Updated ${groups.size} channel-day summar${groups.size === 1 ? "y" : "ies"}.`);
}
