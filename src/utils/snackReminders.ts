import { Client } from 'discord.js';
import { SnackList, findSnackListByChannel } from './snackStorage';
import { GameNight } from './storage';

// Each member's snack items, in the order they were added, for everyone on the
// list except anyone who has since RSVP'd "can't go" (a reminder to bring food
// to an event they're not attending would just be noise).
export function groupSnacksByUser(list: SnackList, declinedUserIds: string[]): Map<string, string[]> {
  const byUser = new Map<string, string[]>();
  for (const { userId, item } of list.items) {
    if (declinedUserIds.includes(userId)) continue;
    byUser.set(userId, [...(byUser.get(userId) ?? []), item]);
  }
  return byUser;
}

export function buildSnackReminderMessage(gn: Pick<GameNight, 'title' | 'date' | 'eventChannelId'>, items: string[]): string {
  const where = gn.eventChannelId ? ` (<#${gn.eventChannelId}>)` : '';
  return (
    `🍿 **Snack reminder** — the lineup for **${gn.title ?? 'the event'}** on ${gn.date} just locked${where}. ` +
    `You said you'd bring:\n${items.map((i) => `• ${i}`).join('\n')}\n` +
    'Plans changed? Run `/snacks remove` in the event channel to take one off the list.'
  );
}

// Side effect: DMs every member with snacks on this event's list a reminder of
// what they signed up for. Sent at lineup lock, right after the "please bring
// this game" asks, so the two nudges arrive together. Returns how many
// reminders were delivered. A member with DMs disabled is logged and skipped —
// one failed DM never blocks the rest or the lock itself.
export async function sendSnackReminders(client: Client, gn: GameNight): Promise<number> {
  if (!gn.eventChannelId) return 0;
  const list = await findSnackListByChannel(gn.eventChannelId);
  if (!list || list.items.length === 0) return 0;

  let sent = 0;
  for (const [userId, items] of groupSnacksByUser(list, gn.rsvps.no)) {
    try {
      const user = await client.users.fetch(userId);
      await user.send(buildSnackReminderMessage(gn, items));
      sent++;
    } catch (err) {
      console.warn(`Could not DM snack reminder to ${userId} for game night ${gn.id}:`, err);
    }
  }
  return sent;
}
