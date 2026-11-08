import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Confirmed quota exhaustion (mission ac0a8f3a) + pinned-task reserve policy (mission 56d8abb5, option A).
//  - A window measured exhausted whose reset merely PASSED stays blocked until a measurement taken after the reset.
//  - Unknown lookups (expired token, no prior reading) neither create nor erase that hold.
//  - The CLI's own "usage limit reached" report holds the provider the same way.
//  - Model-unspecified Antigravity admission is judged by the best pool, not the blended worst headline.
//  - A provider pin passes the RESERVE line (notifying the coordinator once per crossing) but never a confirmed exhaustion.

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-quota-confirmed-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
  getMachineId: () => ({ machineId: 'test-machine' } as any).machineId,
  getMachineNickname: () => null,
}))
const meshConfigMocks = vi.hoisted(() => ({ getMesh: vi.fn(), getMeshByRepo: vi.fn(), listMeshes: vi.fn(() => [] as any[]) }))
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh, getMeshByRepo: meshConfigMocks.getMeshByRepo, listMeshes: meshConfigMocks.listMeshes,
}))
const notifySpy = vi.hoisted(() => vi.fn(() => true))
vi.mock('../../src/mesh/turn-ledger/deliver.js', async (orig) => ({ ...(await orig() as object), notifyMeshCoordinator: notifySpy }))

import { evaluateProviderQuotaGate } from '../../src/mesh/mesh-quota-routing.js'
import { evaluateQuotaClaimGateForAssignment } from '../../src/mesh/mesh-queue-claim-gate.js'
import { quotaBlockOverridable, quotaBlockPinOverridable } from '../../src/mesh/mesh-quota-override.js'
import { resetPinCrossingForTests } from '../../src/mesh/mesh-quota-pin-crossing.js'
import { CLI_RATE_LIMIT_UNKNOWN_RESET_HARD_MS, preserveCliRateLimitEvidence, withCliRateLimitEvidence } from '../../src/quota/exhaustion-hold.js'
import { classifyOwnQuotaFailureOnlyReply, parseClaudeUsageLimitBanner } from '../../src/providers/spec/provider-output-attribution.js'
import { clearQuotaCache, readQuotaCache, recordCliRateLimitEvidence } from '../../src/quota/refresh.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask } from '../../src/mesh/mesh-work-queue.js'

const NOW = 1_800_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

const node = (quota: Record<string, any>) => ({ id: 'n1', nodeFacts: { schemaVersion: 1, reportedAt: NOW, quota } })
const quota = (over: Record<string, any> = {}) => ({
  provider: 'claude-cli', status: 'ok',
  session: { usedPercent: 50, windowMinutes: 300, resetsAt: null },
  weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null },
  updatedAt: NOW - MIN, error: null, ...over,
})

afterEach(() => { notifySpy.mockClear(); resetPinCrossingForTests() })

describe('confirmed exhaustion: elapsed reset time alone never unblocks', () => {
  const exhausted = (over: Record<string, any> = {}) => quota({
    session: { usedPercent: 100, windowMinutes: 300, resetsAt: NOW - 10 * MIN },
    updatedAt: NOW - 3 * HOUR, ...over,
  })

  it('an ok snapshot measured exhausted before its reset stays blocked as reset_unconfirmed', () => {
    const block = evaluateProviderQuotaGate(node({ 'claude-cli': exhausted() }), 'claude-cli', null, NOW)
    expect(block).toMatchObject({ reason: 'provider_quota_reset_unconfirmed', window: 'session' })
    expect(quotaBlockOverridable(block!)).toBe(true) // the owner's run is the probe
    expect(quotaBlockPinOverridable(block!)).toBe(false) // a pin never waives it
  })

  it('a measurement taken AFTER the reset with headroom unblocks', () => {
    const fresh = quota({ session: { usedPercent: 3, windowMinutes: 300, resetsAt: NOW + 4 * HOUR }, updatedAt: NOW - MIN })
    expect(evaluateProviderQuotaGate(node({ 'claude-cli': fresh }), 'claude-cli', null, NOW)).toBeNull()
  })

  it('an expired-token lookup that carried the exhausted reading forward keeps the hold', () => {
    const carried = exhausted({ status: 'error', error: 'token expired', metadata: { failureKind: 'expired-token', lastGoodWindows: true } })
    expect(evaluateProviderQuotaGate(node({ 'claude-cli': carried }), 'claude-cli', null, NOW)?.reason).toBe('provider_quota_reset_unconfirmed')
  })

  it('an expired-token lookup with NO prior reading is unknown, not exhausted', () => {
    const unknown = quota({ status: 'error', session: null, weekly: null, error: 'token expired', metadata: { failureKind: 'expired-token' } })
    expect(evaluateProviderQuotaGate(node({ 'claude-cli': unknown }), 'claude-cli', null, NOW)).toBeNull()
  })
})

