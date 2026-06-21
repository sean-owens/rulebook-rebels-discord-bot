import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { data as gamenightCommand } from './commands/gamenight';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in .env');
  process.exit(1);
}

const commands = [gamenightCommand.toJSON()];
const rest = new REST().setToken(token);

(async () => {
  try {
    if (guildId) {
      // Guild-scoped deploy: instant, great for development
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log(`Slash commands deployed to guild ${guildId}`);
    } else {
      // Global deploy: can take up to 1 hour to propagate
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('Slash commands deployed globally');
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
