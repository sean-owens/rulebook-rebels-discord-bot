import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { handleInteraction } from './events/interactionCreate';
import { handleReady } from './events/ready';
import {
  handleScheduledEventDelete,
  handleScheduledEventUpdate,
  handleScheduledEventUserAdd,
  handleScheduledEventUserRemove,
} from './events/scheduledEvents';
import { handleGuildMemberAdd } from './events/guildMemberAdd';
import { handleGuildCreate } from './events/guildCreate';
import { handleGuildDelete } from './events/guildDelete';
import { handleMessageCreate } from './events/messageCreate';
import { runRetentionCleanup } from './utils/guildLifecycle';
import { loadBGGCatalog } from './utils/bggCatalog';
import { startShortLinkServer } from './utils/shortLinkServer';

loadBGGCatalog().catch((err) => console.error('[BGGCatalog] Startup error:', err));

// Backs the BG Stats "Log in BG Stats" button (see src/utils/bgStats.ts) — a
// short redirect URL that fits Discord's button length limit regardless of
// player count. No-ops entirely if not configured (see .env.example).
if (process.env.SHORT_LINK_BASE_URL && process.env.PORT) {
  startShortLinkServer(Number(process.env.PORT));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildScheduledEvents,
    // Privileged — must also be enabled in the Discord Developer Portal for
    // this bot application, or the gateway will reject the connection. Reads
    // plain-message guesses for the weekly board game challenge (see
    // src/events/messageCreate.ts) — the bot's only feature that isn't
    // slash-command/component-driven.
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('clientReady', () => handleReady(client));
client.on('interactionCreate', handleInteraction);
client.on('messageCreate', (message) =>
  handleMessageCreate(message).catch((err) => console.error('[MessageCreate] Handler error:', err)),
);
client.on('guildScheduledEventDelete', handleScheduledEventDelete);
client.on('guildScheduledEventUpdate', handleScheduledEventUpdate);
client.on('guildScheduledEventUserAdd', handleScheduledEventUserAdd);
client.on('guildScheduledEventUserRemove', handleScheduledEventUserRemove);
client.on('guildMemberAdd', handleGuildMemberAdd);
client.on('guildCreate', handleGuildCreate);
client.on('guildDelete', handleGuildDelete);

runRetentionCleanup().catch((err) => console.error('[GuildLifecycle] Retention cleanup error:', err));
setInterval(
  () => runRetentionCleanup().catch((err) => console.error('[GuildLifecycle] Retention cleanup error:', err)),
  24 * 60 * 60 * 1000,
);

client.login(process.env.DISCORD_TOKEN);
