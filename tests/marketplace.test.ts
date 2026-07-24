import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChannelType } from 'discord.js';
import {
  handleDenyBid,
  handleCounterButton,
  handleAdminPurge,
  handleBidModal,
  handleAcceptBid,
  handleBuyNowButton,
  handleBuyNowConfirm,
  handleBuyNowCancel,
  updateMarketplaceHubThread,
  handleHubMarketplaceSellButton,
  handleHubMarketplaceSellModal,
  handleHubMarketplaceTradeButton,
  handleHubMarketplaceTradeModal,
  handleHubMarketplaceConditionSelect,
  handleHubMarketplaceOffersYes,
  handleHubMarketplaceBrowseButton,
  handleHubMarketplaceMyButton,
  handleIncludeBaseGameYes,
  handleIncludeBaseGameNo,
  handleMatchConfirmYes,
  handleMatchConfirmNotBgg,
  handleMatchConfirmSearchAgain,
  handleMatchResearchModal,
  handlePriceNone,
  execute,
} from '../src/commands/marketplace';
import {
  createListing,
  addBid,
  getListing,
  getListingsForGuild,
  closeListing,
} from '../src/utils/marketplaceStorage';
import { updateGuildConfig, getGuildConfig } from '../src/utils/config';
import { _loadFromCsvText, _resetCatalog } from '../src/utils/bggCatalog';
import { searchBGG } from '../src/utils/bgg';

const EXPANSION_TEST_CSV = `id,name,yearpublished,rank,bayesaverage,average,usersrated,is_expansion,abstracts_rank
266192,Wingspan,2019,5,8.01,8.10,80000,0,
266192001,"Wingspan: European Expansion",2019,,,,5000,1,`;

vi.mock('../src/utils/bgg', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/bgg')>('../src/utils/bgg');
  return {
    ...actual,
    fetchBGGMarketplacePrices: vi.fn(async () => null),
    searchBGG: vi.fn(async () => []),
    getBGGGame: vi.fn(async (id: string) => {
      if (id === '266192001') {
        return {
          id, name: 'Wingspan: European Expansion', bggLink: '', minPlayers: 1, maxPlayers: 5,
          suggestedPlayers: 2, minPlaytime: 40, maxPlaytime: 70, weight: null, thumbnail: null,
          expansions: [], parentGame: { id: '266192', name: 'Wingspan' }, tags: [], howToPlayUrl: null,
        };
      }
      if (id === '266192') {
        return {
          id, name: 'Wingspan', bggLink: '', minPlayers: 1, maxPlayers: 5,
          suggestedPlayers: 2, minPlaytime: 40, maxPlaytime: 70, weight: null, thumbnail: null,
          expansions: [{ id: '266192001', name: 'Wingspan: European Expansion' }], parentGame: undefined, tags: [], howToPlayUrl: null,
        };
      }
      throw new Error(`unexpected BGG id in test: ${id}`);
    }),
  };
});

const BASE_LISTING = {
  guildId: 'guild-1',
  userId: 'user-1',
  username: 'Alice',
  type: 'sell' as const,
  itemName: 'Wingspan',
  bidsAllowed: true,
};

function makeButtonInteraction(userId: string, opts: { guildId?: string | null } = {}) {
  return {
    guildId: opts.guildId ?? null,
    user: { id: userId },
    message: { content: 'original', edit: vi.fn(async () => {}) },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    client: {
      users: {
        fetch: vi.fn(async (id: string) => ({ id, send: vi.fn(async () => ({ id: 'msg-1', channelId: 'chan-1' })) })),
      },
      channels: { fetch: vi.fn(async () => { throw new Error('no thread in test'); }) },
    },
  } as any;
}

