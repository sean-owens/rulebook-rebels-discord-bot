import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  handleDenyBid,
  handleCounterButton,
  handleAdminPurge,
  handleBidModal,
  handleAcceptBid,
  handleBuyNowButton,
  handleBuyNowConfirm,
  handleBuyNowCancel,
} from '../src/commands/marketplace';
import {
  createListing,
  addBid,
  getListing,
  getListingsForGuild,
  closeListing,
} from '../src/utils/marketplaceStorage';
import { updateGuildConfig } from '../src/utils/config';

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
