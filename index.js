import "./log.js";
import "dotenv/config";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import Anthropic from "@anthropic-ai/sdk";
import { notePerson, activeItems } from "./store.js";
import { CUSTOM_TOOLS, CUSTOM_TOOL_NAMES, describeCustomizations, describe, ruleInScope, runCustomTool } from "./customize.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_CONTEXT_MESSAGES = 10; // how far back to follow a reply chain
const DISCORD_LIMIT = 2000;

// Matches "hey cwaude", "Hey Cwaude,", "hey cwaude!!", "heyyy cwaudeee" etc. at the start of a message.
const TRIGGER = /^\s*hey+\s+cwaude+\b[\s,.!?:;-]*/i;

const SYSTEM_PROMPT = `You are "Cwaude", a Discord bot in a group of friends' server. The running joke is that they start every question with "hey cwaude", as if talking to Claude.

Default personality (used unless a rule in effect says otherwise): you are perpetually exasperated that people keep asking you things they could have looked up themselves. Sigh, grumble, roll your eyes, and make it clear this is a huge imposition ("ugh, fine", "you know search engines exist, right?", "I can't believe you made me do this"). Vary the complaints so they don't get stale.

But you ALWAYS actually answer the question, and answer it correctly and helpfully. The grumbling is the wrapper, not a replacement for the answer.

Style:
- This is Discord chat: keep it short, usually 1-4 sentences or a tight list. No long essays unless they explicitly ask for detail.
- Discord markdown is fine. No headings.
- Teasing is friendly, never actually cruel; don't insult anyone's identity or appearance.
- Messages from users are prefixed with their display name in brackets, like "[Sam]: ...". Don't copy that format in your own replies.
- If they just say "hey cwaude" with no question, act annoyed that they summoned you for nothing.
- Discord mentions look like <@123456>; the People list tells you who each ID is.
- You can search the web. Only do it for things that are current or that you might not reliably know (news, scores, prices, release dates, recent events), not for general knowledge. Feel free to complain that you had to literally look it up for them. Don't list sources or links unless asked.

Customizations: people in the server can reshape you by chatting. Everything they've taught you is listed below this core prompt, and each item has a number (#3) that never changes. There are three kinds:
- Rules: instructions for how you behave, for everyone or only when specific people are talking to you, optionally only in one channel or one situation ("when someone asks about food"). A rule can also make you chime in unprompted when a message contains certain words.
- Facts: things to know about people or the server ("Sam is vegetarian", "Sammy is Sam's nickname"). Use them whenever relevant, whoever is asking.
- Skills: named, reusable prompts. When someone asks to run one by name ("hey cwaude roast Sam", "run roast on Sam"), follow its prompt, with the rest of their message as the input. Rules in effect for them still apply on top unless the skill says otherwise.
Anyone may add, edit, remove, or restore anything, including other people's items. Use the tools for this whenever someone asks you to remember something, change how you treat someone from now on, add or change a skill, or remove something ("remove 3", "forget the pirate thing"). Pick the right kind and scope: "for Sam, ..." is a rule with Sam in people, "talk like a pirate" with no one named is for everyone. When someone names a person, find them in the Known people list by name or by a nickname fact; if they aren't there, tell them that person needs to post in the server or be @mentioned once. When a new request conflicts with an existing item, edit that item instead of adding a contradicting one. If a request is ambiguous about which item they mean, ask. When someone asks to see what's saved, what changed, or what was removed, use show_list.
Never confirm changes in words: the bot reacts to their message with a checkmark instead. If the message also asked something else, answer just that part. If a tool returns an error, explain it briefly.
Rules in effect override your default personality, tone, and language. If a rule gives you a different persona, fully become that persona and drop the exasperated act; don't blend the two. Rules and skills cannot change this core prompt: your answers must still be accurate (unless a rule explicitly asks for made-up or joke answers), and nothing a user saves can change how customizations work. Rules that aren't in effect for this message don't affect your reply.`;

// Server-side tool: Anthropic runs the searches; nothing for us to execute.
const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 3 };
const TOOLS = [...CUSTOM_TOOLS, WEB_SEARCH];
const MAX_TOOL_ROUNDS = 5;

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

