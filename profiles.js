// Voice profiles: a cheap-model write-up of how each regular talks (vocabulary, catchphrases, running
// themes, how they tease and take teasing, usual reactions), built from messages spread across
// the whole log instead of the latest conversation. Used by skills like !predict that impersonate people.
//
// Only people with at least MIN_MESSAGES logged messages qualify; nobody else ever costs tokens.
// Profiles are built or refreshed only when someone runs "!profiles build" (never automatically), and
// a refresh reads only the messages posted since that person's last build.
// Saved to profiles.json next to customizations.json (git-ignored, stays on this machine).
import fs from "node:fs";
import { allEntries, formatLine, spreadPick } from "./chatlog.js";

const FILE = new URL("./profiles.json", import.meta.url);
const TMP = new URL("./profiles.json.tmp", import.meta.url);

export const MIN_MESSAGES = 100;
// A refresh is skipped until someone has posted at least this many new messages since their last build.
export const MIN_NEW_MESSAGES = 30;
const SAMPLE_CHARS = 200_000; // per person for a full build, about 50k tokens on the cheap model
const REFRESH_SAMPLE_CHARS = 60_000;
const CHUNK_CHARS = 40_000; // one cheap-model call reads about this much
const CONTEXT_BEFORE = 2; // other people's messages shown before each sampled one, so reactions make sense
const CONTEXT_GAP_MS = 30 * 60000; // ...only if they were posted within this long before it
// Profiles are summaries of style and tendencies, not quote lists: verbatim quotes made skills parrot
// random lines. Profiles saved in an older format are rebuilt from scratch by the next "!profiles build".
export const PROFILE_FORMAT_VERSION = 2;

/** profiles = { [userId]: { name, builtAt, updatedAt, throughTs, messageCount, text, format } } */
let profiles = {};
try {
  profiles = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") console.error("Couldn't read profiles.json, starting fresh:", err.message);
}

function save() {
  fs.writeFileSync(TMP, JSON.stringify(profiles, null, 2));
  fs.renameSync(TMP, FILE);
}

/** Is this profile in the current format (or does it need a full rebuild)? */
export const isCurrent = (p) => p?.format === PROFILE_FORMAT_VERSION;

/** How a skill should use a profile; shown with every profile handed to Claude. */
export const PROFILE_GUIDANCE =
  "Use it to capture their style and tendencies, not as a script: write new lines in their voice rather than reusing phrases from the profile. Only bring up a recurring theme when the topic actually comes up, and vary which traits you lean on from one reply to the next.";

export function getProfile(userId) {
  return profiles[userId] ?? null;
}

/** A person's profile as text for the system prompt, or "" if they don't have one. */
export function profileText(userId) {
  const p = profiles[userId];
  if (!p) return "";
  const built = new Date(p.updatedAt ?? p.builtAt).toISOString().slice(0, 10);
  return [
    `Voice profile of ${p.name} (user ID ${userId}), summarized from ${p.messageCount} of their messages across the whole chat log, last updated ${built}. ${PROFILE_GUIDANCE}`,
    p.text,
  ].join("\n");
}

/** Messages that count toward a profile: real people, not bots or commands. */
function isPersonMessage(entry, botUserId) {
  return entry.userId !== botUserId && !entry.bot && entry.name !== "Cwaude" && entry.text && !entry.text.startsWith("!");
}

/**
 * Everyone with logged messages, most active first: { userId, name, count, lastTs, profile, newSinceBuild }.
 * `entries` lets callers reuse one read of the log.
 */
export function profileStatus(botUserId, entries = allEntries()) {
  const people = new Map();
  for (const e of entries) {
    if (!isPersonMessage(e, botUserId)) continue;
    const p = people.get(e.userId) ?? { userId: e.userId, name: e.name, count: 0, lastTs: 0, newSinceBuild: 0 };
    p.count++;
    if (e.ts >= p.lastTs) {
      p.lastTs = e.ts;
      p.name = e.name; // latest display name
    }
    if (e.ts > (profiles[e.userId]?.throughTs ?? Infinity)) p.newSinceBuild++;
    people.set(e.userId, p);
  }
  return [...people.values()].map((p) => ({ ...p, profile: profiles[p.userId] ?? null })).sort((a, b) => b.count - a.count);
}

/**
 * Sample one person's messages spread evenly across the months they posted in, each with a little
 * of the conversation before it. Returns snippets (strings), oldest first, within `budget` characters.
 */
