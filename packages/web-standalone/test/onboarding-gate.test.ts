import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { countEnabledProviders, setUpOnboardingProvider, shouldShowOnboarding } from '../src/onboarding-gate.ts'

// The first-run dialog means "no provider is ENABLED on this machine yet".
//
// It used to key on GET /api/v1/providers/installed returning zero rows — a
// listing that only saw `<providers>/.upstream`, empty on every channel-store
// daemon. So it showed on a fresh daemon by accident, and in any browser/origin
// without the localStorage marker it kept showing on a machine that already had
// providers enabled. And its "Install" only activated the spec: every picked
// provider stayed disabled, so nothing could be launched afterwards.

type Call = { url: string; body: any }

function fakeDaemon(replies: Record<string, { ok?: boolean; status?: number; body?: unknown } | Error>) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    const key = url === '/api/v1/command' ? `command:${body?.type}` : url
    const reply = replies[key]
    if (!reply) throw new Error(`unexpected request ${key}`)
    if (reply instanceof Error) throw reply
    return { ok: reply.ok ?? true, json: async () => reply.body }
  }
  return { calls, fetchImpl }
}

const settings = (values: Record<string, Record<string, unknown>>) => ({ success: true, settings: {}, values })

test('0 enabled providers → show', async () => {
  const { calls, fetchImpl } = fakeDaemon({
    'command:get_provider_settings': { body: settings({ 'claude-cli': { enabled: false, autoApprove: false }, 'codex-cli': { enabled: false }, cursor: { autoApprove: false } }) },
  })
  assert.equal(await shouldShowOnboarding({ completed: false, fetchImpl }), true)
  assert.deepEqual(calls, [{ url: '/api/v1/command', body: { type: 'get_provider_settings', payload: {} } }])
})

test('a fresh daemon with no provider rows at all → show', async () => {
  const { fetchImpl } = fakeDaemon({ 'command:get_provider_settings': { body: settings({}) } })
  assert.equal(await shouldShowOnboarding({ completed: false, fetchImpl }), true)
})

test('≥1 enabled provider → hide', async () => {
  const { fetchImpl } = fakeDaemon({
    'command:get_provider_settings': { body: settings({ 'claude-cli': { enabled: false }, 'codex-cli': { enabled: true } }) },
  })
  assert.equal(await shouldShowOnboarding({ completed: false, fetchImpl }), false)
})

test('an error is never read as "zero enabled" → hide', async () => {
  const cases: Array<[string, Parameters<typeof fakeDaemon>[0]]> = [
    ['401 on a token-gated daemon', { 'command:get_provider_settings': { ok: false, status: 401, body: { error: 'unauthorized' } } }],
    ['refused command', { 'command:get_provider_settings': { body: { success: false, error: 'nope' } } }],
    ['reply without values', { 'command:get_provider_settings': { body: { success: true } } }],
    ['non-object body', { 'command:get_provider_settings': { body: null } }],
    ['network error', { 'command:get_provider_settings': new Error('ECONNREFUSED') }],
  ]
  for (const [name, replies] of cases) {
    assert.equal(await shouldShowOnboarding({ completed: false, fetchImpl: fakeDaemon(replies).fetchImpl }), false, name)
  }
})

test('dismissed → hide, without asking the daemon', async () => {
  const { calls, fetchImpl } = fakeDaemon({ 'command:get_provider_settings': { body: settings({}) } })
  assert.equal(await shouldShowOnboarding({ completed: true, fetchImpl }), false)
  assert.equal(calls.length, 0)
})

test('countEnabledProviders: null when the reply does not answer the question', () => {
  assert.equal(countEnabledProviders(settings({ a: { enabled: true }, b: { enabled: true }, c: { enabled: 'yes' } })), 2)
  assert.equal(countEnabledProviders({ success: true, values: [] }), null)
  assert.equal(countEnabledProviders({ values: {} }), null)
  assert.equal(countEnabledProviders('nope'), null)
})

test('dialog Install: a CLI provider is installed AND enabled, so the gate closes', async () => {
  const { calls, fetchImpl } = fakeDaemon({
    '/api/v1/providers/install': { body: { success: true, installed: { type: 'claude-cli', category: 'cli', alreadyInstalled: true } } },
    'command:set_provider_setting': { body: { success: true } },
  })
  assert.deepEqual(await setUpOnboardingProvider({ type: 'claude-cli' }, fetchImpl), { type: 'claude-cli', ok: true })
  assert.deepEqual(calls, [
    { url: '/api/v1/providers/install', body: { type: 'claude-cli' } },
    { url: '/api/v1/command', body: { type: 'set_provider_setting', payload: { providerType: 'claude-cli', key: 'enabled', value: true } } },
  ])
})

test('dialog Install: IDE / extension providers have no per-machine enable — install only', async () => {
  const { calls, fetchImpl } = fakeDaemon({
    '/api/v1/providers/install': { body: { success: true, installed: { type: 'cursor', category: 'ide' } } },
  })
  assert.deepEqual(await setUpOnboardingProvider({ type: 'cursor', category: 'ide' }, fetchImpl), { type: 'cursor', ok: true })
  assert.equal(calls.length, 1)
})

test('dialog Install: a failed install or a refused enable is reported, not swallowed', async () => {
  const failedInstall = fakeDaemon({ '/api/v1/providers/install': { ok: false, body: { success: false, error: 'not published' } } })
  assert.deepEqual(await setUpOnboardingProvider({ type: 'x-cli', category: 'cli' }, failedInstall.fetchImpl), { type: 'x-cli', ok: false, error: 'not published' })
  assert.equal(failedInstall.calls.length, 1)

  const refusedEnable = fakeDaemon({
    '/api/v1/providers/install': { body: { success: true, installed: { category: 'cli' } } },
    'command:set_provider_setting': { body: { success: false, error: 'Failed to set x-cli.enabled' } },
  })
  assert.deepEqual(await setUpOnboardingProvider({ type: 'x-cli' }, refusedEnable.fetchImpl), { type: 'x-cli', ok: false, error: 'Failed to set x-cli.enabled' })
})

test('App gate and dialog are wired to the enablement gate, not the installed listing', () => {
  const src = (name: string) => readFileSync(join(import.meta.dirname, '..', 'src', name), 'utf8')
  assert.match(src('App.tsx'), /shouldShowOnboarding\(\)/)
  assert.doesNotMatch(src('App.tsx'), /providers\/installed/)
  assert.match(src('StandaloneOnboarding.tsx'), /setUpOnboardingProvider\(/)
})
