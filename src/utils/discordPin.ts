// Discord's permission overwrites are only eventually consistent. A message
// pinned immediately after creating a brand-new channel (as every "Quick
// Actions"/list pin does, right after the bot grants itself ManageMessages on
// that same channel) can transiently 403 with "Missing Permissions" even
// though the permission is already correctly in place — live testing showed
// this can take longer than a second to clear, sometimes tens of seconds.
// Retrying that long inline would block the caller (which has often already
// deferred/replied and is doing other work), so only the first attempt is
// awaited here; further attempts run in the background on an increasing
// delay and are logged only if every attempt is exhausted. A non-50013 error
// is assumed to be a real permissions problem, not this propagation quirk,
// so it's logged immediately with no retry.

const MISSING_PERMISSIONS_CODE = 50013;
const BACKGROUND_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000];

interface Pinnable {
  pin(): Promise<unknown>;
}

function isMissingPermissionsError(err: unknown): boolean {
  return (err as { code?: number } | undefined)?.code === MISSING_PERMISSIONS_CODE;
}

export async function pinWithRetry(target: Pinnable, context: string): Promise<void> {
  try {
    await target.pin();
    return;
  } catch (err) {
    if (!isMissingPermissionsError(err)) {
      console.warn(`Could not pin ${context}:`, err);
      return;
    }
  }

  void retryInBackground(target, context, 0);
}

async function retryInBackground(target: Pinnable, context: string, attempt: number): Promise<void> {
  if (attempt >= BACKGROUND_RETRY_DELAYS_MS.length) {
    console.warn(`Could not pin ${context} (gave up after ${BACKGROUND_RETRY_DELAYS_MS.length} background retries)`);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, BACKGROUND_RETRY_DELAYS_MS[attempt]));
  try {
    await target.pin();
  } catch (err) {
    if (!isMissingPermissionsError(err)) {
      console.warn(`Could not pin ${context}:`, err);
      return;
    }
    await retryInBackground(target, context, attempt + 1);
  }
}
