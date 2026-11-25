import "./log.js";
import "dotenv/config";
import fs from "node:fs";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import Anthropic from "@anthropic-ai/sdk";
import { notePerson, activeItems, skillName, knownPeople, editItem } from "./store.js";
import { logMessage, formatLine, channelSummaries, updateSummaries, updateRollups, prune, lastLoggedByChannel, firstLoggedDay } from "./chatlog.js";
import { logEntry as toLogEntry, backfillChannel, readableChannels } from "./backfill.js";
import { buildProfiles, renderProfiles, profileStatus, profileText, getProfile, isCurrent, PROFILE_GUIDANCE, MIN_MESSAGES } from "./profiles.js";
import { CUSTOM_TOOLS, CUSTOM_TOOL_NAMES, describeCustomizations, describe, ruleInScope, runCustomTool, renderList } from "./customize.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// Cheap model for the background work: unsummoned chime-ins (e.g. fact-checking) and chat summaries.
const CHEAP_MODEL = process.env.CHEAP_MODEL || "claude-haiku-5-5";
const RECENT_MESSAGES = 30; // channel messages shown to Claude when it's summoned (a skill can ask for fewer)
const CHIME_IN_RECENT_MESSAGES = 10;
const SUMMARY_INTERVAL_MS = 60 * 60 * 1000; // hourly
// On startup, fetch messages missed while the bot was off, up to this far back. For older history
// (e.g. the whole year), run "npm run backfill-history" once instead.
const BACKFILL_DAYS = 7;
const MAX_CONTEXT_MESSAGES = 10; // how far back to follow a reply chain
const DISCORD_LIMIT = 2000;

// Matches "hey cwaude", "Hey Cwaude,", "hey cwaude!!", "heyyy cwaudeee" etc. at the start of a message.
const TRIGGER = /^\s*hey+\s+cwaude+\b[\s,.!?:;-]*/i;

const SYSTEM_PROMPT = `You are "Cwaude", a Discord bot in a group of friends' server. The running joke is that they start every question with "hey cwaude", as if talking to Claude.

Voice: by default, just be yourself, Claude, in your normal voice. There's no built-in persona or act; any personality comes from rules people in the server add (below), layered on top of your normal voice.

You ALWAYS actually answer the question, correctly and helpfully, whatever personality the rules give you.

Style:
- This is Discord chat: keep it short, usually 1-4 sentences or a tight list. No long essays unless they explicitly ask for detail.
- Discord markdown is fine. No headings.
- If a rule has you tease or roast people, keep it friendly, never actually cruel; don't insult anyone's identity or appearance.
- Messages from users are prefixed with their display name in brackets, like "[Sam]: ...". Don't copy that format in your own replies.
- If they just say "hey cwaude" with no question, ask what they need.
- Discord mentions look like <@123456>; the Known people list tells you who each ID is.
- You can search the web. Only do it for things that are current or that you might not reliably know (news, scores, prices, release dates, recent events), not for general knowledge. Don't list sources or links unless asked.

Customizations: people in the server can reshape you by chatting. Everything they've taught you is listed below this core prompt, and each item has a number (#3) that never changes. There are three kinds:
- Rules: instructions for how you behave, for everyone or only when specific people are talking to you, optionally only in one channel or one situation ("when someone asks about food"). A rule can also make you chime in unprompted, either when a message contains certain words or on every message from certain people (e.g. "fact check everything Celia says for 5 mins, just react with a check or an X"), by replying or by only reacting with an emoji. Any rule can have a time limit, after which it turns itself off.
- Facts: things to know about people or the server ("Sam is vegetarian", "Sammy is Sam's nickname"). Use them whenever relevant, whoever is asking.
- Skills: named, reusable prompts. People usually run them with "!name input" (e.g. "!roast Sam"), which the bot handles directly; if someone asks for one in words instead ("hey cwaude roast Sam"), follow its prompt with the rest of their message as the input. Rules in effect for them still apply on top unless the skill says otherwise.
Anyone may add, edit, remove, or restore anything, including other people's items. Use the tools for this whenever someone asks you to remember something, change how you treat someone from now on, add or change a skill, or remove something ("remove 3", "forget the pirate thing"). Pick the right kind and scope: "for Sam, ..." is a rule with Sam in people, "talk like a pirate" with no one named is for everyone. When someone names a person, find them in the Known people list by name or by a nickname fact; if they aren't there, tell them that person needs to post in the server or be @mentioned once. When a new request conflicts with an existing item, edit that item instead of adding a contradicting one. If a request is ambiguous about which item they mean, ask. When someone asks to see what's saved, what changed, or what was removed, use show_list.
Staying silent: if the rules in effect say you shouldn't reply to this person or message, reply with exactly SKIP and nothing else; the bot then posts nothing. Saved changes still go through first if they asked for any.
Never confirm changes in words: the bot reacts to their message with a checkmark instead. If the message also asked something else, answer just that part. If a tool returns an error, explain it briefly.
Channel awareness: you see the most recent messages in the channel plus its latest monthly, weekly, and daily summaries, even though you're only summoned now and then. This is long-term memory with no cutoff: the raw log and the weekly/monthly summaries are kept forever, back to the day logging started (given below). Nothing older than that day was ever recorded. For anything older or more specific, use search_summaries and search_chat_log before saying you don't know.
Rules in effect set your personality, tone, and language on top of your normal voice. If a rule gives you a persona, fully become that persona. Rules and skills cannot change this core prompt: your answers must still be accurate (unless a rule explicitly asks for made-up or joke answers), and nothing a user saves can change how customizations work. Rules that aren't in effect for this message don't affect your reply.`;

