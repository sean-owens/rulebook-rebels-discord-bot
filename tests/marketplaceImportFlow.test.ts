import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChannelType } from 'discord.js';
import {
  handleImport,
  handleImportTemplate,
  handleImportConfirm,
  handleImportCancel,
} from '../src/commands/marketplace';
import { createListing, getListingsForGuild } from '../src/utils/marketplaceStorage';
import { updateGuildConfig } from '../src/utils/config';
import { _loadFromCsvText, _resetCatalog } from '../src/utils/bggCatalog';

vi.mock('../src/utils/bgg', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/bgg')>('../src/utils/bgg');
  return { ...actual, searchBGG: vi.fn(async () => []) };
});

const CATALOG = `id,name,yearpublished,rank,bayesaverage,average,usersrated,is_expansion,abstracts_rank
266192,Wingspan,2019,5,8.01,8.10,80000,0,
174430,Gloomhaven,2017,4,8.29,8.53,67317,0,
`;

const HEADER = 'type,item,condition,price,offers_allowed,looking_for,notes,bgg_id';

function makeImportInteraction(csvText: string | null, overrides: Record<string, unknown> = {}) {
  return {
    guildId: 'guild-1',
    user: { id: 'user-1', username: 'alice' },
    member: { displayName: 'Alice' },
    options: {
      getAttachment: () => ({ name: 'items.csv', size: csvText?.length ?? 0, url: 'https://cdn.example/items.csv' }),
    },
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    client: {},
    ...overrides,
  } as any;
}

function makeButton(userId = 'user-1') {
  const send = vi.fn(async () => ({ id: 'post-msg-1' }));
  const textChannel = { type: ChannelType.GuildText, id: 'mp-chan', send, client: { channels: { fetch: vi.fn() } } };
  return {
    guildId: 'guild-1',
    user: { id: userId },
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    client: { channels: { fetch: vi.fn(async () => textChannel) } },
    _send: send,
  } as any;
}

function stubCsvDownload(text: string, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status: ok ? 200 : 500, text: async () => text })),
  );
}

// The preview's token lives only inside the confirm/cancel button custom ids.
function tokenFrom(interaction: any, prefix: 'mp_import_yes_' | 'mp_import_no_'): string {
  const payload = interaction.editReply.mock.calls.at(-1)[0];
  const buttons = payload.components[0].toJSON().components;
  return buttons.find((b: any) => b.custom_id.startsWith(prefix)).custom_id.slice(prefix.length);
}

