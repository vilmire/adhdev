import { useState, type RefObject } from 'react'
import type { Badge, OutputEntry } from '../shared'

/** The always-visible Output panel: filterable log, OK/ERROR badge, and the #4 result diff view. */
export function OutputPanel({ output, badge, prevOutput, outputRef, onClear }: {
  output: OutputEntry[]
  badge: Badge
  prevOutput: string | null
  outputRef: RefObject<HTMLDivElement>
  onClear: () => void
}) {
  const [outputFilter, setOutputFilter] = useState('')
  const [showDiff, setShowDiff] = useState(false)
  return (
    <div className="output-panel">
      <div className="output-header">
        <span>Output</span>
        {badge && <span className={`badge ${badge}`}>{badge === 'ok' ? 'OK' : 'ERROR'}</span>}
        {/* #4 Diff toggle */}
        {prevOutput && (
          <button onClick={() => setShowDiff(!showDiff)} style={{
            fontSize: 9, padding: '1px 5px', borderRadius: 3, cursor: 'pointer',
            background: showDiff ? 'rgba(139,92,246,0.15)' : 'transparent',
            border: '1px solid var(--border)', color: showDiff ? 'var(--accent)' : 'var(--text-dim)',
          }}>⇔ Diff</button>
        )}
        <div style={{ flex: 1 }} />
        <input placeholder="Filter..." value={outputFilter} onChange={e => setOutputFilter(e.target.value)} />
        <button style={{ fontSize: 11, padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 3, background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer' }}
          onClick={() => { onClear(); setShowDiff(false) }}>Clear</button>
      </div>
      <div className="output-content" ref={outputRef}>
        {/* #4 Diff view */}
        {showDiff && prevOutput && (() => {
          const lastResult = [...output].reverse().find(e => e.type === 'result')
          if (!lastResult) return null
          const prevLines = prevOutput.split('\n')
          const currLines = lastResult.text.split('\n')
          const maxLen = Math.max(prevLines.length, currLines.length)
          return (
            <div style={{ padding: 4, background: 'rgba(139,92,246,0.05)', borderRadius: 4, marginBottom: 4, fontSize: 10, fontFamily: 'monospace' }}>
              <div style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 600, marginBottom: 3 }}>⇔ Diff: Previous → Current</div>
              {Array.from({ length: Math.min(maxLen, 50) }).map((_, i) => {
                const prev = prevLines[i] || ''
                const curr = currLines[i] || ''
                if (prev === curr) return <div key={i} style={{ color: 'var(--text-dim)', paddingLeft: 12 }}>{curr}</div>
                return (
                  <div key={i}>
                    {prev && <div style={{ color: '#ef4444', paddingLeft: 12 }}>- {prev}</div>}
                    {curr && <div style={{ color: '#22c55e', paddingLeft: 12 }}>+ {curr}</div>}
                  </div>
                )
              })}
            </div>
          )
        })()}
        {output
          .filter(e => !outputFilter || e.text.toLowerCase().includes(outputFilter.toLowerCase()))
          .map(e => (
            <div key={e.id} className={`output-entry type-${e.type}`}>
              <span className="ts">{e.time}</span>
              <span className="icon">{e.icon}</span>
              <span className="content">{e.text}</span>
            </div>
          ))}
      </div>
    </div>
  )
}