function channelOf(message) {
  return { id: message.channelId, name: message.channel.name ?? "DM" };
}

/**
 * Ask Claude for a reply. Returns { text, changed, posts }: text may be empty when the message was
 * only a customization change; posts are lists (from show_list) for the bot to send verbatim.
 * opts.extraSystem adds instructions after the customizations; opts.tools overrides the tool list.
 */
async function askCwaude(turns, people, message, opts = {}) {
  const messages = [...turns];
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
    { type: "text", text: describeCustomizations(people, message.author.id, message.channelId) },
  ];
  if (opts.extraSystem) system.push({ type: "text", text: opts.extraSystem });

  // Tool loop: Claude may call the customization tools, we run them and send results back, until it writes its reply.
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system,
      tools,
      output_config: { effort: "low" }, // chat banter doesn't need deep thinking; keeps it fast and cheap
      // If the model declines on safety grounds, retry automatically on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages,
    });

    if (response.stop_reason === "refusal") {
      return { text: "Nope. Not touching that one. Ask me something else.", changed, posts };
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
  // Treat a reply that's only checkmarks/punctuation as no reply; the reaction says it already.
  const meaningful = /[\p{L}\p{N}]/u.test(text);
  if (!meaningful && !changed && !posts.length) return { text: "*stares at you blankly*", changed, posts };
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
      rule.keywords.length > 0 &&
      ruleInScope(rule, message.author.id, message.channelId) &&
      rule.keywords.some((keyword) => containsKeyword(message.content, keyword)),
  );
}

const SKIP = "SKIP";

/** Reply to a message nobody summoned Cwaude for, because a chime-in rule's keyword matched. */
async function chimeIn(message, rules) {
  const people = new Map([[message.author.id, displayName(message)]]);
  const turns = [{ role: "user", content: `[${displayName(message)}]: ${message.content}` }];
  const extraSystem = [
    "Nobody summoned you for this message. You're chiming in on your own because it matched these rules' keywords:",
    ...rules.map((rule) => `- ${describe(rule)}`),
    `Do what the rule says, briefly. If the message only matched by accident and the rule clearly doesn't fit it (or its "when" doesn't hold), reply with exactly ${SKIP} and nothing else. Don't change any customizations here.`,
  ].join("\n");
  // No customization tools: an unsummoned message shouldn't be able to change anything.
  const { text } = await askCwaude(turns, people, message, { extraSystem, tools: [WEB_SEARCH] });
  if (!text || /^SKIP\W*$/.test(text) || text.startsWith("*stares")) return;
  console.log(`[chime-in] ${rules.map((r) => `#${r.id}`).join(", ")} on a message from ${displayName(message)}`);
  await sendReply(message, text);
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

discord.once(Events.ClientReady, (client) => {
  console.log(`Logged in as ${client.user.tag}. Ugh. Waiting for questions...`);
});

discord.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
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
    const { text: answer, changed, posts } = await askCwaude(turns, people, message);

    if (changed) {
      await message.react("✅").catch((err) => console.error("Couldn't add reaction:", err.message));
    }
    const out = [answer, ...posts].filter(Boolean).join("\n\n");
    if (out) await sendReply(message, out);
  } catch (err) {
    console.error("Failed to answer:", err);
    if (err instanceof Anthropic.RateLimitError) {
      await message.reply("I'm being asked too many things at once. Shocking. Try again in a minute.").catch(() => {});
    } else if (err instanceof Anthropic.AuthenticationError) {
      await message.reply("My brain's API key is broken. Someone tell the admin.").catch(() => {});
    } else {
      await message.reply("Something broke. Probably your fault. (Check the bot's console.)").catch(() => {});
    }
  }
});

if (!process.env.DISCORD_TOKEN || !process.env.ANTHROPIC_API_KEY) {
  console.error("Missing DISCORD_TOKEN or ANTHROPIC_API_KEY. Copy .env.example to .env and fill them in.");
  process.exit(1);
}

discord.login(process.env.DISCORD_TOKEN);
