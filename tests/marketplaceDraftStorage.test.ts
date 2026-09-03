import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SellDraft, saveDraft, deleteDraft, loadUnexpiredDrafts } from '../src/utils/marketplaceDraftStorage';

function makeDraft(overrides: Partial<SellDraft> = {}): SellDraft {
  return {
    listingType: 'sell',
    guildId: 'guild-1',
    userId: 'user-1',
    username: 'Alice',
    itemName: 'Wingspan',
    condition: 'good',
    bidsAllowed: true,
    expiresAt: Date.now() + 15 * 60 * 1000,
    ...overrides,
  };
}

describe('marketplaceDraftStorage', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-draft-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads a draft back unchanged', async () => {
    const draft = makeDraft();
    await saveDraft('draft-1', draft);

    const loaded = await loadUnexpiredDrafts();
    expect(loaded['draft-1']).toEqual(draft);
  });

  it('supports multiple drafts side by side', async () => {
    await saveDraft('draft-1', makeDraft({ itemName: 'Wingspan' }));
    await saveDraft('draft-2', makeDraft({ itemName: 'Gloomhaven', userId: 'user-2' }));

    const loaded = await loadUnexpiredDrafts();
    expect(Object.keys(loaded).sort()).toEqual(['draft-1', 'draft-2']);
    expect(loaded['draft-2'].itemName).toBe('Gloomhaven');
  });

  it('overwrites a draft saved again under the same id', async () => {
    await saveDraft('draft-1', makeDraft({ suggestedPrice: undefined }));
    await saveDraft('draft-1', makeDraft({ suggestedPrice: 25 }));

    const loaded = await loadUnexpiredDrafts();
    expect(loaded['draft-1'].suggestedPrice).toBe(25);
  });

  it('removes a draft on delete', async () => {
    await saveDraft('draft-1', makeDraft());
    await deleteDraft('draft-1');

    const loaded = await loadUnexpiredDrafts();
    expect(loaded['draft-1']).toBeUndefined();
  });

  it('deleting a draft that was never saved is a no-op', async () => {
    await expect(deleteDraft('never-existed')).resolves.not.toThrow();
  });

  it('excludes expired drafts from loadUnexpiredDrafts', async () => {
    await saveDraft('expired', makeDraft({ expiresAt: Date.now() - 1000 }));
    await saveDraft('fresh', makeDraft({ expiresAt: Date.now() + 1000 }));

    const loaded = await loadUnexpiredDrafts();
    expect(loaded['expired']).toBeUndefined();
    expect(loaded['fresh']).toBeDefined();
  });
});
