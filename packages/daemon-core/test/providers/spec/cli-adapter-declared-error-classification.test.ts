import { describe, expect, it, vi } from 'vitest'
import { SpecCliAdapter, classifyDeclaredError } from '../../../src/providers/spec/cli-adapter.js'

// ERROR-NOT-COMPLETION: a PTY CLI can print a transport/auth/billing/quota
// failure mid-turn without exiting. Before this class, only Kimi had any live
// classifier (cliType-gated), so a claude-cli/cursor-cli/codex session that
// hit the same wording had the text fall through to the ordinary completion
// path and land in finalSummary as a "possible completion (weak evidence)".
// These tests cover the generic, manifest-driven classifier that replaces
// the Kimi-only gate, and — critically — the false-positive guard: a normal
// completion report that merely quotes an error string in prose must NOT be
// misclassified as a live failure.

describe('classifyDeclaredError — generic manifest-driven classification', () => {
  it('classifies a declared transport pattern once the turn is no longer generating', () => {
    const declared = {
      transport: {
        patterns: [{ regex: 'api error: connection closed mid-response\\.(?: the response above may be incomplete\\.)?' }],
        requires: 'no_further_generation' as const,
      },
    }
    const text = 'API Error: Connection closed mid-response. The response above may be incomplete.'
    expect(classifyDeclaredError(text, declared, { generating: false })).toMatchObject({
      errorReason: 'spawn_error',
      failureKind: 'transport',
    })
  })

  it('does NOT classify a transport pattern while the FSM still reports generating', () => {
    // Guards against firing on a transient screen state mid-repaint — the
    // match must be the last thing seen before the turn actually goes quiet.
    const declared = {
      transport: {
        patterns: [{ regex: 'api error: connection closed mid-response\\.(?: the response above may be incomplete\\.)?' }],
        requires: 'no_further_generation' as const,
      },
    }
    const text = 'API Error: Connection closed mid-response. The response above may be incomplete.'
    expect(classifyDeclaredError(text, declared, { generating: true })).toBeNull()
  })

  // FALSE-POSITIVE GUARD (required by the task): a worker can legitimately
  // report on/quote an error string as part of normal completed work — e.g.
  // fixing a retry handler and describing the exact error it now catches.
  // Both this report and a genuine live failure are equally "not generating"
  // by the time getStatus() is read, so a bare generating-flag check is not
  // sufficient on its own. The transport class also requires the match to
  // sit at the END of the scanned tail (within a small slop): a genuine
  // mid-response drop leaves the error string as literally the last thing
  // printed, while a completed report keeps narrating well past it. This is
  // the test the task calls out explicitly — it MUST pass green.
  it('does NOT classify a normal completion report that quotes the error string but keeps narrating past it', () => {
    const declared = {
      transport: {
        patterns: [{ regex: 'connection closed mid-response' }],
        requires: 'no_further_generation' as const,
      },
    }
    const quotedInReport = 'Fixed the retry handler so a "Connection closed mid-response" API Error no longer crashes the client; added a regression test and updated the changelog.'
    expect(classifyDeclaredError(quotedInReport, declared, { generating: false })).toBeNull()
  })

  it('DOES classify the same wording when it is genuinely the last thing printed', () => {
    const declared = {
      transport: {
        patterns: [{ regex: 'connection closed mid-response' }],
        requires: 'no_further_generation' as const,
      },
    }
    const genuineFailure = 'API Error: Connection closed mid-response'
    expect(classifyDeclaredError(genuineFailure, declared, { generating: false })).toMatchObject({ failureKind: 'transport' })
  })

  it('classifies the full live-incident error envelope (both sentences) when the pattern is anchored to the whole message', () => {
    // Authoring guidance this test documents: a spec pattern narrowed to a
    // FRAGMENT of a multi-sentence error (as above) will treat the CLI's own
    // trailing clause as "narration after the match" and correctly decline —
    // the live incident's exact two-sentence envelope is itself the whole
    // error, so the declared pattern should span it end-to-end.
    const declared = {
      transport: {
        patterns: [{ regex: 'api error: connection closed mid-response\\.(?: the response above may be incomplete\\.)?' }],
        requires: 'no_further_generation' as const,
      },
    }
    const genuineFailure = 'API Error: Connection closed mid-response. The response above may be incomplete.'
    expect(classifyDeclaredError(genuineFailure, declared, { generating: false })).toMatchObject({ failureKind: 'transport' })
  })

  it('tolerates a short trailing prompt-redraw artifact after the match without losing the transport verdict', () => {
    const declared = {
      transport: {
        patterns: [{ regex: 'connection closed mid-response' }],
        requires: 'no_further_generation' as const,
      },
    }
    const withRedrawTail = 'API Error: Connection closed mid-response.\r\n> '
    expect(classifyDeclaredError(withRedrawTail, declared, { generating: false })).toMatchObject({ failureKind: 'transport' })
  })

  it('classifies a declared auth pattern for a non-kimi provider with no envelope precondition required', () => {
    const declared = {
      auth: { patterns: [{ regex: 'login expired' }, { regex: 'please run /login' }] },
    }
    expect(classifyDeclaredError('Login expired · Please run /login', declared, { generating: false }))
      .toMatchObject({ errorReason: 'auth_failed', failureKind: 'auth' })
  })

  it('respects provider_failure_envelope on a declared quota bucket for a non-kimi provider', () => {
    const declared = {
      quota: {
        patterns: [{ regex: 'usage limit' }],
        requires: 'provider_failure_envelope' as const,
      },
    }
    expect(classifyDeclaredError('HTTP 403 - usage limit reached', declared, { generating: false }))
      .toMatchObject({ errorReason: 'quota_exceeded', failureKind: 'quota' })
    // Bare mention with no failure envelope stays unclassified — same rule
    // Kimi's own quota bucket already relies on.
    expect(classifyDeclaredError('the docs describe a usage limit', declared, { generating: false })).toBeNull()
  })

  it('returns null when the provider declares no error_classification at all', () => {
    expect(classifyDeclaredError('API Error: Connection closed mid-response', undefined, { generating: false })).toBeNull()
  })

  it('respects declared class priority: quota before billing before auth before transport', () => {
    const declared = {
      quota: { patterns: [{ regex: 'limit' }], requires: 'provider_failure_envelope' as const },
      billing: { patterns: [{ regex: 'limit' }] },
    }
    // Both buckets match the same word; quota is checked first and wins,
    // exactly as it must for Kimi's own incident-fixed ordering.
    expect(classifyDeclaredError('HTTP 403 - limit', declared, { generating: false }))
      .toMatchObject({ failureKind: 'quota' })
  })
})

