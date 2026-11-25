// The chat-editable layer: tools Claude uses to add/edit/remove rules, facts, and skills,
// how they're shown to Claude in the system prompt, and the lists the bot posts itself.
import { searchLog, searchSummaries, sampleLog, firstLoggedDay } from "./chatlog.js";
import { profileText, MIN_MESSAGES } from "./profiles.js";
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

/**
 * The API compiles every strict tool's schema into one grammar per request and rejects the request when it
 * gets too big ("compiled grammar is too large"). So only the tools that change things are strict; the
 * read-only lookup tools (search/sample the log, summaries, voice profiles) aren't, and their handlers
 * cope with missing or odd arguments instead.
 *
 * Strict tool schemas support anyOf, so "this or null" is spelled that way. The API allows at most 16 of
 * these across ALL tools in a request (it answers 400 above that), so use it only where null must differ
 * from an empty value, i.e. edit_item's "leave unchanged". Elsewhere use "" or 0 for "not set".
 */
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
        when: {
          type: "string",
          description: 'Plain-English situation it applies in, e.g. "when someone asks about food". "" = always.',
        },
        chime_in_keywords: {
          type: "array",
          items: { type: "string" },
          description:
            'Only if they want you to respond WITHOUT being summoned (e.g. "whenever anyone says pineapple pizza, say gross"): the words or short phrases that trigger it, e.g. ["pineapple pizza"]. Otherwise an empty array.',
        },
        chime_in_on_every_message: {
          type: "boolean",
          description:
            'true if you should respond, unsummoned, to EVERY message from the rule\'s people (or everyone if people is empty), e.g. "fact check everything Celia says". Usually false.',
        },
        chime_in_response: {
          type: "string",
          enum: ["reply", "react"],
          description: 'For chime-ins: "react" if they want just an emoji reaction (e.g. a check or an X), otherwise "reply".',
        },
        expires_in_minutes: {
          type: "integer",
          description: 'If they gave a time limit ("for 5 mins", "for the next hour"), that many minutes. 0 = permanent.',
        },
        nothing_else_to_answer: NOTHING_ELSE,
      },
      required: [
        "text",
        "people",
        "this_channel_only",
        "when",
        "chime_in_keywords",
        "chime_in_on_every_message",
        "chime_in_response",
        "expires_in_minutes",
        "nothing_else_to_answer",
      ],
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
      'Save a named skill: a reusable prompt that anyone can run later with "!name", e.g. "!roast Sam" (or by asking, "hey cwaude roast Sam"). Write the prompt as instructions to yourself.',
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'One word (dashes OK) people type after "!" to run it, e.g. "roast" or "fact-check".' },
        prompt: {
          type: "string",
          description:
            "What to do when it's run, as instructions to yourself. Whatever the person types after the name is the input, and if they run it as a reply, the message they replied to is included too. When it runs you can search the chat log (latest matches, or samples spread across the year), look up people's voice profiles, and search the web. If the skill imitates or writes as people, say \"use their voice profiles\" in the prompt: the profiles of everyone named in the input are then loaded automatically. Keep everything they asked for.",
        },
        recent_messages: {
          type: "integer",
          description:
            "How many of the channel's most recent messages the skill sees as background: -1 = the default (30), 0 = none (for skills that shouldn't be swayed by the current chat), or a smaller number. Use -1 unless they ask, or the skill is about long-term patterns rather than the current conversation.",
        },
        description: {
          type: "string",
          description: 'A short one-line description for the !help list, e.g. "Fact-checks what someone said in the last 5 minutes".',
        },
        nothing_else_to_answer: NOTHING_ELSE,
      },
      required: ["name", "prompt", "description", "recent_messages", "nothing_else_to_answer"],
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
        chime_in_on_every_message: nullable({ type: "boolean", description: "Rules only: respond unsummoned to every message from its people." }),
        chime_in_response: nullable({ type: "string", enum: ["reply", "react"], description: "Rules only: how to chime in." }),
        expires_in_minutes: nullable({ type: "integer", description: "New time limit in minutes from now; 0 to make it permanent." }),
        name: nullable({ type: "string", description: "Skills only: new name." }),
        description: nullable({ type: "string", description: "Skills only: new one-line description for the !help list." }),
        recent_messages: nullable({ type: "integer", description: "Skills only: how many recent channel messages it sees (-1 = default 30, 0 = none)." }),
        nothing_else_to_answer: NOTHING_ELSE,
      },
      required: [
        "id",
        "text",
        "people",
        "this_channel_only",
        "when",
        "chime_in_keywords",
        "chime_in_on_every_message",
        "chime_in_response",
        "expires_in_minutes",
        "name",
        "description",
        "recent_messages",
        "nothing_else_to_answer",
      ],
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
    name: "search_chat_log",
    description:
      "Search the exact messages people have said in the server (the bot keeps a local log of everything since it started logging). Use it when someone asks about something said earlier that isn't in the recent messages or summaries you were given. All filters are optional. For older or vaguer questions (\"when did we plan that trip?\"), search_summaries first can find the right dates to search here.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Words that must all appear in the message (any case). "" = any message.' },
        user_id: { type: "string", description: 'Only messages from this person (ID from Known people). "" = anyone.' },
        this_channel_only: { type: "boolean" },
        days_back: { type: "integer", description: "How many days back from today to search (any number). Ignored if from_date or minutes_back is set." },
        from_date: { type: "string", description: 'Start date "YYYY-MM-DD" (inclusive) for searching a specific past period. "" otherwise.' },
        to_date: { type: "string", description: 'End date "YYYY-MM-DD" (inclusive). "" = today.' },
        minutes_back: {
          type: "integer",
          description: 'For recent things ("the last 5 minutes"): only messages from this many minutes ago until now. Overrides days_back. 0 otherwise.',
        },
      },
      required: ["query", "user_id", "this_channel_only", "days_back", "from_date", "to_date", "minutes_back"],
      additionalProperties: false,
    },
  },
  {
    name: "sample_chat_log",
    description:
      "Like search_chat_log, but returns messages spread evenly across every month of the log instead of the latest ones. Use it to learn someone's long-term habits, opinions and running jokes (e.g. for impersonating them) without being swayed by the current conversation. Also says how many matches each month has.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Words that must all appear in the message (any case). "" = any message.' },
        user_id: { type: "string", description: 'Only messages from this person (ID from Known people). "" = anyone.' },
        this_channel_only: { type: "boolean" },
        skip_recent_days: { type: "integer", description: "Leave out the last N days (e.g. 3 to ignore the current conversation). 0 = include everything." },
        from_date: { type: "string", description: 'Only messages from this date "YYYY-MM-DD" on. "" = the whole log.' },
        how_many: { type: "integer", description: "How many messages to return, 10 to 150. Default 60." },
      },
      required: ["query", "user_id", "this_channel_only", "skip_recent_days", "from_date", "how_many"],
      additionalProperties: false,
    },
  },
  {
    name: "get_voice_profile",
    description: `Get the voice profiles of one or more people: a summary of how they talk (tone, message shape, humor, how they tease and take teasing, usual reactions, recurring themes), built from their messages across the whole log. Use it whenever you imitate, predict, or write as someone: capture their style, don't reuse its wording, and only bring up a recurring theme when the topic comes up. Only people with ${MIN_MESSAGES}+ messages have one.`,
    input_schema: {
      type: "object",
      properties: {
        user_ids: { type: "array", items: { type: "string" }, description: "User IDs from Known people." },
      },
      required: ["user_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "search_summaries",
    description:
      "Search the long-term memory: the daily, weekly and monthly summaries of every channel, kept forever. Good for older or broad questions (\"what were we arguing about in March?\", \"has anyone talked about Japan?\") and for finding when something happened before searching the exact messages.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Words that must all appear in the summary (any case). "" = the most recent summaries.' },
        this_channel_only: { type: "boolean" },
      },
      required: ["query", "this_channel_only"],
      additionalProperties: false,
    },
  },
  {
    name: "show_list",
    description:
      'Post an exact, numbered list. Use it whenever someone asks to see/list rules, facts, skills, everything, what was removed, what changed recently, or the details of one item ("what\'s #4?"). The bot posts the list itself; don\'t repeat it in your reply.',
    input_schema: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["everything", "rules", "facts", "skills", "removed", "changes", "one_item"] },
        id: { type: "integer", description: "For one_item: the item's number. Otherwise 0." },
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

const timeFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function names(ids) {
  return ids.map(personName).join(", ");
}

function shorten(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line describing an item, shared by the system prompt and the posted lists. */
export function describe(item, { maxText = Infinity } = {}) {
  const tags = [item.kind === "skill" ? `skill !${item.name}` : item.kind];
  if (item.kind === "rule") tags.push(item.people.length ? `for ${names(item.people)}` : "for everyone");
  if (item.kind === "fact" && item.people.length) tags.push(`about ${names(item.people)}`);
  if (item.kind === "skill" && item.recentMessages != null) tags.push(item.recentMessages === 0 ? "ignores recent chat" : `sees ${item.recentMessages} recent messages`);
  if (item.channel) tags.push(`only in #${item.channel.name}`);
  if (item.when) tags.push(`when: ${item.when}`);
  if (item.everyMessage) tags.push("chimes in on every message");
  else if (item.keywords.length) tags.push(`chimes in on: ${item.keywords.map((k) => `"${k}"`).join(", ")}`);
  if ((item.everyMessage || item.keywords.length) && item.respond === "react") tags.push("reacts only");
  if (item.expiresAt) tags.push(`${item.removed ? "ended" : "until"} ${timeFormat.format(new Date(item.expiresAt))}`);
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
  const now = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date());
  const lines = [`It is now ${now}.`, "", "Known people (use these IDs when saving rules and facts):"];
  for (const [id, { name }] of Object.entries(knownPeople())) {
    const marks = [];
    if (id === askerId) marks.push("the person talking to you right now");
    else if (conversation.has(id)) marks.push("in this conversation");
    lines.push(`- ${name} (ID ${id})${marks.length ? ` <- ${marks.join(", ")}` : ""}`);
  }

  const rules = activeItems("rule");
  // Chime-in rules are triggers the bot handles on its own for unsummoned messages, not reply behavior.
  const isChimeIn = (rule) => rule.everyMessage || rule.keywords.length > 0;
  const inEffect = rules.filter((rule) => !isChimeIn(rule) && ruleInScope(rule, askerId, channelId));
  const notInEffect = rules.filter((rule) => !inEffect.includes(rule));
  const facts = activeItems("fact");
  const skills = activeItems("skill");

  lines.push("", "Facts (things you know; use them whenever they're relevant):");
  lines.push(...(facts.length ? facts.map((item) => `- ${describe(item)}`) : ["- none yet"]));

  lines.push("", 'Skills (people run them with "!name input"; if someone asks for one in words instead, run it the same way):');
  lines.push(...(skills.length ? skills.map((item) => `- ${describe(item)}`) : ["- none yet"]));

  if (notInEffect.length) {
    lines.push(
      "",
      "Other rules (chime-in rules, which the bot runs separately on messages nobody summoned you for, and rules that don't apply here because of who's talking or which channel this is; listed only so you can edit or remove them):",
      ...notInEffect.map((item) => `- ${describe(item)}`),
    );
  }

  const asker = personName(askerId).toUpperCase();
  if (inEffect.length) {
    lines.push(
      "",
      `RULES IN EFFECT FOR ${asker} IN THIS CHANNEL (they set your personality, tone, and language on top of your normal voice; follow them fully, but only the ones whose "when" fits this message; if two conflict, the higher number wins):`,
      ...inEffect.map((item) => `- ${describe(item)}`),
    );
  } else {
    lines.push("", `No rules are in effect for ${asker} here; use your normal voice.`);
  }
  return lines.join("\n");
}

