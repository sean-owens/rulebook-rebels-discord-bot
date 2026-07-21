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
      "Here's everything you can do. All commands are slash commands — type `/` to get started.\n\nNew here? Run `/getting-started` for a quick walkthrough instead of this full list.",
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
          '`cancel` — Remove a game suggestion — the suggester, the event host, or an admin can do this',
          '`bgstats` — Generate a "Log in BG Stats" button + QR code for one of this channel\'s suggested games',
        ].join('\n'),
      },
      {
        name: '📚  /library',
        value: [
          '`add` — Add a game you own to the shared library',
          '`remove` — Remove one of your games from the library',
          "`mine` — List all the games you've added, plus any shared with you",
          '`list` — Browse the full library',
          '`view` — Look up a specific game',
          '`random` — Get 3 random picks, filtered by tag/complexity — defaults to your `/myroles` preferences if set',
          '`search` — Find games by player count, tag, duration, or complexity — also defaults to your `/myroles` preferences',
          '`edit` — Update details on one of your games (players, play time, tags, complexity)',
          '`clear` — Remove all your own games at once',
          '`link` — Share your library with another member so they can view, request, and bring it too',
          '`unlink` — Remove a library link with another member',
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
      {
        name: '🔒  /room',
        value: [
          '`create` — Make a private channel with just you and whoever you mention — hidden from everyone else except hosts and admins. Set an expiration date, or `persist:true` for a room that never auto-expires (shown with a 📌 in the channel name)',
          '`invite` — Add more people to a private room (run inside it) — the creator or any host/admin can do this',
          '`kick` — Remove someone from a private room (run inside it) — the creator or any host/admin can do this',
          '`close` — Close and delete a private room (run inside it) — the creator or any host/admin can do this',
          '`persist` — Turn a room\'s auto-expiration on or off (run inside it) — the creator or any host/admin can do this',
        ].join('\n'),
      },
      {
        name: '🎮  /hub',
        value: 'Get the "Quick Actions" buttons for wherever you are — an event channel, private room, marketplace, or general chat — as an ephemeral reply only you can see, in case you missed the pinned one.',
      },
      ...(isHost
        ? [
            {
              name: '🎙️  /host — Event & moderation tools',
              value: [
                '`/host event create` — Schedule a new game night',
                '`/host event edit` — Update an existing game night',
                '`/host event cancel` — Cancel a game night',
                '`/host event privacy` — Open or restrict one event\'s channel, overriding the server default',
                '`/host event greeters` — Set, view, remove one, or clear all of this event\'s greeters — restricted to Light games, never seated together',
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
              name: '🔧  /admin — Server & library configuration',
              value: [
                '`/admin event config` — Set server-wide defaults for new events (location, time, description)',
                '`/admin event preview` — Preview the game schedule for this event channel without locking or posting (dry run)',
                "`/admin library clear` — Clear a specific member's entire library",
                "`/admin library sync` — Re-sync a game's data from BoardGameGeek",
                '`/admin library syncall` — Re-sync every game from BoardGameGeek (force:False to only fill in missing data)',
                '`/admin tags add` — Add a game genre tag (creates a Discord role)',
                '`/admin tags remove` — Remove a game genre tag',
                '`/admin tags list` — List all current tags',
                '`/admin tags sync` — Create roles for all built-in tags at once',
                '`/admin tags clear` — Remove all game tags and their roles',
              ].join('\n'),
            },
            {
              name: '🔧  /admin — Welcome, marketplace & rooms',
              value: [
                '`/admin welcome config` — Configure the welcome message and channel',
                '`/admin welcome test` — Preview the welcome message',
                '`/admin welcome greet` — Manually send the welcome message to a member',
                '`/admin marketplace config` — Set the marketplace forum channel and negotiation mode',
                '`/admin marketplace purge` — Delete old/closed marketplace listings',
                '`/admin room config` — Set the Discord category used for /room private channels',
                '`/admin general config` — Set the channel for the general chat "Quick Actions" button hub',
                '`/admin usage` — Show which commands are used on this server, and how often',
              ].join('\n'),
            },
          ]
        : []),
    )
    .setFooter({ text: 'Built for the Rulebook Rebels board game group • Made with Claude' });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
