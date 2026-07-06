import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show all available bot commands');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  const isHost =
    isAdmin || (interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Rulebook Rebels Bot — Commands')
    .setDescription(
      "Here's everything you can do. All commands are slash commands — type `/` to get started.",
    )
    .addFields(
      {
        name: '📅  /event',
        value: '`list` — See upcoming game nights',
      },
      {
        name: '🎲  /game',
        value: [
          '`suggest` — Suggest a game to play at an event',
          '`list` — See the game lineup for an event (use inside an event channel)',
          '`cancel` — Remove your own game suggestion',
        ].join('\n'),
      },
      {
        name: '📚  /library',
        value: [
          '`add` — Add a game you own to the shared library',
          '`remove` — Remove one of your games from the library',
          "`mine` — List all the games you've added",
          '`list` — Browse the full library',
          '`view` — Look up a specific game',
          '`edit` — Update details on one of your games (players, play time, tags, complexity)',
          '`clear` — Remove all your own games at once',
          '`request` — Request a game be brought to an event',
          '`unrequest` — Cancel one of your own game requests',
          '`bring` — See which of your games have been requested for upcoming events',
          '`import csv` — Bulk-add games from a CSV file',
          '`import bgg` — Import your owned collection from BoardGameGeek',
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
      {
        name: '🛒  /marketplace',
        value: [
          '`post sell` — List an item for sale (BGG-assisted with expansion and price reference; custom items supported)',
          '`post trade` — List an item you want to trade away',
          '`price` — Look up current BGG marketplace prices without creating a listing',
          '`conditions` — Show the condition grading scale (New → Acceptable)',
          '`browse` — Browse active listings (filter by sell or trade)',
          '`my` — View and manage your own listings',
          '`close` — Close one of your listings',
          '`reopen` — Reopen a closed or sold listing',
        ].join('\n'),
      },
      ...(isHost
        ? [
            {
              name: '🎙️  /host — Event & moderation tools',
              value: [
                '`/host event create` — Schedule a new game night',
                '`/host event cancel` — Cancel a game night',
                '`/host event archive` — Archive past event channels',
                '`/host game cancel` — Remove any game from the event lineup',
                '`/host library unrequest` — Remove any game request from an event',
              ].join('\n'),
            },
          ]
        : []),
      ...(isAdmin
        ? [
            {
              name: '🔧  /admin — Server configuration',
              value: [
                '`/admin event config` — Set server-wide defaults for new events (location, time, description)',
                "`/admin library clear` — Clear a specific member's entire library",
                "`/admin library sync` — Re-sync a game's data from BoardGameGeek",
                '`/admin library syncall` — Re-sync every game in the library from BoardGameGeek',
                '`/admin tags add` — Add a game genre tag (creates a Discord role)',
                '`/admin tags remove` — Remove a game genre tag',
                '`/admin tags list` — List all current tags',
                '`/admin tags sync` — Create roles for all built-in tags at once',
                '`/admin tags clear` — Remove all game tags and their roles',
                '`/admin welcome config` — Configure the welcome message and channel',
                '`/admin welcome test` — Preview the welcome message',
                '`/admin welcome greet` — Manually send the welcome message to a member',
                '`/admin marketplace config` — Set the marketplace forum channel and negotiation mode',
                '`/admin marketplace purge` — Delete old/closed marketplace listings',
              ].join('\n'),
            },
          ]
        : []),
    )
    .setFooter({ text: 'Built for the Rulebook Rebels board game group • Made with Claude' });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
