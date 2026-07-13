import { ForumChannel } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config';

const GAME_NIGHT_TAG_KEYS = ['upcoming', 'cancelled', 'concluded'] as const;
type GameNightTagKey = (typeof GAME_NIGHT_TAG_KEYS)[number];

const TAG_NAMES: Record<GameNightTagKey, string> = {
  upcoming: 'Upcoming',
  cancelled: 'Cancelled',
  concluded: 'Concluded',
};

// Mirrors ensureMarketplaceTags in commands/marketplace.ts — creates any missing
// status tags on the forum channel (reusing same-named tags already there) and
// persists the resolved tag IDs on the guild config so we don't recreate them.
export async function ensureGameNightTags(
  forumChannel: ForumChannel,
  guildId: string,
): Promise<Record<string, string>> {
  const config = await getGuildConfig(guildId);
  const tagIds: Record<string, string> = { ...config.gameNightTagIds };
  const existingByName = new Map(forumChannel.availableTags.map((t) => [t.name, t.id]));

  const missing = GAME_NIGHT_TAG_KEYS.filter((key) => {
    if (tagIds[key]) return false;
    const existingId = existingByName.get(TAG_NAMES[key]);
    if (existingId) {
      tagIds[key] = existingId;
      return false;
    }
    return true;
  });

  if (missing.length > 0) {
    const merged = [
      ...forumChannel.availableTags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated })),
      ...missing.map((key) => ({ name: TAG_NAMES[key], moderated: false })),
    ];
    const updated = await forumChannel.setAvailableTags(merged);
    for (const key of missing) {
      const found = updated.availableTags.find((t) => t.name === TAG_NAMES[key]);
      if (found) tagIds[key] = found.id;
    }
  }

  await updateGuildConfig(guildId, { gameNightTagIds: tagIds });
  return tagIds;
}

export function resolvedGameNightTag(
  tagIds: Record<string, string>,
  status: GameNightTagKey,
): string[] {
  return [tagIds[status]].filter(Boolean) as string[];
}