// Regression tests for a bug where every DM-triggered marketplace button
// (Accept/Deny/Counter) looked up its listing via `interaction.guildId`, which
// is always null in a DM — so clicking any of these buttons (sent to the
// seller/buyer's DMs by design) threw "Listing not found." findListingById()
// now resolves the listing by scanning across guilds instead.
describe('marketplace DM button handlers (guildId is null in a DM)', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-dm-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lets the buyer deny/withdraw their own bid from a DM', async () => {
    const listing = await createListing('guild-1', BASE_LISTING);
    const added = await addBid('guild-1', listing.id, { userId: 'buyer-1', username: 'Buyer' });
    const interaction = makeButtonInteraction('buyer-1', { guildId: null });

    await handleDenyBid(interaction, listing.id, added!.bid.id);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('withdrawn') }),
    );
    expect(interaction.editReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not found') }),
    );
    const updated = await getListing('guild-1', listing.id);
    expect(updated!.bids[0].status).toBe('denied');
  });

  it('lets the seller open a counter modal from a DM', async () => {
    const listing = await createListing('guild-1', BASE_LISTING);
    const added = await addBid('guild-1', listing.id, { userId: 'buyer-1', username: 'Buyer' });
    const interaction = makeButtonInteraction('user-1', { guildId: null });

    await handleCounterButton(interaction, listing.id, added!.bid.id);

    expect(interaction.showModal).toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not found') }),
    );
  });

  it('rejects acting on a bid a second time after it is no longer open (stale DM buttons)', async () => {
    const listing = await createListing('guild-1', BASE_LISTING);
    const added = await addBid('guild-1', listing.id, { userId: 'buyer-1', username: 'Buyer' });

    await handleDenyBid(makeButtonInteraction('buyer-1', { guildId: null }), listing.id, added!.bid.id);

    const secondAttempt = makeButtonInteraction('buyer-1', { guildId: null });
    await handleDenyBid(secondAttempt, listing.id, added!.bid.id);

    expect(secondAttempt.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer open') }),
    );
  });
});

describe('/admin marketplace purge — forum thread cleanup', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-purge-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeAdminInteraction(threadDelete: ReturnType<typeof vi.fn>) {
    return {
      guildId: 'guild-1',
      user: { id: 'admin-1', username: 'Admin' },
      memberPermissions: { has: () => true },
      options: {
        getUser: () => null,
        getString: () => null,
      },
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      client: {
        channels: { fetch: vi.fn(async () => ({ delete: threadDelete })) },
      },
    } as any;
  }

  it('deletes the forum thread for each purged listing, not just the storage record', async () => {
    const listing = await createListing('guild-1', { ...BASE_LISTING, forumThreadId: 'thread-1' });
    await closeListing('guild-1', listing.id);
    const threadDelete = vi.fn(async () => {});

    await handleAdminPurge(makeAdminInteraction(threadDelete));

    expect(threadDelete).toHaveBeenCalled();
    expect(await getListingsForGuild('guild-1')).toHaveLength(0);
  });

  it('completes cleanly for a purged listing with no forum thread', async () => {
    const listing = await createListing('guild-1', BASE_LISTING);
    await closeListing('guild-1', listing.id);
    const threadDelete = vi.fn(async () => {});

    const interaction = makeAdminInteraction(threadDelete);
    await handleAdminPurge(interaction);

    expect(threadDelete).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Purged **1**') }),
    );
  });
});

describe('firm-price listings have no Counter option', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-firm-counter-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a Counter attempt on a firm-price listing instead of opening a modal', async () => {
    const listing = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: false });
    const added = await addBid('guild-1', listing.id, { userId: 'buyer-1', username: 'Buyer' });
    const interaction = makeButtonInteraction('user-1', { guildId: null });

    await handleCounterButton(interaction, listing.id, added!.bid.id);

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("there's no price to counter") }),
    );
  });

  it('still allows Counter on a negotiable (bids-allowed) listing', async () => {
    const listing = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: true });
    const added = await addBid('guild-1', listing.id, { userId: 'buyer-1', username: 'Buyer' });
    const interaction = makeButtonInteraction('user-1', { guildId: null });

    await handleCounterButton(interaction, listing.id, added!.bid.id);

    expect(interaction.showModal).toHaveBeenCalled();
  });

  it('still allows Counter on a trade listing', async () => {
    const listing = await createListing('guild-1', {
      ...BASE_LISTING,
      type: 'trade' as const,
      bidsAllowed: true,
      lookingFor: 'Terraforming Mars',
    });
    const added = await addBid('guild-1', listing.id, { userId: 'buyer-1', username: 'Buyer', offer: 'Wingspan' });
    const interaction = makeButtonInteraction('user-1', { guildId: null });

    await handleCounterButton(interaction, listing.id, added!.bid.id);

    expect(interaction.showModal).toHaveBeenCalled();
  });
});

