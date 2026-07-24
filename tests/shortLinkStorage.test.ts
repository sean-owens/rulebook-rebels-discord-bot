import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadShortLinks,
  findShortLink,
  createShortLink,
  cleanupExpiredShortLinks,
  generateShortCode,
  recordShortLinkOpen,
  getShortLinkStatsForGame,
  ShortLink,
} from '../src/utils/shortLinkStorage';

describe('shortLinkStorage', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-shortlink-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty array when no short links exist', async () => {
    expect(await loadShortLinks()).toEqual([]);
  });

  it('generates URL-safe codes', () => {
    const code = generateShortCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('creates a short link with a future expiration and persists it', async () => {
    const link = await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=abc');
    expect(link.url).toBe('https://app.bgstatsapp.com/createPlay.html?data=abc');
    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const found = await findShortLink(link.code);
    expect(found).toEqual(link);
  });

  it('returns undefined for an unknown code', async () => {
    expect(await findShortLink('nope')).toBeUndefined();
  });

  it('removes expired links but keeps unexpired ones on cleanup', async () => {
    const expired: ShortLink = {
      code: 'expired1',
      url: 'https://app.bgstatsapp.com/createPlay.html?data=old',
      createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      openCount: 0,
    };
    const fresh = await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=new');

    const { saveShortLinks, loadShortLinks: reload } = await import('../src/utils/shortLinkStorage');
    const all = await reload();
    await saveShortLinks([...all, expired]);

    await cleanupExpiredShortLinks();

    const remaining = await loadShortLinks();
    expect(remaining.map((l) => l.code)).toEqual([fresh.code]);
  });

  describe('recordShortLinkOpen', () => {
    it('increments openCount and sets lastOpenedAt on an existing link', async () => {
      const link = await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=abc');
      expect(link.openCount).toBe(0);

      await recordShortLinkOpen(link.code);
      const once = await findShortLink(link.code);
      expect(once?.openCount).toBe(1);
      expect(once?.lastOpenedAt).toBeDefined();

      await recordShortLinkOpen(link.code);
      const twice = await findShortLink(link.code);
      expect(twice?.openCount).toBe(2);
    });

    it('is a no-op for an unknown code', async () => {
      await expect(recordShortLinkOpen('does-not-exist')).resolves.toBeUndefined();
    });
  });

  describe('getShortLinkStatsForGame', () => {
    it('sums opens across multiple short links created for the same game', async () => {
      const first = await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=1', {
        guildId: 'g1',
        eventId: 'e1',
        gameId: 'game1',
      });
      const second = await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=2', {
        guildId: 'g1',
        eventId: 'e1',
        gameId: 'game1',
      });
      await recordShortLinkOpen(first.code);
      await recordShortLinkOpen(second.code);
      await recordShortLinkOpen(second.code);

      const stats = await getShortLinkStatsForGame('g1', 'e1', 'game1');
      expect(stats.openCount).toBe(3);
      expect(stats.lastOpenedAt).toBeDefined();
    });

    it('ignores short links for other games/events/guilds', async () => {
      const own = await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=own', {
        guildId: 'g1',
        eventId: 'e1',
        gameId: 'game1',
      });
      await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=other-game', {
        guildId: 'g1',
        eventId: 'e1',
        gameId: 'game2',
      });
      await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=other-guild', {
        guildId: 'g2',
        eventId: 'e1',
        gameId: 'game1',
      });
      await recordShortLinkOpen(own.code);

      const stats = await getShortLinkStatsForGame('g1', 'e1', 'game1');
      expect(stats.openCount).toBe(1);
    });

    it('returns zero opens and no lastOpenedAt when nothing matches', async () => {
      const stats = await getShortLinkStatsForGame('g1', 'e1', 'game1');
      expect(stats).toEqual({ openCount: 0, lastOpenedAt: undefined });
    });
  });
});