describe('SpecCliAdapter — declared error_classification for a NON-kimi provider', () => {
  function makeAdapter(cliType: string, spec: Record<string, unknown>) {
    const adapter = Object.create(SpecCliAdapter.prototype) as any
    adapter.cliType = cliType
    adapter.cliName = cliType
    adapter.spawned = true
    adapter.exited = false
    adapter.activeInteractivePrompt = null
    adapter.providerSessionId = undefined
    adapter.spec = spec
    adapter.kimiFailureOutputTail = ''
    adapter.declaredErrorFailure = null
    adapter.latestState = { id: 'idle', label: 'idle', title: null, status: 'idle' }
    adapter.latestModal = null
    adapter.driver = {}
    adapter.statusCallback = vi.fn()
    adapter.ptyDataCallback = null
    adapter.detectInteractivePromptFromPtyChunk = vi.fn()
    adapter.maybeClearResolvedClaudeTuiPrompt = vi.fn()
    adapter.maybeCaptureClaudeTuiPrompt = vi.fn()
    adapter.maybeUpgradeClaudeTuiMultiSelect = vi.fn()
    adapter.refreshWirePendingQuestion = vi.fn()
    adapter.maybeRefreshNativeHistory = vi.fn()
    return adapter
  }

  it('surfaces adapter status=error for claude-cli once its spec declares error_classification', () => {
    const adapter = makeAdapter('claude-cli', {
      id: 'claude-cli',
      name: 'claude-cli',
      error_classification: {
        auth: { patterns: [{ regex: 'login expired' }] },
      },
    })
    adapter.handleEvent({ kind: 'pty_data', chunk: 'Login expired · Please run /login\r\n' })
    expect(adapter.getStatus()).toMatchObject({ status: 'error', errorReason: 'auth_failed' })
    expect(adapter.statusCallback).toHaveBeenCalledTimes(1)
  })

  it('leaves claude-cli status untouched (never "error") when its spec declares no error_classification — today\'s unchanged behavior', () => {
    const adapter = makeAdapter('claude-cli', { id: 'claude-cli', name: 'claude-cli' })
    adapter.handleEvent({ kind: 'pty_data', chunk: 'API Error: Connection closed mid-response. The response above may be incomplete.\r\n' })
    expect(adapter.getStatus().status).not.toBe('error')
  })

  it('a declared transport bucket does not fire while the adapter still reports generating', () => {
    const adapter = makeAdapter('claude-cli', {
      id: 'claude-cli',
      name: 'claude-cli',
      error_classification: {
        transport: {
          patterns: [{ regex: 'connection closed mid-response' }],
          requires: 'no_further_generation',
        },
      },
    })
    adapter.latestState = { id: 'busy', label: 'busy', title: null, status: 'generating' }
    adapter.handleEvent({ kind: 'pty_data', chunk: 'API Error: Connection closed mid-response.\r\n' })
    expect(adapter.getStatus().status).not.toBe('error')
  })

  it('a declared transport bucket fires once the adapter has settled to idle', () => {
    const adapter = makeAdapter('claude-cli', {
      id: 'claude-cli',
      name: 'claude-cli',
      error_classification: {
        transport: {
          patterns: [{ regex: 'connection closed mid-response' }],
          requires: 'no_further_generation',
        },
      },
    })
    adapter.latestState = { id: 'idle', label: 'idle', title: null, status: 'idle' }
    adapter.handleEvent({ kind: 'pty_data', chunk: 'API Error: Connection closed mid-response.\r\n' })
    expect(adapter.getStatus()).toMatchObject({ status: 'error', errorReason: 'spawn_error' })
  })
})
