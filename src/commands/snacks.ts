import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { loadGameNights } from '../utils/storage';
import { findRoomByChannel } from '../utils/roomStorage';
import {
  SnackItem,
  SnackList,
  addSnackItem,
  findSnackListByChannel,
  removeSnackItem,
  upsertSnackList,
} from '../utils/snackStorage';

// Same `room:` key convention games.json uses for a room's suggestions (see
// ROOM_GAME_NIGHT_PREFIX in game.ts) — keeps a room's snack list keyed
// distinctly from an event's without touching the GameNight/PrivateRoom types.
const ROOM_EVENT_PREFIX = 'room:';

const NOT_IN_CONTEXT_MSG =
  'This must be used inside an event channel or a private room.';

interface SnackChannelContext {
  eventId: string;
  guildId: string;
}

async function resolveSnackContext(channelId: string): Promise<SnackChannelContext | undefined> {
  const nights = await loadGameNights();
  const gameNight = nights.find((gn) => gn.eventChannelId === channelId && !gn.cancelled && !gn.archived);
  if (gameNight) return { eventId: gameNight.id, guildId: gameNight.guildId };

  const room = await findRoomByChannel(channelId);
  if (room) return { eventId: `${ROOM_EVENT_PREFIX}${room.id}`, guildId: room.guildId };

  return undefined;
}

async function resolveDisplayNames(client: Client, guildId: string, userIds: string[]): Promise<Record<string, string>> {
  const nameMap: Record<string, string> = {};
  const uniqueIds = [...new Set(userIds)];
  try {
    const guild = await client.guilds.fetch(guildId);
    await Promise.all(
      uniqueIds.map(async (uid) => {
        try {
          nameMap[uid] = (await guild.members.fetch(uid)).displayName;
        } catch {
          nameMap[uid] = client.users.cache.get(uid)?.username ?? `User ${uid.slice(0, 6)}…`;
        }
      }),
    );
  } catch {
    /* guild unavailable — names fall back to the id-based placeholder above */
  }
  return nameMap;
}

function buildSnacksEmbed(items: SnackItem[], nameMap: Record<string, string>): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('🍿 Snacks List').setColor(0xe67e22);
  if (items.length === 0) {
    return embed.setDescription("No snacks have been added yet — use `/snacks add` or the 🍿 Snacks button.");
  }
  const lines = items.map((i) => `• ${i.item} — *${nameMap[i.userId] ?? `User ${i.userId.slice(0, 6)}…`}*`);
  return embed
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Add yours with /snacks add, or the 🍿 Snacks hub button.' });
}

export async function updateSnacksPin(client: Client, channelId: string): Promise<void> {
  const list = await findSnackListByChannel(channelId);
  if (!list) return;

  const nameMap = await resolveDisplayNames(client, list.guildId, list.items.map((i) => i.userId));
  const embed = buildSnacksEmbed(list.items, nameMap);

  let channel: TextChannel;
  try {
    channel = (await client.channels.fetch(channelId)) as TextChannel;
  } catch {
    return;
  }

  if (list.pinMessageId) {
    try {
      const msg = await channel.messages.fetch(list.pinMessageId);
      await msg.edit({ embeds: [embed] });
      if (!msg.pinned) {
        try {
          await msg.pin();
        } catch (err) {
          console.warn(`Could not re-pin snacks list message in channel ${channelId}:`, err);
        }
      }
      return;
    } catch {
      /* message was deleted — fall through and repost */
    }
  }

  const msg = await channel.send({ embeds: [embed] });
  try {
    await msg.pin();
  } catch (err) {
    console.warn(`Could not pin snacks list message in channel ${channelId}:`, err);
  }

  list.pinMessageId = msg.id;
  await upsertSnackList(list);
}

