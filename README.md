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

## Tweaking

- **Personality**: edit `SYSTEM_PROMPT` in `index.js`.
- **Model / cost**: set `CLAUDE_MODEL` in `.env`. The default is `claude-opus-5-5`. `claude-haiku-5-5` costs about 1/40th as much and handles chat well.
