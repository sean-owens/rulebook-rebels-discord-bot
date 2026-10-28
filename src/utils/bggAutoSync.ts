import { Client } from 'discord.js';
import { BggAccount, listAllBggAccounts, recordBggSyncAttempt } from './bggAccountStorage';
import { fetchBggOwnedCollection } from './bgg';
import { applyBggCollectionToLibrary, BggSyncSummary } from './bggLibrarySync';
import { bggAutoSyncDaysFor, getGuildConfig } from './config';
import { getUserCollection } from './userCollectionStorage';

// Pacing, deliberately conservative — BGG's terms ask for minimal request volume and
// no polling loops (see CLAUDE.md §4). Each account is due only every N days, at most
// MAX_PER_RUN are processed per hourly tick (so a backlog drains over a few hours rather
// than in a burst), with a pause between them, and a failing account backs off rather
// than being retried every tick.
export const BGG_AUTO_SYNC_MAX_PER_RUN = 5;
export const BGG_AUTO_SYNC_GAP_MS = 5000;
export const BGG_AUTO_SYNC_RETRY_BACKOFF_HOURS = 6;
const DM_NAME_LIMIT = 10;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Whether an account's automatic re-sync is due. Pure so the schedule can be tested
// against a fixed `now`. A never-synced account is due immediately (once eligible —
// see hasImportedBefore), which is how accounts that imported before this feature
// existed get picked up.
export function isBggSyncDue(
  account: Pick<BggAccount, 'lastSyncedAt' | 'lastSyncAttemptAt'>,
  intervalDays: number,
  now: Date,
): boolean {
  if (intervalDays <= 0) return false;
  if (account.lastSyncAttemptAt && now.getTime() - Date.parse(account.lastSyncAttemptAt) < BGG_AUTO_SYNC_RETRY_BACKOFF_HOURS * HOUR_MS) {
    return false;
  }
  if (!account.lastSyncedAt) return true;
  return now.getTime() - Date.parse(account.lastSyncedAt) >= intervalDays * DAY_MS;
}

// Only members who have imported from BGG before are synced automatically. Linking an
// account alone isn't consent to fill their library — someone may have linked purely
// for their profile or the marketplace. A prior import leaves a snapshot behind even
// for accounts that predate lastSyncedAt.
async function hasImportedBefore(guildId: string, account: BggAccount): Promise<boolean> {
  if (account.lastSyncedAt) return true;
  return (await getUserCollection(guildId, account.userId)).length > 0;
}

// The DM sent when an automatic sync added something. Null when there's nothing to say —
// no news is deliberately no message, so a quiet week costs the member nothing.
export function buildAutoSyncDm(summary: BggSyncSummary): string | null {
  if (summary.addedGames === 0 && summary.addedExpansions === 0) return null;

  const names = (list: string[]) => {
    const shown = list.slice(0, DM_NAME_LIMIT).join(', ');
    return list.length > DM_NAME_LIMIT ? `${shown} and ${list.length - DM_NAME_LIMIT} more` : shown;
  };
  const lines = ['📚 I checked your BoardGameGeek collection and added what was new to the group library:'];
  if (summary.addedGames > 0) {
    lines.push(`• **${summary.addedGames}** game${summary.addedGames !== 1 ? 's' : ''}: ${names(summary.addedGameNames)}`);
  }
  if (summary.addedExpansions > 0) {
    lines.push(
      `• **${summary.addedExpansions}** expansion${summary.addedExpansions !== 1 ? 's' : ''}: ${names(summary.addedExpansionNames)}`,
    );
  }
  lines.push('', "-# Don't want a game listed? `/library remove` it and it stays removed. To stop automatic syncing, use `/bgg unlink`.");
  return lines.join('\n');
}

// Side effect: DMs the member. Best-effort — closed DMs must never fail a sync that
// already succeeded.
async function sendAutoSyncDm(client: Client, userId: string, content: string): Promise<void> {
  try {
    const user = await client.users.fetch(userId);
    await user.send({ content });
  } catch (err) {
    console.warn(`[BggAutoSync] Could not DM ${userId} their sync summary:`, err);
  }
}

// Syncs one member. Returns the summary, or null if BGG couldn't be reached.
// Records the attempt either way so a failure backs off instead of retrying hourly.
// `now` is the sweep's own clock, so what's recorded here and what isBggSyncDue
// later compares against can't disagree.
export async function syncAccountFromBgg(
  client: Client,
  guildId: string,
  account: BggAccount,
  now: Date = new Date(),
): Promise<BggSyncSummary | null> {
  const attemptedAt = now.toISOString();

  let games;
  try {
    games = await fetchBggOwnedCollection(account.bggUsername);
  } catch (err) {
    console.warn(`[BggAutoSync] Fetch failed for ${account.bggUsername} in guild ${guildId}:`, err);
    games = null;
  }

  if (!games) {
    await recordBggSyncAttempt(guildId, account.userId, { at: attemptedAt, success: false });
    console.warn(`[BggAutoSync] Could not reach BGG for ${account.bggUsername} in guild ${guildId}; will retry later`);
    return null;
  }

  const summary = await applyBggCollectionToLibrary(guildId, account.userId, games, 'new-only');
  await recordBggSyncAttempt(guildId, account.userId, { at: attemptedAt, success: true });

  const dm = buildAutoSyncDm(summary);
  if (dm) await sendAutoSyncDm(client, account.userId, dm);

  console.log(
    `[BggAutoSync] ${account.bggUsername} (guild ${guildId}): +${summary.addedGames} games, +${summary.addedExpansions} expansions`,
  );
  return summary;
}

let running = false;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Hourly sweep. Picks the longest-overdue eligible accounts, up to the per-run cap, and
// syncs them one at a time. Safe to call overlapping (startup + the hourly tick): a run
// already in flight makes the second a no-op.
export async function checkBggAutoSync(client: Client, opts: { gapMs?: number; now?: Date } = {}): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = opts.now ?? new Date();
    const gapMs = opts.gapMs ?? BGG_AUTO_SYNC_GAP_MS;

    const intervalByGuild = new Map<string, number>();
    const due: Array<BggAccount & { guildId: string }> = [];
    for (const account of await listAllBggAccounts()) {
      if (!intervalByGuild.has(account.guildId)) {
        intervalByGuild.set(account.guildId, bggAutoSyncDaysFor(await getGuildConfig(account.guildId)));
      }
      if (!isBggSyncDue(account, intervalByGuild.get(account.guildId)!, now)) continue;
      if (!(await hasImportedBefore(account.guildId, account))) continue;
      due.push(account);
    }

    // Longest-overdue first (never-synced counts as oldest), so nobody starves behind a backlog.
    due.sort((a, b) => Date.parse(a.lastSyncedAt ?? '1970-01-01') - Date.parse(b.lastSyncedAt ?? '1970-01-01'));

    const batch = due.slice(0, BGG_AUTO_SYNC_MAX_PER_RUN);
    for (let i = 0; i < batch.length; i++) {
      if (i > 0) await sleep(gapMs);
      const account = batch[i];
      try {
        // A member who has left the server shouldn't keep costing BGG requests.
        const guild = await client.guilds.fetch(account.guildId);
        await guild.members.fetch(account.userId);
      } catch {
        await recordBggSyncAttempt(account.guildId, account.userId, { at: now.toISOString(), success: false });
        continue;
      }
      try {
        await syncAccountFromBgg(client, account.guildId, account, now);
      } catch (err) {
        console.error(`[BggAutoSync] Sync failed for ${account.userId} in guild ${account.guildId}:`, err);
      }
    }
  } finally {
    running = false;
  }
}
