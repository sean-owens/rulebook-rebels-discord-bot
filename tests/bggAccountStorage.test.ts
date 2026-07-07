import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getBggAccount, setBggAccount, removeBggAccount } from '../src/utils/bggAccountStorage';

describe('bggAccountStorage', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-bgg-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const G = 'guild1';
  const U = 'user1';

  it('returns undefined when no account is linked', async () => {
    expect(await getBggAccount(G, U)).toBeUndefined();
  });

  it('stores and retrieves a linked account', async () => {
    await setBggAccount(G, U, 'boardgamefan');
    const account = await getBggAccount(G, U);
    expect(account?.bggUsername).toBe('boardgamefan');
    expect(account?.userId).toBe(U);
    expect(account?.linkedAt).toBeTruthy();
  });

  it('overwrites an existing link with a new username', async () => {
    await setBggAccount(G, U, 'oldname');
    await setBggAccount(G, U, 'newname');
    expect((await getBggAccount(G, U))?.bggUsername).toBe('newname');
  });

  it('does not affect other users in the same guild', async () => {
    await setBggAccount(G, U, 'user1bgg');
    await setBggAccount(G, 'user2', 'user2bgg');
    expect((await getBggAccount(G, U))?.bggUsername).toBe('user1bgg');
    expect((await getBggAccount(G, 'user2'))?.bggUsername).toBe('user2bgg');
  });

  it('does not affect other guilds', async () => {
    await setBggAccount(G, U, 'user1bgg');
    await setBggAccount('guild2', U, 'otherbgg');
    expect((await getBggAccount(G, U))?.bggUsername).toBe('user1bgg');
    expect((await getBggAccount('guild2', U))?.bggUsername).toBe('otherbgg');
  });

  it('removes a linked account and returns true', async () => {
    await setBggAccount(G, U, 'boardgamefan');
    const result = await removeBggAccount(G, U);
    expect(result).toBe(true);
    expect(await getBggAccount(G, U)).toBeUndefined();
  });

  it('returns false when removing a non-existent account', async () => {
    expect(await removeBggAccount(G, U)).toBe(false);
  });

  it('only removes the target user, not others in the same guild', async () => {
    await setBggAccount(G, U, 'user1bgg');
    await setBggAccount(G, 'user2', 'user2bgg');
    await removeBggAccount(G, U);
    expect((await getBggAccount(G, 'user2'))?.bggUsername).toBe('user2bgg');
  });
});
