import fs from 'fs';
import path from 'path';

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

function logFilePath(): string {
  const dir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'marketplace_log.jsonl');
}

export function appendMarketplaceLog(entry: MarketplaceLogEntry): void {
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
  fs.appendFileSync(logFilePath(), line, 'utf-8');
}

export function readMarketplaceLog(): MarketplaceLogEntry[] {
  const file = logFilePath();
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MarketplaceLogEntry);
}
