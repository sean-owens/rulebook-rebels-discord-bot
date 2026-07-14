import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hydrateSellDrafts, handlePriceCustomButton } from '../src/commands/marketplace';
import { saveDraft, SellDraft } from '../src/utils/marketplaceDraftStorage';

// Regression: an in-progress /marketplace sell draft used to live only in a
// bare in-memory Map, so a bot restart between two steps of the flow (e.g.
// picking a price) silently stranded the user with a dead button pointing at
// a draft the process no longer remembered. hydrateSellDrafts() is what runs
// on startup to recover any drafts that were persisted before the restart.
describe('hydrateSellDrafts', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-hydrate-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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

  function makeButtonInteraction(userId: string) {
    return {
      user: { id: userId },
      update: vi.fn(async () => {}),
      showModal: vi.fn(async () => {}),
    } as any;
  }

  it('recovers a draft that was persisted before a simulated restart', async () => {
    await saveDraft('draft-1', makeDraft());

    // Nothing in memory yet (simulating a fresh process) until hydration runs.
    await hydrateSellDrafts();

    const interaction = makeButtonInteraction('user-1');
    await handlePriceCustomButton(interaction, 'draft-1');

    expect(interaction.showModal).toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('does not recover a draft that already expired before hydration ran', async () => {
    await saveDraft('expired-draft', makeDraft({ expiresAt: Date.now() - 1000 }));

    await hydrateSellDrafts();

    const interaction = makeButtonInteraction('user-1');
    await handlePriceCustomButton(interaction, 'expired-draft');

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('expired') }),
    );
  });
});
