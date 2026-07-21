import { randomUUID } from 'crypto';
import { readJson, writeJson } from './db';

const FILE = 'marketplace.json';

export type ListingType = 'sell' | 'trade';
export type ListingStatus = 'active' | 'pending' | 'sold' | 'closed';
export type BidStatus = 'open' | 'accepted' | 'denied' | 'withdrawn' | 'sold_to_other';
export type Condition = 'new' | 'like_new' | 'very_good' | 'good' | 'acceptable';

export const CONDITION_LABELS: Record<Condition, string> = {
  new: 'New',
  like_new: 'Like New',
  very_good: 'Very Good',
  good: 'Good',
  acceptable: 'Acceptable',
};

export interface Counter {
  id: string;
  fromUserId: string;
  fromUsername: string;
  amount?: number;
  offer?: string;
  message?: string;
  createdAt: string;
}

export interface Bid {
  id: string;
  listingId: string;
  userId: string;
  username: string;
  amount?: number;
  offer?: string;
  message?: string;
  status: BidStatus;
  counters: Counter[];
  /** Channel + message ID of the current DM (or thread/reply-fallback) prompt awaiting a response for this bid. */
  dmChannelId?: string;
  dmMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceListing {
  id: string;
  guildId: string;
  userId: string;
  username: string;
  type: ListingType;
  bggId?: string;
  itemName: string;
  thumbnail?: string;
  condition?: Condition;
  notes?: string;
  askingPrice?: number;
  referenceLink?: string;
  bidsAllowed: boolean;
  lookingFor?: string;
  expansions?: { bggId: string; name: string }[];
  parentItem?: { bggId: string; name: string };
  includesBaseGame?: boolean;
  status: ListingStatus;
  // Forum-mode only: the forum post's own thread, holding this listing's
  // embed/button (see postListingToChannel in marketplace.ts).
  forumThreadId?: string;
  // Text-mode only: the listing's embed/button lives in a plain message
  // (listingMessageId) in the configured Text channel (listingChannelId) — no
  // Discord thread is created. Follow-up activity (offer notifications, DM
  // fallback, sold/closed announcements) is posted as a reply to this message
  // instead of into a thread (see postListingFollowup in marketplace.ts).
  listingMessageId?: string;
  listingChannelId?: string;
  bids: Bid[];
  createdAt: string;
  updatedAt: string;
}

type MarketplaceStore = Record<string, MarketplaceListing[]>;

function load(): Promise<MarketplaceStore> {
  return readJson<MarketplaceStore>(FILE, {});
}

function save(store: MarketplaceStore): Promise<void> {
  return writeJson(FILE, store);
}

export async function getListingsForGuild(guildId: string): Promise<MarketplaceListing[]> {
  return (await load())[guildId] ?? [];
}

export async function getListing(
  guildId: string,
  listingId: string,
): Promise<MarketplaceListing | undefined> {
  return (await getListingsForGuild(guildId)).find((l) => l.id === listingId);
}

export async function findListingById(
  listingId: string,
): Promise<{ guildId: string; listing: MarketplaceListing } | undefined> {
  const store = await load();
  for (const [guildId, listings] of Object.entries(store)) {
    const listing = listings.find((l) => l.id === listingId);
    if (listing) return { guildId, listing };
  }
  return undefined;
}

export async function getActiveListingsForGuild(
  guildId: string,
): Promise<MarketplaceListing[]> {
  return (await getListingsForGuild(guildId)).filter(
    (l) => l.status === 'active' || l.status === 'pending',
  );
}

export async function getUserListings(
  guildId: string,
  userId: string,
): Promise<MarketplaceListing[]> {
  return (await getListingsForGuild(guildId)).filter((l) => l.userId === userId);
}

export async function createListing(
  guildId: string,
  data: Omit<MarketplaceListing, 'id' | 'bids' | 'status' | 'createdAt' | 'updatedAt'>,
): Promise<MarketplaceListing> {
  const store = await load();
  const listings = store[guildId] ?? [];
  const now = new Date().toISOString();
  const listing: MarketplaceListing = {
    ...data,
    id: randomUUID(),
    status: 'active',
    bids: [],
    createdAt: now,
    updatedAt: now,
  };
  listings.push(listing);
  store[guildId] = listings;
  await save(store);
  return listing;
}

export async function updateListing(
  guildId: string,
  listingId: string,
  patch: Partial<Pick<MarketplaceListing, 'status' | 'forumThreadId' | 'listingMessageId' | 'listingChannelId' | 'bids' | 'updatedAt'>>,
): Promise<MarketplaceListing | undefined> {
  const store = await load();
  const listings = store[guildId] ?? [];
  const idx = listings.findIndex((l) => l.id === listingId);
  if (idx === -1) return undefined;
  listings[idx] = { ...listings[idx], ...patch, updatedAt: new Date().toISOString() };
  store[guildId] = listings;
  await save(store);
  return listings[idx];
}

export async function addBid(
  guildId: string,
  listingId: string,
  bidData: Omit<Bid, 'id' | 'listingId' | 'status' | 'counters' | 'createdAt' | 'updatedAt'>,
): Promise<{ listing: MarketplaceListing; bid: Bid } | undefined> {
  const store = await load();
  const listings = store[guildId] ?? [];
  const idx = listings.findIndex((l) => l.id === listingId);
  if (idx === -1) return undefined;

  const listing = listings[idx];
  const now = new Date().toISOString();
  const bid: Bid = {
    ...bidData,
    id: randomUUID(),
    listingId,
    status: 'open',
    counters: [],
    createdAt: now,
    updatedAt: now,
  };

  listing.bids.push(bid);

  if (listing.status === 'active') {
    listing.status = 'pending';
  }
  listing.updatedAt = now;

  store[guildId] = listings;
  await save(store);
  return { listing, bid };
}

export async function updateBid(
  guildId: string,
  listingId: string,
  bidId: string,
  patch: Partial<Pick<Bid, 'status' | 'counters' | 'dmChannelId' | 'dmMessageId'>>,
): Promise<{ listing: MarketplaceListing; bid: Bid } | undefined> {
  const store = await load();
  const listings = store[guildId] ?? [];
  const listingIdx = listings.findIndex((l) => l.id === listingId);
  if (listingIdx === -1) return undefined;

  const listing = listings[listingIdx];
  const bidIdx = listing.bids.findIndex((b) => b.id === bidId);
  if (bidIdx === -1) return undefined;

  listing.bids[bidIdx] = { ...listing.bids[bidIdx], ...patch, updatedAt: new Date().toISOString() };
  listing.updatedAt = new Date().toISOString();
  store[guildId] = listings;
  await save(store);
  return { listing, bid: listing.bids[bidIdx] };
}

export async function addCounter(
  guildId: string,
  listingId: string,
  bidId: string,
  counter: Omit<Counter, 'id' | 'createdAt'>,
): Promise<{ listing: MarketplaceListing; bid: Bid; counter: Counter } | undefined> {
  const store = await load();
  const listings = store[guildId] ?? [];
  const listingIdx = listings.findIndex((l) => l.id === listingId);
  if (listingIdx === -1) return undefined;

  const listing = listings[listingIdx];
  const bidIdx = listing.bids.findIndex((b) => b.id === bidId);
  if (bidIdx === -1) return undefined;

  const now = new Date().toISOString();
  const newCounter: Counter = { ...counter, id: randomUUID(), createdAt: now };
  listing.bids[bidIdx].counters.push(newCounter);
  listing.bids[bidIdx].updatedAt = now;
  listing.updatedAt = now;
  store[guildId] = listings;
  await save(store);
  return { listing, bid: listing.bids[bidIdx], counter: newCounter };
}

export async function acceptBid(
  guildId: string,
  listingId: string,
  bidId: string,
): Promise<{ listing: MarketplaceListing; acceptedBid: Bid; closedBids: Bid[] } | undefined> {
  const store = await load();
  const listings = store[guildId] ?? [];
  const listingIdx = listings.findIndex((l) => l.id === listingId);
  if (listingIdx === -1) return undefined;

  const listing = listings[listingIdx];
  const bidIdx = listing.bids.findIndex((b) => b.id === bidId);
  if (bidIdx === -1) return undefined;

  const now = new Date().toISOString();
  const closedBids: Bid[] = [];

  for (let i = 0; i < listing.bids.length; i++) {
    if (listing.bids[i].id === bidId) {
      listing.bids[i].status = 'accepted';
      listing.bids[i].updatedAt = now;
    } else if (listing.bids[i].status === 'open') {
      listing.bids[i].status = 'sold_to_other';
      listing.bids[i].updatedAt = now;
      closedBids.push(listing.bids[i]);
    }
  }

  listing.status = 'sold';
  listing.updatedAt = now;
  store[guildId] = listings;
  await save(store);
  return { listing, acceptedBid: listing.bids[bidIdx], closedBids };
}

/**
 * Buy It Now (firm listings only): creates a bid already in the 'accepted'
 * state and marks the listing sold in one atomic step — there's no seller
 * review to wait on since the price was already fixed. Any other open bids
 * (e.g. someone's pending "I'm Interested" message) are closed out exactly
 * like acceptBid() does, since the item is no longer available.
 */
export async function buyNow(
  guildId: string,
  listingId: string,
  buyerUserId: string,
  buyerUsername: string,
): Promise<{ listing: MarketplaceListing; boughtBid: Bid; closedBids: Bid[] } | undefined> {
  const store = await load();
  const listings = store[guildId] ?? [];
  const listingIdx = listings.findIndex((l) => l.id === listingId);
  if (listingIdx === -1) return undefined;

  const listing = listings[listingIdx];
  if (listing.status === 'sold' || listing.status === 'closed') return undefined;

  const now = new Date().toISOString();
  const closedBids: Bid[] = [];
  for (const bid of listing.bids) {
    if (bid.status === 'open') {
      bid.status = 'sold_to_other';
      bid.updatedAt = now;
      closedBids.push(bid);
    }
  }

  const boughtBid: Bid = {
    id: randomUUID(),
    listingId,
    userId: buyerUserId,
    username: buyerUsername,
    status: 'accepted',
    counters: [],
    createdAt: now,
    updatedAt: now,
  };
  listing.bids.push(boughtBid);
  listing.status = 'sold';
  listing.updatedAt = now;

  store[guildId] = listings;
  await save(store);
  return { listing, boughtBid, closedBids };
}

export async function denyBid(
  guildId: string,
  listingId: string,
  bidId: string,
): Promise<{ listing: MarketplaceListing; bid: Bid } | undefined> {
  const store = await load();
  const listings = store[guildId] ?? [];
  const listingIdx = listings.findIndex((l) => l.id === listingId);
  if (listingIdx === -1) return undefined;

  const listing = listings[listingIdx];
  const bidIdx = listing.bids.findIndex((b) => b.id === bidId);
  if (bidIdx === -1) return undefined;

  const now = new Date().toISOString();
  listing.bids[bidIdx].status = 'denied';
  listing.bids[bidIdx].updatedAt = now;

  const hasOpenBids = listing.bids.some((b) => b.status === 'open');
  if (!hasOpenBids && listing.status === 'pending') {
    listing.status = 'active';
  }
  listing.updatedAt = now;
  store[guildId] = listings;
  await save(store);
  return { listing, bid: listing.bids[bidIdx] };
}

export async function closeListing(
  guildId: string,
  listingId: string,
): Promise<MarketplaceListing | undefined> {
  return updateListing(guildId, listingId, { status: 'closed' });
}

export async function reopenListing(
  guildId: string,
  listingId: string,
): Promise<MarketplaceListing | undefined> {
  const store = await load();
  const listings = store[guildId] ?? [];
  const idx = listings.findIndex((l) => l.id === listingId);
  if (idx === -1) return undefined;

  const now = new Date().toISOString();
  const hasOpenBids = listings[idx].bids.some((b) => b.status === 'open');
  listings[idx].status = hasOpenBids ? 'pending' : 'active';
  listings[idx].updatedAt = now;
  store[guildId] = listings;
  await save(store);
  return listings[idx];
}

export async function purgeListings(
  guildId: string,
  filter: { userId?: string; status?: ListingStatus[] },
): Promise<number> {
  const store = await load();
  const listings = store[guildId] ?? [];
  const before = listings.length;
  store[guildId] = listings.filter((l) => {
    if (filter.userId && l.userId !== filter.userId) return true;
    if (filter.status && !filter.status.includes(l.status)) return true;
    return false;
  });
  await save(store);
  return before - store[guildId].length;
}

export function getOpenBid(listing: MarketplaceListing, userId: string): Bid | undefined {
  return listing.bids.find((b) => b.userId === userId && b.status === 'open');
}
