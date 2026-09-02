import {
  AutocompleteInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { loadCommandUsage } from '../utils/commandUsageStorage';
import { loadGameNights } from '../utils/storage';
import { findGamesByEvent } from '../utils/gameStorage';
import { getShortLinkStatsForGame } from '../utils/shortLinkStorage';
import { handleConfig as handleEventConfig } from './gamenight';
import { previewSchedule as handleEventPreview, makeGroupGameId } from '../utils/scheduler';
import { handleAdminLibraryClear, handleSync as handleLibrarySync, handleSyncAll as handleLibrarySyncAll } from './library';
import { findGameNamesByPartial, loadLibraryForGuild } from '../utils/libraryStorage';
import {
  handleAdd as handleTagAdd,
  handleRemove as handleTagRemove,
  handleList as handleTagList,
  handleSync as handleTagSync,
  handleClear as handleTagClear,
  handleAutocomplete as handleTagAutocomplete,
} from './gametags';
import {
  handleConfig as handleWelcomeConfig,
  handleTest as handleWelcomeTest,
  handleGreet as handleWelcomeGreet,
} from './welcome';
import {
  handleAdminConfig as handleMarketplaceConfig,
  handleAdminPurge as handleMarketplacePurge,
} from './marketplace';
import { handleRoomConfig } from './room';
import { handleGeneralHubConfig } from '../utils/generalHub';
import { handleChallengeConfig, WEEKDAY_CHOICES } from './boardgamechallenge';

export const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Admin-only server management commands')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  // ── usage ─────────────────────────────────────────────────────────────────────
  .addSubcommand((sub) =>
    sub
      .setName('usage')
      .setDescription('Show which commands are used on this server, and how often'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('bgstats')
      .setDescription('Show BG Stats link open counts for the most recently locked event'),
  )
  // ── event group ──────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('event')
      .setDescription('Event administration')
      .addSubcommand((sub) =>
        sub
          .setName('config')
          .setDescription('Set server-wide defaults for new events')
          .addStringOption((opt) =>
            opt
              .setName('timezone')
              .setDescription('IANA timezone for event date/time input and display (e.g. "America/New_York", default: UTC)')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('location').setDescription('Default location').setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('time')
              .setDescription('Default start time (e.g. "7:00 PM")')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('end_time')
              .setDescription('Default end time (e.g. "10:00 PM")')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('description').setDescription('Default notes').setRequired(false),
          )
          .addChannelOption((opt) =>
            opt
              .setName('announcements')
              .setDescription('Channel where RSVP embeds are posted')
              .setRequired(false),
          )
          .addBooleanOption((opt) =>
            opt
              .setName('open_channels')
              .setDescription(
                'Allow everyone to see event channels (true = open, false = RSVP only)',
              )
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('event_category')
              .setDescription(
                'Discord category name for new event channels (default: "Game Nights")',
              )
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('archive_category')
              .setDescription(
                'Discord category name for archived event channels (default: "Archive")',
              )
              .setRequired(false),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('archive_retention_days')
              .setDescription(
                'Auto-delete archived channels after this many days (0 = never, minimum 7)',
              )
              .setRequired(false)
              .setMinValue(0),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('lock_hours_before_event')
              .setDescription(
                'Lock game suggestions/seats this many hours before an event and run the scheduler (0 = disabled)',
              )
              .setRequired(false)
              .setMinValue(0),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('table_count')
              .setDescription('Number of tables available to schedule games in parallel (default: 1)')
              .setRequired(false)
              .setMinValue(1),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('light_buffer_minutes')
              .setDescription('Minutes added to Light games\' playtime for teach/overflow when scheduling (default: 15)')
              .setRequired(false)
              .setMinValue(0),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('medium_buffer_minutes')
              .setDescription('Minutes added to Medium games\' playtime for teach/overflow when scheduling (default: 30)')
              .setRequired(false)
              .setMinValue(0),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('heavy_buffer_minutes')
              .setDescription('Minutes added to Heavy games\' playtime for teach/overflow when scheduling (default: 45)')
              .setRequired(false)
              .setMinValue(0),
          )
          .addBooleanOption((opt) =>
            opt
              .setName('post_bgstats_links')
              .setDescription(
                'Post a "Log in BG Stats" button per scheduled game when the lineup locks (default: false)',
              )
              .setRequired(false),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('heavy_game_break_minutes')
              .setDescription(
                'Minutes to pause before a table plays two Heavy games back-to-back (0 = disabled, default: 30)',
              )
              .setRequired(false)
              .setMinValue(0),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('max_game_repeats')
              .setDescription(
                'Cap on total plays for a short game (<30 min) repeating back-to-back at its table (default: 3)',
              )
              .setRequired(false)
              .setMinValue(1),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('max_tables')
              .setDescription(
                'Hard cap on concurrent tables, e.g. a venue\'s physical table count (0 = uncapped, default: 0)',
              )
              .setRequired(false)
              .setMinValue(0),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('break_minutes')
              .setDescription(
                "Minutes before a person's next game can start, on top of the complexity buffer (default: 0)",
              )
              .setRequired(false)
              .setMinValue(0),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('flex_tables')
              .setDescription(
                'Reserve this many tables for Light-complexity games only (0 = disabled, default: 0)',
              )
              .setRequired(false)
              .setMinValue(0),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('preview')
          .setDescription(
            "Preview the game schedule for this event channel without locking or posting (dry run)",
          ),
      ),
  )
  // ── library group ─────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('library')
      .setDescription('Library administration')
      .addSubcommand((sub) =>
        sub
          .setName('clear')
          .setDescription("Clear a specific member's entire library")
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Member whose library to clear').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('sync')
          .setDescription("Re-sync a game's data from BoardGameGeek (thumbnail, video, expansions)")
          .addStringOption((opt) =>
            opt.setName('game').setDescription('Game name to sync').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('syncall')
          .setDescription(
            'Re-sync all library games from BGG — slow, rate-limited, admin only',
          )
          .addBooleanOption((opt) =>
            opt
              .setName('force')
              .setDescription('Overwrite existing data (default: true). False only fills in missing fields')
              .setRequired(false),
          ),
      ),
  )
  // ── tags group ────────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('tags')
      .setDescription('Manage game genre and difficulty tags')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Create a new game genre tag')
          .addStringOption((opt) =>
            opt
              .setName('name')
              .setDescription('Tag name (e.g. "Trick-Taking", "Euro", "Strategy")')
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('color')
              .setDescription('Role color — pick from the list or type a hex code (e.g. #5865F2)')
              .setRequired(false)
              .setAutocomplete(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('type')
              .setDescription('Role type (default: genre)')
              .setRequired(false)
              .addChoices(
                { name: 'Genre', value: 'genre' },
                { name: 'Difficulty', value: 'difficulty' },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Delete a game genre tag')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Exact tag name to remove').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('List all current game genre tags'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('sync')
          .setDescription('Create server roles for all built-in game tags (skips existing)'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('clear')
          .setDescription('Remove all game tags and their Discord roles from this server'),
      ),
  )
  // ── welcome group ─────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('welcome')
      .setDescription('Manage the new member welcome message')
      .addSubcommand((sub) =>
        sub
          .setName('config')
          .setDescription('Set welcome message options')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel where welcome messages are posted')
              .setRequired(false),
          )
          .addChannelOption((opt) =>
            opt
              .setName('rules_channel')
              .setDescription('Channel containing server rules')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('facebook_url').setDescription('Facebook group URL').setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('bgg_url').setDescription('BoardGameGeek group/guild page URL').setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('test').setDescription('Preview the welcome message as if you just joined'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('greet')
          .setDescription('Manually send the welcome message to a specific member')
          .addUserOption((opt) =>
            opt.setName('member').setDescription('The member to welcome').setRequired(true),
          ),
      ),
  )
  // ── marketplace group ─────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('marketplace')
      .setDescription('Marketplace administration')
      .addSubcommand((sub) =>
        sub
          .setName('config')
          .setDescription('Configure the marketplace channel (Forum or Text) and negotiation mode')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Forum or text channel where listings are posted')
              .addChannelTypes(ChannelType.GuildForum, ChannelType.GuildText)
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('negotiation_mode')
              .setDescription('Where negotiations happen (default: private)')
              .setRequired(false)
              .addChoices(
                { name: 'Public — offers visible in the forum thread', value: 'public' },
                { name: 'Private — each offer gets its own private thread', value: 'private' },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('purge')
          .setDescription('Delete marketplace listings (admin cleanup)')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Only purge listings from this user').setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('status')
              .setDescription('Which statuses to purge (default: all when user specified, sold+closed otherwise)')
              .setRequired(false)
              .addChoices(
                { name: 'Active', value: 'active' },
                { name: 'Active + Pending', value: 'active_pending' },
                { name: 'Sold + Closed', value: 'sold_closed' },
                { name: 'All', value: 'all' },
              ),
          ),
      ),
  )
  // ── room group ────────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('room')
      .setDescription('/room private channel administration')
      .addSubcommand((sub) =>
        sub
          .setName('config')
          .setDescription('Set the Discord category used for /room private channels')
          .addStringOption((opt) =>
            opt
              .setName('category')
              .setDescription('Discord category name for private rooms (default: "Private Rooms")')
              .setRequired(false),
          ),
      ),
  )
  // ── general group ────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('general')
      .setDescription('General chat "Quick Actions" hub administration')
      .addSubcommand((sub) =>
        sub
          .setName('config')
          .setDescription('Set the channel for the general chat "Quick Actions" button hub')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Text channel to post the Quick Actions hub in (e.g. #general)')
              .setRequired(false),
          ),
      ),
  )
  // ── challenge group ──────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('challenge')
      .setDescription('"Guess the Board Game" challenge administration')
      .addSubcommand((sub) => {
        sub
          .setName('config')
          .setDescription('Set the channel, frequency, on/off state, and hint/reveal schedule for the board game challenge')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel for hints/guesses (auto-created if omitted and enabling)')
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(false),
          )
          .addBooleanOption((opt) =>
            opt
              .setName('enabled')
              .setDescription('Turn the challenge on or off (default: off)')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('frequency')
              .setDescription('How often a new challenge cycle starts (default: weekly)')
              .addChoices(
                { name: 'Daily', value: 'daily' },
                { name: 'Weekly', value: 'weekly' },
                { name: 'Bi-weekly', value: 'biweekly' },
              )
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('start_date')
              .setDescription('Bi-weekly only: which week is "on" (e.g. "August 22") — defaults to this week')
              .setRequired(false),
          )
          .addBooleanOption((opt) =>
            opt
              .setName('cleanup_old_posts')
              .setDescription('Delete the previous cycle\'s hints/reveal when a new one starts (default: off)')
              .setRequired(false),
          );
        const scheduleFields: [string, string, string][] = [
          ['clue1', 'Hint 1', 'default Monday 8am'],
          ['clue2', 'Hint 2', 'default Wednesday 8am'],
          ['clue3', 'Hint 3', 'default Friday 8am'],
          ['reveal', 'Reveal', 'default Saturday 6pm'],
        ];
        for (const [prefix, label, defaultText] of scheduleFields) {
          sub
            .addStringOption((opt) =>
              opt
                .setName(`${prefix}_day`)
                .setDescription(`Day of week ${label.toLowerCase()} posts on, ignored in daily mode (${defaultText})`)
                .addChoices(...WEEKDAY_CHOICES)
                .setRequired(false),
            )
            .addStringOption((opt) =>
              opt
                .setName(`${prefix}_hour`)
                .setDescription(`Hour ${label.toLowerCase()} posts at: 12h or 24h, e.g. "8am"/"20" (${defaultText})`)
                .setRequired(false),
            );
        }
        return sub;
      }),
  );

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();
  if (group === 'tags') {
    await handleTagAutocomplete(interaction);
  } else if (group === 'library' && sub === 'sync') {
    const focused = interaction.options.getFocused();
    const guildId = interaction.guildId!;
    const expansionNames = new Set(
      (await loadLibraryForGuild(guildId)).filter((e) => e.isExpansion).map((e) => e.gameName.toLowerCase()),
    );
    const matches = (await findGameNamesByPartial(guildId, focused))
      .filter((name) => !expansionNames.has(name.toLowerCase()))
      .slice(0, 25);
    await interaction.respond(matches.map((name) => ({ name, value: name })));
  }
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  if (!group && sub === 'usage') {
    await handleUsage(interaction);
  } else if (!group && sub === 'bgstats') {
    await handleAdminBgStats(interaction);
  } else if (group === 'event') {
    if (sub === 'config') await handleEventConfig(interaction);
    else if (sub === 'preview') await handleEventPreview(interaction);
  } else if (group === 'library') {
    if (sub === 'clear') await handleAdminLibraryClear(interaction);
    else if (sub === 'sync') await handleLibrarySync(interaction);
    else if (sub === 'syncall') await handleLibrarySyncAll(interaction);
  } else if (group === 'tags') {
    if (sub === 'add') await handleTagAdd(interaction);
    else if (sub === 'remove') await handleTagRemove(interaction);
    else if (sub === 'list') await handleTagList(interaction);
    else if (sub === 'sync') await handleTagSync(interaction);
    else if (sub === 'clear') await handleTagClear(interaction);
  } else if (group === 'welcome') {
    if (sub === 'config') await handleWelcomeConfig(interaction);
    else if (sub === 'test') await handleWelcomeTest(interaction);
    else if (sub === 'greet') await handleWelcomeGreet(interaction);
  } else if (group === 'marketplace') {
    if (sub === 'config') await handleMarketplaceConfig(interaction);
    else if (sub === 'purge') await handleMarketplacePurge(interaction);
  } else if (group === 'room') {
    if (sub === 'config') await handleRoomConfig(interaction);
  } else if (group === 'general') {
    if (sub === 'config') await handleGeneralHubConfig(interaction);
  } else if (group === 'challenge') {
    if (sub === 'config') await handleChallengeConfig(interaction);
  }
}

