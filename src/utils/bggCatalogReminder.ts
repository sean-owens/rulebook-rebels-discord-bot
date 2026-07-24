import { Client } from 'discord.js';
import { getBggCatalogReminderSentAt, markBggCatalogReminderSent } from './systemState';

const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

export async function checkBggCatalogReminder(client: Client): Promise<void> {
  const maintainerId = process.env.BGG_CATALOG_MAINTAINER_ID;
  if (!maintainerId) return;

  const lastSent = await getBggCatalogReminderSentAt();
  if (lastSent && Date.now() - lastSent.getTime() < REMINDER_INTERVAL_MS) return;

  // Mark sent before attempting delivery — a maintainer with DMs disabled
  // shouldn't cause this to retry (and log a warning) on every tick forever.
  await markBggCatalogReminderSent();
  try {
    const user = await client.users.fetch(maintainerId);
    await user.send(
      "📦 **BGG catalog check-in** — it's been a week since the last reminder. If BoardGameGeek has published a newer " +
        '`boardgames_ranks` dump (https://boardgamegeek.com/data_dumps/bg_ranks), replace the zip in `BGG/backup-data/`, ' +
        'commit, and redeploy. If nothing new, just ignore this.',
    );
  } catch (err) {
    console.warn('[BGGCatalogReminder] Failed to DM maintainer:', err);
  }
}
