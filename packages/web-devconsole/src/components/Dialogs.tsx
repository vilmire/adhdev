import { useRef, useState } from 'react'
import { api, type ProviderInfo } from '../api'
import type { AppendOutput } from '../shared'

/** #5 Quick script params — edit the hinted parameters, then run the script. */
export function ScriptParamsDialog({ script, scriptHints, paramFields, setParamFields, onRun, onClose }: {
  script: string
  scriptHints: Record<string, { template: Record<string, any>; description: string }>
  paramFields: Record<string, any>
  setParamFields: (update: (prev: Record<string, any>) => Record<string, any>) => void
  onRun: () => void
  onClose: () => void
}) {
  return (
    <div className="modal-overlay" onClick={() => onClose()}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <h3 style={{ marginBottom: 4 }}>⚡ {script}</h3>
        {scriptHints[script]?.description && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
            {scriptHints[script].description}
          </div>
        )}
        {Object.keys(paramFields).length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Object.entries(paramFields).map(([key, val]) => (
              <div key={key}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {key}
                  <span style={{ fontSize: 9, color: 'var(--text-dim)', opacity: 0.5, fontWeight: 400 }}>
                    {typeof val === 'number' ? 'number' : 'string'}
                  </span>
                </label>
                <input
                  autoFocus={Object.keys(paramFields)[0] === key}
                  value={typeof val === 'number' && val === 0 ? '' : val}
                  onChange={e => {
                    const newVal = typeof scriptHints[script]?.template[key] === 'number'
                      ? (e.target.value === '' ? 0 : Number(e.target.value))
                      : e.target.value
                    setParamFields(prev => ({ ...prev, [key]: newVal }))
                  }}
                  onKeyDown={e => e.key === 'Enter' && onRun()}
                  placeholder={typeof val === 'number' ? '0' : `Enter ${key}...`}
                  type={typeof val === 'number' ? 'number' : 'text'}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                />
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '12px 0' }}>
            This script has no parameters. Click Run to execute.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={() => onClose()} style={{ padding: '8px 16px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-dim)', cursor: 'pointer' }}>Cancel</button>
          <button
            onClick={() => onRun()}
            style={{ padding: '8px 16px', background: 'var(--accent-green)', color: '#000', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}
          >▶ Run</button>
        </div>
      </div>
    </div>
  )
}

/**
 * "＋ New Provider" dialog. Stays mounted while hidden so a half-filled form
 * survives closing and reopening, exactly like the App-level state it replaced.
 */
export function ScaffoldDialog({ open, onClose, onCreated, appendOutput }: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  appendOutput: AppendOutput
}) {
  const [scaffoldType, setScaffoldType] = useState('')
  const [scaffoldName, setScaffoldName] = useState('')
  const [scaffoldCategory, setScaffoldCategory] = useState('ide')
  const [scaffoldCdpPort, setScaffoldCdpPort] = useState('9222')
  const [scaffoldCli, setScaffoldCli] = useState('')
  const [scaffoldProcess, setScaffoldProcess] = useState('')
  const [scaffoldInstallPath, setScaffoldInstallPath] = useState('')
  const [scaffoldBinary, setScaffoldBinary] = useState('')
  const [scaffoldExtId, setScaffoldExtId] = useState('')

  async function doScaffold() {
    if (!scaffoldType || !scaffoldName) return
    const opts: { type: string; name: string; category: string; [k: string]: unknown } = { type: scaffoldType, name: scaffoldName, category: scaffoldCategory }
    if (scaffoldCategory === 'ide') {
      const port = parseInt(scaffoldCdpPort) || 9222
      opts.cdpPorts = [port, port + 1]
      if (scaffoldCli) opts.cli = scaffoldCli
      if (scaffoldProcess) opts.processName = scaffoldProcess
      if (scaffoldInstallPath) opts.installPath = scaffoldInstallPath
    } else if (scaffoldCategory === 'extension') {
      if (scaffoldExtId) opts.extensionId = scaffoldExtId
    } else if (scaffoldCategory === 'cli' || scaffoldCategory === 'acp') {
      if (scaffoldBinary) opts.binary = scaffoldBinary
    }
    try {
      const r = await api.scaffold(opts) as any
      appendOutput(`✅ Created: ${r.path} (${(r.files || []).join(', ')})`, 'log')
      onClose()
      onCreated()
    } catch (e: any) { appendOutput(e.message, 'error') }
  }

  if (!open) return null
  return (
    <div className="modal-overlay" onClick={() => onClose()}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h3>＋ New Provider</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}><label>Type ID</label><input value={scaffoldType} onChange={e => setScaffoldType(e.target.value)} placeholder="zed" /></div>
            <div style={{ flex: 1 }}><label>Display Name</label><input value={scaffoldName} onChange={e => setScaffoldName(e.target.value)} placeholder="Zed" /></div>
          </div>
          <div>
            <label>Category</label>
            <select value={scaffoldCategory} onChange={e => setScaffoldCategory(e.target.value)}>
              <option value="ide">💻 IDE</option>
              <option value="extension">🧩 Extension</option>
              <option value="cli">⌨️ CLI</option>
              <option value="acp">🤖 ACP</option>
            </select>
          </div>

          {/* IDE-specific fields */}
          {scaffoldCategory === 'ide' && (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}><label>CDP Port</label><input type="number" value={scaffoldCdpPort} onChange={e => setScaffoldCdpPort(e.target.value)} placeholder="9222" /></div>
                <div style={{ flex: 1 }}><label>CLI Command</label><input value={scaffoldCli} onChange={e => setScaffoldCli(e.target.value)} placeholder="zed" /></div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}><label>Process Name (macOS)</label><input value={scaffoldProcess} onChange={e => setScaffoldProcess(e.target.value)} placeholder="Zed" /></div>
                <div style={{ flex: 1 }}><label>Install Path</label><input value={scaffoldInstallPath} onChange={e => setScaffoldInstallPath(e.target.value)} placeholder="/Applications/Zed.app" /></div>
              </div>
            </>
          )}

          {/* Extension-specific fields */}
          {scaffoldCategory === 'extension' && (
            <div><label>Extension ID</label><input value={scaffoldExtId} onChange={e => setScaffoldExtId(e.target.value)} placeholder="publisher.extension-name" /></div>
          )}

          {/* CLI/ACP-specific fields */}
          {(scaffoldCategory === 'cli' || scaffoldCategory === 'acp') && (
            <div><label>Binary / Command</label><input value={scaffoldBinary} onChange={e => setScaffoldBinary(e.target.value)} placeholder={scaffoldType || 'my-tool'} /></div>
          )}

          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -4 }}>
            Creates <code>provider.json</code>{(scaffoldCategory === 'ide' || scaffoldCategory === 'extension') && <> + <code>scripts.js</code></>} in <code>~/.adhdev/providers/{scaffoldType || '...'}/</code>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => onClose()} style={{ padding: '8px 16px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-dim)', cursor: 'pointer' }}>Cancel</button>
            <button onClick={doScaffold} disabled={!scaffoldType || !scaffoldName} style={{ padding: '8px 16px', background: !scaffoldType || !scaffoldName ? 'var(--border)' : 'var(--accent)', color: '#000', border: 'none', borderRadius: 6, fontWeight: 600, cursor: !scaffoldType || !scaffoldName ? 'default' : 'pointer', opacity: !scaffoldType || !scaffoldName ? 0.5 : 1 }}>Create</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 🤖 Auto-Implement dialog: pick agent/reference/functions, then stream the run's progress over SSE. */
