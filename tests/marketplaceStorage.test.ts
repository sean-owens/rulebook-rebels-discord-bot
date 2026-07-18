import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createListing,
  getListing,
  findListingById,
  getListingsForGuild,
  getActiveListingsForGuild,
  getUserListings,
  updateListing,
  addBid,
  updateBid,
  addCounter,
  acceptBid,
  buyNow,
  denyBid,
  closeListing,
  reopenListing,
  purgeListings,
  getOpenBid,
  CONDITION_LABELS,
} from '../src/utils/marketplaceStorage';

const BASE_LISTING = {
  guildId: 'guild-1',
  userId: 'user-1',
  username: 'Alice',
  type: 'sell' as const,
  itemName: 'Wingspan',
  bidsAllowed: true,
};

describe('marketplaceStorage', () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-test-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── createListing ──────────────────────────────────────────────────────────

  describe('createListing', () => {
    it('creates a listing with status active', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      expect(l.status).toBe('active');
      expect(l.bids).toHaveLength(0);
    });

    it('assigns a unique id', async () => {
      const a = await createListing('guild-1', BASE_LISTING);
      const b = await createListing('guild-1', BASE_LISTING);
      expect(a.id).not.toBe(b.id);
    });

    it('persists the listing', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      expect(await getListing('guild-1', l.id)).toBeDefined();
    });

    it('scopes listings to guild', async () => {
      await createListing('guild-1', BASE_LISTING);
      expect(await getListingsForGuild('guild-2')).toHaveLength(0);
    });
  });

  // ── getActiveListingsForGuild ──────────────────────────────────────────────

  describe('getActiveListingsForGuild', () => {
    it('returns active and pending listings only', async () => {
      const l1 = await createListing('guild-1', BASE_LISTING);
      const l2 = await createListing('guild-1', BASE_LISTING);
      await closeListing('guild-1', l2.id);
      const active = await getActiveListingsForGuild('guild-1');
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(l1.id);
    });
  });

  // ── findListingById ────────────────────────────────────────────────────────

  describe('findListingById', () => {
    it('finds a listing across guilds without knowing its guildId up front', async () => {
      const l = await createListing('guild-2', { ...BASE_LISTING, userId: 'user-9' });
      const found = await findListingById(l.id);
      expect(found?.guildId).toBe('guild-2');
      expect(found?.listing.id).toBe(l.id);
    });

    it('returns undefined for an unknown listing id', async () => {
      await createListing('guild-1', BASE_LISTING);
      expect(await findListingById('does-not-exist')).toBeUndefined();
    });
  });

  // ── getUserListings ────────────────────────────────────────────────────────

  describe('getUserListings', () => {
    it("returns only that user's listings", async () => {
      await createListing('guild-1', BASE_LISTING);
      await createListing('guild-1', { ...BASE_LISTING, userId: 'user-2', username: 'Bob' });
      expect(await getUserListings('guild-1', 'user-1')).toHaveLength(1);
    });
  });

  // ── addBid ─────────────────────────────────────────────────────────────────

  describe('addBid', () => {
    it('adds a bid and returns listing + bid', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      const result = await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      expect(result).toBeDefined();
      expect(result!.bid.status).toBe('open');
      expect(result!.bid.amount).toBe(20);
    });

    it('transitions listing status to pending on first bid', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      expect(l.status).toBe('active');
      const result = await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob' });
      expect(result!.listing.status).toBe('pending');
    });

    it('allows multiple bids on a pending listing', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      await addBid('guild-1', l.id, { userId: 'user-3', username: 'Carol', amount: 25 });
      expect((await getListing('guild-1', l.id))!.bids).toHaveLength(2);
    });

    it('returns undefined for non-existent listing', async () => {
      expect(
        await addBid('guild-1', 'bad-id', { userId: 'user-2', username: 'Bob' }),
      ).toBeUndefined();
    });
  });

  // ── acceptBid ─────────────────────────────────────────────────────────────

  describe('acceptBid', () => {
    it('marks listing as sold and accepted bid as accepted', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      const bidResult = await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const result = await acceptBid('guild-1', l.id, bidResult!.bid.id);
      expect(result).toBeDefined();
      expect(result!.listing.status).toBe('sold');
      expect(result!.acceptedBid.status).toBe('accepted');
    });

    it('closes all other open bids with sold_to_other', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      const r1 = await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const r2 = await addBid('guild-1', l.id, { userId: 'user-3', username: 'Carol', amount: 25 });
      const result = await acceptBid('guild-1', l.id, r1!.bid.id);
      expect(result!.closedBids).toHaveLength(1);
      expect(result!.closedBids[0].id).toBe(r2!.bid.id);
      expect(result!.closedBids[0].status).toBe('sold_to_other');
    });

    it('returns undefined for non-existent bid', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      expect(await acceptBid('guild-1', l.id, 'bad-bid')).toBeUndefined();
    });
  });

  // ── buyNow ────────────────────────────────────────────────────────────────

  describe('buyNow', () => {
    it('creates an already-accepted bid and marks the listing sold in one step', async () => {
      const l = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: false });
      const result = await buyNow('guild-1', l.id, 'buyer-1', 'Buyer');
      expect(result).toBeDefined();
      expect(result!.listing.status).toBe('sold');
      expect(result!.boughtBid.status).toBe('accepted');
      expect(result!.boughtBid.userId).toBe('buyer-1');
    });

    it('closes any existing open bids (e.g. a pending "I\'m Interested" message) as sold_to_other', async () => {
      const l = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: false });
      const existing = await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob' });
      const result = await buyNow('guild-1', l.id, 'buyer-1', 'Buyer');
      expect(result!.closedBids).toHaveLength(1);
      expect(result!.closedBids[0].id).toBe(existing!.bid.id);
      expect(result!.closedBids[0].status).toBe('sold_to_other');
    });

    it('returns undefined for a non-existent listing', async () => {
      expect(await buyNow('guild-1', 'no-such-listing', 'buyer-1', 'Buyer')).toBeUndefined();
    });

    it('returns undefined (race lost) when the listing is already sold', async () => {
      const l = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: false });
      await buyNow('guild-1', l.id, 'buyer-1', 'Buyer');
      expect(await buyNow('guild-1', l.id, 'buyer-2', 'Second Buyer')).toBeUndefined();
    });

    it('returns undefined for a closed listing', async () => {
      const l = await createListing('guild-1', { ...BASE_LISTING, bidsAllowed: false });
      await closeListing('guild-1', l.id);
      expect(await buyNow('guild-1', l.id, 'buyer-1', 'Buyer')).toBeUndefined();
    });
  });

  // ── denyBid ───────────────────────────────────────────────────────────────

  describe('denyBid', () => {
    it('marks bid as denied', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      const r = await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const result = await denyBid('guild-1', l.id, r!.bid.id);
      expect(result!.bid.status).toBe('denied');
    });

    it('reverts listing to active when no open bids remain', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      const r = await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob' });
      expect((await getListing('guild-1', l.id))!.status).toBe('pending');
      await denyBid('guild-1', l.id, r!.bid.id);
      expect((await getListing('guild-1', l.id))!.status).toBe('active');
    });

    it('stays pending when other open bids remain', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      const r1 = await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob' });
      await addBid('guild-1', l.id, { userId: 'user-3', username: 'Carol' });
      await denyBid('guild-1', l.id, r1!.bid.id);
      expect((await getListing('guild-1', l.id))!.status).toBe('pending');
    });
  });

  // ── addCounter ────────────────────────────────────────────────────────────

  describe('addCounter', () => {
    it('appends a counter to the bid', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      const r = await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const c = await addCounter('guild-1', l.id, r!.bid.id, {
        fromUserId: 'user-1',
        fromUsername: 'Alice',
        amount: 22,
      });
      expect(c).toBeDefined();
      expect(c!.bid.counters).toHaveLength(1);
      expect(c!.counter.amount).toBe(22);
    });
  });

  // ── closeListing / reopenListing ──────────────────────────────────────────

  describe('closeListing', () => {
    it('sets status to closed', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      await closeListing('guild-1', l.id);
      expect((await getListing('guild-1', l.id))!.status).toBe('closed');
    });

    it('returns undefined for non-existent listing', async () => {
      expect(await closeListing('guild-1', 'bad-id')).toBeUndefined();
    });
  });

  describe('reopenListing', () => {
    it('reopens a closed listing to active when no open bids', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      await closeListing('guild-1', l.id);
      const reopened = await reopenListing('guild-1', l.id);
      expect(reopened!.status).toBe('active');
    });

    it('reopens to pending when there are open bids', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob' });
      await closeListing('guild-1', l.id);
      const reopened = await reopenListing('guild-1', l.id);
      expect(reopened!.status).toBe('pending');
    });
  });

  // ── purgeListings ─────────────────────────────────────────────────────────

  describe('purgeListings', () => {
    it('removes sold and closed listings by default filter', async () => {
      const l1 = await createListing('guild-1', BASE_LISTING);
      const l2 = await createListing('guild-1', BASE_LISTING);
      const l3 = await createListing('guild-1', BASE_LISTING);
      await closeListing('guild-1', l1.id);
      const r = await addBid('guild-1', l2.id, { userId: 'user-2', username: 'Bob' });
      await acceptBid('guild-1', l2.id, r!.bid.id);
      const removed = await purgeListings('guild-1', { status: ['sold', 'closed'] });
      expect(removed).toBe(2);
      expect(await getListingsForGuild('guild-1')).toHaveLength(1);
      expect((await getListingsForGuild('guild-1'))[0].id).toBe(l3.id);
    });

    it('purges only specified user when userId is provided', async () => {
      await createListing('guild-1', BASE_LISTING);
      await createListing('guild-1', { ...BASE_LISTING, userId: 'user-2', username: 'Bob' });
      await closeListing('guild-1', (await getListingsForGuild('guild-1'))[0].id);
      await closeListing('guild-1', (await getListingsForGuild('guild-1'))[1].id);
      const removed = await purgeListings('guild-1', { userId: 'user-1', status: ['closed'] });
      expect(removed).toBe(1);
      expect(await getListingsForGuild('guild-1')).toHaveLength(1);
      expect((await getListingsForGuild('guild-1'))[0].userId).toBe('user-2');
    });

    it('returns 0 when nothing matches', async () => {
      await createListing('guild-1', BASE_LISTING);
      expect(await purgeListings('guild-1', { status: ['sold'] })).toBe(0);
    });

    it('purges active listings when status includes active', async () => {
      const l1 = await createListing('guild-1', BASE_LISTING);
      await createListing('guild-1', BASE_LISTING);
      await closeListing('guild-1', l1.id);
      const removed = await purgeListings('guild-1', { status: ['active'] });
      expect(removed).toBe(1);
      expect((await getListingsForGuild('guild-1'))[0].status).toBe('closed');
    });

    it('purges active and pending listings together', async () => {
      const l1 = await createListing('guild-1', BASE_LISTING); // will be closed
      const l2 = await createListing('guild-1', BASE_LISTING); // will be pending
      const l3 = await createListing('guild-1', BASE_LISTING); // stays active
      await closeListing('guild-1', l1.id);
      await addBid('guild-1', l2.id, { userId: 'user-2', username: 'Bob' });
      const removed = await purgeListings('guild-1', { status: ['active', 'pending'] });
      expect(removed).toBe(2);
      expect(await getListingsForGuild('guild-1')).toHaveLength(1);
      expect((await getListingsForGuild('guild-1'))[0].id).toBe(l1.id);
      void l3; // created to establish the active listing that gets purged
    });
  });

  // ── updateListing ─────────────────────────────────────────────────────────

  describe('updateListing', () => {
    it('patches a field and persists the change', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      const updated = await updateListing('guild-1', l.id, { forumThreadId: 'thread-123' });
      expect(updated).toBeDefined();
      expect(updated!.forumThreadId).toBe('thread-123');
      expect((await getListing('guild-1', l.id))!.forumThreadId).toBe('thread-123');
    });

    it('returns undefined for a non-existent listing', async () => {
      expect(await updateListing('guild-1', 'bad-id', { forumThreadId: 'x' })).toBeUndefined();
    });
  });

  // ── updateBid ─────────────────────────────────────────────────────────────

  describe('updateBid', () => {
    it('patches a bid field and persists the change', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      const r = await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const result = await updateBid('guild-1', l.id, r!.bid.id, { negotiationThreadId: 'thread-456' });
      expect(result).toBeDefined();
      expect(result!.bid.negotiationThreadId).toBe('thread-456');
    });

    it('returns undefined for a non-existent bid', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      expect(
        await updateBid('guild-1', l.id, 'bad-bid', { negotiationThreadId: 'x' }),
      ).toBeUndefined();
    });

    it('persists the dmChannelId/dmMessageId of the bid\'s current action prompt', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      const r = await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const result = await updateBid('guild-1', l.id, r!.bid.id, {
        dmChannelId: 'dm-channel-1',
        dmMessageId: 'dm-message-1',
      });
      expect(result!.bid.dmChannelId).toBe('dm-channel-1');
      expect(result!.bid.dmMessageId).toBe('dm-message-1');
    });
  });

  // ── CONDITION_LABELS ──────────────────────────────────────────────────────

  describe('CONDITION_LABELS', () => {
    it('uses "new" (not "mint") as the top condition key', () => {
      expect(CONDITION_LABELS['new']).toBe('New');
      expect(CONDITION_LABELS['mint' as never]).toBeUndefined();
    });

    it('has all five condition keys', () => {
      const keys = Object.keys(CONDITION_LABELS);
      expect(keys).toEqual(['new', 'like_new', 'very_good', 'good', 'acceptable']);
    });
  });

  // ── getOpenBid ────────────────────────────────────────────────────────────

  describe('getOpenBid', () => {
    it('returns the open bid for a user', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const listing = (await getListing('guild-1', l.id))!;
      const bid = getOpenBid(listing, 'user-2');
      expect(bid).toBeDefined();
      expect(bid!.userId).toBe('user-2');
    });

    it('returns undefined when the user has no open bid', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      expect(getOpenBid(l, 'user-2')).toBeUndefined();
    });

    it('returns undefined after the bid is denied', async () => {
      const l = await createListing('guild-1', BASE_LISTING);
      const r = await addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob' });
      await denyBid('guild-1', l.id, r!.bid.id);
      const listing = (await getListing('guild-1', l.id))!;
      expect(getOpenBid(listing, 'user-2')).toBeUndefined();
    });
  });
});
