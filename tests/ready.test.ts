import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCheckPendingLocks = vi.fn().mockResolvedValue(undefined);
const mockDeleteArchivedChannels = vi.fn().mockResolvedValue(undefined);
const mockArchiveExpiredEvents = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/utils/archive', () => ({
  checkPendingLocks: (...args: unknown[]) => mockCheckPendingLocks(...args),
  deleteArchivedChannels: (...args: unknown[]) => mockDeleteArchivedChannels(...args),
  archiveExpiredEvents: (...args: unknown[]) => mockArchiveExpiredEvents(...args),
}));

const mockCheckPendingSchedules = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/utils/scheduler', () => ({
  checkPendingSchedules: (...args: unknown[]) => mockCheckPendingSchedules(...args),
}));

const mockCheckExpiredRooms = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/commands/room', () => ({
  checkExpiredRooms: (...args: unknown[]) => mockCheckExpiredRooms(...args),
}));

const mockCleanupExpiredShortLinks = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/utils/shortLinkStorage', () => ({
  cleanupExpiredShortLinks: (...args: unknown[]) => mockCleanupExpiredShortLinks(...args),
}));

const mockHydrateSellDrafts = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/commands/marketplace', () => ({
  hydrateSellDrafts: (...args: unknown[]) => mockHydrateSellDrafts(...args),
}));

const mockCheckBggCatalogReminder = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/utils/bggCatalogReminder', () => ({
  checkBggCatalogReminder: (...args: unknown[]) => mockCheckBggCatalogReminder(...args),
}));

const mockCheckAndAdvanceChallengeSchedule = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/utils/boardGameChallenge', () => ({
  checkAndAdvanceChallengeSchedule: (...args: unknown[]) => mockCheckAndAdvanceChallengeSchedule(...args),
}));

import { handleReady, msUntilNextHour } from '../src/events/ready';

function makeClient() {
  return { user: { tag: 'bot#0001' } };
}

describe('msUntilNextHour', () => {
  it('returns the exact ms remaining to the next top of the hour', () => {
    expect(msUntilNextHour(new Date('2026-09-02T12:04:00.000Z'))).toBe(56 * 60 * 1000);
  });

  it('returns a full hour when already exactly on the hour', () => {
    expect(msUntilNextHour(new Date('2026-09-02T12:00:00.000Z'))).toBe(60 * 60 * 1000);
  });

  it('returns a few ms when a moment away from the next hour', () => {
    expect(msUntilNextHour(new Date('2026-09-02T12:59:59.500Z'))).toBe(500);
  });

  it('rolls over correctly at a day boundary', () => {
    expect(msUntilNextHour(new Date('2026-09-02T23:45:00.000Z'))).toBe(15 * 60 * 1000);
  });
});

describe('handleReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs every check immediately on startup', () => {
    vi.setSystemTime(new Date('2026-09-02T12:04:00.000Z'));
    handleReady(makeClient() as any);

    expect(mockCheckPendingLocks).toHaveBeenCalledTimes(1);
    expect(mockDeleteArchivedChannels).toHaveBeenCalledTimes(1);
    expect(mockArchiveExpiredEvents).toHaveBeenCalledTimes(1);
    expect(mockCheckPendingSchedules).toHaveBeenCalledTimes(1);
    expect(mockCheckExpiredRooms).toHaveBeenCalledTimes(1);
    expect(mockCleanupExpiredShortLinks).toHaveBeenCalledTimes(1);
    expect(mockHydrateSellDrafts).toHaveBeenCalledTimes(1);
    expect(mockCheckBggCatalogReminder).toHaveBeenCalledTimes(1);
    expect(mockCheckAndAdvanceChallengeSchedule).toHaveBeenCalledTimes(1);
  });

  it('does not run the checks again before the next hour boundary', () => {
    vi.setSystemTime(new Date('2026-09-02T12:04:00.000Z'));
    handleReady(makeClient() as any);
    vi.clearAllMocks(); // isolate the startup run from what follows

    vi.advanceTimersByTime(55 * 60 * 1000); // 12:59 — 1 minute short of 1pm
    expect(mockCheckAndAdvanceChallengeSchedule).not.toHaveBeenCalled();
  });

  it('re-runs every check exactly on the next hour boundary regardless of the startup offset', () => {
    vi.setSystemTime(new Date('2026-09-02T12:04:00.000Z')); // started 4 minutes past the hour
    handleReady(makeClient() as any);
    vi.clearAllMocks();

    vi.advanceTimersByTime(56 * 60 * 1000); // exactly 1:00pm
    expect(mockCheckAndAdvanceChallengeSchedule).toHaveBeenCalledTimes(1);
    expect(mockCheckPendingLocks).toHaveBeenCalledTimes(1);
  });

  it('keeps re-arming itself on the hour, every hour, without drifting', () => {
    vi.setSystemTime(new Date('2026-09-02T12:04:00.000Z'));
    handleReady(makeClient() as any);
    vi.clearAllMocks();

    vi.advanceTimersByTime(56 * 60 * 1000); // 1:00pm
    expect(mockCheckAndAdvanceChallengeSchedule).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60 * 60 * 1000); // 2:00pm
    expect(mockCheckAndAdvanceChallengeSchedule).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60 * 60 * 1000); // 3:00pm
    expect(mockCheckAndAdvanceChallengeSchedule).toHaveBeenCalledTimes(3);
  });
});
