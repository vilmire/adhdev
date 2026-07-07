import type { DaemonData } from '../../types'

export interface ConversationTarget {
  providerSessionId?: string
  historySessionId?: string
  sessionId?: string
  tabKey?: string
  routeId?: string
}

export interface ConversationIdentity extends ConversationTarget {
  canonicalKey: string
  targetKey: string
  targetValue?: string
  historySessionId?: string
  runtimeSessionId?: string
  allKeys: string[]
  lookupKeys: string[]
}

function normalizeKeyPart(value: string | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || undefined
}

function buildPrefixedKey(prefix: 'provider' | 'session' | 'tab' | 'route', value: string | undefined): string | undefined {
  const normalized = normalizeKeyPart(value)
  return normalized ? `${prefix}:${normalized}` : undefined
}

function appendLookupKeys(
  target: string[],
  prefix: 'provider' | 'session' | 'tab' | 'route',
  value: string | undefined,
): void {
  const prefixed = buildPrefixedKey(prefix, value)
  const normalized = normalizeKeyPart(value)
  if (prefixed) target.push(prefixed)
  if (normalized) target.push(normalized)
}

function dedupeKeys(keys: Array<string | undefined>): string[] {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(key)
  }
  return unique
}

export function getConversationTargetValue(target: ConversationTarget): string | undefined {
  return normalizeKeyPart(target.providerSessionId)
    || normalizeKeyPart(target.sessionId)
    || normalizeKeyPart(target.tabKey)
    || normalizeKeyPart(target.routeId)
}

export function getConversationHistoryLookupIds(
  conversation: Pick<ConversationTarget, 'historySessionId' | 'providerSessionId' | 'sessionId'>,
): string[] {
  return dedupeKeys([
    normalizeKeyPart(conversation.historySessionId),
    normalizeKeyPart(conversation.providerSessionId),
    normalizeKeyPart(conversation.sessionId),
  ])
}

export function buildConversationLookupKeys(
  conversation: ConversationTarget,
): string[] {
  const keys: string[] = []
  appendLookupKeys(keys, 'provider', conversation.providerSessionId)
  appendLookupKeys(keys, 'session', conversation.sessionId)
  appendLookupKeys(keys, 'tab', conversation.tabKey)
  appendLookupKeys(keys, 'route', conversation.routeId)
  return dedupeKeys(keys)
}

export function buildConversationTargetLookupKeys(target: ConversationTarget): string[] {
  const keys: string[] = []
  if (normalizeKeyPart(target.providerSessionId)) {
    appendLookupKeys(keys, 'provider', target.providerSessionId)
    return dedupeKeys(keys)
  }
  if (normalizeKeyPart(target.sessionId)) {
    appendLookupKeys(keys, 'session', target.sessionId)
    return dedupeKeys(keys)
  }
  if (normalizeKeyPart(target.tabKey)) {
    appendLookupKeys(keys, 'tab', target.tabKey)
    return dedupeKeys(keys)
  }
  if (normalizeKeyPart(target.routeId)) {
    appendLookupKeys(keys, 'route', target.routeId)
    return dedupeKeys(keys)
  }
  return []
}

export function buildConversationTargetKey(target: ConversationTarget): string {
  return buildPrefixedKey('provider', target.providerSessionId)
    || buildPrefixedKey('session', target.sessionId)
    || buildPrefixedKey('tab', target.tabKey)
    || buildPrefixedKey('route', target.routeId)
    || 'unknown:'
}

export function getConversationHistorySessionId(
  conversation: Pick<ConversationTarget, 'historySessionId' | 'providerSessionId' | 'sessionId'>,
): string | undefined {
  return getConversationHistoryLookupIds(conversation)[0]
}

/**
 * The historySessionId to actually SEND to the daemon on a native-history read
 * (subscribe / read_chat / chat_history). Unlike getConversationHistorySessionId
 * (whose sessionId fallback is fine for local LOOKUP keys), this MUST NOT fall
 * back to the ADHDev runtime sessionId: for an antigravity coordinator whose
 * providerSessionId is never surfaced to the web, that fallback sends the
 * runtime session id back as historySessionId, which the daemon cannot match to
 * the native rows' stamped conv uuid — it fail-closes the read to pty-parser
 * (user-echo only) and bypasses the daemon's owner-confirmed native resolution
 * (which only runs when historySessionId is EMPTY). Return a real, DISTINCT
 * provider/history id (≠ sessionId) or undefined, so the read OMITS the arg and
 * the daemon resolves native history itself. A real distinct provider conv id is
 * still returned unchanged so legitimate exact-binds keep working.
 */
