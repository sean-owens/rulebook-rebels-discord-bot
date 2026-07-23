// Discord's permission overwrites are only eventually consistent. A message
// pinned immediately after creating a brand-new channel (as every "Quick
// Actions"/list pin does, right after the bot grants itself ManageMessages on
// that same channel) can transiently 403 with "Missing Permissions" even
// though the permission is already correctly in place a moment later, because
// the edge node handling the pin request hasn't caught up yet. A single
// short-delay retry clears this without masking a real permissions problem
// (e.g. an admin actually revoking Manage Messages) as an infinite loop.

const MISSING_PERMISSIONS_CODE = 50013;
const RETRY_DELAY_MS = 1000;

function isMissingPermissionsError(err: unknown): boolean {
  return (err as { code?: number } | undefined)?.code === MISSING_PERMISSIONS_CODE;
}

export async function pinWithRetry(target: { pin(): Promise<unknown> }, context: string): Promise<void> {
  try {
    await target.pin();
    return;
  } catch (err) {
    if (!isMissingPermissionsError(err)) {
      console.warn(`Could not pin ${context}:`, err);
      return;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  try {
    await target.pin();
  } catch (err) {
    console.warn(`Could not pin ${context} (retried once after a delay):`, err);
  }
}
