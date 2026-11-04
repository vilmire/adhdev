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
import { preserveCliRateLimitEvidence, withCliRateLimitEvidence } from '../../src/quota/exhaustion-hold.js'
import { classifyOwnQuotaFailureOnlyReply } from '../../src/providers/spec/provider-output-attribution.js'
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

  it('recognises only a whole-reply Claude limit banner', () => {
    for (const ok of ['Claude usage limit reached. Your limit will reset at 10:40am (Asia/Seoul).', '5-hour limit reached ∙ resets 10:40am', "You've hit your limit · resets 3pm (Asia/Seoul)"]) {
      expect(classifyOwnQuotaFailureOnlyReply('claude-cli', ok), ok).toBe('usage_limit_exceeded')
    }
    for (const no of ['I read the code that prints "usage limit reached" and fixed the parser.', 'Refactored the rate limit handling; the 5-hour limit reached branch now logs.']) {
      expect(classifyOwnQuotaFailureOnlyReply('claude-cli', no), no).toBeNull()
    }
    expect(classifyOwnQuotaFailureOnlyReply('codex-cli', 'Claude usage limit reached.')).toBeNull()
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
