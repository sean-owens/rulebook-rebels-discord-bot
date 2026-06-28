import { AutocompleteInteraction, ChatInputCommandInteraction, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { handleConfig as handleEventConfig } from './gamenight';
import { handleAdminLibraryClear, handleSync as handleLibrarySync } from './library';
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

export const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Admin-only server management commands')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  // ── event group ──────────────────────────────────────────────────────────────
  .addSubcommandGroup(group =>
    group
      .setName('event')
      .setDescription('Event administration')
      .addSubcommand(sub =>
        sub
          .setName('config')
          .setDescription('Set server-wide defaults for new events')
          .addStringOption(opt =>
            opt.setName('location').setDescription('Default location').setRequired(false)
          )
          .addStringOption(opt =>
            opt.setName('time').setDescription('Default start time (e.g. "7:00 PM")').setRequired(false)
          )
          .addStringOption(opt =>
            opt.setName('end_time').setDescription('Default end time (e.g. "10:00 PM")').setRequired(false)
          )
          .addStringOption(opt =>
            opt.setName('description').setDescription('Default notes').setRequired(false)
          )
          .addChannelOption(opt =>
            opt.setName('announcements').setDescription('Channel where RSVP embeds are posted').setRequired(false)
          )
          .addBooleanOption(opt =>
            opt.setName('open_channels').setDescription('Allow everyone to see event channels (true = open, false = RSVP only)').setRequired(false)
          )
          .addStringOption(opt =>
            opt.setName('event_category').setDescription('Discord category name for new event channels (default: "Monthly Events")').setRequired(false)
          )
          .addStringOption(opt =>
            opt.setName('archive_category').setDescription('Discord category name for archived event channels (default: "Archive")').setRequired(false)
          )
      )
  )
  // ── library group ─────────────────────────────────────────────────────────────
  .addSubcommandGroup(group =>
    group
      .setName('library')
      .setDescription('Library administration')
      .addSubcommand(sub =>
        sub
          .setName('clear')
          .setDescription("Clear a specific member's entire library")
          .addUserOption(opt =>
            opt.setName('user').setDescription('Member whose library to clear').setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('sync')
          .setDescription("Re-sync a game's data from BoardGameGeek (thumbnail, video, expansions)")
          .addStringOption(opt =>
            opt.setName('game').setDescription('Game name to sync').setRequired(true)
          )
      )
  )
  // ── tags group ────────────────────────────────────────────────────────────────
  .addSubcommandGroup(group =>
    group
      .setName('tags')
      .setDescription('Manage game genre and difficulty tags')
      .addSubcommand(sub =>
        sub
          .setName('add')
          .setDescription('Create a new game genre tag')
          .addStringOption(opt =>
            opt.setName('name').setDescription('Tag name (e.g. "Trick-Taking", "Euro", "Strategy")').setRequired(true)
          )
          .addStringOption(opt =>
            opt.setName('color').setDescription('Role color — pick from the list or type a hex code (e.g. #5865F2)').setRequired(false).setAutocomplete(true)
          )
          .addStringOption(opt =>
            opt.setName('type').setDescription('Role type (default: genre)').setRequired(false)
              .addChoices(
                { name: 'Genre', value: 'genre' },
                { name: 'Difficulty', value: 'difficulty' },
              )
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('remove')
          .setDescription('Delete a game genre tag')
          .addStringOption(opt =>
            opt.setName('name').setDescription('Exact tag name to remove').setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName('list').setDescription('List all current game genre tags')
      )
      .addSubcommand(sub =>
        sub.setName('sync').setDescription('Create server roles for all built-in game tags (skips existing)')
      )
      .addSubcommand(sub =>
        sub.setName('clear').setDescription('Remove all game tags and their Discord roles from this server')
      )
  )
  // ── welcome group ─────────────────────────────────────────────────────────────
  .addSubcommandGroup(group =>
    group
      .setName('welcome')
      .setDescription('Manage the new member welcome message')
      .addSubcommand(sub =>
        sub
          .setName('config')
          .setDescription('Set welcome message options')
          .addChannelOption(opt =>
            opt.setName('channel').setDescription('Channel where welcome messages are posted').setRequired(false)
          )
          .addChannelOption(opt =>
            opt.setName('rules_channel').setDescription('Channel containing server rules').setRequired(false)
          )
          .addStringOption(opt =>
            opt.setName('facebook_url').setDescription('Facebook group URL').setRequired(false)
          )
      )
      .addSubcommand(sub =>
        sub.setName('test').setDescription('Preview the welcome message as if you just joined')
      )
      .addSubcommand(sub =>
        sub
          .setName('greet')
          .setDescription('Manually send the welcome message to a specific member')
          .addUserOption(opt =>
            opt.setName('member').setDescription('The member to welcome').setRequired(true)
          )
      )
  );

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup();
  if (group === 'tags') await handleTagAutocomplete(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(true);
  const sub = interaction.options.getSubcommand();

  if (group === 'event') {
    if (sub === 'config') await handleEventConfig(interaction);
  } else if (group === 'library') {
    if (sub === 'clear') await handleAdminLibraryClear(interaction);
    else if (sub === 'sync') await handleLibrarySync(interaction);
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
  }
}
