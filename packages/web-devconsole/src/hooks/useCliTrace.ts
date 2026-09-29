import { useCallback, useEffect, useState } from 'react'
import { api, type CliExerciseResponse, type CliFixtureInfo, type CliFixtureReplayResponse, type CliTraceResponse } from '../api'
import type { AppendOutput } from '../shared'

const EXERCISE_DEFAULT_PROMPT = 'Create a file at tmp/adhdev_provider_fix_test.py that prints the current working directory and the squares of 1 through 5, then run python3 tmp/adhdev_provider_fix_test.py and tell me the exact output.'

/** The exercise request both "Run Exercise" and "Capture Fixture" send. */
function exerciseRequest(text: string) {
  return {
    text,
    freshSession: true,
    autoLaunch: true,
    autoResolveApprovals: true,
    approvalButtonIndex: 0,
    timeoutMs: 45000,
    traceLimit: 200,
  }
}

/**
 * CLI debug-session state for the Trace tab: the polled PTY trace, the
 * launch/stop/raw-key/approval actions, and the exercise + fixture flows.
 * Resets whenever the selected provider changes.
 */
export function useCliTrace(provider: string, isCli: boolean, appendOutput: AppendOutput) {
  const [traceState, setTraceState] = useState<CliTraceResponse | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [rawInput, setRawInput] = useState('')
  const [exercisePrompt, setExercisePrompt] = useState(EXERCISE_DEFAULT_PROMPT)
  const [exerciseRunning, setExerciseRunning] = useState(false)
  const [exerciseResult, setExerciseResult] = useState<CliExerciseResponse | null>(null)
  const [fixtures, setFixtures] = useState<CliFixtureInfo[]>([])
  const [fixtureName, setFixtureName] = useState('provider-fix')
  const [selectedFixture, setSelectedFixture] = useState('')
  const [fixtureBusy, setFixtureBusy] = useState(false)
  const [replayResult, setReplayResult] = useState<CliFixtureReplayResponse | null>(null)

  // Reset when the provider changes (declared before the polling effect so the
  // reset lands first, exactly as the single App-level effect ordered it).
  useEffect(() => {
    setTraceState(null)
    setSelectedId(null)
    setRawInput('')
    setExerciseResult(null)
    setFixtures([])
    setFixtureName('provider-fix')
    setSelectedFixture('')
    setReplayResult(null)
  }, [provider])

  const refreshFixtures = useCallback(async () => {
    if (!provider || !isCli) {
      setFixtures([])
      return
    }
    try {
      const result = await api.cliFixtures(provider)
      const list = result.fixtures || []
      setFixtures(list)
      setSelectedFixture(prev => prev && list.some(f => f.name === prev) ? prev : (list[0]?.name || ''))
    } catch {
      setFixtures([])
    }
  }, [provider, isCli])

  const refresh = useCallback(async (showSpinner = false) => {
    if (!provider || !isCli) {
      setTraceState(null)
      setSelectedId(null)
      return
    }
    if (showSpinner) setLoading(true)
    try {
      const trace = await api.cliTrace(provider, 160) as any
      if (trace?.error || !trace?.trace) {
        setTraceState(null)
        setSelectedId(null)
        return
      }
      setTraceState(trace)
      setSelectedId(prev => {
        const entries = trace.trace?.entries || []
        if (prev && entries.some((entry: { id: number }) => entry.id === prev)) return prev
        return entries.length > 0 ? entries[entries.length - 1].id : null
      })
    } catch {
      setTraceState(null)
      setSelectedId(null)
    } finally {
      if (showSpinner) setLoading(false)
    }
  }, [provider, isCli])

  useEffect(() => {
    if (!provider || !isCli) return
    refresh(true)
    refreshFixtures()
    const interval = setInterval(() => {
      refresh(false)
    }, 1000)
    return () => clearInterval(interval)
  }, [provider, isCli, refresh, refreshFixtures])

  async function launch() {
    if (!provider || !isCli) return
    try {
      setLoading(true)
      const result = await api.cliLaunch(provider) as any
      if (result?.error || !result?.launched) {
        appendOutput(`❌ CLI launch failed: ${result?.error || 'unknown error'}`, 'error')
        return
      }
      appendOutput(`🚀 CLI launched: ${result.type}`, 'log')
      await refresh(false)
    } catch (e: any) {
      appendOutput(`❌ CLI launch failed: ${e.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  async function stop() {
    if (!provider || !isCli) return
    try {
      const result = await api.cliStop(provider, traceState?.instanceId) as any
      if (result?.error || !result?.stopped) {
        appendOutput(`❌ CLI stop failed: ${result?.error || 'unknown error'}`, 'error')
        return
      }
      appendOutput(`🛑 CLI stopped: ${provider}`, 'log')
      await refresh(false)
    } catch (e: any) {
      appendOutput(`❌ CLI stop failed: ${e.message}`, 'error')
    }
  }

  async function sendRaw(keys: string, label?: string) {
    if (!provider || !isCli || !keys) return
    try {
      const result = await api.cliRaw(provider, keys, traceState?.instanceId) as any
      if (result?.error || !result?.sent) {
        appendOutput(`❌ Raw key failed: ${result?.error || 'unknown error'}`, 'error')
        return
      }
      appendOutput(`⌨️ Raw key sent${label ? `: ${label}` : ''}`, 'log')
      setRawInput('')
      await refresh(false)
    } catch (e: any) {
      appendOutput(`❌ Raw key failed: ${e.message}`, 'error')
    }
  }

  async function resolveApproval(buttonIndex: number) {
    if (!provider || !isCli) return
    try {
      const result = await api.cliResolve(provider, buttonIndex, traceState?.instanceId) as any
      if (result?.error || !result?.resolved) {
        appendOutput(`❌ Approval resolve failed: ${result?.error || 'unknown error'}`, 'error')
        return
      }
      appendOutput(`✅ Approval resolved: button ${buttonIndex}`, 'log')
      await refresh(false)
    } catch (e: any) {
      appendOutput(`❌ Approval resolve failed: ${e.message}`, 'error')
    }
  }

  async function runExercise() {
    if (!provider || !isCli || !exercisePrompt.trim()) return
    try {
      setExerciseRunning(true)
      const result = await api.cliExercise(provider, exerciseRequest(exercisePrompt.trim())) as CliExerciseResponse
      if ((result as any)?.error || !result?.exercised) {
        appendOutput(`❌ CLI exercise failed: ${(result as any)?.error || 'unknown error'}`, 'error')
        return
      }
      setExerciseResult(result)
      setReplayResult(null)
      appendOutput(`🧪 CLI exercise ${result.timedOut ? 'timed out' : 'completed'} in ${result.elapsedMs}ms`, result.timedOut ? 'warn' : 'result')
      await refresh(false)
    } catch (e: any) {
      appendOutput(`❌ CLI exercise failed: ${e.message}`, 'error')
    } finally {
      setExerciseRunning(false)
    }
  }

  async function captureFixture() {
    if (!provider || !isCli || !exercisePrompt.trim()) return
    try {
      setFixtureBusy(true)
      const result = await api.cliFixtureCapture(provider, {
        name: fixtureName.trim() || 'provider-fix',
        request: exerciseRequest(exercisePrompt.trim()),
        assertions: {
          requireNotTimedOut: true,
        },
      })
      if ((result as any)?.error || !result?.saved) {
        appendOutput(`❌ Fixture capture failed: ${(result as any)?.error || 'unknown error'}`, 'error')
        return
      }
      appendOutput(`💾 Fixture saved: ${result.name}`, result.verification?.pass ? 'result' : 'warn')
      if (result.verification?.failures?.length) {
        appendOutput(result.verification.failures.join('\n'), 'warn')
      }
      await refreshFixtures()
      setSelectedFixture(result.name)
      await refresh(false)
    } catch (e: any) {
      appendOutput(`❌ Fixture capture failed: ${e.message}`, 'error')
    } finally {
      setFixtureBusy(false)
    }
  }

  async function replayFixture() {
    if (!provider || !isCli || !selectedFixture) return
    try {
      setFixtureBusy(true)
      const result = await api.cliFixtureReplay(provider, selectedFixture)
      if ((result as any)?.error || !result?.replayed) {
        appendOutput(`❌ Fixture replay failed: ${(result as any)?.error || 'unknown error'}`, 'error')
        return
      }
      setReplayResult(result)
      appendOutput(`🔁 Fixture replay ${result.pass ? 'PASS' : 'FAIL'}: ${selectedFixture}`, result.pass ? 'result' : 'warn')
      if (result.failures?.length) {
        appendOutput(result.failures.join('\n'), 'warn')
      }
      await refresh(false)
    } catch (e: any) {
      appendOutput(`❌ Fixture replay failed: ${e.message}`, 'error')
    } finally {
      setFixtureBusy(false)
    }
  }

  const entries = traceState?.trace?.entries || []
  const debug = traceState?.debug || null
  return {
    traceState, loading, entries, debug,
    selectedEntry: entries.find(entry => entry.id === selectedId) || entries[entries.length - 1] || null,
    setSelectedId,
    activeModal: traceState?.trace?.activeModal || debug?.activeModal || null,
    running: Boolean(traceState?.instanceId),
    rawInput, setRawInput,
    exercisePrompt, setExercisePrompt, exerciseRunning, exerciseResult,
    fixtures, fixtureName, setFixtureName, selectedFixture, setSelectedFixture, fixtureBusy, replayResult,
    refresh, launch, stop, sendRaw, resolveApproval, runExercise, captureFixture, replayFixture,
  }
}

export type CliTraceController = ReturnType<typeof useCliTrace>
