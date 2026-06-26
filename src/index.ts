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
import { loadBGGCatalog } from './utils/bggCatalog';

loadBGGCatalog().catch(err => console.error('[BGGCatalog] Startup error:', err));

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

client.login(process.env.DISCORD_TOKEN);