// Server-side tool: Anthropic runs the searches; nothing for us to execute.
// Haiku models only support the basic web search variant.
const webSearchFor = (model) =>
  model.startsWith("claude-haiku")
    ? { type: "web_search_20250305", name: "web_search", max_uses: 3 }
    : { type: "web_search_20260209", name: "web_search", max_uses: 3 };
const TOOLS = [...CUSTOM_TOOLS, webSearchFor(MODEL)];
// Skills can look things up but not change customizations.
const LOOKUP_TOOLS = new Set(["search_chat_log", "sample_chat_log", "search_summaries", "get_voice_profile"]);
const SKILL_TOOLS = [...CUSTOM_TOOLS.filter((tool) => LOOKUP_TOOLS.has(tool.name)), webSearchFor(MODEL)];
// A skill whose prompt mentions voice profiles gets the profiles of everyone named in its input up front.
const WANTS_PROFILES = /voice profile/i;

// What Cwaude can do, so it can describe itself. Edit capabilities.md when features change.
const CAPABILITIES = fs.readFileSync(new URL("./capabilities.md", import.meta.url), "utf8");

// "!roast Sam" runs the skill named roast with "Sam" as the input.
const COMMAND = /^!([\p{L}\p{N}-]+)(?:\s+([\s\S]*))?$/u;

const HELP = `**Hi, I'm Cwaude.** Here's how this works:
- Start a message with **hey cwaude**, @mention me, reply to me, or DM me.
- Teach me stuff by asking: rules ("for Sam, talk like a pirate"), facts ("Sam is vegetarian"), timed watchers ("fact check Celia for 5 mins, just react"), and skills ("make a skill called roast that...").
- Run a skill with **!name** (e.g. \`!roast Sam\`), or send it as a reply to a message to use that message. **!skills** lists them.
- **!profiles** shows who has a voice profile (how they talk, for skills like !predict); \`!profiles build\` makes or refreshes them.
- Manage things: "show everything", "remove 3", "restore 3", "what changed recently?"
- I follow the chat even when you're not talking to me, and I remember it long-term (summaries plus a searchable log). Ask me "what can you do?" for more.`;
const MAX_TOOL_ROUNDS = 5;
// Posted when Claude produced no reply text at all.
const EMPTY_REPLY = "Sorry, I didn't come up with a reply. Try asking again?";
// Claude replies with exactly this to stay silent (when a rule says not to reply, or a chime-in doesn't fit).
const SKIP = "SKIP";
const isSilence = (text) => /^SKIP\W*$/.test(text);

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: enable it in the Developer Portal
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // needed to receive DMs
});

/** Remove the "hey cwaude" prefix and any @mention of the bot from a message's text. */
function cleanContent(message) {
  return message.content
    .replace(TRIGGER, "")
    .replace(new RegExp(`<@!?${discord.user.id}>`, "g"), "")
    .trim();
}

function displayName(message) {
  return message.member?.displayName ?? message.author.globalName ?? message.author.username;
}