export const data = new SlashCommandBuilder()
  .setName('snacks')
  .setDescription('Track who is bringing which snack — run inside an event channel or private room')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a snack to the list for this event/room')
      .addStringOption((opt) =>
        opt
          .setName('item')
          .setDescription('What are you bringing? (e.g. Chips, Soda)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('See the current snacks list for this event/room'),
  )
  .addSubcommand((sub) =>
    sub.setName('remove').setDescription('Remove one of your own snacks from the list'),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') await handleAdd(interaction);
  else if (sub === 'list') await handleList(interaction);
  else if (sub === 'remove') await handleRemove(interaction);
}

async function handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await resolveSnackContext(interaction.channelId!);
  if (!ctx) {
    await interaction.reply({ content: NOT_IN_CONTEXT_MSG, flags: MessageFlags.Ephemeral });
    return;
  }

  const item = interaction.options.getString('item', true).trim();
  if (!item) {
    await interaction.reply({
      content: 'Enter what you plan to bring (e.g. `item:Chips`).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await addSnackItem(interaction.channelId!, ctx.guildId, ctx.eventId, interaction.user.id, item);
  await interaction.reply({ content: `Added **${item}** to the snacks list.`, flags: MessageFlags.Ephemeral });
  await updateSnacksPin(interaction.client, interaction.channelId!);
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await resolveSnackContext(interaction.channelId!);
  if (!ctx) {
    await interaction.reply({ content: NOT_IN_CONTEXT_MSG, flags: MessageFlags.Ephemeral });
    return;
  }

  const list = await findSnackListByChannel(interaction.channelId!);
  const nameMap = await resolveDisplayNames(interaction.client, ctx.guildId, (list?.items ?? []).map((i) => i.userId));
  await interaction.reply({ embeds: [buildSnacksEmbed(list?.items ?? [], nameMap)], flags: MessageFlags.Ephemeral });
}

async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await resolveSnackContext(interaction.channelId!);
  if (!ctx) {
    await interaction.reply({ content: NOT_IN_CONTEXT_MSG, flags: MessageFlags.Ephemeral });
    return;
  }

  const list = await findSnackListByChannel(interaction.channelId!);
  const mine = (list?.items ?? []).filter((i) => i.userId === interaction.user.id);

  if (mine.length === 0) {
    await interaction.reply({ content: "You haven't added any snacks yet.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (mine.length === 1) {
    await removeSnackItem(interaction.channelId!, mine[0].id);
    await interaction.reply({ content: `Removed **${mine[0].item}** from the snacks list.`, flags: MessageFlags.Ephemeral });
    await updateSnacksPin(interaction.client, interaction.channelId!);
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('snacks_remove_select')
    .setPlaceholder('Select a snack to remove…')
    .addOptions(mine.map((i) => new StringSelectMenuOptionBuilder().setLabel(i.item.slice(0, 100)).setValue(i.id)));
  await interaction.reply({
    content: 'Which of your snacks would you like to remove?',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleSnacksRemoveSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  await removeSelectedSnack(interaction, interaction.values[0]);
}

// ── "Quick Actions" hub button ────────────────────────────────────────────────
// Shared by the event-channel hub (requestPin.ts's buildHubButtons) and the
// room hub (room.ts's buildRoomHubButtons) — same customId, handled here once.

export function buildSnacksHubButton(): ButtonBuilder {
  return new ButtonBuilder().setCustomId('hub_snacks').setLabel('🍿 Snacks').setStyle(ButtonStyle.Secondary);
}

export async function handleHubSnacksButton(interaction: ButtonInteraction): Promise<void> {
  const ctx = await resolveSnackContext(interaction.channelId!);
  if (!ctx) {
    await interaction.reply({ content: NOT_IN_CONTEXT_MSG, flags: MessageFlags.Ephemeral });
    return;
  }

  const list = await findSnackListByChannel(interaction.channelId!);
  const nameMap = await resolveDisplayNames(interaction.client, ctx.guildId, (list?.items ?? []).map((i) => i.userId));
  const hasMine = (list?.items ?? []).some((i) => i.userId === interaction.user.id);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('hub_snacks_add').setLabel('➕ Add a Snack').setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('hub_snacks_remove')
      .setLabel('🗑️ Remove Mine')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasMine),
  );

  await interaction.reply({
    embeds: [buildSnacksEmbed(list?.items ?? [], nameMap)],
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleHubSnacksAddButton(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId('hub_snacks_add_modal')
    .setTitle('Add a Snack')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('item')
          .setLabel('What are you bringing?')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Chips, Soda, Cookies')
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

export async function handleHubSnacksAddModal(interaction: ModalSubmitInteraction): Promise<void> {
  const ctx = await resolveSnackContext(interaction.channelId!);
  if (!ctx) {
    await interaction.reply({ content: NOT_IN_CONTEXT_MSG, flags: MessageFlags.Ephemeral });
    return;
  }

  const item = interaction.fields.getTextInputValue('item').trim();
  if (!item) {
    await interaction.reply({ content: 'Enter what you plan to bring.', flags: MessageFlags.Ephemeral });
    return;
  }

  await addSnackItem(interaction.channelId!, ctx.guildId, ctx.eventId, interaction.user.id, item);
  await interaction.reply({ content: `Added **${item}** to the snacks list.`, flags: MessageFlags.Ephemeral });
  await updateSnacksPin(interaction.client, interaction.channelId!);
}

export async function handleHubSnacksRemoveButton(interaction: ButtonInteraction): Promise<void> {
  const list = await findSnackListByChannel(interaction.channelId!);
  const mine = (list?.items ?? []).filter((i) => i.userId === interaction.user.id);

  if (mine.length === 0) {
    await interaction.reply({ content: "You haven't added any snacks yet.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (mine.length === 1) {
    await removeSnackItem(interaction.channelId!, mine[0].id);
    await interaction.reply({ content: `Removed **${mine[0].item}** from the snacks list.`, flags: MessageFlags.Ephemeral });
    await updateSnacksPin(interaction.client, interaction.channelId!);
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('hub_snacks_remove_select')
    .setPlaceholder('Select a snack to remove…')
    .addOptions(mine.map((i) => new StringSelectMenuOptionBuilder().setLabel(i.item.slice(0, 100)).setValue(i.id)));
  await interaction.reply({
    content: 'Which of your snacks would you like to remove?',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleHubSnacksRemoveSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  await removeSelectedSnack(interaction, interaction.values[0]);
}

async function removeSelectedSnack(
  interaction: StringSelectMenuInteraction,
  itemId: string,
): Promise<void> {
  const list = await findSnackListByChannel(interaction.channelId!);
  const item = list?.items.find((i) => i.id === itemId);
  if (!item || item.userId !== interaction.user.id) {
    await interaction.update({ content: "That snack couldn't be found — it may have already been removed.", components: [] });
    return;
  }

  await removeSnackItem(interaction.channelId!, itemId);
  await interaction.update({ content: `Removed **${item.item}** from the snacks list.`, components: [] });
  await updateSnacksPin(interaction.client, interaction.channelId!);
}