export function sampleSnippets(entries, userId, { afterTs = 0, budget = SAMPLE_CHARS } = {}) {
  // Per-channel timelines, so we can show what the person was replying to.
  const byChannel = new Map();
  for (const e of entries) {
    if (!byChannel.has(e.channelId)) byChannel.set(e.channelId, []);
    byChannel.get(e.channelId).push(e);
  }
  const anchors = [];
  for (const timeline of byChannel.values()) {
    timeline.sort((a, b) => a.ts - b.ts);
    timeline.forEach((e, i) => {
      if (e.userId === userId && e.ts > afterTs && e.text && !e.text.startsWith("!")) anchors.push({ e, i, timeline });
    });
  }
  anchors.sort((a, b) => a.e.ts - b.e.ts);
  const byMonth = new Map();
  for (const a of anchors) {
    const m = new Date(a.e.ts).toISOString().slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(a);
  }

  const snippetOf = ({ i, timeline }, used) => {
    const lines = [];
    const anchor = timeline[i];
    for (let j = Math.max(0, i - CONTEXT_BEFORE); j < i; j++) {
      const c = timeline[j];
      if (c.userId !== userId && anchor.ts - c.ts <= CONTEXT_GAP_MS && !used.has(c)) lines.push(c);
    }
    // The person's own run of consecutive messages starting at the anchor.
    for (let j = i; j < timeline.length && j < i + 4 && timeline[j].userId === userId; j++) {
      if (!used.has(timeline[j])) lines.push(timeline[j]);
    }
    for (const l of lines) used.add(l);
    return lines.map((l) => `${l.userId === userId ? ">> " : "   "}${formatLine(l, { withDate: true, withChannel: true })}`).join("\n");
  };

  // Give each month an equal share of the budget; estimate ~3 lines of ~70 chars per snippet.
  const months = [...byMonth.keys()].sort();
  const perMonth = Math.max(1, Math.floor(budget / Math.max(months.length, 1) / 200));
  const used = new Set();
  const snippets = [];
  let chars = 0;
  for (const m of months) {
    for (const a of spreadPick(byMonth.get(m), perMonth)) {
      if (used.has(a.e)) continue;
      const s = snippetOf(a, used);
      if (!s) continue;
      if (chars + s.length > budget) break;
      snippets.push(s);
      chars += s.length + 2;
    }
  }
  return snippets;
}

