import { readText, writeText } from './db';

export type MarketplaceEventType =
  | 'listing_created'
  | 'listing_closed'
  | 'listing_sold'
  | 'listing_reopened'
  | 'bid_placed'
  | 'bid_accepted'
  | 'bid_denied'
  | 'bid_withdrawn'
  | 'counter_made'
  | 'admin_purge';

export interface MarketplaceLogEntry {
  timestamp: string;
  guildId: string;
  event: MarketplaceEventType;
  listingId: string;
  listingName: string;
  listingType: 'sell' | 'trade';
  actorId: string;
  actorUsername: string;
  bidId?: string;
  counterId?: string;
  amount?: number;
  offer?: string;
  details?: string;
}

const LOG_FILE = 'marketplace_log.jsonl';

export async function appendMarketplaceLog(entry: MarketplaceLogEntry): Promise<void> {
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
  const existing = await readText(LOG_FILE, '');
  await writeText(LOG_FILE, existing + line);
}

export async function readMarketplaceLog(): Promise<MarketplaceLogEntry[]> {
  const content = await readText(LOG_FILE, '');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MarketplaceLogEntry);
}
