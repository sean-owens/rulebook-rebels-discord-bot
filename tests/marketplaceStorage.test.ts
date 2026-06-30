import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createListing,
  getListing,
  getListingsForGuild,
  getActiveListingsForGuild,
  getUserListings,
  updateListing,
  addBid,
  updateBid,
  addCounter,
  acceptBid,
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
    it('creates a listing with status active', () => {
      const l = createListing('guild-1', BASE_LISTING);
      expect(l.status).toBe('active');
      expect(l.bids).toHaveLength(0);
    });

    it('assigns a unique id', () => {
      const a = createListing('guild-1', BASE_LISTING);
      const b = createListing('guild-1', BASE_LISTING);
      expect(a.id).not.toBe(b.id);
    });

    it('persists the listing', () => {
      const l = createListing('guild-1', BASE_LISTING);
      expect(getListing('guild-1', l.id)).toBeDefined();
    });

    it('scopes listings to guild', () => {
      createListing('guild-1', BASE_LISTING);
      expect(getListingsForGuild('guild-2')).toHaveLength(0);
    });
  });

  // ── getActiveListingsForGuild ──────────────────────────────────────────────

  describe('getActiveListingsForGuild', () => {
    it('returns active and pending listings only', () => {
      const l1 = createListing('guild-1', BASE_LISTING);
      const l2 = createListing('guild-1', BASE_LISTING);
      closeListing('guild-1', l2.id);
      const active = getActiveListingsForGuild('guild-1');
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(l1.id);
    });
  });

  // ── getUserListings ────────────────────────────────────────────────────────

  describe('getUserListings', () => {
    it("returns only that user's listings", () => {
      createListing('guild-1', BASE_LISTING);
      createListing('guild-1', { ...BASE_LISTING, userId: 'user-2', username: 'Bob' });
      expect(getUserListings('guild-1', 'user-1')).toHaveLength(1);
    });
  });

  // ── addBid ─────────────────────────────────────────────────────────────────

  describe('addBid', () => {
    it('adds a bid and returns listing + bid', () => {
      const l = createListing('guild-1', BASE_LISTING);
      const result = addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      expect(result).toBeDefined();
      expect(result!.bid.status).toBe('open');
      expect(result!.bid.amount).toBe(20);
    });

    it('transitions listing status to pending on first bid', () => {
      const l = createListing('guild-1', BASE_LISTING);
      expect(l.status).toBe('active');
      const result = addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob' });
      expect(result!.listing.status).toBe('pending');
    });

    it('allows multiple bids on a pending listing', () => {
      const l = createListing('guild-1', BASE_LISTING);
      addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      addBid('guild-1', l.id, { userId: 'user-3', username: 'Carol', amount: 25 });
      expect(getListing('guild-1', l.id)!.bids).toHaveLength(2);
    });

    it('returns undefined for non-existent listing', () => {
      expect(addBid('guild-1', 'bad-id', { userId: 'user-2', username: 'Bob' })).toBeUndefined();
    });
  });

  // ── acceptBid ─────────────────────────────────────────────────────────────

  describe('acceptBid', () => {
    it('marks listing as sold and accepted bid as accepted', () => {
      const l = createListing('guild-1', BASE_LISTING);
      const bidResult = addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const result = acceptBid('guild-1', l.id, bidResult!.bid.id);
      expect(result).toBeDefined();
      expect(result!.listing.status).toBe('sold');
      expect(result!.acceptedBid.status).toBe('accepted');
    });

    it('closes all other open bids with sold_to_other', () => {
      const l = createListing('guild-1', BASE_LISTING);
      const r1 = addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const r2 = addBid('guild-1', l.id, { userId: 'user-3', username: 'Carol', amount: 25 });
      const result = acceptBid('guild-1', l.id, r1!.bid.id);
      expect(result!.closedBids).toHaveLength(1);
      expect(result!.closedBids[0].id).toBe(r2!.bid.id);
      expect(result!.closedBids[0].status).toBe('sold_to_other');
    });

    it('returns undefined for non-existent bid', () => {
      const l = createListing('guild-1', BASE_LISTING);
      expect(acceptBid('guild-1', l.id, 'bad-bid')).toBeUndefined();
    });
  });

  // ── denyBid ───────────────────────────────────────────────────────────────

  describe('denyBid', () => {
    it('marks bid as denied', () => {
      const l = createListing('guild-1', BASE_LISTING);
      const r = addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const result = denyBid('guild-1', l.id, r!.bid.id);
      expect(result!.bid.status).toBe('denied');
    });

    it('reverts listing to active when no open bids remain', () => {
      const l = createListing('guild-1', BASE_LISTING);
      const r = addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob' });
      expect(getListing('guild-1', l.id)!.status).toBe('pending');
      denyBid('guild-1', l.id, r!.bid.id);
      expect(getListing('guild-1', l.id)!.status).toBe('active');
    });

    it('stays pending when other open bids remain', () => {
      const l = createListing('guild-1', BASE_LISTING);
      const r1 = addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob' });
      addBid('guild-1', l.id, { userId: 'user-3', username: 'Carol' });
      denyBid('guild-1', l.id, r1!.bid.id);
      expect(getListing('guild-1', l.id)!.status).toBe('pending');
    });
  });

  // ── addCounter ────────────────────────────────────────────────────────────

  describe('addCounter', () => {
    it('appends a counter to the bid', () => {
      const l = createListing('guild-1', BASE_LISTING);
      const r = addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const c = addCounter('guild-1', l.id, r!.bid.id, {
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
    it('sets status to closed', () => {
      const l = createListing('guild-1', BASE_LISTING);
      closeListing('guild-1', l.id);
      expect(getListing('guild-1', l.id)!.status).toBe('closed');
    });

    it('returns undefined for non-existent listing', () => {
      expect(closeListing('guild-1', 'bad-id')).toBeUndefined();
    });
  });

  describe('reopenListing', () => {
    it('reopens a closed listing to active when no open bids', () => {
      const l = createListing('guild-1', BASE_LISTING);
      closeListing('guild-1', l.id);
      const reopened = reopenListing('guild-1', l.id);
      expect(reopened!.status).toBe('active');
    });

    it('reopens to pending when there are open bids', () => {
      const l = createListing('guild-1', BASE_LISTING);
      addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob' });
      closeListing('guild-1', l.id);
      const reopened = reopenListing('guild-1', l.id);
      expect(reopened!.status).toBe('pending');
    });
  });

  // ── purgeListings ─────────────────────────────────────────────────────────

  describe('purgeListings', () => {
    it('removes sold and closed listings by default filter', () => {
      const l1 = createListing('guild-1', BASE_LISTING);
      const l2 = createListing('guild-1', BASE_LISTING);
      const l3 = createListing('guild-1', BASE_LISTING);
      closeListing('guild-1', l1.id);
      const r = addBid('guild-1', l2.id, { userId: 'user-2', username: 'Bob' });
      acceptBid('guild-1', l2.id, r!.bid.id);
      const removed = purgeListings('guild-1', { status: ['sold', 'closed'] });
      expect(removed).toBe(2);
      expect(getListingsForGuild('guild-1')).toHaveLength(1);
      expect(getListingsForGuild('guild-1')[0].id).toBe(l3.id);
    });

    it('purges only specified user when userId is provided', () => {
      createListing('guild-1', BASE_LISTING);
      createListing('guild-1', { ...BASE_LISTING, userId: 'user-2', username: 'Bob' });
      closeListing('guild-1', getListingsForGuild('guild-1')[0].id);
      closeListing('guild-1', getListingsForGuild('guild-1')[1].id);
      const removed = purgeListings('guild-1', { userId: 'user-1', status: ['closed'] });
      expect(removed).toBe(1);
      expect(getListingsForGuild('guild-1')).toHaveLength(1);
      expect(getListingsForGuild('guild-1')[0].userId).toBe('user-2');
    });

    it('returns 0 when nothing matches', () => {
      createListing('guild-1', BASE_LISTING);
      expect(purgeListings('guild-1', { status: ['sold'] })).toBe(0);
    });

    it('purges active listings when status includes active', () => {
      const l1 = createListing('guild-1', BASE_LISTING);
      createListing('guild-1', BASE_LISTING);
      closeListing('guild-1', l1.id);
      const removed = purgeListings('guild-1', { status: ['active'] });
      expect(removed).toBe(1);
      expect(getListingsForGuild('guild-1')[0].status).toBe('closed');
    });

    it('purges active and pending listings together', () => {
      const l1 = createListing('guild-1', BASE_LISTING); // will be closed
      const l2 = createListing('guild-1', BASE_LISTING); // will be pending
      const l3 = createListing('guild-1', BASE_LISTING); // stays active
      closeListing('guild-1', l1.id);
      addBid('guild-1', l2.id, { userId: 'user-2', username: 'Bob' });
      const removed = purgeListings('guild-1', { status: ['active', 'pending'] });
      expect(removed).toBe(2);
      expect(getListingsForGuild('guild-1')).toHaveLength(1);
      expect(getListingsForGuild('guild-1')[0].id).toBe(l1.id);
      void l3; // created to establish the active listing that gets purged
    });
  });

  // ── updateListing ─────────────────────────────────────────────────────────

  describe('updateListing', () => {
    it('patches a field and persists the change', () => {
      const l = createListing('guild-1', BASE_LISTING);
      const updated = updateListing('guild-1', l.id, { forumThreadId: 'thread-123' });
      expect(updated).toBeDefined();
      expect(updated!.forumThreadId).toBe('thread-123');
      expect(getListing('guild-1', l.id)!.forumThreadId).toBe('thread-123');
    });

    it('returns undefined for a non-existent listing', () => {
      expect(updateListing('guild-1', 'bad-id', { forumThreadId: 'x' })).toBeUndefined();
    });
  });

  // ── updateBid ─────────────────────────────────────────────────────────────

  describe('updateBid', () => {
    it('patches a bid field and persists the change', () => {
      const l = createListing('guild-1', BASE_LISTING);
      const r = addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const result = updateBid('guild-1', l.id, r!.bid.id, { negotiationThreadId: 'thread-456' });
      expect(result).toBeDefined();
      expect(result!.bid.negotiationThreadId).toBe('thread-456');
    });

    it('returns undefined for a non-existent bid', () => {
      const l = createListing('guild-1', BASE_LISTING);
      expect(updateBid('guild-1', l.id, 'bad-bid', { negotiationThreadId: 'x' })).toBeUndefined();
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
    it('returns the open bid for a user', () => {
      const l = createListing('guild-1', BASE_LISTING);
      addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob', amount: 20 });
      const listing = getListing('guild-1', l.id)!;
      const bid = getOpenBid(listing, 'user-2');
      expect(bid).toBeDefined();
      expect(bid!.userId).toBe('user-2');
    });

    it('returns undefined when the user has no open bid', () => {
      const l = createListing('guild-1', BASE_LISTING);
      expect(getOpenBid(l, 'user-2')).toBeUndefined();
    });

    it('returns undefined after the bid is denied', () => {
      const l = createListing('guild-1', BASE_LISTING);
      const r = addBid('guild-1', l.id, { userId: 'user-2', username: 'Bob' });
      denyBid('guild-1', l.id, r!.bid.id);
      const listing = getListing('guild-1', l.id)!;
      expect(getOpenBid(listing, 'user-2')).toBeUndefined();
    });
  });
});
