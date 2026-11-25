// Copying old messages from Discord into the local log. Uses no tokens: it's only Discord's history API.
// Used on startup (catch up on what was missed while the bot was off) and by backfill-history.js
// (a one-off import of older history, e.g. back to Jan 1).
import { PermissionFlagsBits } from "discord.js";
import { logMessage, entryKey } from "./chatlog.js";

const DISCORD_EPOCH = 1420070400000n;

/** A Discord message ID for this moment, for paging history from a point in time. */
export function snowflakeAt(ts) {
  return ((BigInt(Math.floor(ts)) - DISCORD_EPOCH) << 22n).toString();
}

function displayName(message) {
  return message.member?.displayName ?? message.author.globalName ?? message.author.username;
}

/** A message as a log entry. `botUserId` is Cwaude's own ID (its messages are logged as "Cwaude"). */
export function logEntry(message, botUserId) {
  return {
    id: message.id,
    ts: message.createdTimestamp,
    channelId: message.channelId,
    channelName: message.channel.name,
    userId: message.author.id,
    name: message.author.id === botUserId ? "Cwaude" : displayName(message),
    text: message.content,
    ...(message.author.bot && { bot: true }),
  };
}

/** Every text channel the bot can read the history of. */
export function readableChannels(client) {
  const channels = [];
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isTextBased() || !channel.viewable) continue;
      if (!channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ReadMessageHistory)) continue;
      channels.push(channel);
    }
  }
  return channels;
}

/**
 * Log one channel's messages posted after `sinceTs` and before `untilTs`, paging backwards from
 * `untilTs`, 100 at a time. Messages whose key is in `skip` are already logged and aren't added again.
 * `onMessage(message)` runs for each one added (e.g. to note the person). Returns how many were added.
 */
export async function backfillChannel(channel, { sinceTs, untilTs, botUserId, skip = null, onMessage = null, onPage = null }) {
  let added = 0;
  let before = snowflakeAt(untilTs);
  for (;;) {
    const page = await channel.messages.fetch({ limit: 100, before });
    if (page.size === 0) break;
    let reachedEnd = false;
    for (const message of page.values()) {
      if (message.createdTimestamp <= sinceTs) {
        reachedEnd = true;
        break;
      }
      if (message.createdTimestamp >= untilTs) continue; // logged live
      const entry = logEntry(message, botUserId);
      if (skip && (skip.has(entryKey(entry)) || skip.has(`${entry.channelId}|${entry.userId}|${entry.ts}`))) continue;
      logMessage(entry);
      onMessage?.(message);
      added++;
    }
    onPage?.(page.last().createdTimestamp, added);
    if (reachedEnd || page.size < 100) break;
    before = page.last().id;
  }
  return added;
}
