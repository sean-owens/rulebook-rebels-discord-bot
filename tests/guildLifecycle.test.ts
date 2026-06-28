import { describe, it, expect, beforeEach, vi } from 'vitest';
import { markGuildDeleted, restoreGuild, runRetentionCleanup } from '../src/utils/guildLifecycle';

// Mock db.ts so tests don't touch the filesystem
vi.mock('../src/utils/db', () => {
  const store: Record<string, unknown> = {};
  return {
    readJson: vi.fn((filename: string, fallback: unknown) => store[filename] ?? fallback),
    writeJson: vi.fn((filename: string, data: unknown) => {
      store[filename] = data;
    }),
  };
});

import { readJson, writeJson } from '../src/utils/db';

function setFile(filename: string, data: unknown) {
  (readJson as ReturnType<typeof vi.fn>).mockImplementation((f: string, fallback: unknown) => {
    const store: Record<string, unknown> = (
      setFile as unknown as { _store: Record<string, unknown> }
    )._store;
    return f in store ? store[f] : fallback;
  });
  const s = (setFile as unknown as { _store: Record<string, unknown> })._store;
  s[filename] = data;
}
(setFile as unknown as { _store: Record<string, unknown> })._store = {};

// Simpler approach: use the mock's captured calls to verify writes
function getLastWrite(filename: string): unknown {
  const calls = (writeJson as ReturnType<typeof vi.fn>).mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0] === filename) return calls[i][1];
  }
  return undefined;
}

describe('guildLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (readJson as ReturnType<typeof vi.fn>).mockImplementation(
      (_: string, fallback: unknown) => fallback,
    );
  });

  describe('markGuildDeleted', () => {
    it('adds an entry to deleted_guilds.json with a deletedAt timestamp', () => {
      markGuildDeleted('guild-1', 'Test Server');
      const written = getLastWrite('deleted_guilds.json') as Array<{
        guildId: string;
        guildName: string;
        deletedAt: string;
      }>;
      expect(written).toHaveLength(1);
      expect(written[0].guildId).toBe('guild-1');
      expect(written[0].guildName).toBe('Test Server');
      expect(written[0].deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it('replaces an existing entry for the same guild (no duplicates)', () => {
      (readJson as ReturnType<typeof vi.fn>).mockReturnValue([
        { guildId: 'guild-1', guildName: 'Test Server', deletedAt: '2025-01-01T00:00:00.000Z' },
      ]);
      markGuildDeleted('guild-1', 'Test Server');
      const written = getLastWrite('deleted_guilds.json') as unknown[];
      expect(written).toHaveLength(1);
    });
  });

  describe('restoreGuild', () => {
    it('returns false when the guild is not pending deletion', () => {
      expect(restoreGuild('guild-1')).toBe(false);
    });

    it('returns true and removes the entry when the guild is pending deletion', () => {
      (readJson as ReturnType<typeof vi.fn>).mockReturnValue([
        { guildId: 'guild-1', guildName: 'Test Server', deletedAt: '2025-01-01T00:00:00.000Z' },
        { guildId: 'guild-2', guildName: 'Other Server', deletedAt: '2025-01-01T00:00:00.000Z' },
      ]);
      const result = restoreGuild('guild-1');
      expect(result).toBe(true);
      const written = getLastWrite('deleted_guilds.json') as Array<{ guildId: string }>;
      expect(written).toHaveLength(1);
      expect(written[0].guildId).toBe('guild-2');
    });
  });

  describe('runRetentionCleanup', () => {
    it('does nothing when no guilds are pending deletion', () => {
      runRetentionCleanup();
      expect(writeJson).not.toHaveBeenCalled();
    });

    it('does not purge guilds deleted less than 30 days ago', () => {
      const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      (readJson as ReturnType<typeof vi.fn>).mockReturnValue([
        { guildId: 'guild-1', guildName: 'Recent Server', deletedAt: recentDate },
      ]);
      runRetentionCleanup();
      // No writes should happen — guild is within retention window
      expect(writeJson).not.toHaveBeenCalled();
    });

    it('purges and removes guilds deleted more than 30 days ago', () => {
      const expiredDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      (readJson as ReturnType<typeof vi.fn>).mockReturnValue([
        { guildId: 'guild-expired', guildName: 'Old Server', deletedAt: expiredDate },
        { guildId: 'guild-recent', guildName: 'New Server', deletedAt: recentDate },
      ]);
      runRetentionCleanup();
      // deleted_guilds.json should be updated to only contain the recent guild
      const updatedList = getLastWrite('deleted_guilds.json') as Array<{ guildId: string }>;
      expect(updatedList).toHaveLength(1);
      expect(updatedList[0].guildId).toBe('guild-recent');
    });
  });
});
