// Everything people have taught Cwaude by chatting: numbered rules, facts, and skills, plus a roster
// of known people. Saved to customizations.json; every change is appended to changes.log.
import fs from "node:fs";

const FILE = new URL("./customizations.json", import.meta.url);
const TMP = new URL("./customizations.json.tmp", import.meta.url);
const LOG = new URL("./changes.log", import.meta.url);
const OLD_MEMORY = new URL("./memory.json", import.meta.url);

export const KINDS = ["rule", "fact", "skill"];
// Built-in "!" commands; skills can't take these names.
export const RESERVED_NAMES = ["help", "skills", "profiles"];

/** "Fact Check" -> "fact-check", so a skill name is one word you can type after "!". */
export function skillName(name) {
  return (name ?? "").trim().toLowerCase().replace(/^!+/, "").replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-+|-+$/g, "");
}

/**
 * data = {
 *   nextId: 1,
 *   items: [{ id, kind, text, name, people, channel, when, keywords, removed, createdBy, createdAt, updatedAt }],
 *   people: { [userId]: { name } },
 * }
 * - text: the instruction (rule), the fact, or the skill's prompt.
 * - name: skills only, the word people type after "!" to run it (letters, digits, dashes).
 * - people: user IDs a rule applies to (when they're the one talking). Empty = everyone.
 *   For facts: who the fact is about (empty = general).
 * - channel: { id, name } or null for everywhere.
 * - when: plain-English condition ("when someone asks about food") or null.
 * - keywords: words that make the bot chime in unprompted (rules only). Empty = only when summoned.
 * - everyMessage: rules only; chime in on EVERY message from the rule's people (or everyone), e.g. fact-checking.
 * - respond: rules only, for chime-ins: "reply" (post a message) or "react" (just add an emoji reaction).
 * - expiresAt: ISO time after which the item turns itself off ("for 5 minutes"), or null.
 * Numbers come from one shared counter and are never reused, so "remove 3" is always unambiguous.
 */
let data = { nextId: 1, items: [], people: {} };

function save() {
  // Write to a temp file then rename, so a crash mid-write can't corrupt the file.
  fs.writeFileSync(TMP, JSON.stringify(data, null, 2));
  fs.renameSync(TMP, FILE);
}

function load() {
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
    return;
  } catch (err) {
    if (err.code !== "ENOENT") {
      // Don't overwrite a file we couldn't parse; someone should look at it.
      console.error("Couldn't read customizations.json:", err.message);
      process.exit(1);
    }
  }
  migrateOldNotes();
}

/** One-time import of the old per-person notes in memory.json. The old file is left untouched. */
function migrateOldNotes() {
  let old;
  try {
    old = JSON.parse(fs.readFileSync(OLD_MEMORY, "utf8"));
  } catch {
    return;
  }
  const now = new Date().toISOString();
  for (const [userId, entry] of Object.entries(old)) {
    data.people[userId] = { name: entry.name };
    for (const note of entry.notes ?? []) {
      const item = blankItem({ kind: "rule", text: note, people: [userId] }, { id: null, name: "(old notes)" }, now);
      data.items.push(item);
      writeLog({ at: now, by: item.createdBy, action: "add", item });
    }
  }
  save();
  console.log(`[store] Imported ${data.items.length} old note(s) from memory.json.`);
}

function writeLog(entry) {
  fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");
}

function blankItem(fields, by, now) {
  return {
    id: data.nextId++,
    kind: fields.kind,
    text: fields.text.trim(),
    name: fields.kind === "skill" ? skillName(fields.name) : null,
    description: fields.kind === "skill" ? fields.description?.trim() || null : undefined,
    recentMessages: fields.kind === "skill" ? recentCount(fields.recentMessages) : undefined,
    people: fields.people ?? [],
    channel: fields.channel ?? null,
    when: fields.when?.trim() || null,
    keywords: cleanKeywords(fields.keywords),
    everyMessage: Boolean(fields.everyMessage),
    respond: fields.respond === "react" ? "react" : "reply",
    expiresAt: fields.expiresAt ?? null,
    removed: false,
    createdBy: by,
    createdAt: now,
    updatedAt: now,
  };
}

