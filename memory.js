// Per-user memory: short notes Cwaude keeps about people, saved to memory.json.
import fs from "node:fs";

const FILE = new URL("./memory.json", import.meta.url);
const MAX_NOTES = 10;
const MAX_NOTE_LENGTH = 300;

let data = {};
try {
  data = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") console.error("Couldn't read memory.json, starting empty:", err.message);
}

function save() {
  // Write to a temp file then rename, so a crash mid-write can't corrupt the file.
  const tmp = new URL("./memory.json.tmp", import.meta.url);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

export function getNotes(userId) {
  return data[userId]?.notes ?? [];
}

export function addNote(userId, name, note) {
  note = note.trim();
  if (!note) return "Note is empty.";
  if (note.length > MAX_NOTE_LENGTH) return `Note is too long (max ${MAX_NOTE_LENGTH} characters).`;
  const entry = (data[userId] ??= { name, notes: [] });
  entry.name = name;
  if (entry.notes.includes(note)) return null; // already saved: treat as success, not an error
  if (entry.notes.length >= MAX_NOTES) return `${name} already has ${MAX_NOTES} notes. Forget one first.`;
  entry.notes.push(note);
  save();
  return null;
}

export function removeNote(userId, note) {
  const entry = data[userId];
  const index = entry?.notes.indexOf(note.trim()) ?? -1;
  if (index === -1) return "No note with that exact text.";
  entry.notes.splice(index, 1);
  if (entry.notes.length === 0) delete data[userId];
  save();
  return null;
}