// Discord caps message content at 2000 chars — leave headroom and truncate
// defensively rather than crash if a server accumulates enough distinct
// command paths to blow past the limit.
const USAGE_CONTENT_BUDGET = 1900;

export async function handleUsage(interaction: ChatInputCommandInteraction): Promise<void> {
  const stats = await loadCommandUsage(interaction.guildId!);
  if (stats.length === 0) {
    await interaction.reply({
      content: 'No command usage recorded yet.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sorted = [...stats].sort((a, b) => b.totalCalls - a.totalCalls);
  const lines = sorted.map((entry) => {
    const params = Object.entries(entry.paramCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([name, count]) => `${name}: ${count}`)
      .join(', ');
    const callWord = entry.totalCalls === 1 ? 'call' : 'calls';
    return `/${entry.commandPath} — ${entry.totalCalls} ${callWord}${params ? ` (${params})` : ''}`;
  });

  let body = '';
  let shown = 0;
  for (const line of lines) {
    if (body.length + line.length + 1 > USAGE_CONTENT_BUDGET) break;
    body += (body ? '\n' : '') + line;
    shown++;
  }
  const omittedNote = shown < lines.length ? `\n… and ${lines.length - shown} more` : '';

  await interaction.reply({
    content: `**Command usage (${sorted.length} command${sorted.length === 1 ? '' : 's'} tracked):**\n\`\`\`\n${body}${omittedNote}\n\`\`\``,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleAdminBgStats(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const lockedEvents = (await loadGameNights())
    .filter((gn) => gn.guildId === guildId && gn.locked)
    .sort((a, b) => Date.parse(b.startTimeISO) - Date.parse(a.startTimeISO));

  if (lockedEvents.length === 0) {
    await interaction.reply({
      content: 'No locked events yet — BG Stats links are only generated once an event locks.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const event = lockedEvents[0];
  const scheduledGames = (await findGamesByEvent(event.id)).filter(
    (g) => g.scheduledTable !== undefined || g.scheduledWalkUp === true,
  );

  if (scheduledGames.length === 0) {
    await interaction.reply({
      content: `**${event.title ?? 'Game Night'}** (<t:${Math.floor(Date.parse(event.startTimeISO) / 1000)}:D>) locked with no scheduled games.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const describeStats = (stats: { openCount: number; lastOpenedAt?: string }): string =>
    stats.openCount > 0
      ? `${stats.openCount} open${stats.openCount === 1 ? '' : 's'}${
          stats.lastOpenedAt
            ? ` (last <t:${Math.floor(new Date(stats.lastOpenedAt).getTime() / 1000)}:R>)`
            : ''
        }`
      : 'not opened yet';

  let openedCount = 0;
  let sessionCount = 0;
  const lines: string[] = [];
  for (const game of scheduledGames) {
    // A game split into groups (see expandGamesIntoGroups in scheduler.ts)
    // was posted as one BG Stats message per group, each with its own play
    // id (game.id for group 1, makeGroupGameId(game.id, N) for group N) —
    // report opens per group so a busy game's real per-table activity isn't
    // collapsed into a single, misleadingly low-looking count.
    if (game.scheduledSessions && game.scheduledSessions.length > 1) {
      for (const session of game.scheduledSessions) {
        sessionCount++;
        const sessionId = makeGroupGameId(game.id, session.groupIndex);
        const stats = await getShortLinkStatsForGame(guildId, event.id, sessionId);
        if (stats.openCount > 0) openedCount++;
        lines.push(`**${game.title} (Group ${session.groupIndex})** — ${describeStats(stats)}`);
      }
    } else {
      sessionCount++;
      const stats = await getShortLinkStatsForGame(guildId, event.id, game.id);
      if (stats.openCount > 0) openedCount++;
      lines.push(`**${game.title}** — ${describeStats(stats)}`);
    }
  }

  await interaction.reply({
    content:
      `**BG Stats links — ${event.title ?? 'Game Night'}** (<t:${Math.floor(Date.parse(event.startTimeISO) / 1000)}:D>)\n` +
      `${lines.join('\n')}\n\n` +
      `${openedCount} of ${sessionCount} scheduled sessions opened at least once.`,
    flags: MessageFlags.Ephemeral,
  });
}