/** A skill's recent-message count: null = the default, otherwise 0 or more. */
function recentCount(n) {
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function cleanKeywords(keywords) {
  return [...new Set((keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean))];
}

load();

// ---------- people ----------

/** Remember someone's current display name. Cheap to call on every message; only saves on change. */
export function notePerson(userId, name) {
  if (data.people[userId]?.name === name) return;
  data.people[userId] = { name };
  save();
}

export function knownPeople() {
  return data.people;
}

export function personName(userId) {
  return data.people[userId]?.name ?? `unknown (${userId})`;
}

// ---------- items ----------

const TIMER = { id: null, name: "timer" };

/** Turn off anything whose time is up, logging it like any other change. */
function expireDue() {
  const now = new Date().toISOString();
  let changed = false;
  for (const item of data.items) {
    if (item.removed || !item.expiresAt || item.expiresAt > now) continue;
    item.removed = true;
    item.updatedAt = now;
    writeLog({ at: now, by: TIMER, action: "expire", id: item.id, item });
    console.log(`[store] #${item.id} expired.`);
    changed = true;
  }
  if (changed) save();
}

export function activeItems(kind) {
  expireDue();
  return data.items.filter((item) => !item.removed && (!kind || item.kind === kind));
}

export function removedItems() {
  expireDue();
  return data.items.filter((item) => item.removed);
}

export function getItem(id) {
  expireDue();
  return data.items.find((item) => item.id === id);
}

/** Returns { item } or { error }. */
export function addItem(fields, by) {
  if (!KINDS.includes(fields.kind)) return { error: `Unknown kind "${fields.kind}".` };
  if (!fields.text?.trim()) return { error: "The text is empty." };
  if (fields.kind === "skill") {
    const name = skillName(fields.name);
    if (!name) return { error: "A skill needs a name." };
    if (RESERVED_NAMES.includes(name)) return { error: `"!${name}" is a built-in command; pick another name.` };
    const clash = activeItems("skill").find((s) => s.name === name);
    if (clash) return { error: `There's already a skill called "${clash.name}" (#${clash.id}). Edit or remove that one.` };
  }
  const unknown = (fields.people ?? []).filter((id) => !data.people[id]);
  if (unknown.length) return { error: `Unknown user ID(s): ${unknown.join(", ")}. They need to post in the server (or be @mentioned) first.` };

  const now = new Date().toISOString();
  const item = blankItem(fields, by, now);
  data.items.push(item);
  save();
  writeLog({ at: now, by, action: "add", item });
  return { item };
}

/** Change some fields of an item, keeping its number. Returns { item } or { error }. */
export function editItem(id, changes, by) {
  const item = getItem(id);
  if (!item || item.removed) return { error: `There's no active #${id}.` };
  const before = structuredClone(item);
  if (changes.text != null) {
    if (!changes.text.trim()) return { error: "The text is empty." };
    item.text = changes.text.trim();
  }
  if (changes.description != null && item.kind === "skill") item.description = changes.description.trim() || null;
  if (changes.recentMessages != null && item.kind === "skill") item.recentMessages = recentCount(changes.recentMessages);
  if (changes.name != null && item.kind === "skill") {
    const name = skillName(changes.name);
    if (!name || RESERVED_NAMES.includes(name)) return { error: `Can't use "${changes.name}" as a skill name.` };
    const clash = activeItems("skill").find((s) => s.name === name && s.id !== id);
    if (clash) return { error: `There's already a skill called "${name}" (#${clash.id}).` };
    item.name = name;
  }
  if (changes.people != null) {
    const unknown = changes.people.filter((uid) => !data.people[uid]);
    if (unknown.length) return { error: `Unknown user ID(s): ${unknown.join(", ")}.` };
    item.people = changes.people;
  }
  if (changes.channel !== undefined) item.channel = changes.channel;
  if (changes.when != null) item.when = changes.when.trim() || null;
  if (changes.keywords != null) item.keywords = cleanKeywords(changes.keywords);
  if (changes.everyMessage != null) item.everyMessage = changes.everyMessage;
  if (changes.respond != null) item.respond = changes.respond === "react" ? "react" : "reply";
  if (changes.expiresAt !== undefined) item.expiresAt = changes.expiresAt;
  item.updatedAt = new Date().toISOString();
  save();
  writeLog({ at: item.updatedAt, by, action: "edit", id, before, after: item });
  return { item };
}

/** Returns { item } or { error }. */
export function setRemoved(id, removed, by) {
  const item = getItem(id);
  if (!item) return { error: `There's no #${id}.` };
  if (item.removed === removed) return { error: `#${id} is already ${removed ? "removed" : "active"}.` };
  if (!removed && item.kind === "skill") {
    const clash = activeItems("skill").find((s) => s.name === item.name);
    if (clash) return { error: `Can't restore: skill "${item.name}" is now #${clash.id}.` };
  }
  item.removed = removed;
  // Restoring something that timed out brings it back for good; set a new time limit by editing it.
  if (!removed && item.expiresAt && item.expiresAt <= new Date().toISOString()) item.expiresAt = null;
  item.updatedAt = new Date().toISOString();
  save();
  writeLog({ at: item.updatedAt, by, action: removed ? "remove" : "restore", id, item });
  return { item };
}

/** The most recent changes, newest first. */
export function recentChanges(limit = 15) {
  let lines;
  try {
    lines = fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
  return lines
    .slice(-limit)
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