export function getConversationHistorySessionIdForRead(
  conversation: Pick<ConversationTarget, 'historySessionId' | 'providerSessionId' | 'sessionId'>,
): string | undefined {
  const sessionId = normalizeKeyPart(conversation.sessionId)
  const historySessionId = getConversationHistorySessionId(conversation)
  if (!historySessionId) return undefined
  // Omit when the resolved id is just the runtime sessionId (the poison).
  if (sessionId && historySessionId === sessionId) return undefined
  return historySessionId
}

export function buildConversationIdentity(
  conversation: ConversationTarget,
): ConversationIdentity {
  const providerSessionId = normalizeKeyPart(conversation.providerSessionId)
  const sessionId = normalizeKeyPart(conversation.sessionId)
  const tabKey = normalizeKeyPart(conversation.tabKey)
  const routeId = normalizeKeyPart(conversation.routeId)

  const allKeys = [
    buildPrefixedKey('provider', providerSessionId),
    buildPrefixedKey('session', sessionId),
    buildPrefixedKey('tab', tabKey),
    buildPrefixedKey('route', routeId),
  ].filter((value): value is string => typeof value === 'string')
  const lookupKeys = buildConversationLookupKeys({
    providerSessionId,
    sessionId,
    tabKey,
    routeId,
  })

  const targetKey = buildConversationTargetKey({
    providerSessionId,
    sessionId,
    tabKey,
    routeId,
  })

  return {
    providerSessionId,
    sessionId,
    tabKey,
    routeId,
    canonicalKey: targetKey,
    targetKey,
    targetValue: getConversationTargetValue({ providerSessionId, sessionId, tabKey, routeId }),
    historySessionId: getConversationHistorySessionId({ providerSessionId, sessionId }),
    runtimeSessionId: sessionId,
    allKeys,
    lookupKeys,
  }
}

export function conversationMatchesTarget(
  conversation: ConversationTarget,
  target: ConversationTarget,
): boolean {
  const conversationIdentity = buildConversationIdentity(conversation)
  return buildConversationTargetLookupKeys(target)
    .some((lookupKey) => conversationIdentity.lookupKeys.includes(lookupKey))
}

// ─── DaemonData-level session identity (SSOT) ────────────────────────────
//
// The functions above resolve identity for an already-built ActiveConversation
// (provider/session/tab/route keyspace). The ones below are the single source of
// truth for the PRE-build, raw `DaemonData` entry: session-suffix extraction,
// mesh-owned detection, owner-machine resolution, and the three dedup keys.
// Before this consolidation each of these lived inline in useDashboardConversations,
// daemon-utils, and buildConversations with subtly different rules — that drift is
// how the ghost-tab / mis-grouped-machine-card regressions kept recurring. The
// three dedup keys index three different scopes (chat-tab list, machine-card group,
// dockview panel) so they keep distinct output shapes, but they are now all derived
// from this one identity decision instead of being independently re-implemented.

/** Strip the reporting-daemon prefix from `id`, yielding the raw session id shared
 *  across the coordinator-reported and worker-reported copies of one mesh session. */
export function getDaemonEntrySessionSuffix(entry: Pick<DaemonData, 'daemonId' | 'id'>): string {
  const daemonId = String(entry.daemonId || '').trim()
  const id = String(entry.id || '').trim()
  return daemonId && id.startsWith(`${daemonId}:`) ? id.slice(daemonId.length + 1) : id
}

/** True when this entry is a coordinator-synthesised mesh-owned session copy. The
 *  coordinator stamps any of these markers; a worker's own session report carries none.
 *  This is the WIDEST (5-marker) detection on purpose: a dedup path that collapses a copy
 *  carrying only marker A while another path checks only marker B is exactly the drift that
 *  re-introduced ghost tabs, so every dedup path keys off this single predicate. */
export function isMeshOwnedSessionCopy(entry: Pick<DaemonData, 'ownerDaemonId' | 'settings'>): boolean {
  if (String(entry.ownerDaemonId || '').trim()) return true
  const settings = entry.settings as Record<string, unknown> | undefined
  if (!settings) return false
  return Boolean(settings.meshNodeFor) || Boolean(settings.meshNodeId)
    || settings.launchedByCoordinator === true || settings._remoteOwnedSession === true
}

