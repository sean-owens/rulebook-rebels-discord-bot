import { Client } from 'discord.js';
import { checkPendingLocks, deleteArchivedChannels, archiveExpiredEvents } from '../utils/archive';
import { checkPendingSchedules } from '../utils/scheduler';
import { checkExpiredRooms } from '../commands/room';
import { cleanupExpiredShortLinks } from '../utils/shortLinkStorage';
import { hydrateSellDrafts } from '../commands/marketplace';
import { checkBggCatalogReminder } from '../utils/bggCatalogReminder';
import { checkAndAdvanceChallengeSchedule } from '../utils/boardGameChallenge';

const LOCK_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function handleReady(client: Client): void {
  console.log(`Logged in as ${client.user?.tag}`);

  checkPendingLocks(client).catch((err) => console.warn('Lock check failed on startup:', err));
  deleteArchivedChannels(client).catch((err) => console.warn('Archive cleanup failed on startup:', err));
  archiveExpiredEvents(client).catch((err) => console.warn('Expired event check failed on startup:', err));
  checkPendingSchedules(client).catch((err) => console.warn('Lineup lock/schedule check failed on startup:', err));
  checkExpiredRooms(client).catch((err) => console.warn('Private room expiry check failed on startup:', err));
  cleanupExpiredShortLinks().catch((err) => console.warn('Short link cleanup failed on startup:', err));
  hydrateSellDrafts().catch((err) => console.warn('Sell draft recovery failed on startup:', err));
  checkBggCatalogReminder(client).catch((err) => console.warn('BGG catalog reminder check failed on startup:', err));
  checkAndAdvanceChallengeSchedule(client).catch((err) => console.warn('Board game challenge schedule check failed on startup:', err));

  setInterval(() => {
    checkPendingLocks(client).catch((err) => console.warn('Lock check failed:', err));
    deleteArchivedChannels(client).catch((err) => console.warn('Archive cleanup failed:', err));
    archiveExpiredEvents(client).catch((err) => console.warn('Expired event check failed:', err));
    checkPendingSchedules(client).catch((err) => console.warn('Lineup lock/schedule check failed:', err));
    checkExpiredRooms(client).catch((err) => console.warn('Private room expiry check failed:', err));
    cleanupExpiredShortLinks().catch((err) => console.warn('Short link cleanup failed:', err));
    checkBggCatalogReminder(client).catch((err) => console.warn('BGG catalog reminder check failed:', err));
    checkAndAdvanceChallengeSchedule(client).catch((err) => console.warn('Board game challenge schedule check failed:', err));
  }, LOCK_CHECK_INTERVAL_MS);
}
