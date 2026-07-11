import { Client } from 'discord.js';
import { getBggAccount } from './bggAccountStorage';

/**
 * Resolves display names for a batch of Discord user IDs, preferring each
 * member's linked BGG username (see /bgg link) over their Discord display
 * name — used when building BG Stats player rosters (see bgStats.ts) so
 * plays match against a member's existing BG Stats player history rather
 * than creating a duplicate entry under their Discord name.
 */
export async function resolvePlayerNames(
  client: Client,
  guildId: string,
  userIds: string[],
): Promise<Record<string, string>> {
  const nameMap: Record<string, string> = {};
  const guild = await client.guilds.fetch(guildId).catch(() => null);

  await Promise.all(
    userIds.map(async (id) => {
      const bggAccount = await getBggAccount(guildId, id).catch(() => undefined);
      if (bggAccount?.bggUsername) {
        nameMap[id] = bggAccount.bggUsername;
        return;
      }
      try {
        nameMap[id] = (await guild!.members.fetch(id)).displayName;
      } catch {
        nameMap[id] = id;
      }
    }),
  );

  return nameMap;
}
