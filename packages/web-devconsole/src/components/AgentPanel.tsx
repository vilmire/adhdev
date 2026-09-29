import type { ProviderInfo } from '../api'
import type { AgentChatController } from '../hooks/useAgentChat'
import type { CliTraceController } from '../hooks/useCliTrace'
import type { Category, ValidationResult } from '../shared'
import { CliTraceView } from './CliTraceView'

export type AgentTab = 'config' | 'settings' | 'chat' | 'trace' | 'validate'

/** ACP/CLI right panel: Config / Settings preview / Chat test / (CLI) Trace / Validate tabs. */
export function AgentPanel(props: {
  category: Category
  provider: string
  selectedProvider: ProviderInfo | undefined
  providerConfig: any
  acpTabs: AgentTab[]
  acpRightTab: AgentTab
  setAcpRightTab: (tab: AgentTab) => void
  settingsPreview: Record<string, any> | null
  validationResult: ValidationResult | null
  onValidateNow: () => void
  chat: AgentChatController
  cliTrace: CliTraceController
}) {
  const {
    category, provider, selectedProvider, providerConfig, acpTabs, acpRightTab, setAcpRightTab,
    settingsPreview, validationResult, onValidateNow, chat, cliTrace,
  } = props
  return (
    <div className="config-panel" style={{ display: 'flex', flexDirection: 'column' }}>
      {selectedProvider ? (
        <>
          <div className="config-header">
            <span className="config-icon">{selectedProvider.icon || (selectedProvider.category === 'acp' ? '🤖' : '⌨️')}</span>
            <div>
              <div className="config-name">{selectedProvider.displayName || selectedProvider.name}</div>
              <div className="config-type">{selectedProvider.type} · {selectedProvider.category.toUpperCase()}</div>
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 6 }}>
            {acpTabs.map(tab => (
              <button key={tab} onClick={() => setAcpRightTab(tab)} style={{
                padding: '4px 10px', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                background: 'none', border: 'none', borderBottom: acpRightTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                color: acpRightTab === tab ? 'var(--accent)' : 'var(--text-dim)',
              }}>
                {tab === 'config'
                  ? '📋 Config'
                  : tab === 'settings'
                    ? '⚙️ Settings'
                    : tab === 'chat'
                      ? '💬 Chat'
                      : tab === 'trace'
                        ? '🧪 Trace'
                        : '🔍 Validate'}
              </button>
            ))}
          </div>

          {/* Config Tab */}
          {acpRightTab === 'config' && (
            <div style={{ flex: 1, overflow: 'auto' }}>
              {selectedProvider.spawn && (
                <div className="config-section">
                  <div className="config-label">Spawn Command</div>
                  <code className="config-code">{selectedProvider.spawn.command} {(selectedProvider.spawn.args || []).join(' ')}</code>
                </div>
              )}
              {selectedProvider.install && (
                <div className="config-section">
                  <div className="config-label">Install</div>
                  <code className="config-code">{selectedProvider.install}</code>
                </div>
              )}
              {selectedProvider.auth && selectedProvider.auth.length > 0 && (
                <div className="config-section">
                  <div className="config-label">Auth ({selectedProvider.auth.length})</div>
                  {selectedProvider.auth.map((a, i) => (
                    <div key={i} className="config-item">
                      <span className="config-item-name">{a.name}</span>
                      <span className="config-item-desc">{a.description}</span>
                    </div>
                  ))}
                </div>
              )}
              {selectedProvider.hasSettings && (
                <div className="config-section">
                  <div className="config-label">Settings ({selectedProvider.settingsCount})</div>
                  {providerConfig?.settings && Object.entries(providerConfig.settings).map(([key, val]: [string, any]) => (
                    <div key={key} className="config-item">
                      <span className="config-item-name">{val.label || key}</span>
                      <span className="config-item-desc">{val.type} = {String(val.default)}</span>
                    </div>
                  ))}
                </div>
              )}
              {selectedProvider.cdpPorts && selectedProvider.cdpPorts.length > 0 && (
                <div className="config-section">
                  <div className="config-label">CDP Ports</div>
                  <code className="config-code">{selectedProvider.cdpPorts.join(', ')}</code>
                </div>
              )}
            </div>
          )}

          {/* #2 Settings Preview Tab */}
          {acpRightTab === 'settings' && (
            <div style={{ flex: 1, overflow: 'auto', padding: 4 }}>
              {settingsPreview ? (
                <>
                  <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 8 }}>Preview of settings as they'll appear in the dashboard</div>
                  {Object.entries(settingsPreview).map(([key, val]: [string, any]) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 4px', borderBottom: '1px solid var(--border)' }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text)' }}>{val.label || key}</div>
                        {val.description && <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>{val.description}</div>}
                      </div>
                      <div>
                        {val.type === 'boolean' ? (
                          <div style={{ width: 32, height: 18, borderRadius: 9, background: val.default ? 'var(--accent)' : 'var(--border)', position: 'relative', cursor: 'default' }}>
                            <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: val.default ? 16 : 2, transition: 'left 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.3)' }} />
                          </div>
                        ) : val.type === 'number' ? (
                          <input type="number" value={val.default ?? 0} readOnly style={{ width: 60, textAlign: 'center', fontSize: 10, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 3, padding: '2px 4px' }} />
                        ) : val.type === 'select' ? (
                          <select disabled style={{ fontSize: 10, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 3, padding: '2px 4px' }}>
                            {(val.options || []).map((o: string) => <option key={o}>{o}</option>)}
                          </select>
                        ) : (
                          <input type="text" value={val.default ?? ''} readOnly style={{ width: 80, fontSize: 10, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 3, padding: '2px 4px' }} />
                        )}
                      </div>
                    </div>
                  ))}
                  <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 8, padding: 4, background: 'rgba(139,92,246,0.05)', borderRadius: 4 }}>
                    💡 Edit the "settings" object in provider.json to update this preview
                  </div>
                </>
              ) : (
                <div className="placeholder" style={{ padding: 20 }}>
                  <div style={{ fontSize: 13, marginBottom: 8 }}>No settings defined</div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                    Open provider.json and add a "settings" key to preview how settings will appear in the dashboard.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* #3 ACP Chat Test Tab */}
          {acpRightTab === 'chat' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ flex: 1, overflow: 'auto', padding: 4 }}>
                {chat.history.length === 0 && (
                  <div className="placeholder" style={{ padding: 20 }}>
                    Send a message to test the {selectedProvider.category.toUpperCase()} agent.
                    <br /><small>Messages are sent via spawn command + args.</small>
                  </div>
                )}
                {chat.history.map((msg, i) => (
                  <div key={i} style={{
                    padding: '6px 8px', margin: '3px 0', borderRadius: 6, fontSize: 11,
                    background: msg.role === 'user' ? 'rgba(99,102,241,0.1)' : msg.role === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.08)',
                    borderLeft: `3px solid ${msg.role === 'user' ? 'var(--accent)' : msg.role === 'error' ? '#ef4444' : 'var(--accent-green)'}`,
                  }}>
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 2 }}>
                      {msg.role === 'user' ? '👤 You' : msg.role === 'error' ? '❌ Error' : '🤖 Agent'}
                      {msg.elapsed !== undefined && <span style={{ marginLeft: 6 }}>{msg.elapsed}ms</span>}
                    </div>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, lineHeight: 1.4 }}>{msg.text}</pre>
                  </div>
                ))}
                {chat.loading && <div style={{ padding: 8, fontSize: 11, color: 'var(--text-dim)' }}>⏳ Waiting for response...</div>}
              </div>
              <div style={{ display: 'flex', gap: 4, padding: 4, borderTop: '1px solid var(--border)' }}>
                <input
                  value={chat.input}
                  onChange={e => chat.setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && chat.send()}
                  placeholder="Type message..."
                  disabled={chat.loading}
                  style={{ flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', padding: '5px 8px', borderRadius: 4, fontSize: 11, fontFamily: 'inherit' }}
                />
                <button onClick={chat.send} disabled={chat.loading || !chat.input.trim()} style={{
                  background: 'var(--accent)', color: '#000', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                  opacity: chat.loading || !chat.input.trim() ? 0.4 : 1,
                }}>Send</button>
                {chat.history.length > 0 && (
                  <button onClick={() => chat.clearHistory()} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 4, padding: '4px 6px', fontSize: 9, cursor: 'pointer' }}>Clear</button>
                )}
              </div>
            </div>
          )}

          {acpRightTab === 'trace' && selectedProvider.category === 'cli' && (
            <CliTraceView trace={cliTrace} provider={provider} />
          )}

          {/* #6 Validate Tab */}
          {acpRightTab === 'validate' && (
            <div style={{ flex: 1, overflow: 'auto', padding: 4 }}>
              {validationResult ? (
                <>
                  <div style={{ padding: '8px', background: validationResult.valid ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)', borderRadius: 6, marginBottom: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: validationResult.valid ? 'var(--accent-green)' : '#ef4444' }}>
                      {validationResult.valid ? '✅ provider.json is valid' : `❌ ${validationResult.errors.length} validation error(s)`}
                    </div>
                  </div>
                  {validationResult.errors.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: '#ef4444', marginBottom: 3 }}>Errors</div>
                      {validationResult.errors.map((e, i) => (
                        <div key={i} style={{ fontSize: 10, color: '#ef4444', padding: '2px 4px', background: 'rgba(239,68,68,0.05)', borderRadius: 3, marginBottom: 2 }}>• {e}</div>
                      ))}
                    </div>
                  )}
                  {validationResult.warnings.length > 0 && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 600, color: '#f59e0b', marginBottom: 3 }}>Warnings</div>
                      {validationResult.warnings.map((w, i) => (
                        <div key={i} style={{ fontSize: 10, color: '#f59e0b', padding: '2px 4px', background: 'rgba(245,158,11,0.05)', borderRadius: 3, marginBottom: 2 }}>⚠ {w}</div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="placeholder" style={{ padding: 20 }}>
                  <div style={{ fontSize: 13, marginBottom: 8 }}>Open provider.json to validate</div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                    Click provider.json in the file tree → validation runs automatically as you edit.
                  </div>
                </div>
              )}
              {/* Manual validate button */}
              {provider && (
                <button onClick={onValidateNow} style={{ marginTop: 8, width: '100%', padding: '5px', fontSize: 10, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 4, cursor: 'pointer' }}>
                  🔍 Validate Now
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="placeholder">Select a {category.toUpperCase()} provider to view config</div>
      )}
    </div>
  )
}
