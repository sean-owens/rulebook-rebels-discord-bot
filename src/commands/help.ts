import { ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show all available bot commands');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Rulebook Rebels Bot — Commands')
    .setDescription('Here\'s everything you can do. All commands are slash commands — type `/` to get started.')
    .addFields(
      {
        name: '📅  /event',
        value: [
          '`list` — See upcoming game nights',
          '`cancel` — Cancel an event you created',
        ].join('\n'),
      },
      {
        name: '🎲  /game',
        value: [
          '`suggest` — Suggest a game to play at an event',
          '`list` — See the game lineup for an event (use inside an event channel)',
          '`cancel` — Remove your game suggestion',
        ].join('\n'),
      },
      {
        name: '📚  /library',
        value: [
          '`add` — Add a game you own to the shared library',
          '`remove` — Remove one of your games from the library',
          '`mine` — List all the games you\'ve added',
          '`list` — Browse the full library',
          '`view` — Look up a specific game',
          '`edit` — Update details on one of your games (players, play time, tags, complexity)',
          '`clear` — Remove all your games at once',
          '`request` — Request a game be brought to an event',
          '`unrequest` — Cancel a game request',
          '`bring` — See which of your games have been requested for upcoming events',
          '`import` — Bulk-add games from a CSV file',
        ].join('\n'),
      },
      {
        name: '🏷️  /myroles',
        value: 'Set your game genre preferences so others can see what you like to play.',
      },
      {
        name: '🎲  /bgg',
        value: [
          '`link` — Connect your BoardGameGeek account to this server',
          '`unlink` — Remove your linked BoardGameGeek account',
          '`profile` — View your currently linked BoardGameGeek account',
        ].join('\n'),
      },
      ...(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ? [{
        name: '🔧  Admin only',
        value: [
          '`/event create` — Schedule a new game night',
          '`/event config` — Set server-wide defaults for future events (location, time, description) — does not edit existing events',
          '`/event archive` — Archive a past event',
          '`/gametags add` — Add a game genre tag (creates a Discord role)',
          '`/gametags remove` — Remove a game genre tag',
          '`/gametags list` — List all current tags',
          '`/gametags sync` — Sync tags with existing Discord roles',
          '`/welcome config` — Configure the welcome message and channel',
          '`/welcome test` — Preview the welcome message',
        ].join('\n'),
      }] : []),
    )
    .setFooter({ text: 'Built for the Rulebook Rebels board game group • Made with Claude' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