/**
 * Chat-list tab dedup key (Key 1). Mesh delegated sessions arrive through two sources for
 * the SAME underlying session:
 *  - coordinator-reported: id='<coordDaemon>:<rest>', daemonId='<coordDaemon>', ownerDaemonId='<workerDaemon>'
 *  - worker-reported:      id='<workerDaemon>:<rest>', daemonId='<workerDaemon>', ownerDaemonId=undefined
 * Keying on the reporting daemon yields two distinct keys and a duplicate "ghost" tab.
 *
 * When the coordinator successfully resolved owner attribution it carries
 * ownerDaemonId='<workerDaemon>', so normalizing to (ownerDaemonId || daemonId) collapses both
 * arrivals to '<workerDaemon>:<rest>'. But attribution resolution is racy — the owning node may
 * not be probed yet — and when it fails the coordinator copy has NO ownerDaemonId (or a
 * node-scoped fallback that does NOT equal the worker daemonId). The reporting-daemon
 * normalization then can't merge it with the worker copy and the ghost tab reappears.
 *
 * Defense: any session that is mesh-owned (coordinator copy carries a mesh marker) is keyed on
 * the session SUFFIX alone — a value both the coordinator copy and the marker-less worker copy
 * share — so the two collapse regardless of whether attribution resolved. `meshSessionSuffixes`
 * is the set of suffixes seen on a mesh-owned copy, so the marker-less worker copy is pulled in too.
 */
export function getIdeChatDedupeKey(
  entry: Pick<DaemonData, 'daemonId' | 'id' | 'ownerDaemonId'>,
  meshSessionSuffixes: ReadonlySet<string>,
): string {
  const daemonId = String(entry.daemonId || '').trim()
  const id = String(entry.id || '').trim()
  const sessionSuffix = getDaemonEntrySessionSuffix(entry)
  if (sessionSuffix && meshSessionSuffixes.has(sessionSuffix)) {
    return `mesh:${sessionSuffix}`
  }
  // Non-mesh sessions keep their reporting daemon and stay distinct (two unrelated local sessions
  // on different daemons that happen to share a raw session id must remain separate tabs).
  const ownerDaemonId = String(entry.ownerDaemonId || '').trim() || daemonId
  if (!ownerDaemonId) return id
  return sessionSuffix ? `${ownerDaemonId}:${sessionSuffix}` : ownerDaemonId
}

/**
 * Per-machine session dedup key (Key 2). A mesh-delegated session lands in the SAME machine
 * group twice (worker's own report + coordinator's synthesised copy); both carry the SAME
 * underlying sessionId (the coordinator mirror uses the worker's real session id), so key on it
 * to collapse the two. Neither the reporting-daemon prefix nor the provider label may enter the
 * key. Fall back to the full id when no sessionId exists so unrelated single-path sessions stay
 * distinct (regression guard). Raw — unlike Key 1 it is NOT daemon-scoped, because the machine
 * group already partitions by owner daemon before this key is applied.
 */
export function getMachineSessionDedupeKey(entry: { sessionId?: string; id: string }): string {
  const sessionId = String(entry.sessionId || '').trim()
  return sessionId || entry.id
}

/**
 * Dockview tab/panel key (Key 3). Tab/panel identity must be globally unique across connected
 * daemons. Keep raw sessionId/providerSessionId on the conversation for URL/history compatibility,
 * but use the daemon-scoped route id (fallbackKey) as the stable tab key. Does NOT mesh-collapse:
 * it relies on the chat-ide dedup (Key 1) having already merged the two copies upstream, so only
 * one conversation — and therefore one tab key — is produced per mesh session.
 */
export function getConversationTabKey(sessionId: string | undefined, fallbackKey: string): string {
  return fallbackKey || sessionId || 'unknown'
}

/**
 * Single owner-machine-name fallback chain for a (possibly mesh-delegated) entry. A mesh session
 * synthesised into the coordinator's snapshot belongs to a worker node, so prefer the resolved
 * owning daemon's machine name, then an explicit ownerMachineName, then the snapshot daemon's own
 * machine. Returns undefined when nothing resolves.
 */
export function resolveOwnerMachineName(
  entry: Pick<DaemonData, 'ownerDaemonId' | 'ownerMachineName' | 'daemonId'>,
  machineNames: Record<string, string> | undefined,
): string | undefined {
  const ownerMachineName = (entry.ownerDaemonId && machineNames?.[entry.ownerDaemonId])
    || entry.ownerMachineName
    || undefined
  return ownerMachineName
    || (entry.daemonId && machineNames?.[entry.daemonId])
    || undefined
}
