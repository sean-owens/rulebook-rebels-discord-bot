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
  negotiationThreadId?: string;
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
  status: ListingStatus;
  forumThreadId?: string;
  bids: Bid[];
  createdAt: string;
  updatedAt: string;
}

type MarketplaceStore = Record<string, MarketplaceListing[]>;

function load(): MarketplaceStore {
  return readJson<MarketplaceStore>(FILE, {});
}

function save(store: MarketplaceStore): void {
  writeJson(FILE, store);
}

export function getListingsForGuild(guildId: string): MarketplaceListing[] {
  return load()[guildId] ?? [];
}

export function getListing(guildId: string, listingId: string): MarketplaceListing | undefined {
  return getListingsForGuild(guildId).find((l) => l.id === listingId);
}

export function getActiveListingsForGuild(guildId: string): MarketplaceListing[] {
  return getListingsForGuild(guildId).filter((l) => l.status === 'active' || l.status === 'pending');
}

export function getUserListings(guildId: string, userId: string): MarketplaceListing[] {
  return getListingsForGuild(guildId).filter((l) => l.userId === userId);
}

export function createListing(
  guildId: string,
  data: Omit<MarketplaceListing, 'id' | 'bids' | 'status' | 'createdAt' | 'updatedAt'>,
): MarketplaceListing {
  const store = load();
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
  save(store);
  return listing;
}

export function updateListing(
  guildId: string,
  listingId: string,
  patch: Partial<Pick<MarketplaceListing, 'status' | 'forumThreadId' | 'bids' | 'updatedAt'>>,
): MarketplaceListing | undefined {
  const store = load();
  const listings = store[guildId] ?? [];
  const idx = listings.findIndex((l) => l.id === listingId);
  if (idx === -1) return undefined;
  listings[idx] = { ...listings[idx], ...patch, updatedAt: new Date().toISOString() };
  store[guildId] = listings;
  save(store);
  return listings[idx];
}

export function addBid(
  guildId: string,
  listingId: string,
  bidData: Omit<Bid, 'id' | 'listingId' | 'status' | 'counters' | 'createdAt' | 'updatedAt'>,
): { listing: MarketplaceListing; bid: Bid } | undefined {
  const store = load();
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
  save(store);
  return { listing, bid };
}

export function updateBid(
  guildId: string,
  listingId: string,
  bidId: string,
  patch: Partial<Pick<Bid, 'status' | 'negotiationThreadId' | 'counters'>>,
): { listing: MarketplaceListing; bid: Bid } | undefined {
  const store = load();
  const listings = store[guildId] ?? [];
  const listingIdx = listings.findIndex((l) => l.id === listingId);
  if (listingIdx === -1) return undefined;

  const listing = listings[listingIdx];
  const bidIdx = listing.bids.findIndex((b) => b.id === bidId);
  if (bidIdx === -1) return undefined;

  listing.bids[bidIdx] = { ...listing.bids[bidIdx], ...patch, updatedAt: new Date().toISOString() };
  listing.updatedAt = new Date().toISOString();
  store[guildId] = listings;
  save(store);
  return { listing, bid: listing.bids[bidIdx] };
}

export function addCounter(
  guildId: string,
  listingId: string,
  bidId: string,
  counter: Omit<Counter, 'id' | 'createdAt'>,
): { listing: MarketplaceListing; bid: Bid; counter: Counter } | undefined {
  const store = load();
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
  save(store);
  return { listing, bid: listing.bids[bidIdx], counter: newCounter };
}

export function acceptBid(
  guildId: string,
  listingId: string,
  bidId: string,
): { listing: MarketplaceListing; acceptedBid: Bid; closedBids: Bid[] } | undefined {
  const store = load();
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
  save(store);
  return { listing, acceptedBid: listing.bids[bidIdx], closedBids };
}

export function denyBid(
  guildId: string,
  listingId: string,
  bidId: string,
): { listing: MarketplaceListing; bid: Bid } | undefined {
  const store = load();
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
  save(store);
  return { listing, bid: listing.bids[bidIdx] };
}

export function closeListing(
  guildId: string,
  listingId: string,
): MarketplaceListing | undefined {
  return updateListing(guildId, listingId, { status: 'closed' });
}

export function reopenListing(
  guildId: string,
  listingId: string,
): MarketplaceListing | undefined {
  const store = load();
  const listings = store[guildId] ?? [];
  const idx = listings.findIndex((l) => l.id === listingId);
  if (idx === -1) return undefined;

  const now = new Date().toISOString();
  const hasOpenBids = listings[idx].bids.some((b) => b.status === 'open');
  listings[idx].status = hasOpenBids ? 'pending' : 'active';
  listings[idx].updatedAt = now;
  store[guildId] = listings;
  save(store);
  return listings[idx];
}

export function purgeListings(
  guildId: string,
  filter: { userId?: string; status?: ListingStatus[] },
): number {
  const store = load();
  const listings = store[guildId] ?? [];
  const before = listings.length;
  store[guildId] = listings.filter((l) => {
    if (filter.userId && l.userId !== filter.userId) return true;
    if (filter.status && !filter.status.includes(l.status)) return true;
    return false;
  });
  save(store);
  return before - store[guildId].length;
}

export function getOpenBid(listing: MarketplaceListing, userId: string): Bid | undefined {
  return listing.bids.find((b) => b.userId === userId && b.status === 'open');
}