export function AutoImplDialog({ open, onClose, provider, providerName, providers, appendOutput, onRefresh }: {
  open: boolean
  onClose: () => void
  provider: string
  providerName: string | undefined
  providers: ProviderInfo[]
  appendOutput: AppendOutput
  onRefresh: () => void
}) {
  const [autoImplAgent, setAutoImplAgent] = useState('claude-cli')
  const [autoImplReference, setAutoImplReference] = useState('antigravity')
  const [autoImplFunctions, setAutoImplFunctions] = useState<Record<string, boolean>>({
    readChat: true, sendMessage: true, resolveAction: true, listSessions: true, listModels: true, setModel: true, switchSession: true, newSession: true, focusEditor: true, openPanel: true, listModes: true, setMode: true
  })
  const [autoImplStatus, setAutoImplStatus] = useState<{ running: boolean; functions: string[]; message: string; logs: { event: string; data: any }[] } | null>(null)
  const autoImplSSERef = useRef<EventSource | null>(null)

  async function doAutoImpl() {
    if (!provider) return
    const fns = Object.keys(autoImplFunctions).filter(k => autoImplFunctions[k])
    if (fns.length === 0) { appendOutput('Select at least one function', 'warn'); return }
    try {
      setAutoImplStatus({ running: true, functions: fns, message: 'Starting...', logs: [] })
      await api.autoImplement(provider, { agent: autoImplAgent, reference: autoImplReference, functions: fns })
      appendOutput(`🚀 Auto-Implement started for ${fns.length} functions`, 'log')
    
      if (autoImplSSERef.current) autoImplSSERef.current.close()
      const es = api.autoImplementStatus(provider)
      autoImplSSERef.current = es
      // unnamed messages (data-only from initial connection)
      es.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data)
          setAutoImplStatus(prev => prev ? { ...prev, logs: [...prev.logs, { event: 'connected', data: d }] } : null)
        } catch {}
      }
      es.addEventListener('progress', (e: any) => {
        try {
          const d = JSON.parse(e.data)
          setAutoImplStatus(prev => prev ? { ...prev, message: d.message, logs: [...prev.logs, { event: 'progress', data: d }] } : null)
        } catch {}
      })
      es.addEventListener('output', (e: any) => {
        try {
          const d = JSON.parse(e.data)
          setAutoImplStatus(prev => prev ? { ...prev, logs: [...prev.logs, { event: 'output', data: d }] } : null)
        } catch {}
      })
      es.addEventListener('complete', (e: any) => {
        try {
          const d = JSON.parse(e.data)
          appendOutput(d.message, d.success ? 'result' : 'error')
          es.close()
          autoImplSSERef.current = null
          setAutoImplStatus(prev => prev ? { ...prev, running: false, message: d.message } : null)
          onRefresh()
        } catch {}
      })
      es.addEventListener('error', () => {
        appendOutput('SSE connection lost', 'error')
        es.close()
        autoImplSSERef.current = null
        setAutoImplStatus(prev => prev ? { ...prev, running: false, message: 'Connection lost' } : null)
      })
    } catch (e: any) {
      appendOutput(e.message, 'error')
      setAutoImplStatus(prev => prev ? { ...prev, running: false, message: `❌ ${e.message}` } : { running: false, functions: [], message: `❌ ${e.message}`, logs: [] })
    }
  }

  function toggleAutoImplFunc(fn: string) {
    setAutoImplFunctions(prev => ({ ...prev, [fn]: !prev[fn] }))
  }

  async function cancelAutoImpl() {
    if (!provider) return
    try {
      await api.autoImplementCancel(provider)
      appendOutput('⛔ Auto-Implement cancelled', 'warn')
      if (autoImplSSERef.current) { autoImplSSERef.current.close(); autoImplSSERef.current = null }
      setAutoImplStatus(prev => prev ? { ...prev, running: false, message: '⛔ Aborted by user' } : null)
    } catch (e: any) { appendOutput(e.message, 'error') }
  }

  if (!open) return null
  return (
    <div className="modal-overlay" onClick={() => !autoImplStatus?.running && onClose()}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 500, maxWidth: '90vw' }}>
        <h3 style={{ marginBottom: 12 }}>🤖 Auto-Implement: {providerName || provider}</h3>
    
        {autoImplStatus ? (
          // Progress View
          <div style={{ marginTop: 20 }}>
            <div style={{ marginBottom: 15, fontWeight: 600 }}>
              {autoImplStatus.running ? '⏳ Auto-Implementing...' : '✨ Done'}
              <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 4 }}>{autoImplStatus.message}</div>
            </div>
            <div style={{ background: '#1e1e1e', padding: 10, borderRadius: 6, maxHeight: 300, minHeight: 150, overflowY: 'auto', fontSize: 12, fontFamily: 'monospace' }}>
              {autoImplStatus.logs.map((log, i) => {
                if (log.event === 'output') return <span key={i} style={{ color: log.data.stream === 'stderr' ? '#f44' : '#ccc' }}>{log.data.chunk}</span>
                if (log.event === 'progress') return <div key={i} style={{ color: '#64ffda', marginTop: 4 }}>▶ {log.data.function}: {log.data.message}</div>
                if (log.event === 'connected') return <div key={i} style={{ color: '#888' }}>- Connected to SSE -</div>
                return null
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              {autoImplStatus.running ? (
                <button onClick={cancelAutoImpl} style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', fontWeight: 600, cursor: 'pointer' }}>⛔ Cancel</button>
              ) : (
                <button className="primary" onClick={() => { onClose(); setAutoImplStatus(null) }}>Close</button>
              )}
            </div>
          </div>
        ) : (
          // Configuration View
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '12px 0', alignItems: 'center' }}>
              <label>Agent:</label>
              <select value={autoImplAgent} onChange={e => setAutoImplAgent(e.target.value)}>
                <optgroup label="⌨️ CLI Agents (stdin prompt)">
                  {providers.filter(p => p.category === 'cli').map(p => (
                    <option key={p.type} value={p.type}>{p.name} ({p.type})</option>
                  ))}
                </optgroup>
                <optgroup label="🤖 ACP Agents (JSON-RPC)">
                  {providers.filter(p => p.category === 'acp').map(p => (
                    <option key={p.type} value={p.type}>{p.name} ({p.type})</option>
                  ))}
                </optgroup>
              </select>

              <label>Reference:</label>
              <select value={autoImplReference} onChange={e => setAutoImplReference(e.target.value)}>
                <option value="antigravity">Antigravity (Recommended)</option>
                <option value="cursor">Cursor</option>
                <option value="kiro">Kiro</option>
              </select>
            </div>

            <div style={{ marginTop: 24 }}>
              <label style={{ display: 'block', marginBottom: 10, fontWeight: 600 }}>Functions to Implement:</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, background: 'rgba(255,255,255,0.03)', padding: 12, borderRadius: 6 }}>
                {Object.keys(autoImplFunctions).map(fn => (
                  <label key={fn} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={autoImplFunctions[fn]} onChange={() => toggleAutoImplFunc(fn)} />
                    {fn}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 24 }}>
              <button onClick={() => onClose()}>Cancel</button>
              <button className="primary" onClick={doAutoImpl}>🚀 Start Auto-Implement</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
