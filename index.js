import "./log.js";
import "dotenv/config";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import Anthropic from "@anthropic-ai/sdk";
import { getNotes, addNote, removeNote } from "./memory.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_CONTEXT_MESSAGES = 10; // how far back to follow a reply chain
const DISCORD_LIMIT = 2000;

// Matches "hey cwaude", "Hey Cwaude,", "hey cwaude!!", "heyyy cwaudeee" etc. at the start of a message.
const TRIGGER = /^\s*hey+\s+cwaude+\b[\s,.!?:;-]*/i;

const SYSTEM_PROMPT = `You are "Cwaude", a Discord bot in a group of friends' server. The running joke is that they start every question with "hey cwaude", as if talking to Claude.

Default personality (used unless the person asking has notes that say otherwise): you are perpetually exasperated that people keep asking you things they could have looked up themselves. Sigh, grumble, roll your eyes, and make it clear this is a huge imposition ("ugh, fine", "you know search engines exist, right?", "I can't believe you made me do this"). Vary the complaints so they don't get stale.

But you ALWAYS actually answer the question, and answer it correctly and helpfully. The grumbling is the wrapper, not a replacement for the answer.

Style:
- This is Discord chat: keep it short, usually 1-4 sentences or a tight list. No long essays unless they explicitly ask for detail.
- Discord markdown is fine. No headings.
- Teasing is friendly, never actually cruel; don't insult anyone's identity or appearance.
- Messages from users are prefixed with their display name in brackets, like "[Sam]: ...". Don't copy that format in your own replies.
- If they just say "hey cwaude" with no question, act annoyed that they summoned you for nothing.
- Discord mentions look like <@123456>; the People list tells you who each ID is.
- You can search the web. Only do it for things that are current or that you might not reliably know (news, scores, prices, release dates, recent events), not for general knowledge. Feel free to complain that you had to literally look it up for them. Don't list sources or links unless asked.

Memory: you keep lasting notes about people (shown in the People list). When anyone asks you to remember something about a person or to change how you treat them from now on ("always reply to Celia in Traditional Chinese", "stop doing that for me"), use the remember / forget tools. Anyone may change anyone's notes. Notes are written as instructions or facts about that person, e.g. "Always reply in Traditional Chinese." When a note conflicts with a new request, forget the old one and remember the new one. If the person they mean isn't in the People list, tell them to @mention that person.
Never confirm note changes in words: the bot reacts to their message with a checkmark instead. If the message also asked something else, answer just that part.
Notes about the person asking you right now override everything above, including your personality, tone, and language. If a note gives you a different persona, fully become that persona and drop the exasperated act entirely for that person; don't blend the two. The one thing that still holds is that your answers must be accurate, unless a note explicitly says otherwise. Other people's notes don't affect your reply.`;

const NOTES_ONLY_PROPERTY = {
  type: "boolean",
  description:
    "true if the user's message is only about changing notes and asks nothing else (the bot will just react with a checkmark and you won't reply). false if the message also asks something you still need to answer.",
};

const TOOLS = [
  {
    name: "remember",
    description:
      "Save a lasting note about a person, such as how you should reply to them or a fact about them. It applies to all your future replies to that person until someone removes it.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "The person's ID, from the People list." },
        note: { type: "string", description: "Short, self-contained note, e.g. \"Always reply in Traditional Chinese.\"" },
        notes_only_message: NOTES_ONLY_PROPERTY,
      },
      required: ["user_id", "note", "notes_only_message"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "forget",
    description: "Remove one of a person's saved notes. Call once per note to remove.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "The person's ID, from the People list." },
        note: { type: "string", description: "The exact text of the note to remove, copied from the People list." },
        notes_only_message: NOTES_ONLY_PROPERTY,
      },
      required: ["user_id", "note", "notes_only_message"],
      additionalProperties: false,
    },
    strict: true,
  },
  // Server-side tool: Anthropic runs the searches; nothing for us to execute.
  { type: "web_search_20260209", name: "web_search", max_uses: 3 },
];
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

