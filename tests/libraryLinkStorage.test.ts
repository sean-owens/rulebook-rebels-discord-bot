import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  addLibraryLink,
  removeLibraryLink,
  getEffectiveOwnerIds,
  getLibraryLinksForGuild,
} from '../src/utils/libraryLinkStorage';

describe('libraryLinkStorage', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-library-link-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getEffectiveOwnerIds', () => {
    it('always includes the user themselves, even with no links', async () => {
      expect(await getEffectiveOwnerIds('g1', 'alice')).toEqual(['alice']);
    });

    it("includes anyone who's granted the user delegate access", async () => {
      await addLibraryLink('g1', 'alice', 'bob'); // alice shares her library with bob
      expect(await getEffectiveOwnerIds('g1', 'bob')).toEqual(['bob', 'alice']);
    });

    it('does not grant the reverse direction automatically', async () => {
      await addLibraryLink('g1', 'alice', 'bob');
      expect(await getEffectiveOwnerIds('g1', 'alice')).toEqual(['alice']);
    });

    it('supports full mutual sharing via two separate calls', async () => {
      await addLibraryLink('g1', 'alice', 'bob');
      await addLibraryLink('g1', 'bob', 'alice');
      expect(await getEffectiveOwnerIds('g1', 'alice')).toEqual(['alice', 'bob']);
      expect(await getEffectiveOwnerIds('g1', 'bob')).toEqual(['bob', 'alice']);
    });

    it('scopes links to their own guild', async () => {
      await addLibraryLink('g1', 'alice', 'bob');
      expect(await getEffectiveOwnerIds('g2', 'bob')).toEqual(['bob']);
    });
  });

  describe('addLibraryLink', () => {
    it("doesn't create a duplicate grant when linked twice", async () => {
      await addLibraryLink('g1', 'alice', 'bob');
      await addLibraryLink('g1', 'alice', 'bob');
      const links = await getLibraryLinksForGuild('g1');
      expect(links).toHaveLength(1);
    });
  });

  describe('removeLibraryLink', () => {
    it('removes the link and returns true', async () => {
      await addLibraryLink('g1', 'alice', 'bob');
      expect(await removeLibraryLink('g1', 'alice', 'bob')).toBe(true);
      expect(await getEffectiveOwnerIds('g1', 'bob')).toEqual(['bob']);
    });

    it('works when invoked by either party, regardless of link direction', async () => {
      await addLibraryLink('g1', 'alice', 'bob');
      expect(await removeLibraryLink('g1', 'bob', 'alice')).toBe(true);
      expect(await getEffectiveOwnerIds('g1', 'bob')).toEqual(['bob']);
    });

    it('returns false when there was nothing to remove', async () => {
      expect(await removeLibraryLink('g1', 'alice', 'bob')).toBe(false);
    });

    it('only removes the link between the two specified users', async () => {
      await addLibraryLink('g1', 'alice', 'bob');
      await addLibraryLink('g1', 'alice', 'carol');
      await removeLibraryLink('g1', 'alice', 'bob');
      expect(await getEffectiveOwnerIds('g1', 'bob')).toEqual(['bob']);
      expect(await getEffectiveOwnerIds('g1', 'carol')).toEqual(['carol', 'alice']);
    });
  });
});