// ---------- the lists the bot posts itself ----------

/** One skill as it appears in !help and !skills: `!name` (number) - description. */
function skillLine(skill) {
  // Skills saved before descriptions existed fall back to the start of their prompt.
  const description = skill.description || shorten(skill.text.split(/(?<=[.!?])\s/)[0], 100);
  return `\`!${skill.name}\` (${skill.id}) - ${description}`;
}

function skillSection(items) {
  if (!items.length) return ["**Skills:** none"];
  return ["**Skills:**", ...items.map(skillLine)];
}

function section(title, items) {
  if (!items.length) return [`**${title}:** none`];
  return [`**${title}:**`, ...items.map((item) => describe(item, { maxText: 200 }))];
}

function describeChange(change) {
  const when = timeFormat.format(new Date(change.at));
  const who = change.action === "expire" ? "" : `${change.by?.name ?? "someone"} `;
  const item = change.after ?? change.item;
  const label = item.kind === "skill" ? `skill #${item.id} !${item.name}` : `${item.kind} #${item.id}`;
  const verb = { add: "added", edit: "edited", remove: "removed", restore: "restored", expire: "expired" }[change.action] ?? change.action;
  return `${when}: ${who}${verb} ${label}: ${shorten(item.text, 120)}`;
}

export function renderList(what, id) {
  switch (what) {
    case "rules":
      return section("Rules", activeItems("rule")).join("\n");
    case "facts":
      return section("Facts", activeItems("fact")).join("\n");
    case "skills":
      return skillSection(activeItems("skill")).join("\n");
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
      return [...section("Rules", activeItems("rule")), "", ...section("Facts", activeItems("fact")), "", ...skillSection(activeItems("skill"))].join("\n");
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
  const validDay = (day) => (/^\d{4}-\d{2}-\d{2}$/.test(day ?? "") ? day : null);
  // The lookup tools aren't strict (see above), so their arguments may be missing or the wrong type.
  const str = (value) => (typeof value === "string" ? value : value == null ? "" : String(value));
  const int = (value, fallback = 0) => (Number.isFinite(Number(value)) && value !== "" && value != null ? Math.trunc(Number(value)) : fallback);
  const expiry = (minutes) => (minutes > 0 ? new Date(Date.now() + minutes * 60000).toISOString() : null);
  let result;

  switch (block.name) {
    case "add_rule":
      result = addItem(
        {
          kind: "rule",
          text: input.text,
          people: input.people,
          channel: channel(input.this_channel_only),
          when: input.when,
          keywords: input.chime_in_keywords,
          everyMessage: input.chime_in_on_every_message,
          respond: input.chime_in_response,
          expiresAt: expiry(input.expires_in_minutes),
        },
        ctx.by,
      );
      break;
    case "add_fact":
      result = addItem({ kind: "fact", text: input.text, people: input.about }, ctx.by);
      break;
    case "add_skill":
      result = addItem({ kind: "skill", name: input.name, text: input.prompt, description: input.description, recentMessages: input.recent_messages }, ctx.by);
      break;
    case "edit_item": {
      const changes = {
        text: input.text,
        people: input.people,
        when: input.when,
        keywords: input.chime_in_keywords,
        everyMessage: input.chime_in_on_every_message,
        respond: input.chime_in_response,
        name: input.name,
        description: input.description,
        recentMessages: input.recent_messages,
      };
      if (input.this_channel_only != null) changes.channel = channel(input.this_channel_only);
      if (input.expires_in_minutes != null) changes.expiresAt = expiry(input.expires_in_minutes);
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
    case "search_chat_log": {
      const { total, lines } = searchLog({
        query: str(input.query),
        userId: str(input.user_id),
        channelId: input.this_channel_only ? ctx.channel.id : null,
        daysBack: int(input.days_back, 7),
        fromDay: validDay(input.from_date),
        toDay: validDay(input.to_date),
        sinceTs: int(input.minutes_back) > 0 ? Date.now() - int(input.minutes_back) * 60000 : null,
      });
      if (!total) return { error: false, text: "No matching messages.", changed: false };
      const note = total > lines.length ? `${total} matches; showing the ${lines.length} most recent:\n` : "";
      return { error: false, text: note + lines.join("\n"), changed: false };
    }
    case "sample_chat_log": {
      const { total, months, lines } = sampleLog({
        query: str(input.query),
        userId: str(input.user_id),
        channelId: input.this_channel_only ? ctx.channel.id : null,
        skipRecentDays: int(input.skip_recent_days),
        fromDay: validDay(input.from_date),
        limit: Math.min(Math.max(int(input.how_many, 60) || 60, 10), 150),
      });
      if (!total) return { error: false, text: `No matching messages. (The chat log starts ${firstLoggedDay() ?? "today"}.)`, changed: false };
      const note = `${total} matches (per month: ${months.join(", ")}); ${lines.length === total ? "all of them" : `${lines.length} spread across those months`}:\n`;
      return { error: false, text: note + lines.join("\n"), changed: false };
    }
    case "get_voice_profile": {
      const ids = (Array.isArray(input.user_ids) ? input.user_ids : [input.user_ids]).filter(Boolean).map(String);
      const texts = ids.map((id) => profileText(id) || `${personName(id)} (ID ${id}) has no voice profile (it needs ${MIN_MESSAGES}+ logged messages and someone running "!profiles build"); use sample_chat_log with their user_id instead.`);
      return { error: false, text: texts.join("\n\n") || "No user IDs given.", changed: false };
    }
    case "search_summaries": {
      const { total, texts } = searchSummaries({ query: str(input.query), channelId: input.this_channel_only ? ctx.channel.id : null });
      if (!total) return { error: false, text: `No matching summaries. (The chat log starts ${firstLoggedDay() ?? "today"}.)`, changed: false };
      const note = total > texts.length ? `${total} matches; showing the ${texts.length} most recent:\n\n` : "";
      return { error: false, text: note + texts.join("\n\n"), changed: false };
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