describe('confirmed exhaustion: the CLI reported its own usage limit', () => {
  const evidence = (resetsAt?: number) => ({ observedAt: NOW - 20 * MIN, ...(resetsAt ? { resetsAt } : {}) })
  // Statusline said 1% left (>= the hard-limit cut), but the CLI said "usage limit reached".
  const onePercent = (over: Record<string, any> = {}) => quota({
    session: { usedPercent: 99, windowMinutes: 300, resetsAt: NOW + 2 * HOUR },
    updatedAt: NOW - 30 * MIN, ...over,
  })

  it('blocks before the stated reset even though the percentage is above the hard-limit cut', () => {
    const q = withCliRateLimitEvidence('claude-cli', onePercent() as any, evidence(NOW + 2 * HOUR))
    const block = evaluateProviderQuotaGate(node({ 'claude-cli': q }), 'claude-cli', null, NOW)
    expect(block).toMatchObject({ reason: 'provider_quota_exhausted', window: 'unknown', resetsAt: NOW + 2 * HOUR })
    expect(quotaBlockOverridable(block!)).toBe(false)
  })

  it('after the stated reset it is reset_unconfirmed until a newer measurement arrives', () => {
    const q = withCliRateLimitEvidence('claude-cli', onePercent({ session: null }) as any, evidence(NOW - 5 * MIN))
    expect(evaluateProviderQuotaGate(node({ 'claude-cli': q }), 'claude-cli', null, NOW)?.reason).toBe('provider_quota_reset_unconfirmed')
  })

  it('an expired-token refresh does not erase the hold; an ok measurement after the reset does', () => {
    const held = withCliRateLimitEvidence('claude-cli', onePercent() as any, evidence(NOW - 5 * MIN))
    const afterUnknown = preserveCliRateLimitEvidence(held as any, quota({ status: 'error', session: null, weekly: null, metadata: { failureKind: 'expired-token' }, updatedAt: NOW }) as any)
    expect(evaluateProviderQuotaGate(node({ 'claude-cli': afterUnknown }), 'claude-cli', null, NOW)).not.toBeNull()
    const afterMeasure = preserveCliRateLimitEvidence(held as any, quota({ updatedAt: NOW - MIN }) as any)
    expect(afterMeasure.metadata?.cliRateLimit).toBeUndefined()
    expect(evaluateProviderQuotaGate(node({ 'claude-cli': afterMeasure }), 'claude-cli', null, NOW)).toBeNull()
  })

  // Owner 2026-11-08: antigravity's token only refreshes when `agy` runs, so a held antigravity was never
  // measured again and its Gemini pool sat unused all day. An UNMEASURABLE provider is released by the clock.
  it('an unmeasurable provider is released 30 min past the stated reset; a measurable one still waits', () => {
    const held = withCliRateLimitEvidence('claude-cli', onePercent() as any, evidence(NOW - 31 * MIN))
    const unmeasurable = preserveCliRateLimitEvidence(held as any, quota({ status: 'error', session: null, weekly: null, metadata: { failureKind: 'expired-token' }, updatedAt: NOW }) as any)
    expect(evaluateProviderQuotaGate(node({ 'claude-cli': unmeasurable }), 'claude-cli', null, NOW)).toBeNull()
    expect(evaluateProviderQuotaGate(node({ 'claude-cli': held }), 'claude-cli', null, NOW)).not.toBeNull() // measurable (ok, pre-reset reading)
  })
  it('an unmeasurable provider with no stated reset is released after the bounded unknown-reset window + grace', () => {
    const old = { observedAt: NOW - CLI_RATE_LIMIT_UNKNOWN_RESET_HARD_MS - 31 * MIN }
    const unmeasurable = withCliRateLimitEvidence('antigravity-cli', quota({ provider: 'antigravity-cli', status: 'unavailable', session: null, weekly: null, metadata: { failureKind: 'expired-token' }, updatedAt: NOW }) as any, old)
    expect(evaluateProviderQuotaGate(node({ 'antigravity-cli': unmeasurable }), 'antigravity-cli', null, NOW)).toBeNull()
    const fresh = withCliRateLimitEvidence('antigravity-cli', quota({ provider: 'antigravity-cli', status: 'unavailable', session: null, weekly: null, metadata: { failureKind: 'expired-token' }, updatedAt: NOW }) as any, { observedAt: NOW - HOUR })
    expect(evaluateProviderQuotaGate(node({ 'antigravity-cli': fresh }), 'antigravity-cli', null, NOW)).not.toBeNull()
  })

  it('without a stated reset only a newer reading with real headroom everywhere clears it', () => {
    const held = withCliRateLimitEvidence('claude-cli', onePercent() as any, evidence())
    const still = preserveCliRateLimitEvidence(held as any, quota({ session: { usedPercent: 99, windowMinutes: 300, resetsAt: NOW + HOUR }, updatedAt: NOW - MIN }) as any)
    expect(still.metadata?.cliRateLimit).toBeTruthy()
    const cleared = preserveCliRateLimitEvidence(held as any, quota({ updatedAt: NOW - MIN }) as any)
    expect(cleared.metadata?.cliRateLimit).toBeUndefined()
  })
})

