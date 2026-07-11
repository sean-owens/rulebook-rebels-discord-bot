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
    };
    const fresh = await createShortLink('https://app.bgstatsapp.com/createPlay.html?data=new');

    const { saveShortLinks, loadShortLinks: reload } = await import('../src/utils/shortLinkStorage');
    const all = await reload();
    await saveShortLinks([...all, expired]);

    await cleanupExpiredShortLinks();

    const remaining = await loadShortLinks();
    expect(remaining.map((l) => l.code)).toEqual([fresh.code]);
  });
});
