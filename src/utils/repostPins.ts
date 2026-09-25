import { Client, TextChannel } from 'discord.js';
import { GameNight, upsertGameNight } from './storage';
import { updateGameListPin, updateRequestPin, updateHubPin } from './requestPin';
import { findSnackListByChannel, upsertSnackList } from './snackStorage';
import { updateSnacksPin } from '../commands/snacks';

export type RepostTarget = 'game_list' | 'requests' | 'snacks' | 'hub';

export const REPOST_TARGET_LABELS: Record<RepostTarget, string> = {
  game_list: 'Game lineup',
  requests: 'Games to bring',
  snacks: 'Snacks list',
  hub: 'Quick Actions',
};

export const ALL_REPOST_TARGETS = Object.keys(REPOST_TARGET_LABELS) as RepostTarget[];

// Best-effort: the old pinned copy may already have been deleted by hand.
async function deleteOldMessage(client: Client, channelId: string, messageId: string | undefined): Promise<void> {
  if (!messageId) return;
  try {
    const channel = (await client.channels.fetch(channelId)) as TextChannel;
    await channel.messages.delete(messageId);
  } catch (err) {
    console.warn(`[repost] Could not delete old message ${messageId} in channel ${channelId}:`, err);
  }
}

// Replaces one of an event channel's pinned, edit-in-place messages with a
// fresh copy at the bottom of the channel: the old message is deleted, its
// stored id cleared, and the matching update*Pin function — which posts and
// pins a new message whenever there's no stored id — does the rest, so the
// reposted message is built by exactly the same code as the original and
// keeps being edited in place afterward. Returns false when there was nothing
// to repost (a snacks list nobody has started yet).
export async function repostPin(client: Client, gameNight: GameNight, target: RepostTarget): Promise<boolean> {
  const channelId = gameNight.eventChannelId;
  if (!channelId) return false;

  switch (target) {
    case 'game_list': {
      await deleteOldMessage(client, channelId, gameNight.gameListPinMessageId);
      gameNight.gameListPinMessageId = undefined;
      await upsertGameNight(gameNight);
      await updateGameListPin(client, gameNight.id);
      return true;
    }
    case 'requests': {
      await deleteOldMessage(client, channelId, gameNight.requestPinMessageId);
      gameNight.requestPinMessageId = undefined;
      await upsertGameNight(gameNight);
      await updateRequestPin(client, gameNight.id);
      return true;
    }
    case 'hub': {
      await deleteOldMessage(client, channelId, gameNight.hubPinMessageId);
      gameNight.hubPinMessageId = undefined;
      await upsertGameNight(gameNight);
      await updateHubPin(client, gameNight.id);
      return true;
    }
    case 'snacks': {
      const list = await findSnackListByChannel(channelId);
      if (!list) return false;
      await deleteOldMessage(client, channelId, list.pinMessageId);
      list.pinMessageId = undefined;
      await upsertSnackList(list);
      await updateSnacksPin(client, channelId);
      return true;
    }
  }
}
