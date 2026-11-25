# hey cwaude

A Discord bot that answers your questions, reluctantly. It responds when a message:

- starts with **"hey cwaude"** (any capitalization, extra letters like "heyyy cwaudeee" work too)
- **@mentions** the bot
- is a **reply** to one of the bot's messages (so you can ask follow-ups; it reads up to 10 messages back in the reply chain)
- is a **DM** to the bot

## Setup

### 1. Node.js
Use Node **20 or newer**. The 22 LTS from https://nodejs.org is a good choice. (Node 18.13 is too old for discord.js's networking library.)

### 2. Create the Discord bot
1. Go to https://discord.com/developers/applications and click **New Application** (call it Cwaude).
2. **Bot** tab:
   - Click **Reset Token** and copy the token. This is your `DISCORD_TOKEN`.
   - Under **Privileged Gateway Intents**, turn on **Message Content Intent**. Without it, the bot can't read "hey cwaude".
3. **OAuth2 → URL Generator** tab:
   - Scopes: `bot`
   - Bot permissions: `View Channels`, `Send Messages`, `Read Message History`, `Add Reactions`
   - Open the generated URL and add the bot to your server.

### 3. Anthropic API key
Create a key at https://console.anthropic.com/settings/keys.

### 4. Configure and run
```bash
cp .env.example .env     # then paste both keys into .env
npm install
npm start
```

The bot runs for as long as that terminal is open.

## Teaching it things (rules, facts, skills)

Anyone in the server can reshape Cwaude just by asking it. Everything they add gets a number, so it's easy to undo.

- **Rules** change how it behaves: "hey cwaude, for Sam always reply in pirate speak", "hey cwaude, in this channel keep answers to one sentence", "hey cwaude, when someone asks about food, recommend tacos". You don't need to @mention the person, as long as the bot has seen them post (live, or in the week it catches up on at startup). Otherwise @mention them once.
- **Chime-in rules** make it reply without being summoned: "hey cwaude, whenever anyone says pineapple pizza, reply 'gross'". The bot checks messages against the trigger words itself and only calls Claude when one matches.
- **Watchers** are chime-in rules for people instead of words, usually with a time limit: "hey cwaude fact check everything Celia says for 5 mins, just react with a check or an X". They turn themselves off when the time is up (that shows in the change log too). Chime-ins run on the cheap model (`CHEAP_MODEL`, Haiku by default).
- **Facts** are things it should know: "hey cwaude, remember Sam is vegetarian", "hey cwaude, Sammy is Sam's nickname".
- **Skills** are reusable prompts you run with `!`: "hey cwaude, make a skill called factcheck: look at what the named person said in the last 5 minutes and check whether it's true", then `!factcheck celia`. Send a skill as a reply to a message to run it on that message. `!skills` lists them, `!help` shows a help card. Unknown `!` commands are ignored, so other bots' commands don't clash.

Managing them:
- "hey cwaude show everything" / "show rules" / "show skills" / "show removed" posts a numbered list.
- "hey cwaude remove 3" removes #3; "restore 3" brings it back. Numbers are never reused.
- "hey cwaude change 3 to only apply to Celia" edits it in place.
- "hey cwaude what changed recently?" shows who changed what and when.

## Channel awareness

Cwaude follows the chat even when nobody's talking to it:
- Every server message (not DMs) is written to a local log in `chatlog/`, one file per day, kept forever (it's just text: a few MB a month for a chatty server).
- On startup it fetches from Discord whatever it missed while it was off (up to 7 days back per channel). That uses no tokens, and the next summary run catches up on it.
- When summoned, it sees the last 30 messages in that channel, plus the channel's summaries (details below).
- Every hour, the cheap model folds new messages into each channel's daily summary (`summaries.json`). Only channels with new messages cost anything; a busy day is well under a cent on Haiku.
- When a week or month ends, the cheap model rolls that channel's daily summaries up into a weekly and a monthly summary, kept forever. Daily summaries are dropped after 60 days once their month is rolled up. The bot sees the latest month, the last two weeks and the last three days when summoned, and can search all summaries for older things.
- For anything older or more specific ("what restaurant did Celia mention last week?", "what did we talk about in March?"), it can search the summaries and the full log.

There's no time limit on this memory, but it only goes back to when logging started: the first run of this version, plus the up-to-7 days it caught up on then.

Let your friends know the bot keeps this log. The files stay on your computer, but excerpts go to the Anthropic API: new messages for the hourly summaries, and recent messages, summaries, and search results whenever the bot is summoned or chimes in.

Everything is stored locally in `customizations.json`, and every change is appended to `changes.log` (who, when, before/after). These, and the chat log and summaries, are all git-ignored. The core personality in `SYSTEM_PROMPT` can't be changed from chat; user rules layer on top of it. The first time the new version runs, old per-person notes from `memory.json` are imported as rules (the old file is left alone).

## What it knows about itself

`capabilities.md` describes what Cwaude can do, and it's loaded into the core prompt so the bot can answer "what can you do?" accurately. Update it when you add features. The current rules, facts and skills are shown to it automatically.

## Tweaking

- **Personality**: edit `SYSTEM_PROMPT` in `index.js`.
- **Model / cost**: set `CLAUDE_MODEL` in `.env`. The default is `claude-opus-5-5`. `claude-haiku-5-5` costs about 1/40th as much and handles chat well.
- **Background model**: `CHEAP_MODEL` (default `claude-haiku-5-5`) handles chime-ins and summaries. Use `claude-sonnet-5-5` if fact-checking chime-ins aren't accurate enough.
- **What it can say about itself**: edit `capabilities.md`.
