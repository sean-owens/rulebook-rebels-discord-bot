import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  handleList,
  handleMine,
  handleLibraryListNav,
  handleLibraryListJumpButton,
  handleLibraryListJumpModal,
  handleLibraryMineJumpButton,
  handleLibraryMineJumpModal,
} from '../src/commands/library';
import { addGame } from '../src/utils/libraryStorage';

// Enough long-named games that the list spans several ~1000-character pages.
const TITLES = Array.from({ length: 90 }, (_, i) => `Game ${String(i).padStart(2, '0')} ${'x'.repeat(20)}`);

function makeInteraction(userId: string) {
  return {
    guildId: 'guild-1',
    user: { id: userId },
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
  } as any;
}

function makeModalSubmit(userId: string, value: string, fromMessage = true) {
  return {
    user: { id: userId },
    isFromMessage: () => fromMessage,
    fields: { getTextInputValue: () => value },
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
  } as any;
}

function buttonIds(payload: any): { id: string; label: string; disabled: boolean }[] {
  return payload.components[0].toJSON().components.map((c: any) => ({
    id: c.custom_id,
    label: c.label,
    disabled: !!c.disabled,
  }));
}

describe('library list/mine "Go to…" button', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-library-jump-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    for (const t of TITLES) await addGame('guild-1', 'user-1', t);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('/library list', () => {
    async function openList(userId = 'user-1') {
      const interaction = makeInteraction(userId);
      await handleList(interaction);
      return interaction.reply.mock.calls[0][0];
    }

    it('makes the middle page button clickable and labels it with the current page', async () => {
      const payload = await openList();
      const [prev, mid, next] = buttonIds(payload);
      expect(prev.id).toBe('library_list_prev');
      expect(mid).toMatchObject({ id: 'library_list_page', disabled: false });
      expect(mid.label).toMatch(/^Go to… \(1\/\d+\)$/);
      expect(next.id).toBe('library_list_next');
    });

    it('opens a modal from the button', async () => {
      await openList();
      const click = makeInteraction('user-1');
      await handleLibraryListJumpButton(click);
      const modal = click.showModal.mock.calls[0][0].toJSON();
      expect(modal.custom_id).toBe('library_list_jump_modal');
    });

    it('jumps to a typed page number and updates the embed and buttons', async () => {
      const payload = await openList();
      const totalPages = parseInt(buttonIds(payload)[1].label.match(/\/(\d+)\)/)![1], 10);
      expect(totalPages).toBeGreaterThan(2);

      const submit = makeModalSubmit('user-1', String(totalPages));
      await handleLibraryListJumpModal(submit);

      const updated = submit.update.mock.calls[0][0];
      expect(updated.embeds[0].data.footer.text).toContain(`Page ${totalPages} of ${totalPages}`);
      expect(buttonIds(updated)[2].disabled).toBe(true); // Next disabled on the last page
    });

    it('jumps to the page holding a game typed by name, and Next/Previous continue from there', async () => {
      await openList();
      const submit = makeModalSubmit('user-1', 'game 60');
      await handleLibraryListJumpModal(submit);

      const updated = submit.update.mock.calls[0][0];
      expect(updated.embeds[0].data.fields[0].value).toContain('Game 60');

      const next = makeInteraction('user-1');
      await handleLibraryListNav(next, 'next');
      const afterNext = next.update.mock.calls[0][0];
      const pageNow = parseInt(afterNext.embeds[0].data.footer.text.match(/Page (\d+)/)![1], 10);
      const pageJumped = parseInt(updated.embeds[0].data.footer.text.match(/Page (\d+)/)![1], 10);
      expect(pageNow).toBe(pageJumped + 1);
    });

    it('rejects an out-of-range page or an unknown name without changing the page', async () => {
      await openList();
      const bad = makeModalSubmit('user-1', '999');
      await handleLibraryListJumpModal(bad);
      expect(bad.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Pick a page between') }));
      expect(bad.update).not.toHaveBeenCalled();

      const unknown = makeModalSubmit('user-1', 'nothing like this');
      await handleLibraryListJumpModal(unknown);
      expect(unknown.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('No game matching') }));
    });

    it('reports an expired session for both the button and the modal', async () => {
      const click = makeInteraction('nobody');
      await handleLibraryListJumpButton(click);
      expect(click.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('expired') }));
      expect(click.showModal).not.toHaveBeenCalled();

      const submit = makeModalSubmit('nobody', '2');
      await handleLibraryListJumpModal(submit);
      expect(submit.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('expired') }));
    });
  });

  describe('/library mine', () => {
    async function openMine() {
      const interaction = makeInteraction('user-1');
      await handleMine(interaction);
      return interaction.reply.mock.calls[0][0];
    }

    it('has the same clickable Go-to button and jumps by page number or game name', async () => {
      const payload = await openMine();
      expect(buttonIds(payload)[1]).toMatchObject({ id: 'library_mine_page', disabled: false });

      const click = makeInteraction('user-1');
      await handleLibraryMineJumpButton(click);
      expect(click.showModal.mock.calls[0][0].toJSON().custom_id).toBe('library_mine_jump_modal');

      const byName = makeModalSubmit('user-1', 'game 75');
      await handleLibraryMineJumpModal(byName);
      expect(byName.update.mock.calls[0][0].embeds[0].data.fields[0].value).toContain('Game 75');

      const byNumber = makeModalSubmit('user-1', '1');
      await handleLibraryMineJumpModal(byNumber);
      expect(byNumber.update.mock.calls[0][0].embeds[0].data.footer.text).toContain('Page 1 of');
    });

    it('rejects bad input and expired sessions', async () => {
      await openMine();
      const bad = makeModalSubmit('user-1', '0');
      await handleLibraryMineJumpModal(bad);
      expect(bad.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Pick a page between') }));

      const expired = makeModalSubmit('nobody', '1');
      await handleLibraryMineJumpModal(expired);
      expect(expired.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('expired') }));
    });
  });
});