describe('model-unspecified Antigravity admission', () => {
  const bucket = (name: string, usedPercent: number, windowMinutes: number) => ({ name, usedPercent, windowMinutes, resetsAt: NOW + 3 * HOUR })
  const agy = (gemini: number, claude: number) => ({
    provider: 'antigravity-cli', status: 'ok', updatedAt: NOW - MIN, error: null,
    session: { usedPercent: Math.max(gemini, claude), windowMinutes: 300, resetsAt: NOW + 3 * HOUR },
    weekly: { usedPercent: Math.max(gemini, claude), windowMinutes: 10080, resetsAt: NOW + 3 * HOUR },
    buckets: [
      bucket('Gemini Models · Five Hour Limit Remaining', gemini, 300), bucket('Gemini Models · Weekly Limit Remaining', gemini, 10080),
      bucket('Claude/GPT · Five Hour Limit Remaining', claude, 300), bucket('Claude/GPT · Weekly Limit Remaining', claude, 10080),
    ],
  })
  const gate = (q: any, model?: string) => evaluateProviderQuotaGate(node({ 'antigravity-cli': q }), 'antigravity-cli', null, NOW, null, model ? { model } : undefined)

  it('admits provider-only routing when Gemini has headroom although Claude/GPT is exhausted', () => {
    expect(gate(agy(6, 100))).toBeNull()
    expect(gate(agy(6, 96))).toBeNull() // reserve-low (not exhausted) in the other pool
  })
  it('still blocks a Claude/GPT model slot and blocks provider-only routing when EVERY pool is gated', () => {
    expect(gate(agy(6, 100), 'Claude Sonnet 4.6 (Thinking)')).not.toBeNull()
    expect(gate(agy(6, 100), 'Gemini 3.1 Pro (High)')).toBeNull()
    expect(gate(agy(100, 100))).not.toBeNull()
  })

  // Live 2026-11-08: a Claude Opus session on Antigravity printed its usage limit and the whole provider was
  // held, Gemini included (0% used). The CLI's report now binds only the pool of the model that hit it.
  it('a pool-scoped CLI limit report blocks that pool only; provider-only routing still admits the other pool', () => {
    const q = withCliRateLimitEvidence('antigravity-cli', agy(6, 40), { observedAt: NOW - MIN, resetsAt: NOW + 2 * HOUR, pool: 'claude-gpt' })
    expect(q.metadata?.cliRateLimit).toBeUndefined()
    expect(q.metadata?.cliRateLimitPools).toEqual({ 'claude-gpt': { observedAt: NOW - MIN, resetsAt: NOW + 2 * HOUR } })
    expect(gate(q, 'claude-opus-5-5-high')?.reason).toBe('provider_quota_exhausted')
    expect(gate(q, 'Gemini 4 Argon (High)')).toBeNull()
    expect(gate(q)).toBeNull()
    const both = withCliRateLimitEvidence('antigravity-cli', q, { observedAt: NOW - MIN, resetsAt: NOW + 2 * HOUR, pool: 'gemini' })
    expect(gate(both)).not.toBeNull()
    expect(gate(both, 'Gemini 4 Argon (High)')).not.toBeNull()
  })
  it('a pool report with no prior entry never marks the whole provider exhausted', () => {
    const q = withCliRateLimitEvidence('antigravity-cli', undefined, { observedAt: NOW - MIN, pool: 'claude-gpt' })
    expect(q.metadata?.failureKind).toBeUndefined()
    expect(gate(q, 'Gemini 4 Argon (High)')).toBeNull()
    expect(gate(q, 'Claude Opus 5.5 (High)')).not.toBeNull()
  })
  it('a refresh keeps a still-binding pool report and drops it after a post-reset measurement', () => {
    const held = withCliRateLimitEvidence('antigravity-cli', agy(6, 40), { observedAt: NOW - MIN, resetsAt: NOW + 2 * HOUR, pool: 'claude-gpt' })
    const kept = preserveCliRateLimitEvidence(held, { ...agy(6, 40), updatedAt: NOW } as any)
    expect(kept.metadata?.cliRateLimitPools).toHaveProperty('claude-gpt')
    const after = preserveCliRateLimitEvidence(held, { ...agy(6, 10), updatedAt: NOW + 3 * HOUR } as any)
    expect(after.metadata?.cliRateLimitPools).toBeUndefined()
  })
  it('a provider-wide report (no pool) still holds every pool, as before', () => {
    const q = withCliRateLimitEvidence('antigravity-cli', agy(6, 40), { observedAt: NOW - MIN, resetsAt: NOW + 2 * HOUR })
    expect(gate(q, 'Gemini 4 Argon (High)')).not.toBeNull()
  })
})