describe('marketplace offer wording (never "bid")', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-wording-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('DMs the seller "new offer" (never "new bid") on a firm-price listing', async () => {
    await updateGuildConfig('guild-1', { marketplaceNegotiationMode: 'private' });
    const listing = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: false });

    const sellerSend = vi.fn(async () => ({ id: 'dm-msg-1', channelId: 'dm-chan-1' }));
    const interaction = {
      guildId: 'guild-1',
      user: { id: 'buyer-1', username: 'Buyer' },
      member: null,
      fields: { getTextInputValue: () => '' },
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      client: {
        users: { fetch: vi.fn(async () => ({ send: sellerSend })) },
        channels: { fetch: vi.fn(async () => { throw new Error('no thread in test'); }) },
      },
    } as any;

    await handleBidModal(interaction, listing.id);

    expect(sellerSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('New offer') }),
    );
    expect(sellerSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('New bid') }),
    );
  });

  it('also DMs the seller "new offer" (not "new bid") on a negotiable listing', async () => {
    await updateGuildConfig('guild-1', { marketplaceNegotiationMode: 'private' });
    const listing = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: true });

    const sellerSend = vi.fn(async () => ({ id: 'dm-msg-1', channelId: 'dm-chan-1' }));
    const interaction = {
      guildId: 'guild-1',
      user: { id: 'buyer-1', username: 'Buyer' },
      member: null,
      fields: { getTextInputValue: () => '' },
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      client: {
        users: { fetch: vi.fn(async () => ({ send: sellerSend })) },
        channels: { fetch: vi.fn(async () => { throw new Error('no thread in test'); }) },
      },
    } as any;

    await handleBidModal(interaction, listing.id);

    expect(sellerSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('New offer') }),
    );
    expect(sellerSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('New bid') }),
    );
  });
});

describe('accepting an offer uses type-aware "sold"/"traded" language', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-verb-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks a sell listing as "sold" when its offer is accepted', async () => {
    const listing = await createListing('guild-1', BASE_LISTING);
    const added = await addBid('guild-1', listing.id, { userId: 'buyer-1', username: 'Buyer' });
    const interaction = makeButtonInteraction('user-1', { guildId: null });

    await handleAcceptBid(interaction, listing.id, added!.bid.id);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('marked as sold') }),
    );
  });

  it('marks a trade listing as "traded" (not "sold") when its offer is accepted', async () => {
    const listing = await createListing('guild-1', {
      ...BASE_LISTING,
      type: 'trade' as const,
      lookingFor: 'Terraforming Mars',
    });
    const added = await addBid('guild-1', listing.id, { userId: 'buyer-1', username: 'Buyer', offer: 'Wingspan' });
    const interaction = makeButtonInteraction('user-1', { guildId: null });

    await handleAcceptBid(interaction, listing.id, added!.bid.id);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('marked as traded') }),
    );
    expect(interaction.editReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('marked as sold') }),
    );
  });
});

describe('Buy It Now (firm listings only)', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-buynow-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows a confirm prompt naming the item and price', async () => {
    const listing = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: false, askingPrice: 25 });
    const interaction = makeButtonInteraction('buyer-1', { guildId: 'guild-1' });

    await handleBuyNowButton(interaction, listing.id);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Wingspan'),
        components: expect.any(Array),
      }),
    );
  });

  it("rejects buying your own listing", async () => {
    const listing = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: false });
    const interaction = makeButtonInteraction('user-1', { guildId: 'guild-1' });

    await handleBuyNowButton(interaction, listing.id);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("can't buy your own listing") }),
    );
  });

  it('rejects when the listing is already sold', async () => {
    const listing = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: false });
    await closeListing('guild-1', listing.id);
    const interaction = makeButtonInteraction('buyer-1', { guildId: 'guild-1' });

    await handleBuyNowButton(interaction, listing.id);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer available') }),
    );
  });

  it('completes the purchase on confirm: marks sold, notifies seller, closes other open offers', async () => {
    const listing = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: false, askingPrice: 25 });
    const existingOffer = await addBid('guild-1', listing.id, { userId: 'other-buyer', username: 'Other' });
    const interaction = makeButtonInteraction('buyer-1', { guildId: 'guild-1' });

    await handleBuyNowConfirm(interaction, listing.id);

    const updated = await getListing('guild-1', listing.id);
    expect(updated!.status).toBe('sold');
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Purchase confirmed'), components: [] }),
    );
    // The other pending "I'm Interested" offer should be closed out.
    const closedBid = updated!.bids.find((b) => b.id === existingOffer!.bid.id);
    expect(closedBid?.status).toBe('sold_to_other');
  });

  it('fails gracefully when someone else already bought it first (race lost)', async () => {
    const listing = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: false });
    await closeListing('guild-1', listing.id);
    const interaction = makeButtonInteraction('buyer-1', { guildId: 'guild-1' });

    await handleBuyNowConfirm(interaction, listing.id);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no longer available'), components: [] }),
    );
  });

  it('cancel just dismisses the prompt with no state change', async () => {
    const listing = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: false });
    const interaction = makeButtonInteraction('buyer-1', { guildId: 'guild-1' });

    await handleBuyNowCancel(interaction);

    expect(interaction.update).toHaveBeenCalledWith({ content: 'Purchase cancelled.', components: [] });
    const unchanged = await getListing('guild-1', listing.id);
    expect(unchanged!.status).toBe('active');
  });
});

