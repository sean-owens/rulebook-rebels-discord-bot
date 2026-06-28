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

  it('returns undefined when no account is linked', () => {
    expect(getBggAccount(G, U)).toBeUndefined();
  });

  it('stores and retrieves a linked account', () => {
    setBggAccount(G, U, 'boardgamefan');
    const account = getBggAccount(G, U);
    expect(account?.bggUsername).toBe('boardgamefan');
    expect(account?.userId).toBe(U);
    expect(account?.linkedAt).toBeTruthy();
  });

  it('overwrites an existing link with a new username', () => {
    setBggAccount(G, U, 'oldname');
    setBggAccount(G, U, 'newname');
    expect(getBggAccount(G, U)?.bggUsername).toBe('newname');
  });

  it('does not affect other users in the same guild', () => {
    setBggAccount(G, U, 'user1bgg');
    setBggAccount(G, 'user2', 'user2bgg');
    expect(getBggAccount(G, U)?.bggUsername).toBe('user1bgg');
    expect(getBggAccount(G, 'user2')?.bggUsername).toBe('user2bgg');
  });

  it('does not affect other guilds', () => {
    setBggAccount(G, U, 'user1bgg');
    setBggAccount('guild2', U, 'otherbgg');
    expect(getBggAccount(G, U)?.bggUsername).toBe('user1bgg');
    expect(getBggAccount('guild2', U)?.bggUsername).toBe('otherbgg');
  });

  it('removes a linked account and returns true', () => {
    setBggAccount(G, U, 'boardgamefan');
    const result = removeBggAccount(G, U);
    expect(result).toBe(true);
    expect(getBggAccount(G, U)).toBeUndefined();
  });

  it('returns false when removing a non-existent account', () => {
    expect(removeBggAccount(G, U)).toBe(false);
  });

  it('only removes the target user, not others in the same guild', () => {
    setBggAccount(G, U, 'user1bgg');
    setBggAccount(G, 'user2', 'user2bgg');
    removeBggAccount(G, U);
    expect(getBggAccount(G, 'user2')?.bggUsername).toBe('user2bgg');
  });
});