describe('provider pin vs the reserve line (owner decision A) and confirmed exhaustion', () => {
  const meshId = `mesh_pin_${randomUUID().slice(0, 8)}`
  const run = (q: any, sessionId = 's1') => {
    const n = { id: 'n1', nodeFacts: { schemaVersion: 1, reportedAt: Date.now(), quota: { 'codex-cli': q },
      quotaReserve: { version: 1, defaults: { routingLongMinPercent: 25 } } } }
    meshConfigMocks.getMesh.mockReturnValue({ id: meshId, policy: {}, nodes: [n] })
    return evaluateQuotaClaimGateForAssignment({
      meshId, nodeId: 'n1', sessionId, providerType: 'codex-cli', trigger: 'idle_claim_scan', node: n,
      mesh: meshConfigMocks.getMesh(), providerLoader: { isMachineProviderEnabled: () => true } as any,
    })
  }
  const codex = (over: Record<string, any> = {}) => quota({ provider: 'codex-cli', updatedAt: Date.now(), ...over })

  afterEach(() => { __clearMeshQueueForTests(meshId); __resetMeshRuntimeStoreForTests(); meshConfigMocks.getMesh.mockReset() })

  it('passes the reserve and notifies the coordinator ONCE per crossing; a new crossing notifies again', () => {
    enqueueTask(meshId, 'pinned', { id: 't-pin', targetNodeId: 'n1', requiredTags: ['provider=codex-cli'], difficulty: 'medium' } as any)
    const low = codex({ weekly: { usedPercent: 86, windowMinutes: 10080, resetsAt: null } })
    expect(run(low)).toBe(false)
    expect(run(low)).toBe(false)
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect((notifySpy.mock.calls[0] as any)[0]).toMatchObject({ event: 'mesh:quota_reserve_crossed', meshId, metadataEvent: { taskId: 't-pin', providerType: 'codex-cli' } })
    expect(run(codex())).toBe(false) // gate clears -> crossing forgotten
    expect(run(low)).toBe(false)
    expect(notifySpy).toHaveBeenCalledTimes(2)
  })

  it('does NOT pass a confirmed exhaustion: pinned claim is refused and no crossing notice is sent', () => {
    enqueueTask(meshId, 'pinned', { id: 't-pin2', targetNodeId: 'n1', requiredTags: ['provider=codex-cli'], difficulty: 'medium' } as any)
    const cli = withCliRateLimitEvidence('codex-cli', codex() as any, { observedAt: Date.now() - MIN, resetsAt: Date.now() + HOUR })
    expect(run(cli)).toBe(true)
    const windowExhausted = codex({ weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() + HOUR } })
    expect(run(windowExhausted, 's2')).toBe(true) // remaining 0 < hard-limit cut: not pin-overridable
    expect(notifySpy).not.toHaveBeenCalled()
  })
})

