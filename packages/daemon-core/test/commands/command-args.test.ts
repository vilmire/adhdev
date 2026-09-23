import { describe, expect, it } from 'vitest'
import {
  readMeshDirectDispatchFlag,
  readMeshContext,
  readMessageId,
  readSendPolicy,
} from '../../src/commands/command-args.js'

/**
 * Wiring-unification D3 — pinning tests for the typed args readers that
 * replaced the inline `(args as any)?.foo` casts in cli-manager.ts,
 * chat-commands-write.ts, mesh-crud.ts, fast-forward.ts, mesh-restart.ts and
 * mesh-node-logs.ts. Every assertion here reproduces what the OLD inline
 * expression returned for the same input, so a revert of command-args.ts's
 * implementation flips these red without touching any call site.
 */

describe('readMeshDirectDispatchFlag', () => {
  it('is true only when the flag is exactly boolean true', () => {
    expect(readMeshDirectDispatchFlag({ _meshDirectDispatch: true })).toBe(true)
  })

  it('is false for missing, falsy, or truthy-but-not-true values (matches the old `!args?._meshDirectDispatch` sites)', () => {
    expect(readMeshDirectDispatchFlag(undefined)).toBe(false)
    expect(readMeshDirectDispatchFlag(null)).toBe(false)
    expect(readMeshDirectDispatchFlag({})).toBe(false)
    expect(readMeshDirectDispatchFlag({ _meshDirectDispatch: false })).toBe(false)
    expect(readMeshDirectDispatchFlag({ _meshDirectDispatch: 1 })).toBe(false)
    expect(readMeshDirectDispatchFlag({ _meshDirectDispatch: 'true' })).toBe(false)
  })
})

describe('readMeshContext', () => {
  it('returns the meshContext object when present and object-shaped', () => {
    const mc = { taskId: 't1', nodeId: 'n1' }
    expect(readMeshContext({ meshContext: mc })).toBe(mc)
  })

  it('returns undefined for missing/non-object meshContext (matches the old inline guards)', () => {
    expect(readMeshContext(undefined)).toBeUndefined()
    expect(readMeshContext({})).toBeUndefined()
    expect(readMeshContext({ meshContext: null })).toBeUndefined()
    expect(readMeshContext({ meshContext: 'nope' })).toBeUndefined()
  })
})

describe('readMessageId', () => {
  it('trims and returns a non-empty string messageId', () => {
    expect(readMessageId({ messageId: '  msg_abc  ' })).toBe('msg_abc')
  })

  it('returns undefined for missing, empty, whitespace-only, or non-string messageId', () => {
    expect(readMessageId(undefined)).toBeUndefined()
    expect(readMessageId({})).toBeUndefined()
    expect(readMessageId({ messageId: '' })).toBeUndefined()
    expect(readMessageId({ messageId: '   ' })).toBeUndefined()
    expect(readMessageId({ messageId: 42 })).toBeUndefined()
  })
})

describe('readSendPolicy', () => {
  it('defaults to queue when nothing is set (matches today\'s plain send)', () => {
    expect(readSendPolicy({})).toEqual({ mode: 'queue' })
    expect(readSendPolicy(undefined)).toEqual({ mode: 'queue' })
  })

  it('maps the legacy sendNow boolean to policy.mode "send_now"', () => {
    expect(readSendPolicy({ sendNow: true })).toEqual({ mode: 'send_now' })
  })

  it('maps each legacy interrupt alias to policy.mode "interrupt"', () => {
    expect(readSendPolicy({ interrupt: true })).toEqual({ mode: 'interrupt' })
    expect(readSendPolicy({ force: true })).toEqual({ mode: 'interrupt' })
    expect(readSendPolicy({ forceSend: true })).toEqual({ mode: 'interrupt' })
  })

  it('sendNow takes precedence over the interrupt aliases when both legacy flags are set (matches chat-commands-write.ts\'s existing branch order — sendNow is checked before wantsInterrupt)', () => {
    expect(readSendPolicy({ sendNow: true, interrupt: true })).toEqual({ mode: 'send_now' })
    expect(readSendPolicy({ sendNow: true, force: true })).toEqual({ mode: 'send_now' })
  })

  it('a typed policy.mode wins outright over any legacy boolean, agreeing or not', () => {
    expect(readSendPolicy({ policy: { mode: 'queue' }, sendNow: true })).toEqual({ mode: 'queue' })
    expect(readSendPolicy({ policy: { mode: 'interrupt' }, sendNow: true })).toEqual({ mode: 'interrupt' })
    expect(readSendPolicy({ policy: { mode: 'send_now' }, interrupt: true })).toEqual({ mode: 'send_now' })
  })

  it('ignores a malformed policy field and falls back to the legacy booleans', () => {
    expect(readSendPolicy({ policy: { mode: 'not_a_real_mode' }, sendNow: true })).toEqual({ mode: 'send_now' })
    expect(readSendPolicy({ policy: 'garbage', force: true })).toEqual({ mode: 'interrupt' })
    expect(readSendPolicy({ policy: null, interrupt: true })).toEqual({ mode: 'interrupt' })
  })

  it('today\'s D-web dual-write always agrees (policy.mode and the legacy booleans describe the same outcome) — this is the "no behaviour change" contract command-args.ts documents', () => {
    // dashboard "Send now" press: dual-writes both fields for the same intent.
    expect(readSendPolicy({ policy: { mode: 'send_now' }, sendNow: true })).toEqual({ mode: 'send_now' })
    // dashboard interrupt / legacy force alias: dual-writes both for the same intent.
    expect(readSendPolicy({ policy: { mode: 'interrupt' }, force: true })).toEqual({ mode: 'interrupt' })
    // ordinary send: neither is set.
    expect(readSendPolicy({ policy: { mode: 'queue' } })).toEqual({ mode: 'queue' })
  })
})
