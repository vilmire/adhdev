/**
 * Typed channel-sync errors returned by the daemon's `activate_provider_updates`
 * command, extracted for display.
 *
 * The daemon has always reported these — `handleActivateProviderUpdates`
 * returns `{ success, activated, channelSync }` and `channelSync.errors[]`
 * carries the typed reason (`DIGEST_MISMATCH`, `TRANSPORT_FAILED`,
 * `ENTRY_ARTIFACT_NOT_FOUND`, …). The dashboard discarded the whole response,
 * so an install that the daemon deliberately REFUSED looked identical to one
 * that quietly did nothing: the row just stayed in the "new on the channel"
 * list with no explanation anywhere in the UI.
 *
 * DIGEST_MISMATCH is the case worth naming explicitly. It does not mean the
 * user did anything wrong and retrying will not fix it — it means the bundle on
 * the provider channel no longer matches the digest the registry published, so
 * the fix is a registry republish by an operator.
 */

export interface ChannelSyncErrorInfo {
  code: string;
  message: string;
  providerType?: string;
}

/** The daemon command result may be bare or wrapped in `{ result }`. */
function unwrapResult(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== 'object') return null;
  const obj = response as Record<string, unknown>;
  const inner = obj.result;
  if (inner && typeof inner === 'object') return inner as Record<string, unknown>;
  return obj;
}

/**
 * Pull every typed error out of an `activate_provider_updates` response.
 *
 * Returns ALL errors, not just the ones tagged with the requested provider
 * type: a sync-level failure (`CHANNEL_METADATA_UNAVAILABLE`,
 * `TRANSPORT_FAILED`) carries no `providerType` at all, and filtering by type
 * would drop exactly the errors that explain why nothing installed. A
 * top-level `error` string (the `success: false` path) is included too.
 */
export function extractChannelSyncErrors(response: unknown): ChannelSyncErrorInfo[] {
  const result = unwrapResult(response);
  if (!result) return [];

  const errors: ChannelSyncErrorInfo[] = [];

  if (result.success === false && typeof result.error === 'string' && result.error.trim()) {
    errors.push({ code: 'COMMAND_FAILED', message: result.error });
  }

  const sync = result.channelSync;
  const rawErrors = sync && typeof sync === 'object'
    ? (sync as Record<string, unknown>).errors
    : undefined;
  if (Array.isArray(rawErrors)) {
    for (const raw of rawErrors) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const code = typeof entry.code === 'string' ? entry.code : 'UNKNOWN';
      const message = typeof entry.message === 'string' ? entry.message : '';
      errors.push({
        code,
        message,
        ...(typeof entry.providerType === 'string' ? { providerType: entry.providerType } : {}),
      });
    }
  }

  return errors;
}

/** True when any reported error is the digest-mismatch refusal. */
export function hasDigestMismatch(errors: readonly ChannelSyncErrorInfo[]): boolean {
  return errors.some((e) => e.code === 'DIGEST_MISMATCH');
}
