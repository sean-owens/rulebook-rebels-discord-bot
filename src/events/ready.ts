import { Client } from 'discord.js';
import { checkPendingLocks } from '../utils/archive';

const LOCK_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function handleReady(client: Client): void {
  console.log(`Logged in as ${client.user?.tag}`);

  checkPendingLocks(client).catch((err) => console.warn('Lock check failed on startup:', err));

  setInterval(() => {
    checkPendingLocks(client).catch((err) => console.warn('Lock check failed:', err));
  }, LOCK_CHECK_INTERVAL_MS);
}
