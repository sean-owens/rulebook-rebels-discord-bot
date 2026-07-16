import { ChatInputCommandInteraction, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  handleCreate as handleEventCreate,
  handleEdit as handleEventEdit,
  handleCancel as handleEventCancel,
  handleArchiveOld as handleEventArchive,
  handlePrivacy as handleEventPrivacy,
  handleSetGreeters as handleEventSetGreeters,
} from './gamenight';
import { handleHostGameCancel } from './game';
import { handleUnrequest as handleLibraryUnrequest } from './library';

export const data = new SlashCommandBuilder()
  .setName('host')
  .setDescription('Host-level commands for managing events and game nights')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
  // ── event group ───────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('event')
      .setDescription('Event management')
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Schedule a new game night')
          .addStringOption((opt) =>
            opt
              .setName('title')
              .setDescription('Short event name (e.g. "Board Game Bash") — used in the channel name and posts')
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('date')
              .setDescription('Date (e.g. "August 22" or "aug 22")')
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('time')
              .setDescription('Start time (e.g. "7pm" or "7:00 PM")')
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('end_time')
              .setDescription('End time (e.g. "10pm") — uses server default if omitted')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('location')
              .setDescription('Where it is — uses server default if omitted')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('link')
              .setDescription('Optional URL (e.g. map link, event page)')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('description').setDescription('Optional extra notes').setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('edit')
          .setDescription('Update an existing game night without cancelling and recreating it')
          .addStringOption((opt) =>
            opt
              .setName('id')
              .setDescription('Game night ID (shown in the event embed footer)')
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('title')
              .setDescription('New event name')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('date')
              .setDescription('New date (e.g. "August 22" or "aug 22")')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('time')
              .setDescription('New start time (e.g. "7pm" or "7:00 PM")')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('end_time')
              .setDescription('New end time (e.g. "10pm")')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('location').setDescription('New location').setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('link').setDescription('New URL (e.g. map link, event page)').setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('description').setDescription('New extra notes').setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('cancel')
          .setDescription('Cancel a game night')
          .addStringOption((opt) =>
            opt
              .setName('id')
              .setDescription('Game night ID (shown in the event embed footer)')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('archive').setDescription('Archive channels for all past events'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('privacy')
          .setDescription("Change one event's channel visibility, overriding the server default for it")
          .addStringOption((opt) =>
            opt
              .setName('id')
              .setDescription('Game night ID (shown in the event embed footer)')
              .setRequired(true),
          )
          .addBooleanOption((opt) =>
            opt
              .setName('open')
              .setDescription('true = open to everyone, false = RSVP only')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('greeters')
          .setDescription("Set (or clear) this event's greeters — restricted to Light games, never seated together")
          .addStringOption((opt) =>
            opt
              .setName('id')
              .setDescription('Game night ID (shown in the event embed footer)')
              .setRequired(true),
          )
          .addUserOption((opt) =>
            opt.setName('greeter1').setDescription('First greeter').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('greeter2').setDescription('Second greeter (optional)').setRequired(false),
          )
          .addBooleanOption((opt) =>
            opt
              .setName('clear')
              .setDescription("Remove this event's greeters instead of setting them")
              .setRequired(false),
          ),
      ),
  )
  // ── game group ────────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('game')
      .setDescription('Game suggestion management')
      .addSubcommand((sub) =>
        sub
          .setName('cancel')
          .setDescription('Remove any game from the event lineup')
          .addStringOption((opt) =>
            opt.setName('title').setDescription('Exact game title to remove').setRequired(true),
          ),
      ),
  )
  // ── library group ─────────────────────────────────────────────────────────────
  .addSubcommandGroup((group) =>
    group
      .setName('library')
      .setDescription('Library management')
      .addSubcommand((sub) =>
        sub
          .setName('unrequest')
          .setDescription('View and remove any game request from an upcoming event'),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(true);
  const sub = interaction.options.getSubcommand();

  if (group === 'event') {
    if (sub === 'create') await handleEventCreate(interaction);
    else if (sub === 'edit') await handleEventEdit(interaction);
    else if (sub === 'cancel') await handleEventCancel(interaction);
    else if (sub === 'archive') await handleEventArchive(interaction);
    else if (sub === 'privacy') await handleEventPrivacy(interaction);
    else if (sub === 'greeters') await handleEventSetGreeters(interaction);
  } else if (group === 'game') {
    if (sub === 'cancel') await handleHostGameCancel(interaction);
  } else if (group === 'library') {
    if (sub === 'unrequest') await handleLibraryUnrequest(interaction, true);
  }
}