describe('/marketplace import', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-import-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    _resetCatalog();
    _loadFromCsvText(CATALOG);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    vi.unstubAllGlobals();
    _resetCatalog();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('template sends a CSV attachment', async () => {
    const interaction = makeImportInteraction(null);
    await handleImportTemplate(interaction);
    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.files[0].name).toBe('marketplace-import-template.csv');
    expect(payload.content).toContain('/marketplace import');
  });

  it('rejects a non-.csv upload and an oversized file before downloading anything', async () => {
    stubCsvDownload('irrelevant');
    const notCsv = makeImportInteraction('x', {
      options: { getAttachment: () => ({ name: 'items.xlsx', size: 10, url: 'u' }) },
    });
    await handleImport(notCsv);
    expect(notCsv.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('.csv') }));

    const big = makeImportInteraction('x', {
      options: { getAttachment: () => ({ name: 'items.csv', size: 10_000_000, url: 'u' }) },
    });
    await handleImport(big);
    expect(big.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('too large') }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a download failure', async () => {
    stubCsvDownload('', false);
    const interaction = makeImportInteraction('x');
    await handleImport(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Couldn't download") }),
    );
  });

  it('reports an unusable file (fatal parse error) with no preview', async () => {
    stubCsvDownload('item,price\nWingspan,3');
    const interaction = makeImportInteraction('x');
    await handleImport(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('`condition`') }),
    );
  });

  it('shows a preview with match quality and row errors, and creates nothing yet', async () => {
    stubCsvDownload(
      [
        HEADER,
        'sell,Wingspan,like_new,30,yes,,,',
        'sell,Gloom,good,,,,,',
        'trade,My Homemade Game,good,,,Anything,,',
        'sell,Wingspan,mint,5,,,,',
        'sell,Azul,good,5,,,,555555',
      ].join('\n'),
    );
    const interaction = makeImportInteraction('x');
    await handleImport(interaction);

    const payload = interaction.editReply.mock.calls.at(-1)[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toContain('3 listings ready');
    expect(embed.description).toContain('✅ BGG: Wingspan (2019)');
    expect(embed.description).toContain('⚠️ Best-guess BGG match: Gloomhaven');
    expect(embed.description).toContain('No BGG match');
    expect(embed.description).toContain('Line 5');
    expect(embed.description).toContain('Line 6');
    expect(embed.description).toContain("isn't in the BoardGameGeek catalog");
    expect(payload.components).toHaveLength(1);
    expect(await getListingsForGuild('guild-1')).toHaveLength(0);
  });

  it('skips items the user already has active (and repeats within the file)', async () => {
    await createListing('guild-1', {
      guildId: 'guild-1', userId: 'user-1', username: 'Alice', type: 'sell', itemName: 'wingspan', bidsAllowed: true,
    });
    stubCsvDownload([HEADER, 'sell,Wingspan,good,,,,,', 'sell,Azul,good,,,,,', 'sell,Azul,good,,,,,'].join('\n'));
    const interaction = makeImportInteraction('x');
    await handleImport(interaction);

    const embed = interaction.editReply.mock.calls.at(-1)[0].embeds[0].toJSON();
    expect(embed.title).toContain('1 listing ready');
    expect((embed.description.match(/Skipped/g) ?? []).length).toBe(2);
  });

  it('offers no confirm button when nothing is importable', async () => {
    stubCsvDownload([HEADER, 'sell,Wingspan,mint,,,,,'].join('\n'));
    const interaction = makeImportInteraction('x');
    await handleImport(interaction);
    expect(interaction.editReply.mock.calls.at(-1)[0].components).toEqual([]);
  });

  describe('confirm / cancel', () => {
    async function previewed(csv: string) {
      stubCsvDownload(csv);
      const interaction = makeImportInteraction('x');
      await handleImport(interaction);
      return tokenFrom(interaction, 'mp_import_yes_');
    }

    it('creates the previewed listings with the right fields, then cannot be confirmed twice', async () => {
      const token = await previewed(
        [
          HEADER,
          'sell,Wingspan,like_new,"$30.00",no,,Played twice,',
          'trade,Catan,good,,,Wingspan or Ark Nova,Worn,',
        ].join('\n'),
      );
      const button = makeButton();
      await handleImportConfirm(button, token);

      const listings = await getListingsForGuild('guild-1');
      expect(listings).toHaveLength(2);
      const sell = listings.find((l) => l.type === 'sell')!;
      expect(sell).toMatchObject({
        userId: 'user-1', username: 'Alice', itemName: 'Wingspan', bggId: '266192',
        condition: 'like_new', askingPrice: 30, bidsAllowed: false, notes: 'Played twice',
      });
      const trade = listings.find((l) => l.type === 'trade')!;
      expect(trade).toMatchObject({ itemName: 'Catan', lookingFor: 'Wingspan or Ark Nova', bidsAllowed: true });
      expect(trade.bggId).toBeUndefined();

      expect(button.editReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Created 2 listings') }),
      );

      const again = makeButton();
      await handleImportConfirm(again, token);
      expect(again.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('expired') }));
      expect(await getListingsForGuild('guild-1')).toHaveLength(2);
    });

    it('posts each listing to the configured marketplace channel', async () => {
      await updateGuildConfig('guild-1', { marketplaceChannelId: 'mp-chan' });
      const token = await previewed([HEADER, 'sell,Wingspan,good,,,,,', 'sell,Azul,good,,,,,'].join('\n'));
      const button = makeButton();
      await handleImportConfirm(button, token);

      expect(button._send).toHaveBeenCalledTimes(2);
      const listings = await getListingsForGuild('guild-1');
      expect(listings.every((l) => l.listingMessageId === 'post-msg-1')).toBe(true);
      expect(button.editReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: expect.not.stringContaining("couldn't be posted") }),
      );
    });

    it('warns when listings were saved but no marketplace channel is configured', async () => {
      const token = await previewed([HEADER, 'sell,Wingspan,good,,,,,'].join('\n'));
      const button = makeButton();
      await handleImportConfirm(button, token);
      expect(button.editReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: expect.stringContaining("couldn't be posted") }),
      );
      expect(await getListingsForGuild('guild-1')).toHaveLength(1);
    });

    it("refuses another user's confirm and cancel, leaving the preview usable", async () => {
      const token = await previewed([HEADER, 'sell,Wingspan,good,,,,,'].join('\n'));

      const intruder = makeButton('user-2');
      await handleImportConfirm(intruder, token);
      expect(intruder.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("isn't your") }));

      const intruderCancel = makeButton('user-2');
      await handleImportCancel(intruderCancel, token);
      expect(intruderCancel.reply).toHaveBeenCalled();
      expect(intruderCancel.update).not.toHaveBeenCalled();

      await handleImportConfirm(makeButton('user-1'), token);
      expect(await getListingsForGuild('guild-1')).toHaveLength(1);
    });

    it('cancel discards the preview without creating anything', async () => {
      const token = await previewed([HEADER, 'sell,Wingspan,good,,,,,'].join('\n'));
      const cancel = makeButton();
      await handleImportCancel(cancel, token);
      expect(cancel.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('cancelled') }));

      await handleImportConfirm(makeButton(), token);
      expect(await getListingsForGuild('guild-1')).toHaveLength(0);
    });
  });
});
