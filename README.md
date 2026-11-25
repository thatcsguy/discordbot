# hey cwaude

A Discord bot for a friends' server, running on Claude in its normal voice, that people can reshape by chatting with it. It responds when a message:

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
- **Skills** are reusable prompts you run with `!`: "hey cwaude, make a skill called factcheck: look at what the named person said in the last 5 minutes and check whether it's true", then `!factcheck celia`. Send a skill as a reply to a message to run it on that message. `!skills` lists them, `!help` shows a help card. Unknown `!` commands are ignored, so other bots' commands don't clash. A skill can be told to see fewer of the recent messages, or none ("make it ignore the current chat"), so it isn't swayed by the last conversation.

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
- When a week or month ends, the cheap model rolls that channel's daily summaries up into a weekly and a monthly summary, kept forever. Daily summaries are dropped after 60 days once their month is rolled up. When summoned, the bot sees the latest monthly summary, the two latest weekly summaries and the last three daily ones, and can search all summaries for older things.
- For anything older or more specific ("what restaurant did Celia mention last week?", "what did we talk about in March?"), it can search the summaries and the full log.

There's no time limit on this memory, but it only goes back to when logging started: the first run of this version, plus the up-to-7 days it caught up on then, or further if you imported older history (see below).

Let your friends know the bot keeps this log. The files stay on your computer, but excerpts go to the Anthropic API: new messages for the hourly summaries, and recent messages, summaries, and search results whenever the bot is summoned or chimes in.

Everything is stored locally in `customizations.json`, and every change is appended to `changes.log` (who, when, before/after). These, and the chat log and summaries, are all git-ignored. The core prompt in `SYSTEM_PROMPT` can't be changed from chat. It has no built-in persona, so the bot uses Claude's normal voice, and user rules layer any personality on top. The first time the new version runs, old per-person notes from `memory.json` are imported as rules (the old file is left alone).

## Voice profiles

For skills that imitate people (like `!predict`), the bot can keep a **voice profile** of each regular: their style (length, caps, punctuation, emoji), vocabulary and catchphrases, recurring topics and running jokes, opinions, how they react to teasing or being wrong, who they talk to, and 20-30 real quotes. Profiles are written by the cheap model (`CHEAP_MODEL`) from excerpts spread evenly across every month of the log, each with a couple of lines of the conversation before it, so they reflect the whole year rather than last night's chat. Quotes are checked against the log and dropped if the model paraphrased them.

- Only people with **100+ logged messages** qualify. Nobody else ever costs tokens.
- Profiles are **never built automatically**. In Discord:
  - `!profiles` lists who qualifies (with message counts), who has a profile, and how many new messages each has since.
  - `!profiles build` builds missing profiles and refreshes ones with 30+ new messages. A refresh reads only the messages posted since that person's last build.
  - `!profiles build Name` / `!profiles rebuild Name` (start over from the whole log) / `!profiles show Name` work on one person.
- A full build reads up to about 50k tokens per person on Haiku (a few cents); the bot reports the tokens used.
- They're saved in `profiles.json` (git-ignored, stays on your computer).

Any skill can use them. The model has a `get_voice_profile` tool for one or more people, and a skill whose prompt mentions "voice profile" gets the profiles of everyone named, @mentioned or replied to in its input loaded up front. For example "hey cwaude make a skill called debate: the input names two people and a topic; using their voice profiles, write a short back-and-forth where each argues in their own voice", then `!debate Myps Celia pineapple pizza`. Skills also get `sample_chat_log`, which returns someone's messages spread across every month (optionally skipping the last few days) instead of the latest ones.

### Importing older history

The log normally starts when the bot first ran. To give the profiles and searches the whole year, import older messages from Discord once:

```bash
npm run backfill-history                 # back to 2026-01-01
npm run backfill-history -- 2025-06-01   # or another start date
```

It uses no Anthropic tokens, only Discord's history API, skips messages already in the log (so it's safe to re-run, and safe while the bot is running), and can take a while on a busy server. Imported messages aren't summarized (that would cost tokens); they're searchable and feed the profiles. Run `!profiles build` afterwards.

## What it knows about itself

`capabilities.md` describes what Cwaude can do, and it's loaded into the core prompt so the bot can answer "what can you do?" accurately. Update it when you add features. The current rules, facts and skills are shown to it automatically.

## Tweaking

- **Core prompt**: edit `SYSTEM_PROMPT` in `index.js`. For personality, it's usually easier to just add a rule from chat.
- **Model / cost**: set `CLAUDE_MODEL` in `.env`. The default is `claude-opus-5-5`. `claude-haiku-5-5` costs about 1/40th as much and handles chat well.
- **Background model**: `CHEAP_MODEL` (default `claude-haiku-5-5`) handles chime-ins and summaries. Use `claude-sonnet-5-5` if fact-checking chime-ins aren't accurate enough.
- **What it can say about itself**: edit `capabilities.md`.
