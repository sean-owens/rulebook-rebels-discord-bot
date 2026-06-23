import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';

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
          '`create` — Schedule a new game night',
          '`list` — See upcoming game nights',
          '`cancel` — Cancel an event you created',
        ].join('\n'),
      },
      {
        name: '🎲  /game',
        value: [
          '`suggest` — Suggest a game to play at the next event',
          '`list` — See what games have been suggested',
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
          '`edit` — Update details on one of your games',
          '`clear` — Remove all your games at once',
          '`request` — Request a game be brought to an event',
          '`unrequest` — Cancel a game request',
          '`bring` — Mark that you\'re bringing a game to an event',
          '`import` — Bulk-add games from a CSV file',
        ].join('\n'),
      },
      {
        name: '🏷️  /myroles',
        value: 'Set your game genre preferences so others can see what you like to play.',
      },
      {
        name: '🔧  Admin only',
        value: [
          '`/gametags add` — Add a game genre tag (creates a Discord role)',
          '`/gametags remove` — Remove a game genre tag',
          '`/gametags list` — List all current tags',
          '`/gametags sync` — Sync tags with existing Discord roles',
          '`/event config` — Set default event location, time, and description',
          '`/event archive` — Archive a past event',
          '`/welcome config` — Configure the welcome message and channel',
          '`/welcome test` — Preview the welcome message',
          '`/library import` — Bulk-import games from a CSV',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'Built for the Rulebook Rebels board game group • Made with Claude' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
