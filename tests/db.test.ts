import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readJson, writeJson, clearReadCache } from '../src/utils/db';
import { getGuildConfig, updateGuildConfig } from '../src/utils/config';

describe('db', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readJson', () => {
    it('returns the fallback when file does not exist', async () => {
      expect(await readJson('missing.json', [])).toEqual([]);
      expect(await readJson('missing.json', { x: 1 })).toEqual({ x: 1 });
    });

    it('reads and parses an existing file', async () => {
      const dataPath = path.join(tmpDir, 'data');
      fs.mkdirSync(dataPath);
      fs.writeFileSync(path.join(dataPath, 'test.json'), JSON.stringify({ hello: 'world' }));
      expect(await readJson('test.json', null)).toEqual({ hello: 'world' });
    });

    it('creates the data directory when it does not exist', async () => {
      await readJson('anything.json', []);
      expect(fs.existsSync(path.join(tmpDir, 'data'))).toBe(true);
    });
  });

  describe('writeJson', () => {
    it('writes data as formatted JSON', async () => {
      await writeJson('out.json', { key: 'value' });
      const raw = fs.readFileSync(path.join(tmpDir, 'data', 'out.json'), 'utf-8');
      expect(JSON.parse(raw)).toEqual({ key: 'value' });
    });

    it('creates the data directory when it does not exist', async () => {
      await writeJson('out.json', []);
      expect(fs.existsSync(path.join(tmpDir, 'data'))).toBe(true);
    });

    it('overwrites an existing file', async () => {
      await writeJson('overwrite.json', { v: 1 });
      await writeJson('overwrite.json', { v: 2 });
      expect(await readJson('overwrite.json', null)).toEqual({ v: 2 });
    });
  });

  it('round-trips an array of objects without data loss', async () => {
    const data = [{ id: 'abc', name: 'Test', active: true }];
    await writeJson('roundtrip.json', data);
    expect(await readJson('roundtrip.json', [])).toEqual(data);
  });

  it('supports multiple independent files', async () => {
    await writeJson('a.json', { label: 'A' });
    await writeJson('b.json', { label: 'B' });
    expect(await readJson('a.json', null)).toEqual({ label: 'A' });
    expect(await readJson('b.json', null)).toEqual({ label: 'B' });
  });

  describe('read cache', () => {
    afterEach(() => {
      clearReadCache();
    });

    it('does not hit disk again on a second read of the same file', async () => {
      await writeJson('cached.json', { v: 1 });
      clearReadCache(); // force the first read below to actually hit disk once
      await readJson('cached.json', null);

      const readSpy = vi.spyOn(fs, 'readFileSync');
      const result = await readJson('cached.json', null);

      expect(result).toEqual({ v: 1 });
      expect(readSpy).not.toHaveBeenCalled();
      readSpy.mockRestore();
    });

    it('serves the new value from cache after a write, without re-reading disk', async () => {
      await writeJson('written.json', { v: 1 });
      await readJson('written.json', null); // populate cache

      const readSpy = vi.spyOn(fs, 'readFileSync');
      await writeJson('written.json', { v: 2 });
      const result = await readJson('written.json', null);

      expect(result).toEqual({ v: 2 });
      expect(readSpy).not.toHaveBeenCalled();
      readSpy.mockRestore();
    });

    it('caches a "file not found" result and keeps returning the fallback', async () => {
      const first = await readJson('never-created.json', { fallback: true });
      const readSpy = vi.spyOn(fs, 'existsSync');
      const second = await readJson('never-created.json', { fallback: true });

      expect(first).toEqual({ fallback: true });
      expect(second).toEqual({ fallback: true });
      expect(readSpy).not.toHaveBeenCalled();
      readSpy.mockRestore();
    });

    it('picks the file up once written after being cached as not-found', async () => {
      await readJson('later.json', null); // caches as not-found
      await writeJson('later.json', { arrived: true });
      expect(await readJson('later.json', null)).toEqual({ arrived: true });
    });

    it('clearReadCache forces a fresh read from disk', async () => {
      await writeJson('reset.json', { v: 1 });
      await readJson('reset.json', null); // populate cache

      // Mutate the file directly on disk, bypassing writeJson (so the cache
      // wouldn't naturally know about it) — simulates cache going stale.
      fs.writeFileSync(path.join(tmpDir, 'data', 'reset.json'), JSON.stringify({ v: 2 }));

      clearReadCache();
      expect(await readJson('reset.json', null)).toEqual({ v: 2 });
    });

    it('does not cross-contaminate between different data directories', async () => {
      await writeJson('isolated.json', { from: 'dirA' });

      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-other-'));
      try {
        cwdSpy.mockReturnValue(otherDir);
        expect(await readJson('isolated.json', { from: 'fallback' })).toEqual({
          from: 'fallback',
        });
        await writeJson('isolated.json', { from: 'dirB' });
        expect(await readJson('isolated.json', null)).toEqual({ from: 'dirB' });
      } finally {
        cwdSpy.mockReturnValue(tmpDir);
        fs.rmSync(otherDir, { recursive: true, force: true });
      }

      // Back on the original tmpDir.
      expect(await readJson('isolated.json', null)).toEqual({ from: 'dirA' });
    });
  });
});

// ── GuildConfig ──────────────────────────────────────────────────────────────

describe('guildConfig', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns default config when guild has no saved config', async () => {
    const cfg = await getGuildConfig('guild-1');
    expect(cfg.defaultLocation).toBe('');
    expect(cfg.openEventChannels).toBe(false);
  });

  it('saves and retrieves a config value for a guild', async () => {
    await updateGuildConfig('guild-1', { defaultLocation: 'Library Room 1' });
    expect((await getGuildConfig('guild-1')).defaultLocation).toBe('Library Room 1');
  });

  it('merges partial updates without overwriting unset fields', async () => {
    await updateGuildConfig('guild-1', { defaultLocation: 'Library Room 1' });
    await updateGuildConfig('guild-1', { defaultTime: '7:00 PM' });
    const cfg = await getGuildConfig('guild-1');
    expect(cfg.defaultLocation).toBe('Library Room 1');
    expect(cfg.defaultTime).toBe('7:00 PM');
  });

  it('isolates config between different guilds', async () => {
    await updateGuildConfig('guild-1', { defaultLocation: 'Venue A' });
    await updateGuildConfig('guild-2', { defaultLocation: 'Venue B' });
    expect((await getGuildConfig('guild-1')).defaultLocation).toBe('Venue A');
    expect((await getGuildConfig('guild-2')).defaultLocation).toBe('Venue B');
  });

  it('returns updated config from updateGuildConfig', async () => {
    const result = await updateGuildConfig('guild-1', { openEventChannels: true });
    expect(result.openEventChannels).toBe(true);
  });
});