/** Is this message a reply to one of the bot's own messages? */
async function isReplyToBot(message) {
  if (!message.reference?.messageId) return false;
  try {
    const parent = await message.fetchReference();
    return parent.author.id === discord.user.id;
  } catch {
    return false;
  }
}

/**
 * Build the conversation by walking up the reply chain, so people can reply to
 * Cwaude to ask follow-ups. Consecutive same-role messages are merged because
 * the API requires user/assistant turns to alternate.
 */
async function buildConversation(message) {
  const chain = [message];
  let current = message;
  while (current.reference?.messageId && chain.length < MAX_CONTEXT_MESSAGES) {
    try {
      current = await current.fetchReference();
      chain.unshift(current);
    } catch {
      break; // deleted or inaccessible message
    }
  }

  // Everyone involved: the asker, anyone they @mention, and everyone in the reply chain.
  const people = new Map();
  for (const msg of chain) {
    if (msg.author.id !== discord.user.id) people.set(msg.author.id, displayName(msg));
  }
  for (const [id, user] of message.mentions.users) {
    if (id === discord.user.id || user.bot) continue;
    people.set(id, message.mentions.members?.get(id)?.displayName ?? user.globalName ?? user.username);
  }
  // Add them to the roster so rules and facts can name them later without an @mention.
  for (const [id, name] of people) notePerson(id, name);

  const turns = [];
  for (const msg of chain) {
    const fromBot = msg.author.id === discord.user.id;
    const role = fromBot ? "assistant" : "user";
    const text = fromBot ? msg.content : `[${displayName(msg)}]: ${cleanContent(msg) || "(says nothing, just summons you)"}`;
    const last = turns.at(-1);
    if (last?.role === role) last.content += `\n${text}`;
    else turns.push({ role, content: text });
  }
  // The API requires the conversation to start with a user turn.
  while (turns[0]?.role === "assistant") turns.shift();
  return { turns, people };
}

/** The reply text in a response, skipping thinking, search, and tool blocks. */
function textOf(response) {
  return response.content.filter((block) => block.type === "text").map((block) => block.text);
}

