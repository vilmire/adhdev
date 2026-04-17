export interface ConversationTarget {
  providerSessionId?: string
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
  conversation: Pick<ConversationTarget, 'providerSessionId' | 'sessionId'>,
): string[] {
  return dedupeKeys([
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
  conversation: Pick<ConversationTarget, 'providerSessionId' | 'sessionId'>,
): string | undefined {
  return getConversationHistoryLookupIds(conversation)[0]
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
