// The chat-editable layer: tools Claude uses to add/edit/remove rules, facts, and skills,
// how they're shown to Claude in the system prompt, and the lists the bot posts itself.
import {
  activeItems,
  removedItems,
  getItem,
  addItem,
  editItem,
  setRemoved,
  recentChanges,
  knownPeople,
  personName,
} from "./store.js";

/** Strict tool schemas support anyOf, so "this or null" is spelled that way. */
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }], ...(schema.description && { description: schema.description }) });

const NOTHING_ELSE = {
  type: "boolean",
  description:
    "true if the user's message is only about this change and asks nothing else (the bot will just react with a checkmark, or post the list, and you won't reply). false if the message also asks something you still need to answer.",
};
const PEOPLE = {
  type: "array",
  items: { type: "string" },
  description: "User IDs from the Known people list.",
};
const IDS = { type: "array", items: { type: "integer" }, description: "Item numbers, e.g. [3] for #3." };

export const CUSTOM_TOOLS = [
  {
    name: "add_rule",
    description:
      "Save a lasting instruction for how you behave: for everyone, or only when specific people are the ones talking to you, optionally only in this channel or only in some situation. Optionally make it chime in unprompted when a message contains certain words.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: 'Short, self-contained instruction, e.g. "Reply in pirate speak."' },
        people: { ...PEOPLE, description: "User IDs it applies to (when they're talking to you). Empty array = everyone." },
        this_channel_only: { type: "boolean", description: "true only if they said it should apply just in this channel." },
        when: nullable({
          type: "string",
          description: 'Plain-English situation it applies in, e.g. "when someone asks about food". null = always.',
        }),
        chime_in_keywords: {
          type: "array",
          items: { type: "string" },
          description:
            'Only if they want you to respond WITHOUT being summoned (e.g. "whenever anyone says pineapple pizza, say gross"): the words or short phrases that trigger it, e.g. ["pineapple pizza"]. Otherwise an empty array.',
        },
        nothing_else_to_answer: NOTHING_ELSE,
      },
      required: ["text", "people", "this_channel_only", "when", "chime_in_keywords", "nothing_else_to_answer"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "add_fact",
    description:
      'Save something lasting to know, about a person or in general, e.g. "Sam is vegetarian", "Sammy is Sam\'s nickname", "Our D&D night is Thursday". Use add_rule instead for instructions on how to behave.',
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, short and self-contained, using people's names." },
        about: { ...PEOPLE, description: "User IDs of the people it's about. Empty array if it's general." },
        nothing_else_to_answer: NOTHING_ELSE,
      },
      required: ["text", "about", "nothing_else_to_answer"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "add_skill",
    description:
      'Save a named skill: a reusable prompt that anyone can run later by name, e.g. "hey cwaude roast Sam". Write the prompt as instructions to yourself.',
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'One or two words people will type to run it, e.g. "roast".' },
        prompt: {
          type: "string",
          description:
            "What to do when it's run, as instructions to yourself. Whatever the person types after the name is the input. Keep everything they asked for.",
        },
        nothing_else_to_answer: NOTHING_ELSE,
      },
      required: ["name", "prompt", "nothing_else_to_answer"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "edit_item",
    description: "Change an existing rule, fact, or skill, keeping its number. Pass null for anything that stays the same.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "The item's number." },
        text: nullable({ type: "string", description: "New text (for a skill: its new prompt)." }),
        people: nullable({ type: "array", items: { type: "string" }, description: "New user IDs (empty = everyone / general)." }),
        this_channel_only: nullable({ type: "boolean", description: "true = only this channel, false = everywhere." }),
        when: nullable({ type: "string", description: 'New situation, or "" to make it apply always.' }),
        chime_in_keywords: nullable({ type: "array", items: { type: "string" }, description: "New trigger words ([] to stop chiming in)." }),
        name: nullable({ type: "string", description: "Skills only: new name." }),
        nothing_else_to_answer: NOTHING_ELSE,
      },
      required: ["id", "text", "people", "this_channel_only", "when", "chime_in_keywords", "name", "nothing_else_to_answer"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "remove_items",
    description: 'Remove rules, facts, or skills by number ("remove 3", "delete the pirate rule"). They can be restored later.',
    input_schema: {
      type: "object",
      properties: { ids: IDS, nothing_else_to_answer: NOTHING_ELSE },
      required: ["ids", "nothing_else_to_answer"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "restore_items",
    description: "Bring back previously removed items by number.",
    input_schema: {
      type: "object",
      properties: { ids: IDS, nothing_else_to_answer: NOTHING_ELSE },
      required: ["ids", "nothing_else_to_answer"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "show_list",
    description:
      'Post an exact, numbered list. Use it whenever someone asks to see/list rules, facts, skills, everything, what was removed, what changed recently, or the details of one item ("what\'s #4?"). The bot posts the list itself; don\'t repeat it in your reply.',
    input_schema: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["everything", "rules", "facts", "skills", "removed", "changes", "one_item"] },
        id: nullable({ type: "integer", description: "For one_item: the item's number. Otherwise null." }),
        nothing_else_to_answer: NOTHING_ELSE,
      },
      required: ["what", "id", "nothing_else_to_answer"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export const CUSTOM_TOOL_NAMES = new Set(CUSTOM_TOOLS.map((tool) => tool.name));

// ---------- formatting ----------

function names(ids) {
  return ids.map(personName).join(", ");
}

function shorten(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line describing an item, shared by the system prompt and the posted lists. */
export function describe(item, { maxText = Infinity } = {}) {
  const tags = [item.kind === "skill" ? `skill "${item.name}"` : item.kind];
  if (item.kind === "rule") tags.push(item.people.length ? `for ${names(item.people)}` : "for everyone");
  if (item.kind === "fact" && item.people.length) tags.push(`about ${names(item.people)}`);
  if (item.channel) tags.push(`only in #${item.channel.name}`);
  if (item.when) tags.push(`when: ${item.when}`);
  if (item.keywords.length) tags.push(`chimes in on: ${item.keywords.map((k) => `"${k}"`).join(", ")}`);
  return `#${item.id} [${tags.join(" | ")}] ${shorten(item.text, maxText)}`;
}

/** Does this rule apply when `userId` is talking in `channelId`? (Ignores the plain-English `when`.) */
export function ruleInScope(rule, userId, channelId) {
  return (rule.people.length === 0 || rule.people.includes(userId)) && (!rule.channel || rule.channel.id === channelId);
}

/**
 * The per-request part of the system prompt: who's who, and everything people have taught Cwaude.
 * `conversation` maps the IDs of people in this conversation to their display names.
 */
export function describeCustomizations(conversation, askerId, channelId) {
  const lines = ["Known people (use these IDs when saving rules and facts):"];
  for (const [id, { name }] of Object.entries(knownPeople())) {
    const marks = [];
    if (id === askerId) marks.push("the person talking to you right now");
    else if (conversation.has(id)) marks.push("in this conversation");
    lines.push(`- ${name} (ID ${id})${marks.length ? ` <- ${marks.join(", ")}` : ""}`);
  }

  const rules = activeItems("rule");
  const inEffect = rules.filter((rule) => ruleInScope(rule, askerId, channelId));
  const notInEffect = rules.filter((rule) => !inEffect.includes(rule));
  const facts = activeItems("fact");
  const skills = activeItems("skill");

  lines.push("", "Facts (things you know; use them whenever they're relevant):");
  lines.push(...(facts.length ? facts.map((item) => `- ${describe(item)}`) : ["- none yet"]));

  lines.push("", "Skills (run one when someone asks for it by name; whatever follows the name is the input):");
  lines.push(...(skills.length ? skills.map((item) => `- ${describe(item)}`) : ["- none yet"]));

  if (notInEffect.length) {
    lines.push(
      "",
      "Other rules (they don't apply to this message because of who's talking or which channel this is; listed only so you can edit or remove them):",
      ...notInEffect.map((item) => `- ${describe(item)}`),
    );
  }

  const asker = personName(askerId).toUpperCase();
  if (inEffect.length) {
    lines.push(
      "",
      `RULES IN EFFECT FOR ${asker} IN THIS CHANNEL (they override your default personality, tone, and language; follow them fully, but only the ones whose "when" fits this message; if two conflict, the higher number wins):`,
      ...inEffect.map((item) => `- ${describe(item)}`),
    );
  } else {
    lines.push("", `No rules are in effect for ${asker} here; use your default personality.`);
  }
  return lines.join("\n");
}

// ---------- the lists the bot posts itself ----------

function section(title, items) {
  if (!items.length) return [`**${title}:** none`];
  return [`**${title}:**`, ...items.map((item) => describe(item, { maxText: 200 }))];
}

const timeFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function describeChange(change) {
  const when = timeFormat.format(new Date(change.at));
  const who = change.by?.name ?? "someone";
  const item = change.after ?? change.item;
  const label = item.kind === "skill" ? `skill #${item.id} "${item.name}"` : `${item.kind} #${item.id}`;
  const verb = { add: "added", edit: "edited", remove: "removed", restore: "restored" }[change.action] ?? change.action;
  return `${when}: ${who} ${verb} ${label}: ${shorten(item.text, 120)}`;
}

export function renderList(what, id) {
  switch (what) {
    case "rules":
      return section("Rules", activeItems("rule")).join("\n");
    case "facts":
      return section("Facts", activeItems("fact")).join("\n");
    case "skills":
      return section("Skills", activeItems("skill")).join("\n");
    case "removed":
      return [...section("Removed (say \"restore <number>\" to bring one back)", removedItems())].join("\n");
    case "changes": {
      const changes = recentChanges(15);
      if (!changes.length) return "**Recent changes:** none yet";
      return ["**Recent changes (newest first):**", ...changes.map(describeChange)].join("\n");
    }
    case "one_item": {
      const item = id != null && getItem(id);
      if (!item) return `There's no #${id}.`;
      return [
        describe(item) + (item.removed ? " (removed)" : ""),
        `Added by ${item.createdBy?.name ?? "someone"} on ${timeFormat.format(new Date(item.createdAt))}` +
          (item.updatedAt !== item.createdAt ? `, last changed ${timeFormat.format(new Date(item.updatedAt))}` : ""),
      ].join("\n");
    }
    default:
      return [...section("Rules", activeItems("rule")), "", ...section("Facts", activeItems("fact")), "", ...section("Skills", activeItems("skill"))].join("\n");
  }
}

// ---------- running the tools ----------

/**
 * Run one of the custom tools. ctx = { by: { id, name }, channel: { id, name } }.
 * Returns { error, text, changed, post } where post is a list for the bot to send.
 */
export function runCustomTool(block, ctx) {
  const input = block.input;
  const fail = (text) => ({ error: true, text, changed: false });
  const channel = (only) => (only ? ctx.channel : null);
  let result;

  switch (block.name) {
    case "add_rule":
      result = addItem(
        { kind: "rule", text: input.text, people: input.people, channel: channel(input.this_channel_only), when: input.when, keywords: input.chime_in_keywords },
        ctx.by,
      );
      break;
    case "add_fact":
      result = addItem({ kind: "fact", text: input.text, people: input.about }, ctx.by);
      break;
    case "add_skill":
      result = addItem({ kind: "skill", name: input.name, text: input.prompt }, ctx.by);
      break;
    case "edit_item": {
      const changes = { text: input.text, people: input.people, when: input.when, keywords: input.chime_in_keywords, name: input.name };
      if (input.this_channel_only != null) changes.channel = channel(input.this_channel_only);
      result = editItem(input.id, changes, ctx.by);
      break;
    }
    case "remove_items":
    case "restore_items": {
      const removing = block.name === "remove_items";
      const done = [];
      const problems = [];
      for (const id of input.ids) {
        const r = setRemoved(id, removing, ctx.by);
        if (r.error) problems.push(r.error);
        else done.push(`#${id}`);
      }
      const verb = removing ? "Removed" : "Restored";
      const text = [done.length ? `${verb} ${done.join(", ")}.` : "", ...problems].filter(Boolean).join(" ");
      if (done.length) console.log(`[custom] ${ctx.by.name} ${verb.toLowerCase()} ${done.join(", ")}`);
      return { error: problems.length > 0, text, changed: done.length > 0 };
    }
    case "show_list":
      return { error: false, text: "The bot has posted the list. Don't repeat it.", changed: false, post: renderList(input.what, input.id) };
    default:
      return fail(`Unknown tool ${block.name}.`);
  }

  if (result.error) return fail(result.error);
  const action = block.name === "edit_item" ? "Edited" : "Saved";
  console.log(`[custom] ${ctx.by.name} ${action.toLowerCase()} ${describe(result.item)}`);
  return { error: false, text: `${action} as ${describe(result.item)}`, changed: true };
}
