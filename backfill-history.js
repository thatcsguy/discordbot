// One-off import of older chat history into the local log (chatlog/), so the voice profiles and
// searches can see the whole year instead of only what was logged since the bot started.
// Uses no Anthropic tokens: it only reads Discord's message history.
//
//   npm run backfill-history                 # back to 2026-01-01 (the default)
//   npm run backfill-history -- 2025-06-01   # or any start date
//
// Safe to run while the bot is running and safe to run again: messages already in the log are skipped.
// Large servers take a while (Discord serves 100 messages per request, with rate limits).
import "dotenv/config";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { loggedKeys } from "./chatlog.js";
import { backfillChannel, readableChannels } from "./backfill.js";

const from = process.argv[2] ?? "2026-01-01";
if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
  console.error(`Expected a start date like 2026-01-01, got "${from}".`);
  process.exit(1);
}
if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const sinceTs = new Date(`${from}T00:00:00`).getTime() - 1;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once(Events.ClientReady, async () => {
  const untilTs = Date.now();
  const skip = loggedKeys(from);
  console.log(`Copying messages since ${from} into the log (${skip.size ? "skipping ones already there" : "log is empty"})...`);
  let total = 0;
  for (const channel of readableChannels(client)) {
    try {
      const added = await backfillChannel(channel, {
        sinceTs,
        untilTs,
        botUserId: client.user.id,
        skip,
        onPage: (oldestTs, soFar) => process.stdout.write(`\r#${channel.name}: back to ${new Date(oldestTs).toISOString().slice(0, 10)}, ${soFar} added   `),
      });
      process.stdout.write("\n");
      console.log(`#${channel.name}: added ${added}.`);
      total += added;
    } catch (err) {
      console.error(`\n#${channel.name}: skipped (${err.message}).`);
    }
  }
  console.log(`Done. Added ${total} message(s). Restart the bot (or wait for the next summary run) and try !profiles.`);
  await client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
