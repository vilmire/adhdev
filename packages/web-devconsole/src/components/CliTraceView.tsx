import type { CliTraceController } from '../hooks/useCliTrace'
import { relativeTs } from '../shared'

/** CLI "Trace" tab: debug-session controls, exercise/fixture repro, live screen, trace timeline and parser inspector. */
export function CliTraceView({ trace, provider }: { trace: CliTraceController; provider: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, overflow: 'hidden', padding: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={trace.launch} disabled={trace.loading || trace.running} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text)', cursor: trace.running ? 'not-allowed' : 'pointer', opacity: trace.running ? 0.4 : 1 }}>
          ▶ Launch
        </button>
        <button onClick={trace.stop} disabled={!trace.running} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text)', cursor: trace.running ? 'pointer' : 'not-allowed', opacity: trace.running ? 1 : 0.4 }}>
          ■ Stop
        </button>
        <button onClick={() => trace.refresh(true)} disabled={!provider} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text)', cursor: 'pointer' }}>
          ⟳ Refresh
        </button>
        <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
          {trace.traceState?.trace
            ? `${trace.traceState.trace.status} · ${trace.traceState.trace.entryCount} frames`
            : 'No active CLI trace'}
        </div>
        {trace.loading && <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Loading…</div>}
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-dim)' }}>Exercise Repro</div>
          {trace.exerciseResult && (
            <div style={{ fontSize: 10, color: trace.exerciseResult.timedOut ? '#f59e0b' : 'var(--text-dim)' }}>
              {trace.exerciseResult.timedOut ? 'timed out' : 'settled'} · {trace.exerciseResult.elapsedMs}ms · {trace.exerciseResult.statusesSeen.join(' → ')}
            </div>
          )}
        </div>
        <textarea
          value={trace.exercisePrompt}
          onChange={e => trace.setExercisePrompt(e.target.value)}
          placeholder="Prompt for autonomous launch/send/approval/wait exercise"
          rows={3}
          style={{ width: '100%', resize: 'vertical', background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', padding: 8, borderRadius: 4, fontSize: 11, lineHeight: 1.4, fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={trace.runExercise} disabled={trace.exerciseRunning || !trace.exercisePrompt.trim() || !provider} style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--accent)', color: '#000', cursor: trace.exerciseRunning || !trace.exercisePrompt.trim() || !provider ? 'not-allowed' : 'pointer', opacity: trace.exerciseRunning || !trace.exercisePrompt.trim() || !provider ? 0.4 : 1 }}>
            {trace.exerciseRunning ? 'Running…' : 'Run Exercise'}
          </button>
          <input
            value={trace.fixtureName}
            onChange={e => trace.setFixtureName(e.target.value)}
            placeholder="fixture name"
            style={{ width: 120, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', padding: '4px 6px', borderRadius: 4, fontSize: 10, fontFamily: 'inherit' }}
          />
          <button onClick={trace.captureFixture} disabled={trace.fixtureBusy || !trace.exercisePrompt.trim() || !provider} style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text)', cursor: trace.fixtureBusy || !trace.exercisePrompt.trim() || !provider ? 'not-allowed' : 'pointer', opacity: trace.fixtureBusy || !trace.exercisePrompt.trim() || !provider ? 0.4 : 1 }}>
            {trace.fixtureBusy ? 'Working…' : 'Capture Fixture'}
          </button>
          <select
            value={trace.selectedFixture}
            onChange={e => trace.setSelectedFixture(e.target.value)}
            style={{ minWidth: 150, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', padding: '4px 6px', borderRadius: 4, fontSize: 10 }}
          >
            <option value="">Select fixture…</option>
            {trace.fixtures.map(fixture => (
              <option key={fixture.name} value={fixture.name}>{fixture.name}</option>
            ))}
          </select>
          <button onClick={trace.replayFixture} disabled={trace.fixtureBusy || !trace.selectedFixture} style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text)', cursor: trace.fixtureBusy || !trace.selectedFixture ? 'not-allowed' : 'pointer', opacity: trace.fixtureBusy || !trace.selectedFixture ? 0.4 : 1 }}>
            Replay Fixture
          </button>
          {trace.exerciseResult && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
              approvals={trace.exerciseResult.approvalsResolved.length} · instance={trace.exerciseResult.instanceId}
            </div>
          )}
          {trace.replayResult && (
            <div style={{ fontSize: 10, color: trace.replayResult.pass ? 'var(--accent-green)' : '#f59e0b' }}>
              fixture {trace.replayResult.pass ? 'PASS' : 'FAIL'}
              {trace.replayResult.failures?.length ? ` · ${trace.replayResult.failures.length} issue(s)` : ''}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 6, minHeight: 0, flex: 1 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontSize: 10, fontWeight: 600, color: 'var(--text-dim)' }}>
              Live Screen
            </div>
            <pre style={{ flex: 1, margin: 0, padding: 10, overflow: 'auto', fontSize: 11, lineHeight: 1.35, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap', background: 'rgba(255,255,255,0.02)' }}>
              {trace.traceState?.trace?.screenText || '(no screen yet)'}
            </pre>
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 6 }}>Interactive Controls</div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              <button onClick={() => trace.sendRaw('\r', 'Enter')} disabled={!trace.running} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text)', cursor: trace.running ? 'pointer' : 'not-allowed', opacity: trace.running ? 1 : 0.4 }}>Enter</button>
              <button onClick={() => trace.sendRaw('\x1b', 'Esc')} disabled={!trace.running} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text)', cursor: trace.running ? 'pointer' : 'not-allowed', opacity: trace.running ? 1 : 0.4 }}>Esc</button>
              <button onClick={() => trace.sendRaw('\x03', 'Ctrl+C')} disabled={!trace.running} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text)', cursor: trace.running ? 'pointer' : 'not-allowed', opacity: trace.running ? 1 : 0.4 }}>Ctrl+C</button>
              <button onClick={() => trace.sendRaw('\x1B[A', 'Up')} disabled={!trace.running} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text)', cursor: trace.running ? 'pointer' : 'not-allowed', opacity: trace.running ? 1 : 0.4 }}>Up</button>
              <button onClick={() => trace.sendRaw('\x1B[B', 'Down')} disabled={!trace.running} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text)', cursor: trace.running ? 'pointer' : 'not-allowed', opacity: trace.running ? 1 : 0.4 }}>Down</button>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                value={trace.rawInput}
                onChange={e => trace.setRawInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && trace.sendRaw(trace.rawInput, 'custom raw')}
                placeholder="Raw keys"
                disabled={!trace.running}
                style={{ flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', padding: '5px 8px', borderRadius: 4, fontSize: 11, fontFamily: 'inherit' }}
              />
              <button onClick={() => trace.sendRaw(trace.rawInput, 'custom raw')} disabled={!trace.running || !trace.rawInput} style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--accent)', color: '#000', cursor: trace.running && trace.rawInput ? 'pointer' : 'not-allowed', opacity: trace.running && trace.rawInput ? 1 : 0.4 }}>
                Send Raw
              </button>
            </div>
            {trace.activeModal && (
              <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: '#f59e0b', marginBottom: 4 }}>Approval</div>
                <div style={{ fontSize: 11, whiteSpace: 'pre-wrap', marginBottom: 6 }}>{trace.activeModal.message}</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {trace.activeModal.buttons.map((button: string, index: number) => (
                    <button key={`${button}-${index}`} onClick={() => trace.resolveApproval(index)} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.12)', color: '#f59e0b', cursor: 'pointer' }}>
                      {index}. {button}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateRows: '0.95fr 1.05fr', gap: 6, minHeight: 0 }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontSize: 10, fontWeight: 600, color: 'var(--text-dim)' }}>
              Trace Timeline
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              {trace.entries.length === 0 && (
                <div style={{ padding: 12, fontSize: 11, color: 'var(--text-dim)' }}>Launch the CLI to start collecting PTY frames.</div>
              )}
              {trace.entries.map(entry => (
                <button key={entry.id} onClick={() => trace.setSelectedId(entry.id)} style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '7px 8px',
                  border: 'none',
                  borderBottom: '1px solid var(--border)',
                  background: trace.selectedEntry?.id === entry.id ? 'rgba(99,102,241,0.12)' : 'transparent',
                  color: 'var(--text)',
                  cursor: 'pointer',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 10, marginBottom: 2 }}>
                    <span style={{ color: 'var(--accent)' }}>#{entry.id} {entry.type}</span>
                    <span style={{ color: 'var(--text-dim)' }}>{relativeTs(entry.at)}</span>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                    {entry.status}
                    {entry.payload?.detectStatus ? ` · detect=${entry.payload.detectStatus}` : ''}
                    {entry.payload?.parsedStatus ? ` · parsed=${entry.payload.parsedStatus}` : ''}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontSize: 10, fontWeight: 600, color: 'var(--text-dim)' }}>
              Parser Inspector
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
              {trace.selectedEntry ? (
                <>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 6 }}>
                    {trace.selectedEntry.type} · {trace.selectedEntry.status} · {relativeTs(trace.selectedEntry.at)}
                  </div>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 10, lineHeight: 1.45, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {JSON.stringify(trace.selectedEntry.payload, null, 2)}
                  </pre>
                  {trace.debug && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 4 }}>Current Adapter Snapshot</div>
                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 10, lineHeight: 1.45, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                        {JSON.stringify({
                          status: trace.debug.status,
                          ready: trace.debug.ready,
                          messageCount: trace.debug.messageCount,
                          currentTurnScope: trace.debug.currentTurnScope,
                          responseBuffer: trace.debug.responseBuffer,
                          recentOutputBuffer: trace.debug.recentOutputBuffer,
                          screenText: trace.debug.screenText,
                        }, null, 2)}
                      </pre>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Select a trace frame to inspect detectStatus, approval parsing, and transcript summaries.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
