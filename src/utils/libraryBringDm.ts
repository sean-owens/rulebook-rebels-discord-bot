import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client } from 'discord.js';
import {
  GameRequest,
  RequestAsk,
  addPendingAsk,
  removePendingAsk,
  findGamesByName,
  resolveAttendingOwnerIds,
  pickPreferredOwner,
  buildExpansionNote,
} from './libraryStorage';
import { findGamesByEvent } from './gameStorage';

function bringActionRow(requestId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`library_confirmbring_${requestId}`)
      .setLabel('✅ Confirm bringing')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`library_declinebring_${requestId}`)
      .setLabel("❌ Can't bring it")
      .setStyle(ButtonStyle.Secondary),
  );
}

async function sendDm(
  client: Client,
  req: GameRequest,
  ownerId: string,
  content: string,
): Promise<void> {
  try {
    const owner = await client.users.fetch(ownerId);
    const msg = await owner.send({ content, components: [bringActionRow(req.id)] });
    await addPendingAsk(req.id, ownerId, msg.channelId, msg.id);
  } catch (err) {
    console.warn(`Could not DM "${req.gameName}" bring request to ${ownerId}:`, err);
  }
}

/** Sent when a game is requested via /library request, or when reconcileRequestCopies asks an additional owner. */
export async function sendBringRequestDm(
  client: Client,
  req: GameRequest,
  ownerId: string,
  eventDate: string,
  expansionNote: string,
): Promise<void> {
  await sendDm(
    client,
    req,
    ownerId,
    `🎲 Someone requested that you bring **${req.gameName}**${expansionNote} to the event on ${eventDate}! Tap below to confirm, or run \`/library bring game:${req.gameName}\`.`,
  );
}

/** Strips the buttons from a specific pending ask's DM and appends a closing note. */
export async function invalidateBringDm(
  client: Client,
  ask: Pick<RequestAsk, 'dmChannelId' | 'dmMessageId'>,
  note: string,
): Promise<void> {
  if (!ask.dmChannelId || !ask.dmMessageId) return;
  try {
    const channel = await client.channels.fetch(ask.dmChannelId);
    if (!channel || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(ask.dmMessageId);
    await message.edit({ content: `${message.content}\n\n_${note}_`, components: [] });
  } catch (err) {
    console.warn('Could not invalidate a bring-request DM:', err);
  }
}

/**
 * Reconciles a request's outstanding asks against its current copiesNeeded —
 * called after copiesNeeded changes (waitlist crossing minPlayers, see
 * game.ts) and after a confirmation/decline. Asks additional attending
 * owners if more copies are needed than are currently pending+confirmed, or
 * retracts (and invalidates the DM for) the most recently asked owner(s) if
 * fewer copies are needed than are pending. Never touches confirmations that
 * have already come in — a surplus confirmed copy is harmless.
 */
export async function reconcileRequestCopies(
  client: Client,
  guildId: string,
  rsvps: { yes: string[]; maybe: string[] },
  req: GameRequest,
  eventDate: string,
): Promise<void> {
  const needed = req.copiesNeeded ?? 1;
  const neededPending = Math.max(0, needed - req.confirmations.length);

  if (req.pendingAsks.length > neededPending) {
    // Oldest asks are kept; the most recently asked are retracted first.
    const excess = req.pendingAsks.slice(neededPending);
    for (const ask of excess) {
      const removed = await removePendingAsk(req.id, ask.ownerId);
      if (removed) {
        await invalidateBringDm(client, removed, "No longer needed — we've got enough copies covered now.");
      }
    }
    return;
  }

  if (req.pendingAsks.length < neededPending) {
    const owners = await findGamesByName(guildId, req.gameName);
    const ownerIds = [...new Set(owners.map((o) => o.userId))];
    const attendingOwnerIds = await resolveAttendingOwnerIds(guildId, ownerIds, rsvps);
    const tried = new Set([
      ...req.confirmations.map((c) => c.ownerId),
      ...req.declinedOwnerIds,
      ...req.pendingAsks.map((a) => a.ownerId),
    ]);

    // An owner who suggested this game for the event (and so is already seated
    // in it) is the likeliest to bring it anyway — ask them ahead of fairness.
    const suggesterId = (await findGamesByEvent(req.eventId)).find(
      (g) => g.title.toLowerCase() === req.gameName.toLowerCase(),
    )?.createdBy;

    let toAsk = neededPending - req.pendingAsks.length;
    while (toAsk > 0) {
      // Priority: an explicit copy-select owner pick (req.preferredOwnerId, a
      // specific/specialized copy), then the game's suggester if they own it,
      // then fairness for every other slot (and any further copy, or a
      // fallback if the earlier choices were already tried/ineligible).
      const eligible = (id: string | undefined): id is string =>
        !!id && !tried.has(id) && attendingOwnerIds.includes(id);
      const ownerId = eligible(req.preferredOwnerId)
        ? req.preferredOwnerId
        : eligible(suggesterId)
          ? suggesterId
          : await pickPreferredOwner(req.eventId, attendingOwnerIds, [...tried]);
      if (!ownerId) break; // no more eligible owners left to ask
      tried.add(ownerId);
      const expansionNote = await buildExpansionNote(guildId, ownerId, req.gameName);
      await sendBringRequestDm(client, req, ownerId, eventDate, expansionNote);
      toAsk -= 1;
    }
  }
}