describe('marketplace "Quick Actions" hub', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-hub-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeForumChannelClient() {
    let nextThreadId = 1;
    const threads = new Map<string, any>();
    const makeThread = () => {
      const id = `thread-${nextThreadId++}`;
      const starterMsg = { edit: vi.fn(async () => {}) };
      const thread: any = {
        id,
        pin: vi.fn(async () => {
          thread._pinned = true;
        }),
        flags: { has: () => !!thread._pinned },
        fetchStarterMessage: vi.fn(async () => starterMsg),
        _pinned: false,
        _starterMsg: starterMsg,
      };
      threads.set(id, thread);
      return thread;
    };
    const forumChannel = {
      type: ChannelType.GuildForum,
      threads: {
        create: vi.fn(async () => makeThread()),
        fetch: vi.fn(async (id: string) => threads.get(id)),
      },
    };
    const client = { channels: { fetch: vi.fn(async () => forumChannel) } };
    return { client, forumChannel, threads };
  }

  describe('updateMarketplaceHubThread', () => {
    it('does nothing when no marketplace channel is configured', async () => {
      const { client, forumChannel } = makeForumChannelClient();
      await updateMarketplaceHubThread(client as any, 'guild-1');
      expect(forumChannel.threads.create).not.toHaveBeenCalled();
    });

    it('creates and pins a new hub thread, storing its id on the guild config', async () => {
      await updateGuildConfig('guild-1', { marketplaceChannelId: 'forum-1' });
      const { client, forumChannel } = makeForumChannelClient();

      await updateMarketplaceHubThread(client as any, 'guild-1');

      expect(forumChannel.threads.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: '🎮 Quick Actions' }),
      );
      const config = await getGuildConfig('guild-1');
      expect(config.marketplaceHubThreadId).toBe('thread-1');
    });

    it('edits the existing thread on a subsequent call instead of creating a new one', async () => {
      await updateGuildConfig('guild-1', { marketplaceChannelId: 'forum-1' });
      const { client, forumChannel, threads } = makeForumChannelClient();

      await updateMarketplaceHubThread(client as any, 'guild-1');
      await updateMarketplaceHubThread(client as any, 'guild-1');

      expect(forumChannel.threads.create).toHaveBeenCalledTimes(1);
      const thread = threads.get('thread-1');
      expect(thread._starterMsg.edit).toHaveBeenCalledTimes(1);
    });

    it('recreates the thread if the previously stored one no longer exists', async () => {
      await updateGuildConfig('guild-1', { marketplaceChannelId: 'forum-1', marketplaceHubThreadId: 'stale-thread' });
      const { client, forumChannel } = makeForumChannelClient();

      await updateMarketplaceHubThread(client as any, 'guild-1');

      expect(forumChannel.threads.create).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the configured channel is not a forum channel', async () => {
      await updateGuildConfig('guild-1', { marketplaceChannelId: 'not-a-forum' });
      const client = { channels: { fetch: vi.fn(async () => ({ type: ChannelType.GuildText })) } };

      await updateMarketplaceHubThread(client as any, 'guild-1');

      const config = await getGuildConfig('guild-1');
      expect(config.marketplaceHubThreadId).toBeUndefined();
    });
  });

  function makeButtonInteraction(userId: string, client: any) {
    return {
      guildId: 'guild-1',
      user: { id: userId, username: `user-${userId}` },
      member: null,
      client,
      isChatInputCommand: () => false,
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      deferUpdate: vi.fn(async () => {}),
      showModal: vi.fn(async () => {}),
    } as any;
  }

  function makeModalInteraction(userId: string, itemName: string, client: any) {
    return {
      guildId: 'guild-1',
      user: { id: userId, username: `user-${userId}` },
      member: null,
      client,
      fields: { getTextInputValue: (name: string) => (name === 'item' ? itemName : '') },
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;
  }

  function makeSelectInteraction(userId: string, value: string, client: any) {
    return {
      guildId: 'guild-1',
      user: { id: userId, username: `user-${userId}` },
      member: null,
      client,
      values: [value],
      update: vi.fn(async () => {}),
      deferUpdate: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;
  }

  describe('Sell wizard', () => {
    it('shows a modal asking for the item name when the button is tapped', async () => {
      const interaction = makeButtonInteraction('u1', {});
      await handleHubMarketplaceSellButton(interaction);

      expect(interaction.showModal).toHaveBeenCalledTimes(1);
      const modal = interaction.showModal.mock.calls[0][0].toJSON();
      expect(modal.custom_id).toBe('hub_mp_sell_modal');
    });

    it('submitting the modal shows a condition select', async () => {
      const interaction = makeModalInteraction('u1', 'Some Totally Made Up Game', {});
      await handleHubMarketplaceSellModal(interaction);

      const replyCall = interaction.reply.mock.calls[0][0];
      expect(replyCall.content).toContain('condition');
      expect(replyCall.components[0].components[0].data.custom_id).toBe('hub_mp_condition_select');
    });

    it('selecting a condition shows offers-allowed buttons for a sell listing', async () => {
      await handleHubMarketplaceSellModal(makeModalInteraction('u2', 'Some Totally Made Up Game', {}));
      const interaction = makeSelectInteraction('u2', 'good', {});

      await handleHubMarketplaceConditionSelect(interaction);

      const updateCall = interaction.update.mock.calls[0][0];
      expect(updateCall.content).toContain('offers');
      const customIds = updateCall.components[0].components.map((c: any) => c.data.custom_id);
      expect(customIds).toEqual(['hub_mp_offers_yes', 'hub_mp_offers_no']);
    });

    it('tapping an offers-allowed button reaches the same no-BGG-match prompt the slash command would', async () => {
      await handleHubMarketplaceSellModal(makeModalInteraction('u3', 'Some Totally Made Up Game', {}));
      await handleHubMarketplaceConditionSelect(makeSelectInteraction('u3', 'good', {}));
      const interaction = makeButtonInteraction('u3', {});

      await handleHubMarketplaceOffersYes(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("wasn't found on BoardGameGeek") }),
      );
    });

    it('shows an expired-session message at the condition-select step with no prior modal submission', async () => {
      const interaction = makeSelectInteraction('never-started', 'good', {});
      await handleHubMarketplaceConditionSelect(interaction);

      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('expired') }),
      );
    });

    it('shows an expired-session message at the offers-allowed step with no prior condition selection', async () => {
      const interaction = makeButtonInteraction('never-started', {});
      await handleHubMarketplaceOffersYes(interaction);

      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('expired') }),
      );
    });
  });

  describe('Trade wizard', () => {
    it('shows a modal asking for the item name when the button is tapped', async () => {
      const interaction = makeButtonInteraction('u4', {});
      await handleHubMarketplaceTradeButton(interaction);

      expect(interaction.showModal).toHaveBeenCalledTimes(1);
      const modal = interaction.showModal.mock.calls[0][0].toJSON();
      expect(modal.custom_id).toBe('hub_mp_trade_modal');
    });

    it('selecting a condition skips straight to the listing flow — no offers-allowed step for trades', async () => {
      await handleHubMarketplaceTradeModal(makeModalInteraction('u5', 'Some Totally Made Up Game', {}));
      const interaction = makeSelectInteraction('u5', 'good', {});

      await handleHubMarketplaceConditionSelect(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("wasn't found on BoardGameGeek") }),
      );
    });
  });

  describe('Browse / My Listings buttons', () => {
    it('Browse Listings shows all listings with no type filter applied', async () => {
      await createListing('guild-1', { ...BASE_LISTING, itemName: 'Catan' });
      const interaction = makeButtonInteraction('viewer-1', {});

      await handleHubMarketplaceBrowseButton(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Catan') }),
      );
    });

    it('My Listings shows the tapping user\'s own listings', async () => {
      await createListing('guild-1', { ...BASE_LISTING, userId: 'owner-1', itemName: 'Azul' });
      const interaction = makeButtonInteraction('owner-1', {});

      await handleHubMarketplaceMyButton(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Azul') }),
      );
    });

    it('My Listings tells a user with no listings to use /marketplace post', async () => {
      const interaction = makeButtonInteraction('nobody-1', {});
      await handleHubMarketplaceMyButton(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("don't have any listings") }),
      );
    });
  });

  describe('Expansion / base-game bundling', () => {
    beforeEach(() => {
      _resetCatalog();
      _loadFromCsvText(EXPANSION_TEST_CSV);
    });

    afterEach(() => {
      _resetCatalog();
    });

    // The hub wizard collects the item name via a free-text modal (no
    // autocomplete), so resolveMarketplaceItem always treats a catalog match
    // there as unconfirmed — every one of these flows must pass through the
    // match-confirmation prompt (tapping "Yes, that's it") before it reaches
    // the expansion-select/base-game step.
    async function confirmMatch(offersInteraction: any, userId: string, client: any): Promise<any> {
      const confirmCall = offersInteraction.editReply.mock.calls[0][0];
      expect(confirmCall.embeds[0].data.title).toBe('Found a possible match');
      const draftId = confirmCall.components[0].components[0].data.custom_id.slice('mp_match_yes_'.length);
      const interaction = makeButtonInteraction(userId, client);
      await handleMatchConfirmYes(interaction, draftId);
      return interaction;
    }

    it('offers the expansion-select step (not the base-game prompt) when selling the base game', async () => {
      await handleHubMarketplaceSellModal(makeModalInteraction('base-1', 'Wingspan', {}));
      await handleHubMarketplaceConditionSelect(makeSelectInteraction('base-1', 'good', {}));
      const offersInteraction = makeButtonInteraction('base-1', {});
      await handleHubMarketplaceOffersYes(offersInteraction);

      const interaction = await confirmMatch(offersInteraction, 'base-1', {});

      const call = interaction.editReply.mock.calls[0][0];
      expect(call.embeds[0].data.title).toContain('Expansions for Wingspan');
      expect(call.components[0].components[0].data.custom_id).toMatch(/^mp_exp_select_/);
    });

    it('offers to include the base game (not an expansion-select) when selling an expansion', async () => {
      await handleHubMarketplaceSellModal(makeModalInteraction('exp-1', 'Wingspan: European Expansion', {}));
      await handleHubMarketplaceConditionSelect(makeSelectInteraction('exp-1', 'good', {}));
      const offersInteraction = makeButtonInteraction('exp-1', {});
      await handleHubMarketplaceOffersYes(offersInteraction);

      const interaction = await confirmMatch(offersInteraction, 'exp-1', {});

      const call = interaction.editReply.mock.calls[0][0];
      expect(call.embeds[0].data.title).toBe('Wingspan: European Expansion is an expansion');
      const customIds = call.components[0].components.map((c: any) => c.data.custom_id);
      expect(customIds[0]).toMatch(/^mp_base_yes_/);
      expect(customIds[1]).toMatch(/^mp_base_no_/);
    });

    it('including the base game carries through to the price screen title and the final listing', async () => {
      await handleHubMarketplaceSellModal(makeModalInteraction('exp-2', 'Wingspan: European Expansion', {}));
      await handleHubMarketplaceConditionSelect(makeSelectInteraction('exp-2', 'good', {}));
      const offersInteraction = makeButtonInteraction('exp-2', {});
      await handleHubMarketplaceOffersYes(offersInteraction);
      const promptInteraction = await confirmMatch(offersInteraction, 'exp-2', {});
      const draftId = promptInteraction.editReply.mock.calls[0][0].components[0].components[0].data.custom_id.slice('mp_base_yes_'.length);

      const yesInteraction = makeButtonInteraction('exp-2', {});
      await handleIncludeBaseGameYes(yesInteraction, draftId);

      const priceCall = yesInteraction.editReply.mock.calls[0][0];
      expect(priceCall.embeds[0].data.title).toContain('Wingspan: European Expansion + Base Game');

      // "List as open to offers" finalizes the listing without needing a real price lookup
      const noneButton = priceCall.components[0].components.find((c: any) => c.data.custom_id.startsWith('mp_price_none_'));
      const finalizeInteraction = makeButtonInteraction('exp-2', {});
      await handlePriceNone(finalizeInteraction, noneButton.data.custom_id.slice('mp_price_none_'.length));

      const listings = await getListingsForGuild('guild-1');
      const created = listings.find((l) => l.itemName === 'Wingspan: European Expansion');
      expect(created?.includesBaseGame).toBe(true);
      expect(created?.parentItem).toEqual({ bggId: '266192', name: 'Wingspan' });
    });

    it('declining the base game leaves it out of the final listing', async () => {
      await handleHubMarketplaceSellModal(makeModalInteraction('exp-3', 'Wingspan: European Expansion', {}));
      await handleHubMarketplaceConditionSelect(makeSelectInteraction('exp-3', 'good', {}));
      const offersInteraction = makeButtonInteraction('exp-3', {});
      await handleHubMarketplaceOffersYes(offersInteraction);
      const promptInteraction = await confirmMatch(offersInteraction, 'exp-3', {});
      const draftId = promptInteraction.editReply.mock.calls[0][0].components[0].components[1].data.custom_id.slice('mp_base_no_'.length);

      const noInteraction = makeButtonInteraction('exp-3', {});
      await handleIncludeBaseGameNo(noInteraction, draftId);

      const priceCall = noInteraction.editReply.mock.calls[0][0];
      expect(priceCall.embeds[0].data.title).not.toContain('Base Game');

      const noneButton = priceCall.components[0].components.find((c: any) => c.data.custom_id.startsWith('mp_price_none_'));
      const finalizeInteraction = makeButtonInteraction('exp-3', {});
      await handlePriceNone(finalizeInteraction, noneButton.data.custom_id.slice('mp_price_none_'.length));

      const listings = await getListingsForGuild('guild-1');
      const created = listings.find((l) => l.itemName === 'Wingspan: European Expansion' && l.userId === 'exp-3');
      expect(created?.includesBaseGame).toBe(false);
    });
  });
});