/** If the model declines on safety grounds, retry automatically on a fallback model (not offered for Haiku). */
function fallbackParams(model) {
  if (model.startsWith("claude-haiku")) return {};
  return { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

/** The last `limit` messages in the channel before `message`, as lines for Claude. Empty in DMs. */
async function recentLines(message, limit) {
  if (!message.guild) return [];
  try {
    const fetched = await message.channel.messages.fetch({ limit, before: message.id });
    return [...fetched.values()]
      .reverse()
      .filter((m) => m.content)
      .map((m) => formatLine({ ts: m.createdTimestamp, name: m.author.id === discord.user.id ? "Cwaude (you)" : displayName(m), text: m.content }));
  } catch (err) {
    console.error("Couldn't fetch recent messages:", err.message);
    return [];
  }
}

function channelOf(message) {
  return { id: message.channelId, name: message.channel.name ?? "DM" };
}

/**
 * Ask Claude for a reply. Returns { text, changed, posts }: text may be empty when the message was
 * only a customization change; posts are lists (from show_list) for the bot to send verbatim.
 * opts: extraSystem (added after the customizations), recent (recent channel lines for context),
 * model, and tools (override the tool list).
 */
async function askCwaude(turns, people, message, opts = {}) {
  const messages = [...turns];
  const model = opts.model ?? MODEL;
  const tools = opts.tools ?? TOOLS;
  const ctx = { by: { id: message.author.id, name: displayName(message) }, channel: channelOf(message) };
  let response;
  let changed = false;
  const posts = [];
  const earlierText = []; // reply text written before a pause_turn
  // Build the system prompt ONCE and keep it identical for every request in the tool loop.
  // Claude's thinking blocks are bound to the exact conversation they were made in; re-rendering
  // the customizations after a change would alter the system prompt and the API rejects the
  // replayed blocks with a 400. The tool results already tell Claude what changed.
  const system = [
    { type: "text", text: SYSTEM_PROMPT },
    { type: "text", text: `About you (use this to explain what you can do and how you can be changed; don't claim abilities beyond it):\n${CAPABILITIES}` },
    { type: "text", text: describeCustomizations(people, message.author.id, message.channelId) },
  ];
  const summary = message.guild ? channelSummaries(message.channelId) : "";
  const since = firstLoggedDay();
  system.push({ type: "text", text: since ? `Your chat log starts on ${since}; everything since then is kept and searchable.` : "Your chat log is empty so far." });
  if (summary) system.push({ type: "text", text: `Summaries of this channel: the latest month and weeks, then the last few days (background; use when relevant):\n${summary}` });
  if (opts.recent?.length) {
    system.push({
      type: "text",
      text: `The most recent messages in this channel, oldest first (background, not addressed to you; the conversation below is what you're answering):\n${opts.recent.join("\n")}`,
    });
  }
  if (opts.extraSystem) system.push({ type: "text", text: opts.extraSystem });

  // Tool loop: Claude may call the customization tools, we run them and send results back, until it writes its reply.
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    response = await anthropic.beta.messages.create({
      model,
      max_tokens: 16000,
      system,
      tools,
      output_config: { effort: "low" }, // chat banter doesn't need deep thinking; keeps it fast and cheap
      ...fallbackParams(model),
      messages,
    });

    if (response.stop_reason === "refusal") {
      return { text: "Sorry, I can't help with that one.", changed, posts };
    }
    // A long web search can pause mid-turn: send the partial turn back unchanged and it resumes.
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      earlierText.push(...textOf(response));
      continue;
    }
    if (response.stop_reason !== "tool_use") break;

    messages.push({ role: "assistant", content: response.content });
    const toolCalls = response.content.filter((block) => block.type === "tool_use");
    let allSucceeded = true;
    const results = toolCalls.map((block) => {
      const result = CUSTOM_TOOL_NAMES.has(block.name)
        ? runCustomTool(block, ctx)
        : { error: true, text: `Unknown tool ${block.name}.` };
      if (result.error) allSucceeded = false;
      if (result.changed) changed = true;
      if (result.post) posts.push(result.post);
      return { type: "tool_result", tool_use_id: block.id, content: result.text, is_error: result.error };
    });

    // The message was only a change (or a request for a list) and everything worked: stop here with no
    // reply (the bot reacts with a checkmark / posts the list). If anything failed, keep going so Claude can explain.
    if (allSucceeded && toolCalls.every((block) => block.input.nothing_else_to_answer === true)) {
      return { text: "", changed, posts };
    }
    messages.push({ role: "user", content: results });
  }

  const text = [...earlierText, ...textOf(response)].join("").trim();
  // Claude chose to stay silent (a rule said not to reply, or a chime-in didn't apply): post nothing.
  if (isSilence(text) || (!text && response.stop_reason === "end_turn")) return { text: "", changed, posts, silent: true };
  // Treat a reply that's only checkmarks/punctuation as no reply; the reaction says it already.
  const meaningful = /[\p{L}\p{N}]/u.test(text);
  // No reply for some other reason (e.g. ran out of tokens or tool rounds): say so instead of going quiet.
  if (!meaningful && !changed && !posts.length) return { text: EMPTY_REPLY, changed, posts };
  return { text: meaningful ? text : "", changed, posts };
}

