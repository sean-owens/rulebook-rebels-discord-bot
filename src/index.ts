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
  ],
});

client.once('clientReady', () => handleReady(client));
client.on('interactionCreate', handleInteraction);
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