describe('CLI rate-limit evidence recording', () => {
  afterEach(() => clearQuotaCache())

  it('recognises only the captured Claude Code limit status line, as the WHOLE reply', () => {
    // Real wording captured from Claude Code session transcripts (system messages, 2026-10/11).
    for (const ok of ['Usage limit reached · continuing automatically at 5:30pm · esc to cancel', 'Usage limit reached again · continuing automatically at 12am · esc to cancel', 'Usage limit reached · continuing automatically at 11:50pm · esc to cancel']) {
      expect(classifyOwnQuotaFailureOnlyReply('claude-cli', ok), ok).toBe('usage_limit_exceeded')
    }
    // Wording that is NOT in any captured transcript, and assistant prose, never matches.
    for (const no of ['Claude usage limit reached. Your limit will reset at 10:40am (Asia/Seoul).', "You've hit your limit · resets 3pm", '5-hour limit reached ∙ resets 10:40am',
      'I read the code that prints "Usage limit reached · continuing automatically at 5am · esc to cancel" and fixed the parser.',
      'Usage limit reached · continuing automatically at 5am · esc to cancel. Anyway, here is the plan.', 'The test asserts Usage limit reached is handled.']) {
      expect(classifyOwnQuotaFailureOnlyReply('claude-cli', no), no).toBeNull()
    }
    expect(classifyOwnQuotaFailureOnlyReply('codex-cli', 'Usage limit reached · continuing automatically at 5am · esc to cancel')).toBeNull()
  })

  it('parses the banner clock time as the next local occurrence', () => {
    const now = new Date(2026, 9, 26, 23, 0, 0).getTime()
    const at = parseClaudeUsageLimitBanner('Usage limit reached · continuing automatically at 12am · esc to cancel', now)!.resetsAt!
    expect(new Date(at).getHours()).toBe(0)
    expect(at).toBeGreaterThan(now)
    expect(at - now).toBeLessThanOrEqual(24 * 3_600_000)
    expect(parseClaudeUsageLimitBanner('Usage limit reached · continuing automatically at 5:30pm · esc to cancel', new Date(2026, 9, 26, 10, 0).getTime())!.resetsAt)
      .toBe(new Date(2026, 9, 26, 17, 30).getTime())
  })

  it('a CLI report with no readable reset cannot hold a provider indefinitely: hard for 6h, then owner-waivable reset_unconfirmed', () => {
    const q = withCliRateLimitEvidence('claude-cli', { provider: 'claude-cli', status: 'ok', updatedAt: Date.now() - 3 * HOUR, error: null, session: null, weekly: null } as any, { observedAt: Date.now() - HOUR })
    expect(evaluateProviderQuotaGate(node({ 'claude-cli': q }), 'claude-cli', null, Date.now())?.reason).toBe('provider_quota_exhausted')
    const later = evaluateProviderQuotaGate(node({ 'claude-cli': q }), 'claude-cli', null, Date.now() + 7 * HOUR)
    expect(later?.reason).toBe('provider_quota_reset_unconfirmed')
    expect(quotaBlockOverridable(later!)).toBe(true)
  })

  it('stamps the cache entry so the gate holds the provider, creating a minimal entry when none exists', () => {
    expect(readQuotaCache()?.['claude-cli']).toBeUndefined()
    recordCliRateLimitEvidence('claude-cli', { observedAt: Date.now() })
    const entry = readQuotaCache()!['claude-cli']
    expect(entry.metadata?.cliRateLimit).toMatchObject({ observedAt: expect.any(Number) })
    const block = evaluateProviderQuotaGate(node({ 'claude-cli': entry }), 'claude-cli', null, Date.now())
    expect(block?.reason).toBe('provider_quota_exhausted')
  })
})