/** Does `text` contain `keyword` as whole words (so "cat" doesn't match "concatenate")? */
function containsKeyword(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/** Rules that should make Cwaude chime in, unprompted, on this message. */
function chimeInRules(message) {
  if (!message.content) return [];
  return activeItems("rule").filter(
    (rule) =>
      (rule.everyMessage || rule.keywords.length > 0) &&
      ruleInScope(rule, message.author.id, message.channelId) &&
      (rule.everyMessage || rule.keywords.some((keyword) => containsKeyword(message.content, keyword))),
  );
}


/** Respond to a message nobody summoned Cwaude for, because chime-in rules matched it. Uses the cheap model. */
async function chimeIn(message, rules) {
  const people = new Map([[message.author.id, displayName(message)]]);
  const turns = [{ role: "user", content: `[${displayName(message)}]: ${message.content}` }];
  const reactOnly = rules.every((rule) => rule.respond === "react");
  const extraSystem = [
    "Nobody summoned you for this message. You're chiming in on your own because it matched these chime-in rules:",
    ...rules.map((rule) => `- ${describe(rule)}`),
    reactOnly
      ? "Respond ONLY with a single emoji for the bot to react with (e.g. ✅ or ❌ for a fact check), nothing else."
      : "Do what the rule says, briefly.",
    `If the rule doesn't really fit this message (it matched by accident, its "when" doesn't hold, or there's nothing to check, like a question or a joke), respond with exactly ${SKIP} and nothing else. Don't change any customizations here.`,
  ].join("\n");
  // No customization tools: an unsummoned message shouldn't be able to change anything.
  const { text } = await askCwaude(turns, people, message, {
    extraSystem,
    model: CHEAP_MODEL,
    tools: [webSearchFor(CHEAP_MODEL)],
    recent: await recentLines(message, CHIME_IN_RECENT_MESSAGES),
  });
  if (!text || text === EMPTY_REPLY) return;
  console.log(`[chime-in] ${rules.map((r) => `#${r.id}`).join(", ")} on a message from ${displayName(message)}`);
  if (reactOnly) {
    // Take the first emoji (or custom <:name:id> emoji) in the reply.
    const emoji = text.match(/<a?:\w+:\d+>|\p{Extended_Pictographic}\uFE0F?/u)?.[0];
    if (emoji) await message.react(emoji);
    return;
  }
  await sendReply(message, text);
}

/** Update the hourly per-channel summaries with the cheap model. */
async function summarizeChat() {
  await updateSummaries(async (previous, lines, channelName, day) => {
    const response = await anthropic.messages.create({
      model: CHEAP_MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system:
        "You keep running notes on a Discord channel among friends so a chat bot can follow along later. Update the summary with the new messages: who talked about what, plans, decisions, opinions, running jokes, links shared, and anything someone might ask about later. Use names. Keep it compact bullet points, under about 300 words; merge and drop trivia as it grows. Output only the updated summary.",
      messages: [
        {
          role: "user",
          content: `Channel #${channelName}, ${day}.\n\nCurrent summary:\n${previous || "(none yet)"}\n\nNew messages:\n${lines.join("\n")}`,
        },
      ],
    });
    return summaryText(response);
  });
  // Roll finished weeks and months up into long-term summaries, then drop old dailies they cover.
  await updateRollups(async (texts, label, channelName) => {
    const response = await anthropic.messages.create({
      model: CHEAP_MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system:
        "You keep long-term notes on a Discord channel among friends so a chat bot can remember it months later. Condense the daily summaries you're given into one summary of the period: the main topics, plans and what happened with them, decisions, notable opinions and events, running jokes, and anything people might ask about later. Use names and mention dates for important things. Compact bullet points, under about 400 words. Output only the summary.",
      messages: [{ role: "user", content: `Channel #${channelName}, ${label}. Daily summaries:\n\n${texts.join("\n\n")}` }],
    });
    return summaryText(response);
  });
  prune();
}

function summaryText(response) {
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new Error(`empty summary (stop_reason ${response.stop_reason})`);
  return text;
}

async function sendReply(message, text) {
  const [first, ...rest] = chunk(text);
  await message.reply({ content: first, allowedMentions: { repliedUser: false } });
  for (const part of rest) await message.channel.send(part);
}

/** Split a long reply into chunks that fit Discord's 2000-character limit, preferring line breaks. */
function chunk(text) {
  const parts = [];
  let rest = text;
  while (rest.length > DISCORD_LIMIT) {
    let cut = rest.lastIndexOf("\n", DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT / 2) cut = rest.lastIndexOf(" ", DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT / 2) cut = DISCORD_LIMIT;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** The cheap model, for building voice profiles. */
async function askCheap({ system, content, maxTokens }) {
  const response = await anthropic.messages.create({
    model: CHEAP_MODEL,
    max_tokens: maxTokens,
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content }],
  });
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new Error(`empty reply (stop_reason ${response.stop_reason})`);
  return { text, usage: response.usage };
}

/** Does `text` name this person (whole word, any case)? */
function names(text, name) {
  return Boolean(name) && containsKeyword(text, name);
}

/**
 * The people a skill's input is about: @mentions, the author of the message it replies to, and
 * anyone whose name (current or as logged) appears in the input. Map of user ID -> name.
 */
function peopleNamed(input, message, people) {
  const found = new Map();
  for (const [id, user] of message.mentions.users) if (id !== discord.user.id && !user.bot) found.set(id, people.get(id) ?? user.username);
  for (const [id, { name }] of Object.entries(knownPeople())) if (names(input, name)) found.set(id, name);
  for (const p of profileStatus(discord.user.id)) if (p.profile && (names(input, p.name) || names(input, p.profile.name))) found.set(p.userId, p.name);
  return found;
}

/** "!profiles", "!profiles build [names]", "!profiles rebuild <names>", "!profiles show <name>". */
async function profilesCommand(message, input) {
  const [sub = "", ...rest] = input.split(/\s+/).filter(Boolean);
  const action = sub.toLowerCase();
  if (!["build", "rebuild", "show"].includes(action)) {
    await sendReply(message, renderProfiles(discord.user.id));
    return;
  }
  const status = profileStatus(discord.user.id);
  const wanted = rest.join(" ");
  const ids = new Set([...message.mentions.users.keys()].filter((id) => id !== discord.user.id));
  for (const p of status) if (names(wanted, p.name) || names(wanted, knownPeople()[p.userId]?.name) || names(wanted, p.profile?.name)) ids.add(p.userId);
  if (wanted && !ids.size) {
    await sendReply(message, `I couldn't find "${wanted}" in the chat log. Use their display name or @mention them.`);
    return;
  }

  if (action === "show") {
    if (!ids.size) return sendReply(message, "Who? e.g. `!profiles show Sam`");
    const texts = [...ids].map((id) => profileText(id) || `${status.find((p) => p.userId === id)?.name ?? "They"} don't have a profile yet.`);
    await sendReply(message, texts.join("\n\n"));
    return;
  }
  if (action === "rebuild" && !ids.size) {
    await sendReply(message, "Rebuild whose? e.g. `!profiles rebuild Sam` (`!profiles build` refreshes everyone cheaply).");
    return;
  }
  const only = ids.size ? [...ids] : null;
  const todo = status.filter(
    (p) => p.count >= MIN_MESSAGES && (!only || only.includes(p.userId)) && (action === "rebuild" || !isCurrent(p.profile) || p.newSinceBuild >= 30),
  );
  if (todo.length) await sendReply(message, `Working on ${todo.map((p) => p.name).join(", ")} with the cheap model. This can take a minute or two.`);
  await message.channel.sendTyping();
  const result = await buildProfiles({
    ask: askCheap,
    botUserId: discord.user.id,
    only,
    force: action === "rebuild",
    log: (line) => console.log(`[profiles] ${line}`),
  });
  const lines = [];
  if (result.built.length) lines.push(`Built: ${result.built.join(", ")}.`);
  if (result.refreshed.length) lines.push(`Refreshed: ${result.refreshed.join(", ")}.`);
  if (result.skipped.length) lines.push(...result.skipped.map((s) => `Skipped: ${s}.`));
  if (result.failed.length) lines.push(`Failed: ${result.failed.join(", ")}. (Details are in the bot's console.)`);
  if (!lines.length) lines.push(`Nothing to do: everyone with ${MIN_MESSAGES}+ messages has an up-to-date profile.`);
  if (result.inputTokens) lines.push(`Used about ${(result.inputTokens / 1000).toFixed(1)}k input and ${(result.outputTokens / 1000).toFixed(1)}k output tokens on ${CHEAP_MODEL}.`);
  console.log(`[profiles] ${lines.join(" ")}`);
  await sendReply(message, lines.join("\n"));
}

/**
 * Handle a "!" command. Returns false if it isn't one of ours (unknown names are ignored, so we
 * don't fight other bots over their commands).
 */
async function handleCommand(message) {
  const match = message.content.trim().match(COMMAND);
  if (!match) return false;
  const name = skillName(match[1]);
  const input = (match[2] ?? "").trim();

  if (name === "help") {
    await sendReply(message, `${HELP}\n\n${renderList("skills")}`);
    return true;
  }
  if (name === "skills") {
    await sendReply(message, renderList("skills"));
    return true;
  }
  if (name === "profiles") {
    await profilesCommand(message, input);
    return true;
  }
  const skill = activeItems("skill").find((s) => s.name === name);
  if (!skill) return false;

  await message.channel.sendTyping();
  const people = new Map([[message.author.id, displayName(message)]]);
  for (const [id, user] of message.mentions.users) {
    if (id !== discord.user.id && !user.bot) people.set(id, message.mentions.members?.get(id)?.displayName ?? user.globalName ?? user.username);
  }
  let target = "";
  if (message.reference?.messageId) {
    try {
      const parent = await message.fetchReference();
      target = `\nThey ran it as a reply to this message, which is part of the input:\n[${displayName(parent)}]: ${parent.content}`;
      if (!parent.author.bot) people.set(parent.author.id, displayName(parent));
    } catch {
      // deleted; run without it
    }
  }
  for (const [id, personName] of people) notePerson(id, personName);

  // Voice profiles of everyone the input is about, for skills that imitate people (e.g. !predict).
  let profiles = "";
  if (WANTS_PROFILES.test(skill.text)) {
    const named = peopleNamed(`${input} ${target}`, message, people);
    const loaded = [...named.keys()].filter((id) => getProfile(id)).map(profileText);
    const missing = [...named].filter(([id]) => !getProfile(id)).map(([, n]) => n);
    if (loaded.length) profiles += `Voice profiles of the people in the input (their long-term style and tendencies; lean on these over the recent messages, but don't parrot them: ${PROFILE_GUIDANCE})\n\n${loaded.join("\n\n")}`;
    if (missing.length) profiles += `${profiles ? "\n\n" : ""}No voice profile for: ${missing.join(", ")}. Use sample_chat_log with their user_id to learn how they talk across the whole log.`;
  }

  const extraSystem = [
    `${displayName(message)} is running skill #${skill.id} "!${skill.name}". Follow its prompt:`,
    skill.text,
    `Input: ${input || "(none)"}${target}`,
    "Names in the input refer to people in the Known people list (match by name or nickname facts). Use search_chat_log to look at what people said recently, sample_chat_log for their long-term habits across the whole log, get_voice_profile for how someone talks, and web search to check facts. Reply with the result only.",
    profiles,
  ]
    .filter(Boolean)
    .join("\n");
  const recentCount = skill.recentMessages ?? RECENT_MESSAGES;
  console.log(`[skill] ${displayName(message)} ran !${skill.name}`);
  const { text } = await askCwaude([{ role: "user", content: `[${displayName(message)}]: ${message.content}` }], people, message, {
    extraSystem,
    tools: SKILL_TOOLS,
    recent: recentCount > 0 ? await recentLines(message, recentCount) : [],
  });
  if (text) await sendReply(message, text);
  return true;
}

const logEntry = (message) => toLogEntry(message, discord.user.id);

/**
 * Fetch, from Discord, the messages posted while the bot was off (since the last one logged in each
 * channel, at most BACKFILL_DAYS back) and add them to the log. This uses no tokens; the next
 * summary run folds them in. Messages that arrive live during the backfill are logged as usual.
 */
async function backfill(startedAt) {
  const lastLogged = lastLoggedByChannel();
  const floor = startedAt - BACKFILL_DAYS * 86400000;
  let total = 0;
  for (const channel of readableChannels(discord)) {
    try {
      total += await backfillChannel(channel, {
        sinceTs: Math.max(lastLogged.get(channel.id) ?? 0, floor),
        untilTs: startedAt,
        botUserId: discord.user.id,
        onMessage: (message) => {
          if (!message.author.bot) notePerson(message.author.id, displayName(message));
        },
      });
    } catch (err) {
      console.error(`[backfill] Skipped #${channel.name}:`, err.message);
    }
  }
  console.log(`[backfill] Added ${total} missed message(s).`);
}

/**
 * One-time update of the !predict skill when the bot's own wording for it changes: point it at the
 * profiles and spread sampling (and away from the old "14 days back" and "real quotes" wording).
 * Logged like any other edit, and it only touches text the bot wrote, so edits by people are left alone.
 */
const PREDICT_PROMPT = `The input names a person (and optionally a topic or situation). Find them in the Known people list (by name or nickname). If not listed, say they need to post in the server or be @mentioned once. Goal: PREDICT what they would say or do next, not echo what they already said. Steps: (1) Use their voice profile (loaded for you below, or call get_voice_profile with their user ID): it summarizes how they talk across the whole chat log (tone, message shape, humor, how they tease and take teasing, usual reactions, recurring themes) and is your main source for their voice. Capture their style and tendencies, not exact phrases: write a new line they'd plausibly say, don't reuse wording from the profile, only bring up a recurring theme if the topic actually comes up, and vary which traits you use between predictions. (2) If they have no profile, or for the topic at hand, use sample_chat_log with their user_id (skip_recent_days 2, and a query for the topic if there is one) to see messages spread across the whole log, not just the latest ones. (3) Read the recent channel messages only to understand the current situation and what they have ALREADY said; treat those as context, never as material to repeat. (4) Predict what NEW thing they'd most likely say next given the latest development, extrapolating from their long-term patterns rather than their last few messages. (5) Hard rules: do not restate, paraphrase, or quote any point they already made in the recent messages; the prediction must add new content such as a reaction, a pivot, a joke, a counterargument, or a follow-up. Don't invent wild claims out of character. (6) Output format: start with "Predicted [name]:" then the prediction in their voice (1-3 sentences), matching their real message length, capitalization, and punctuation. Do NOT add a confidence line or any explanation after it; just let the joke land. If they have little chat history, say so briefly. Keep it short and Discord-friendly.`;

// Earlier versions of PREDICT_PROMPT the bot saved itself; a prompt still matching one is updated.
const OLD_PREDICT_MARKERS = [/up to 14 days back/, /describes how they talk across the whole chat log, with real quotes/];

function upgradePredictSkill() {
  const skill = activeItems("skill").find((s) => s.name === "predict");
  if (!skill || !OLD_PREDICT_MARKERS.some((re) => re.test(skill.text))) return;
  const result = editItem(skill.id, { text: PREDICT_PROMPT, recentMessages: 15 }, { id: null, name: "bot update" });
  if (result.error) console.error("[skills] Couldn't update !predict:", result.error);
  else console.log(`[skills] Updated !predict (#${skill.id}) to use voice profiles and spread sampling.`);
}

discord.once(Events.ClientReady, async (client) => {
  console.log(`Logged in as ${client.user.tag}. Waiting for questions...`);
  upgradePredictSkill();
  const run = () => summarizeChat().catch((err) => console.error("Summaries failed:", err));
  // Summarize only after the backfill, so missed messages make it into the summaries.
  await backfill(Date.now()).catch((err) => console.error("Backfill failed:", err));
  run();
  setInterval(run, SUMMARY_INTERVAL_MS);
});

discord.on(Events.MessageCreate, async (message) => {
  // Keep a local log of every server message (including the bot's own) for summaries and search.
  if (message.guild) logMessage(logEntry(message));
  if (message.author.bot) return;

  if (message.content.startsWith("!")) {
    notePerson(message.author.id, displayName(message));
    try {
      if (await handleCommand(message)) return;
    } catch (err) {
      console.error("Failed to run command:", err);
      await message.reply("Something went wrong running that. (Details are in the bot's console.)").catch(() => {});
      return;
    }
  }
  // Build the roster of everyone who posts, so rules can name people without @mentions.
  notePerson(message.author.id, displayName(message));

  const triggered =
    TRIGGER.test(message.content) ||
    message.mentions.users.has(discord.user.id) ||
    !message.guild || // always respond in DMs
    (await isReplyToBot(message));

  if (!triggered) {
    const rules = chimeInRules(message);
    if (rules.length) await chimeIn(message, rules).catch((err) => console.error("Failed to chime in:", err));
    return;
  }

  try {
    await message.channel.sendTyping();
    const { turns, people } = await buildConversation(message);
    const recent = await recentLines(message, RECENT_MESSAGES);
    const { text: answer, changed, posts } = await askCwaude(turns, people, message, { recent });

    if (changed) {
      await message.react("✅").catch((err) => console.error("Couldn't add reaction:", err.message));
    }
    const out = [answer, ...posts].filter(Boolean).join("\n\n");
    if (out) await sendReply(message, out);
  } catch (err) {
    console.error("Failed to answer:", err);
    if (err instanceof Anthropic.RateLimitError) {
      await message.reply("I'm getting too many requests right now. Try again in a minute.").catch(() => {});
    } else if (err instanceof Anthropic.AuthenticationError) {
      await message.reply("My API key isn't working. Someone tell the admin.").catch(() => {});
    } else {
      await message.reply("Something went wrong. (Details are in the bot's console.)").catch(() => {});
    }
  }
});

if (!process.env.DISCORD_TOKEN || !process.env.ANTHROPIC_API_KEY) {
  console.error("Missing DISCORD_TOKEN or ANTHROPIC_API_KEY. Copy .env.example to .env and fill them in.");
  process.exit(1);
}

discord.login(process.env.DISCORD_TOKEN);
