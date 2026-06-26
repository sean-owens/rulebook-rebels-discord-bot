import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readJson, writeJson } from '../src/utils/db';
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
    it('returns the fallback when file does not exist', () => {
      expect(readJson('missing.json', [])).toEqual([]);
      expect(readJson('missing.json', { x: 1 })).toEqual({ x: 1 });
    });

    it('reads and parses an existing file', () => {
      const dataPath = path.join(tmpDir, 'data');
      fs.mkdirSync(dataPath);
      fs.writeFileSync(path.join(dataPath, 'test.json'), JSON.stringify({ hello: 'world' }));
      expect(readJson('test.json', null)).toEqual({ hello: 'world' });
    });

    it('creates the data directory when it does not exist', () => {
      readJson('anything.json', []);
      expect(fs.existsSync(path.join(tmpDir, 'data'))).toBe(true);
    });
  });

  describe('writeJson', () => {
    it('writes data as formatted JSON', () => {
      writeJson('out.json', { key: 'value' });
      const raw = fs.readFileSync(path.join(tmpDir, 'data', 'out.json'), 'utf-8');
      expect(JSON.parse(raw)).toEqual({ key: 'value' });
    });

    it('creates the data directory when it does not exist', () => {
      writeJson('out.json', []);
      expect(fs.existsSync(path.join(tmpDir, 'data'))).toBe(true);
    });

    it('overwrites an existing file', () => {
      writeJson('overwrite.json', { v: 1 });
      writeJson('overwrite.json', { v: 2 });
      expect(readJson('overwrite.json', null)).toEqual({ v: 2 });
    });
  });

  it('round-trips an array of objects without data loss', () => {
    const data = [{ id: 'abc', name: 'Test', active: true }];
    writeJson('roundtrip.json', data);
    expect(readJson('roundtrip.json', [])).toEqual(data);
  });

  it('supports multiple independent files', () => {
    writeJson('a.json', { label: 'A' });
    writeJson('b.json', { label: 'B' });
    expect(readJson('a.json', null)).toEqual({ label: 'A' });
    expect(readJson('b.json', null)).toEqual({ label: 'B' });
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

  it('returns default config when guild has no saved config', () => {
    const cfg = getGuildConfig('guild-1');
    expect(cfg.defaultLocation).toBe('');
    expect(cfg.openEventChannels).toBe(false);
  });

  it('saves and retrieves a config value for a guild', () => {
    updateGuildConfig('guild-1', { defaultLocation: 'Library Room 1' });
    expect(getGuildConfig('guild-1').defaultLocation).toBe('Library Room 1');
  });

  it('merges partial updates without overwriting unset fields', () => {
    updateGuildConfig('guild-1', { defaultLocation: 'Library Room 1' });
    updateGuildConfig('guild-1', { defaultTime: '7:00 PM' });
    const cfg = getGuildConfig('guild-1');
    expect(cfg.defaultLocation).toBe('Library Room 1');
    expect(cfg.defaultTime).toBe('7:00 PM');
  });

  it('isolates config between different guilds', () => {
    updateGuildConfig('guild-1', { defaultLocation: 'Venue A' });
    updateGuildConfig('guild-2', { defaultLocation: 'Venue B' });
    expect(getGuildConfig('guild-1').defaultLocation).toBe('Venue A');
    expect(getGuildConfig('guild-2').defaultLocation).toBe('Venue B');
  });

  it('returns updated config from updateGuildConfig', () => {
    const result = updateGuildConfig('guild-1', { openEventChannels: true });
    expect(result.openEventChannels).toBe(true);
  });
});