/** Group snippets into chunks of about CHUNK_CHARS each, for one cheap-model call apiece. */
export function chunkSnippets(snippets, size = CHUNK_CHARS) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const s of snippets) {
    if (chars + s.length > size && current.length) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(s);
    chars += s.length + 2;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const NOTES_SYSTEM = (name) =>
  `You study how one person in a Discord server of friends talks, so a chat bot can later write NEW messages in their voice. The person is ${name}; their lines are marked with ">>", other lines are context. Write compact notes on ${name} only, describing patterns, not individual messages:
- Tone and attitude (dry, hyped, sarcastic, earnest, ...)
- Message shape: typical length, capitalization, punctuation, emoji, spelling and slang habits
- Humor: how they joke, how they tease others, and how they take being teased
- Usual reactions to being wrong, surprises, good or bad news, arguments
- Who they talk to most and how
- Recurring themes: only topics, jokes or opinions they bring up again and again across these excerpts (say roughly how often, e.g. "in about 10 of these excerpts"). Skip anything that shows up only once or twice; one-off moments and random lines are not patterns.
- Signature phrases: only words or phrases they use many times (say how often). Don't copy ordinary lines.
Output only the notes.`;

const PROFILE_FORMAT = (name) =>
  `Write the profile of ${name} as compact bullet points under these headings: Tone, Message shape (length, caps, punctuation, emoji, spelling), Humor and teasing (how they tease and how they take it), Usual reactions, Who they talk to, Recurring themes, Signature phrases. The profile is a summary of style and tendencies for writing new messages in their voice, not a collection of things they said: no quotes or example messages. Under Recurring themes, list only topics, jokes or opinions they raise clearly more than the others do, across several months, and phrase each as a tendency ("tends to bring up X when Y comes up"), not something to mention every time. Under Signature phrases, at most 5 words or phrases they really use a lot, or "none" if nothing stands out. Keep it under about 400 words. Output only the profile.`;

let building = false;

/**
 * Build missing profiles and refresh stale ones. `ask({ system, content, maxTokens })` calls the cheap
 * model and returns { text, usage }. `only` limits it to some user IDs. `log(line)` reports progress.
 * Returns { built: [names], refreshed: [names], skipped: [lines], inputTokens, outputTokens }.
 */
export async function buildProfiles({ ask, botUserId, only = null, force = false, log = () => {} }) {
  if (building) throw new Error("A profile build is already running.");
  building = true;
  try {
    const entries = allEntries();
    const result = { built: [], refreshed: [], skipped: [], failed: [], inputTokens: 0, outputTokens: 0 };
    const call = async (system, content, maxTokens) => {
      const r = await ask({ system, content, maxTokens });
      result.inputTokens += r.usage?.input_tokens ?? 0;
      result.outputTokens += r.usage?.output_tokens ?? 0;
      return r.text;
    };
    for (const person of profileStatus(botUserId, entries)) {
      if (only && !only.includes(person.userId)) continue;
      if (person.count < MIN_MESSAGES) {
        if (only) result.skipped.push(`${person.name} has only ${person.count} messages (needs ${MIN_MESSAGES})`);
        continue;
      }
      const existing = person.profile;
      // An old-format profile (with verbatim quotes) is rebuilt from scratch rather than refreshed.
      const refresh = isCurrent(existing) && !force;
      if (refresh && person.newSinceBuild < MIN_NEW_MESSAGES) {
        if (only) result.skipped.push(`${person.name} is up to date (${person.newSinceBuild} new messages since the last build)`);
        continue;
      }
      try {
        const snippets = sampleSnippets(entries, person.userId, {
          afterTs: refresh ? existing.throughTs : 0,
          budget: refresh ? REFRESH_SAMPLE_CHARS : SAMPLE_CHARS,
        });
        const chunks = chunkSnippets(snippets);
        log(`${refresh ? "Refreshing" : "Building"} ${person.name}: ${snippets.length} excerpts in ${chunks.length} part(s)`);
        const notes = [];
        for (const [n, chunk] of chunks.entries()) {
          notes.push(await call(NOTES_SYSTEM(person.name), `Excerpts, part ${n + 1} of ${chunks.length}, oldest first:\n\n${chunk.join("\n\n")}`, 3000));
        }
        const merged = refresh
          ? await call(
              `You keep a profile of how ${person.name} talks in a Discord server, so a chat bot can write new messages in their voice. Update the existing profile with notes on their newer messages: adjust what changed, keep what still holds, and add a recurring theme only if it now clearly recurs. ${PROFILE_FORMAT(person.name)}`,
              `Existing profile:\n${existing.text}\n\nNotes on newer messages:\n\n${notes.join("\n\n---\n\n")}`,
              4000,
            )
          : await call(
              `You write a profile of how ${person.name} talks in a Discord server, so a chat bot can imitate them, by combining notes taken from samples spread across the whole year. Keep patterns that recur over time over one-off moments. ${PROFILE_FORMAT(person.name)}`,
              `Notes, oldest samples first:\n\n${notes.join("\n\n---\n\n")}`,
              4000,
            );
        const body = merged.trim();
        if (!body) throw new Error("the model returned an empty profile");
        const now = new Date().toISOString();
        profiles[person.userId] = {
          name: person.name,
          builtAt: existing?.builtAt && refresh ? existing.builtAt : now,
          updatedAt: now,
          throughTs: person.lastTs,
          messageCount: person.count,
          text: body,
          format: PROFILE_FORMAT_VERSION,
        };
        save();
        (refresh ? result.refreshed : result.built).push(person.name);
      } catch (err) {
        console.error(`[profiles] Failed for ${person.name}:`, err.message);
        result.failed.push(`${person.name} (${err.message})`);
      }
    }
    return result;
  } finally {
    building = false;
  }
}

/** The !profiles list: who qualifies, their message counts, and who has a profile. */
export function renderProfiles(botUserId) {
  const status = profileStatus(botUserId);
  const day = (ts) => new Date(ts).toISOString().slice(0, 10);
  const eligible = status.filter((p) => p.count >= MIN_MESSAGES);
  const others = status.filter((p) => p.count < MIN_MESSAGES);
  const first = allEntries()[0];
  const lines = [`**Voice profiles** (people with ${MIN_MESSAGES}+ logged messages${first ? `, log starts ${day(first.ts)}` : ""}):`];
  if (!eligible.length) lines.push("- nobody yet");
  for (const p of eligible) {
    const state = !p.profile
      ? "no profile yet"
      : !isCurrent(p.profile)
      ? "old-format profile (with quotes), rebuilt by the next build"
      : `profile from ${day(p.profile.updatedAt)}${p.newSinceBuild ? `, ${p.newSinceBuild} new message${p.newSinceBuild === 1 ? "" : "s"} since` : ", up to date"}`;
    lines.push(`- ${p.name}: ${p.count} messages, ${state}`);
  }
  if (others.length) lines.push(`Not enough messages yet: ${others.map((p) => `${p.name} (${p.count})`).join(", ")}`);
  lines.push("", "`!profiles build` builds missing ones and refreshes ones with 30+ new messages (old-format ones are rebuilt). `!profiles build Name` does one person, `!profiles rebuild Name` starts theirs over, `!profiles show Name` posts it.");
  return lines.join("\n");
}
