// Channel awareness and long-term memory: a local log of every message the bot can see (kept
// forever), hourly daily summaries written by a cheap model, weekly and monthly roll-ups of those
// (kept forever), and search over all of it. The files stay on this machine; excerpts are sent to the
// API only as part of summary requests and of prompts when the bot is summoned or chimes in.
import fs from "node:fs";

const DIR = new URL("./chatlog/", import.meta.url);
const SUMMARIES = new URL("./summaries.json", import.meta.url);
const SUMMARIES_TMP = new URL("./summaries.json.tmp", import.meta.url);
const RECENT_DAYS = 14; // how far back the summarizer and the restart check look for new messages
const KEEP_DAILY_SUMMARIES_DAYS = 60; // daily summaries older than this are dropped once their month is rolled up

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

/** Monday of the week containing `day` ("YYYY-MM-DD"), as "YYYY-MM-DD". */
function weekOf(day) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dayOf(d);
}

const monthOf = (day) => day.slice(0, 7);

/** Every day that has a log file, oldest first. */
function loggedDays() {
  return fs
    .readdirSync(DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort();
}

function lastDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(dayOf(Date.now() - i * 86400000));
  return days;
}

/** The newest logged message time per channel, so a restart knows what it missed. */
export function lastLoggedByChannel() {
  const last = new Map();
  for (const day of lastDays(RECENT_DAYS)) {
    for (const entry of readDay(day)) last.set(entry.channelId, Math.max(last.get(entry.channelId) ?? 0, entry.ts));
  }
  return last;
}

/** Drop old daily summaries whose month already has a monthly summary. The raw log is never deleted. */
export function prune() {
  const cutoff = dayOf(Date.now() - KEEP_DAILY_SUMMARIES_DAYS * 86400000);
  for (const channel of Object.values(summaries.channels)) {
    for (const day of Object.keys(channel.days)) {
      if (day < cutoff && channel.months?.[monthOf(day)]) delete channel.days[day];
    }
  }
  saveSummaries();
}

/**
 * Search the log. Every filter is optional; words must all appear (any order, any case).
 * Range: sinceTs (exact time), or fromDay/toDay ("YYYY-MM-DD", inclusive), or the last daysBack days.
 * Returns formatted lines, oldest first, capped at `limit` (the most recent matches win).
 */
export function searchLog({ query, userId, channelId, daysBack = 7, sinceTs = null, fromDay = null, toDay = null, limit = 40 }) {
  let from = fromDay ?? dayOf(Date.now() - (Math.max(daysBack, 1) - 1) * 86400000);
  if (sinceTs) from = dayOf(sinceTs);
  const to = toDay ?? dayOf(Date.now());
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = [];
  for (const day of loggedDays()) {
    if (day < from || day > to) continue;
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

/** The first day in the log, so Claude knows how far back memory goes. */
export function firstLoggedDay() {
  return loggedDays()[0] ?? null;
}

// ---------- summaries ----------

/**
 * summaries = { channels: { [channelId]: { name, lastTs, days: { [day]: text },
 *   weeks: { [mondayDay]: text }, months: { ["YYYY-MM"]: text } } } }
 */
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

/**
 * Background for the system prompt: one channel's recent daily summaries plus the latest weekly and
 * monthly roll-ups, oldest first.
 */
export function channelSummaries(channelId, { days = 3, weeks = 2, months = 1 } = {}) {
  const channel = summaries.channels[channelId];
  if (!channel) return "";
  const parts = [];
  for (const [month, text] of Object.entries(channel.months ?? {}).sort().slice(-months)) parts.push(`Month of ${month}:\n${text}`);
  for (const [week, text] of Object.entries(channel.weeks ?? {}).sort().slice(-weeks)) parts.push(`Week of ${week}:\n${text}`);
  for (const day of lastDays(days)) if (channel.days[day]) parts.push(`${day}:\n${channel.days[day]}`);
  return parts.join("\n\n");
}

/**
 * Search every summary (daily, weekly, monthly; any channel unless channelId is given) for
 * summaries containing all the words. Returns the most recent matches, oldest first.
 */
export function searchSummaries({ query, channelId = null, limit = 8 }) {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const found = [];
  for (const [id, channel] of Object.entries(summaries.channels)) {
    if (channelId && id !== channelId) continue;
    const add = (key, label, text) => {
      if (words.every((w) => text.toLowerCase().includes(w))) found.push({ key, text: `#${channel.name}, ${label}:\n${text}` });
    };
    for (const [m, t] of Object.entries(channel.months ?? {})) add(`${m}-99`, `month of ${m}`, t);
    for (const [w, t] of Object.entries(channel.weeks ?? {})) add(w, `week of ${w}`, t);
    for (const [d, t] of Object.entries(channel.days)) add(d, d, t);
  }
  found.sort((a, b) => a.key.localeCompare(b.key));
  return { total: found.length, texts: found.slice(-limit).map((f) => f.text) };
}

/**
 * Roll finished weeks and months up into one summary each, from that period's daily summaries.
 * `condense(texts, label, channelName)` returns the combined summary. Kept forever.
 */
export async function updateRollups(condense) {
  const thisWeek = weekOf(dayOf(Date.now()));
  const thisMonth = monthOf(dayOf(Date.now()));
  for (const channel of Object.values(summaries.channels)) {
    channel.weeks ??= {};
    channel.months ??= {};
    const days = Object.keys(channel.days).sort();
    const periods = [
      ...new Set(days.map(weekOf).filter((w) => w < thisWeek && !channel.weeks[w])),
    ].map((w) => ({ store: channel.weeks, key: w, label: `the week of ${w}`, days: days.filter((d) => weekOf(d) === w) }));
    periods.push(
      ...[...new Set(days.map(monthOf).filter((m) => m < thisMonth && !channel.months[m]))].map((m) => ({
        store: channel.months,
        key: m,
        label: `the month of ${m}`,
        days: days.filter((d) => monthOf(d) === m),
      })),
    );
    for (const period of periods) {
      try {
        period.store[period.key] = await condense(
          period.days.map((d) => `${d}:\n${channel.days[d]}`),
          period.label,
          channel.name,
        );
        saveSummaries();
        console.log(`[summaries] Rolled up #${channel.name}, ${period.label}.`);
      } catch (err) {
        console.error(`[summaries] Roll-up failed for #${channel.name}, ${period.label}:`, err.message);
      }
    }
  }
}

/**
 * Fold every message logged since the last run into each channel's summary for that day.
 * `summarize(previousSummary, newLines, channelName, day)` returns the updated summary text.
 * Only channels with new messages cost anything.
 */
export async function updateSummaries(summarize) {
  const startedAt = Date.now();
  const groups = new Map(); // "channelId|day" -> entries
  for (const day of lastDays(RECENT_DAYS)) {
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