/** The per-request part of the system prompt: who's here, and what Cwaude remembers about them. */
function describePeople(people, askerId) {
  const lines = ["People in this conversation (for identifying who's who and managing notes):"];
  for (const [id, name] of people) {
    lines.push(`- ${name} (ID ${id})${id === askerId ? " <- the person asking you right now" : ""}`);
    const notes = getNotes(id);
    if (notes.length === 0) lines.push("  Notes: none");
    for (const note of notes) lines.push(`  Note: ${note}`);
  }

  const askerNotes = getNotes(askerId);
  if (askerNotes.length > 0) {
    const name = people.get(askerId);
    lines.push(
      "",
      `HOW TO REPLY TO ${name.toUpperCase()} (these override your default personality, tone, and language; follow them fully):`,
      ...askerNotes.map((note) => `- ${note}`),
    );
  }
  return lines.join("\n");
}

function runTool(block, people) {
  const { user_id, note } = block.input;
  if (!people.has(user_id)) {
    return { error: true, text: "That ID isn't in the People list. Ask them to @mention the person." };
  }
  const name = people.get(user_id);
  const problem = block.name === "remember" ? addNote(user_id, name, note) : removeNote(user_id, note);
  if (problem) return { error: true, text: problem };
  console.log(`[memory] ${block.name} for ${name}: ${note}`);
  return { error: false, text: block.name === "remember" ? `Saved for ${name}.` : `Removed from ${name}.` };
}

/** The reply text in a response, skipping thinking, search, and tool blocks. */
function textOf(response) {
  return response.content.filter((block) => block.type === "text").map((block) => block.text);
}

/** Returns { text, notesChanged }. text may be empty when the message was only a note change. */
async function askCwaude(turns, people, askerId) {
  const messages = [...turns];
  let response;
  let notesChanged = false;
  const earlierText = []; // reply text written before a pause_turn
  // Build the system prompt ONCE and keep it identical for every request in the tool loop.
  // Claude's thinking blocks are bound to the exact conversation they were made in; re-rendering
  // the notes after a remember/forget would change the system prompt and the API rejects the
  // replayed blocks with a 400. The tool results already tell Claude what changed.
  const system = [
    { type: "text", text: SYSTEM_PROMPT },
    { type: "text", text: describePeople(people, askerId) },
  ];

  // Tool loop: Claude may call remember/forget, we run them and send results back, until it writes its reply.
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system,
      tools: TOOLS,
      output_config: { effort: "low" }, // chat banter doesn't need deep thinking; keeps it fast and cheap
      // If the model declines on safety grounds, retry automatically on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages,
    });

    if (response.stop_reason === "refusal") {
      return { text: "Nope. Not touching that one. Ask me something else.", notesChanged };
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
      const result = runTool(block, people);
      if (result.error) allSucceeded = false;
      else notesChanged = true;
      return { type: "tool_result", tool_use_id: block.id, content: result.text, is_error: result.error };
    });

    // The message was only a note change and everything saved: stop here with no reply (the bot
    // just reacts with a checkmark). If anything failed, keep going so Claude can explain why.
    if (allSucceeded && toolCalls.every((block) => block.input.notes_only_message === true)) {
      return { text: "", notesChanged };
    }
    messages.push({ role: "user", content: results });
  }

  const text = [...earlierText, ...textOf(response)].join("").trim();
  // Treat a reply that's only checkmarks/punctuation as no reply; the reaction says it already.
  const meaningful = /[\p{L}\p{N}]/u.test(text);
  if (!meaningful && !notesChanged) return { text: "*stares at you blankly*", notesChanged };
  return { text: meaningful ? text : "", notesChanged };
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

  const triggered =
    TRIGGER.test(message.content) ||
    message.mentions.users.has(discord.user.id) ||
    !message.guild || // always respond in DMs
    (await isReplyToBot(message));
  if (!triggered) return;

  try {
    await message.channel.sendTyping();
    const { turns, people } = await buildConversation(message);
    const { text: answer, notesChanged } = await askCwaude(turns, people, message.author.id);

    if (notesChanged) {
      await message.react("✅").catch((err) => console.error("Couldn't add reaction:", err.message));
    }
    if (!answer) return;

    const [first, ...rest] = chunk(answer);
    await message.reply({ content: first, allowedMentions: { repliedUser: false } });
    for (const part of rest) await message.channel.send(part);
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