// Regression coverage for a bug where a marketplace search silently attached
// the wrong BGG game — e.g. typing "gloom" (meaning "Gloomhaven") matched the
// shorter, unrelated game "Gloom" with no confirmation shown. The fix:
// autocomplete now encodes the BGG id (__bgg__:<id>) so an explicit pick is
// unambiguous and never needs confirming; any other value (free-typed text,
// or the hub wizard's modal, which has no autocomplete at all) only ever
// counts as a guess and must be confirmed before it's attached to the draft.
describe('/marketplace post sell — catalog match confirmation', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-match-confirm-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    _resetCatalog();
    _loadFromCsvText(EXPANSION_TEST_CSV);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetCatalog();
  });

  function makeSellInteraction(rawItem: string) {
    return {
      guildId: 'guild-1',
      user: { id: 'seller-1', username: 'seller-1' },
      member: null,
      client: { channels: { fetch: vi.fn(async () => { throw new Error('no marketplace channel configured in test'); }) } },
      options: {
        getSubcommandGroup: (_allowNull?: boolean) => 'post',
        getSubcommand: () => 'sell',
        getString: (name: string) => {
          if (name === 'item') return rawItem;
          if (name === 'condition') return 'good';
          return null;
        },
        getBoolean: () => true,
      },
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      deferUpdate: vi.fn(async () => {}),
      showModal: vi.fn(async () => {}),
    } as any;
  }

  it('an explicit __bgg__: autocomplete pick skips the confirmation prompt entirely', async () => {
    const interaction = makeSellInteraction('__bgg__:266192'); // Wingspan
    await execute(interaction);

    // Straight to expansion-select (Wingspan has an available expansion) —
    // no "Found a possible match" step in between.
    const call = interaction.editReply.mock.calls[0][0];
    expect(call.embeds[0].data.title).toContain('Expansions for Wingspan');
  });

  it('free-typed text that exactly matches a catalog entry shows a confirmation prompt instead of proceeding silently', async () => {
    const interaction = makeSellInteraction('Wingspan');
    await execute(interaction);

    const call = interaction.editReply.mock.calls[0][0];
    expect(call.embeds[0].data.title).toBe('Found a possible match');
    expect(call.embeds[0].data.description).toContain('Wingspan');
    const customIds = call.components[0].components.map((c: any) => c.data.custom_id);
    expect(customIds[0]).toMatch(/^mp_match_yes_/);
    expect(customIds[1]).toMatch(/^mp_match_search_/);
    expect(customIds[2]).toMatch(/^mp_match_notbgg_/);
  });

  it('tapping "Yes, that\'s it" continues the wizard using the confirmed match', async () => {
    const offersInteraction = makeSellInteraction('Wingspan');
    await execute(offersInteraction);
    const draftId = offersInteraction.editReply.mock.calls[0][0].components[0].components[0].data.custom_id.slice('mp_match_yes_'.length);

    const yesInteraction = makeSellInteraction('');
    await handleMatchConfirmYes(yesInteraction, draftId);

    const call = yesInteraction.editReply.mock.calls[0][0];
    expect(call.embeds[0].data.title).toContain('Expansions for Wingspan');
  });

  it('"Not on BGG" clears the matched game and falls back to the custom-item prompt', async () => {
    const offersInteraction = makeSellInteraction('Wingspan');
    await execute(offersInteraction);
    const confirmCall = offersInteraction.editReply.mock.calls[0][0];
    const draftId = confirmCall.components[0].components[2].data.custom_id.slice('mp_match_notbgg_'.length);

    const notBggInteraction = makeSellInteraction('');
    await handleMatchConfirmNotBgg(notBggInteraction, draftId);

    expect(notBggInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("wasn't found on BoardGameGeek") }),
    );
  });

  it('"Search again" shows a modal, and re-resolving still requires confirmation for another free-typed match', async () => {
    const offersInteraction = makeSellInteraction('Wingspan');
    await execute(offersInteraction);
    const draftId = offersInteraction.editReply.mock.calls[0][0].components[0].components[0].data.custom_id.slice('mp_match_yes_'.length);

    const searchAgainInteraction = makeSellInteraction('');
    await handleMatchConfirmSearchAgain(searchAgainInteraction, draftId);
    expect(searchAgainInteraction.showModal).toHaveBeenCalledTimes(1);
    const modal = searchAgainInteraction.showModal.mock.calls[0][0].toJSON();
    expect(modal.custom_id).toBe(`mp_match_research_modal_${draftId}`);

    const modalInteraction = {
      ...makeSellInteraction(''),
      fields: { getTextInputValue: (name: string) => (name === 'item' ? 'Wingspan: European Expansion' : '') },
    };
    await handleMatchResearchModal(modalInteraction, draftId);

    const call = modalInteraction.editReply.mock.calls[0][0];
    expect(call.embeds[0].data.title).toBe('Found a possible match');
    expect(call.embeds[0].data.description).toContain('Wingspan: European Expansion');
  });

  it('a __custom__: pick (the "not on BGG" autocomplete choice) skips confirmation — nothing to confirm', async () => {
    const interaction = makeSellInteraction('__custom__:My Homemade Prototype');
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("wasn't found on BoardGameGeek") }),
    );
  });

  it('a free-typed name that misses the local catalog still resolves via a live BGG search fallback', async () => {
    vi.mocked(searchBGG).mockResolvedValueOnce([{ id: '266192', name: 'Wingspan', yearPublished: 2019 }]);
    const interaction = makeSellInteraction('Wngspn'); // garbled — local fuzzy match misses entirely
    await execute(interaction);

    const call = interaction.editReply.mock.calls[0][0];
    expect(call.embeds[0].data.title).toBe('Found a possible match');
    expect(call.embeds[0].data.description).toContain('Wingspan');
  });

  it('falls back to the "not found on BGG" prompt when both local and live search miss', async () => {
    vi.mocked(searchBGG).mockResolvedValueOnce([]);
    const interaction = makeSellInteraction('Totally Unmatched Xyzzy Game');
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("wasn't found on BoardGameGeek") }),
    );
  });
});
