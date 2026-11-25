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
   - Bot permissions: `View Channels`, `Send Messages`, `Read Message History`
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

- **Rules** change how it behaves: "hey cwaude, for Sam always reply in pirate speak", "hey cwaude, in this channel keep answers to one sentence", "hey cwaude, when someone asks about food, recommend tacos". You don't need to @mention the person, as long as they've posted in the server since the bot started tracking (otherwise @mention them once).
- **Chime-in rules** make it reply without being summoned: "hey cwaude, whenever anyone says pineapple pizza, reply 'gross'". The bot checks messages against the trigger words itself and only calls Claude when one matches.
- **Watchers** are chime-in rules for people instead of words, usually with a time limit: "hey cwaude fact check everything Celia says for 5 mins, just react with a check or an X". They turn themselves off when the time is up (that shows in the change log too). Chime-ins run on the cheap model (`CHEAP_MODEL`, Haiku by default).
- **Facts** are things it should know: "hey cwaude, remember Sam is vegetarian", "hey cwaude, Sammy is Sam's nickname".
- **Skills** are reusable prompts you run by name: "hey cwaude, make a skill called roast: write a 3-line roast of whoever I name", then "hey cwaude roast Sam".

Managing them:
- "hey cwaude show everything" / "show rules" / "show skills" / "show removed" posts a numbered list.
- "hey cwaude remove 3" removes #3; "restore 3" brings it back. Numbers are never reused.
- "hey cwaude change 3 to only apply to Celia" edits it in place.
- "hey cwaude what changed recently?" shows who changed what and when.

## Channel awareness

Cwaude follows the chat even when nobody's talking to it:
- Every server message (not DMs) is written to a local log in `chatlog/`, one file per day, kept for 14 days.
- When summoned, it sees the last 30 messages in that channel, plus summaries of the channel's last 3 days.
- Every hour, the cheap model folds new messages into each channel's daily summary (`summaries.json`). Only channels with new messages cost anything; a busy day is well under a cent on Haiku.
- For anything older or more specific ("what restaurant did Celia mention last week?"), it can search the log.

Let your friends know the bot keeps this log. It never leaves your computer except for the summary requests to the API.

Everything is stored locally in `customizations.json`, and every change is appended to `changes.log` (who, when, before/after). These, and the chat log and summaries, are all git-ignored. The core personality in `SYSTEM_PROMPT` can't be changed from chat; user rules layer on top of it. The first time the new version runs, old per-person notes from `memory.json` are imported as rules (the old file is left alone).

## Tweaking

- **Personality**: edit `SYSTEM_PROMPT` in `index.js`.
- **Model / cost**: set `CLAUDE_MODEL` in `.env`. The default is `claude-opus-5-5`. `claude-haiku-5-5` costs about 1/40th as much and handles chat well.
