import { Client } from 'discord.js';
import { checkPendingLocks, deleteArchivedChannels, archiveExpiredEvents } from '../utils/archive';
import { checkPendingSchedules } from '../utils/scheduler';
import { checkExpiredRooms } from '../commands/room';
import { cleanupExpiredShortLinks } from '../utils/shortLinkStorage';
import { hydrateSellDrafts } from '../commands/marketplace';
import { checkBggCatalogReminder } from '../utils/bggCatalogReminder';
import { checkAndAdvanceChallengeSchedule } from '../utils/boardGameChallenge';

// Pure so it can be tested against a fixed `now` instead of the real wall clock.
export function msUntilNextHour(now: Date): number {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next.getTime() - now.getTime();
}

function runHourlyChecks(client: Client): void {
  checkPendingLocks(client).catch((err) => console.warn('Lock check failed:', err));
  deleteArchivedChannels(client).catch((err) => console.warn('Archive cleanup failed:', err));
  archiveExpiredEvents(client).catch((err) => console.warn('Expired event check failed:', err));
  checkPendingSchedules(client).catch((err) => console.warn('Lineup lock/schedule check failed:', err));
  checkExpiredRooms(client).catch((err) => console.warn('Private room expiry check failed:', err));
  cleanupExpiredShortLinks().catch((err) => console.warn('Short link cleanup failed:', err));
  checkBggCatalogReminder(client).catch((err) => console.warn('BGG catalog reminder check failed:', err));
  checkAndAdvanceChallengeSchedule(client).catch((err) => console.warn('Board game challenge schedule check failed:', err));
}

// Runs on the hour, every hour, instead of a fixed 60-minute interval
// anchored to whenever the bot last started. Hour-of-day-based schedules —
// the board game challenge's hint/reveal times chief among them, where only
// the hour is configurable, not the minute (see /admin challenge config) —
// otherwise post anywhere up to 59 minutes after their configured time, with
// the exact offset shifting on every restart/redeploy. Recomputes the delay
// to the next hour boundary on every tick, via a self-rescheduling
// setTimeout, rather than a single long-lived setInterval, so it can't
// accumulate drift over long uptimes.
export function scheduleHourlyChecks(client: Client): void {
  setTimeout(() => {
    runHourlyChecks(client);
    scheduleHourlyChecks(client);
  }, msUntilNextHour(new Date()));
}

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

  scheduleHourlyChecks(client);
}
