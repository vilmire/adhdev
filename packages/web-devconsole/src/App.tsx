import { useState, useEffect, useRef } from 'react'
import Editor from '@monaco-editor/react'
import { api, type ProviderInfo, type CdpTarget } from './api'
import { CATEGORY_TABS, HELPER_PREAMBLE, isCdpCategory, type Category, type ValidationResult } from './shared'
import { useOutput } from './hooks/useOutput'
import { useCliTrace } from './hooks/useCliTrace'
import { useAgentChat } from './hooks/useAgentChat'
import { useWizard } from './hooks/useWizard'
import { useScreenshotInspector } from './hooks/useScreenshotInspector'
import { verifyProviderRuntime } from './verifyRuntime'
import { FileTree, type FileEntry } from './components/FileTree'
import { CdpInspectorPanel } from './components/CdpInspectorPanel'
import { AgentPanel, type AgentTab } from './components/AgentPanel'
import { OutputPanel } from './components/OutputPanel'
import { AutoImplDialog, ScaffoldDialog, ScriptParamsDialog } from './components/Dialogs'

export default function App() {
  // ─── State ───
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [targets, setTargets] = useState<CdpTarget[]>([])
  const [category, setCategory] = useState<Category>('ide')
  const [provider, setProvider] = useState('')
  const [ideTarget, setIdeTarget] = useState('')
  const [cdpConnected, setCdpConnected] = useState(false)
  const [providerCount, setProviderCount] = useState(0)

  const [editorCode, setEditorCode] = useState('// Write JS to evaluate via CDP — Ctrl+Enter to run\n\n(() => {\n  const title = document.title;\n  log(\'Page title:\', title);\n  return title;\n})()')
  const [activeFile, setActiveFile] = useState<string | null>(null)



  const [selectorInput, setSelectorInput] = useState('')
  const [selectorCount, setSelectorCount] = useState<string>('')

  const [execTime, setExecTime] = useState('')

  const [fileList, setFileList] = useState<FileEntry[]>([])
  const [showScaffold, setShowScaffold] = useState(false)
  const [showAutoImplDialog, setShowAutoImplDialog] = useState(false)
  const [spawnTesting, setSpawnTesting] = useState(false)
  const [providerConfig, setProviderConfig] = useState<any>(null)

  // Version detection
  const [versionInfo, setVersionInfo] = useState<Record<string, { installed: boolean; version: string | null; warning?: string }>>({})

  // #1 provider.json live editor + #6 validation
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const validationTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // #2 Settings preview
  const [settingsPreview, setSettingsPreview] = useState<Record<string, any> | null>(null)

  // #5 Quick script params — dialog
  const [paramScript, setParamScript] = useState<string | null>(null)
  const [paramFields, setParamFields] = useState<Record<string, any>>({})
  const [scriptHints, setScriptHints] = useState<Record<string, { template: Record<string, any>; description: string }>>({})

  // Right panel tab for ACP/CLI
  const [acpRightTab, setAcpRightTab] = useState<AgentTab>('config')


  const { output, badge, setBadge, prevOutput, outputRef, appendOutput, clearOutput } = useOutput()

  const selectedProvider = providers.find(p => p.type === provider)
  const providerCategory = selectedProvider?.category
  const isCdp = isCdpCategory(providerCategory)
  const isCli = providerCategory === 'cli'
  const acpTabs: AgentTab[] = isCli
    ? ['config', 'settings', 'chat', 'trace', 'validate']
    : ['config', 'settings', 'chat', 'validate']

  const cliTrace = useCliTrace(provider, isCli, appendOutput)
  const chat = useAgentChat(provider, selectedProvider, appendOutput, () => { cliTrace.refresh(false).catch(() => {}) })
  const wizard = useWizard(ideTarget, appendOutput)
  const {
    screenshotUrl, liveScreenshot, crosshair, imgRef, inspectResult, analyzeResult, rightTab, setRightTab,
    takeScreenshot, toggleLiveScreenshot, handleScreenshotClick, analyzeElement,
  } = useScreenshotInspector(ideTarget, provider, appendOutput, setBadge)

  // ─── Init ───
  useEffect(() => {
    refresh()
    const interval = setInterval(refreshStatus, 5000)
    // Load version info once
    api.versions().then(r => {
      const map: Record<string, { installed: boolean; version: string | null; warning?: string }> = {}
      for (const p of r.providers) {
        map[p.type] = { installed: p.installed, version: p.version, warning: p.warning }
      }
      setVersionInfo(map)
    }).catch(() => {})
    return () => clearInterval(interval)
  }, [])

  // Load config + file list when provider changes
  useEffect(() => {
    if (provider && !isCdpCategory(providers.find(p => p.type === provider)?.category)) {
      api.getConfig(provider).then(r => setProviderConfig(r.config)).catch(() => setProviderConfig(null))
    } else {
      setProviderConfig(null)
    }
    // Load file list for any provider
    if (provider) {
      api.listFiles(provider).then(r => setFileList(r.files || [])).catch(() => setFileList([]))
    } else {
      setFileList([])
    }
    setActiveFile(null)
    setValidationResult(null)
    setSettingsPreview(null)
    setAcpRightTab('config')
    setScriptHints({})
    // Load script hints for CDP providers
    if (provider && isCdpCategory(providers.find(p => p.type === provider)?.category)) {
      api.scriptHints(provider).then(r => setScriptHints(r.hints || {})).catch(() => setScriptHints({}))
    }
  }, [provider])

  // #6 Auto-validate when editing provider.json
  useEffect(() => {
    if (activeFile !== 'provider.json' || !provider) return
    if (validationTimer.current) clearTimeout(validationTimer.current)
    validationTimer.current = setTimeout(async () => {
      try {
        const result = await api.validate(provider, editorCode)
        setValidationResult(result)
        // #2 Parse settings for preview
        try {
          const config = JSON.parse(editorCode)
          if (config.settings) setSettingsPreview(config.settings)
          else setSettingsPreview(null)
        } catch { setSettingsPreview(null) }
      } catch {}
    }, 800)
    return () => { if (validationTimer.current) clearTimeout(validationTimer.current) }
  }, [editorCode, activeFile, provider])

  async function refresh() {
    try {
      const [provData, targetData, statusData] = await Promise.all([
        api.getProviders(), api.getTargets(), api.getStatus(),
      ])
      setProviders(provData.providers || [])
      setTargets(targetData.targets || [])
      const hasCdp = Object.values(statusData.cdp || {}).some(c => c.connected)
      setCdpConnected(hasCdp)
      setProviderCount(statusData.providers?.length || 0)
    } catch { /* ignore */ }
  }

  async function refreshStatus() {
    try {
      const data = await api.getStatus()
      const hasCdp = Object.values(data.cdp || {}).some(c => c.connected)
      setCdpConnected(hasCdp)
      setProviderCount(data.providers?.length || 0)
    } catch { /* ignore */ }
  }

  // ─── Filtered Providers ───
  const filteredProviders = providers.filter(p => p.category === category)

  // ─── Run Editor (CDP) ───
  async function runEditor() {
    const code = editorCode.trim()
    if (!code) return
    const wrapped = `(async () => {\n${HELPER_PREAMBLE}\ntry {\n  const __result = await (async () => {\n    ${/^\s*\(?\s*(async\s*)?\(\s*\)\s*=>\s*\{/.test(code) ? `return await ${code};` : code}\n  })();\n  return JSON.stringify({ __helpers: true, logs: __logs, result: __result });\n} catch(e) {\n  return JSON.stringify({ __helpers: true, logs: __logs, error: Object.getOwnPropertyNames(e).reduce((a, k) => { a[k] = e[k]; return a; }, {}) });\n}\n})()`
    const start = Date.now()
    try {
      const result = await api.evaluate(wrapped, ideTarget || undefined)
      setExecTime(`${Date.now() - start}ms`)
      let raw: any = result.result
      let parsed: any = null
      if (typeof raw === 'object' && raw?.__helpers) parsed = raw
      else if (typeof raw === 'string') { try { parsed = JSON.parse(raw) } catch {} }
      if (parsed?.__helpers) {
        for (const l of (parsed.logs || [])) appendOutput(l, 'log')
        if (parsed.error) { appendOutput(JSON.stringify(parsed.error, null, 2), 'error'); setBadge('err') }
        else {
          let display = parsed.result
          try { if (typeof display === 'string') display = JSON.parse(display) } catch {}
          appendOutput(typeof display === 'object' ? JSON.stringify(display, null, 2) : String(display ?? 'undefined'), 'result')
          setBadge('ok')
        }
      } else {
        appendOutput(typeof raw === 'object' ? JSON.stringify(raw, null, 2) : String(raw), 'result')
        setBadge('ok')
      }
    } catch (e: any) {
      appendOutput(e.message, 'error')
      setBadge('err')
    }
  }

  // ─── Run Provider Script (CDP) ───
  async function runScript(scriptName: string, params?: unknown) {
    if (!provider) { appendOutput('Select a provider first', 'warn'); return }
    const start = Date.now()
    try {
      const result = await api.runScript(provider, scriptName, params, ideTarget || undefined)
      setExecTime(`${Date.now() - start}ms`)
      const val = result.result !== undefined ? result.result : result
      appendOutput(typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val), 'result')
      setBadge('ok')
    } catch (e: any) {
      appendOutput(e.message, 'error')
      setBadge('err')
    }
  }

  function copySel(selector: string) {
    navigator.clipboard.writeText(selector)
    appendOutput(`📋 Copied: ${selector}`, 'log')
  }

  // Insert evaluation code into editor
  function insertSelectorCode(selector: string) {
    const code = `// Evaluate: ${selector}
const parent = document.querySelector('${selector.replace(/'/g, "\\'")}')
if (!parent) return 'Element not found'

const children = [...parent.children]
return children.map((el, i) => ({
  index: i,
  tag: el.tagName.toLowerCase(),
  text: (el.textContent || '').trim().substring(0, 300),
  childCount: el.children.length,
}))`
    setEditorCode(code)
    appendOutput(`📝 Code inserted for: ${selector}`, 'log')
  }

  // #5 Quick script params — run with inline input
  function runScriptWithParams(scriptName: string) {
    // Build params from dialog fields
    const params: Record<string, any> = {}
    for (const [k, v] of Object.entries(paramFields)) {
      // Skip empty string values (optional params)
      if (v === '' || v === undefined) continue
      params[k] = v
    }
    runScript(scriptName, Object.keys(params).length > 0 ? params : undefined)
    setParamScript(null)
    setParamFields({})
  }

  function openParamDialog(scriptName: string) {
    const hint = scriptHints[scriptName]
    if (hint && Object.keys(hint.template).length > 0) {
      // Pre-fill from template with default values
      setParamFields({ ...hint.template })
    } else {
      setParamFields({})
    }
    setParamScript(scriptName)
  }

  // ─── Selector Query ───
  async function querySel() {
    if (!selectorInput.trim()) return
    try {
      const result = await api.querySelector(selectorInput.trim(), 20, ideTarget || undefined)
      setSelectorCount(`${result.total || 0} matches`)
      let text = `🔍 ${selectorInput} — ${result.total} match(es)\n\n`
      for (const item of (result.results || [])) {
        text += `[${item.index}] <${item.tag}> ${item.visible ? '✅' : '❌'} ${item.rect ? `${item.rect.w}×${item.rect.h}` : ''}\n`
        if (item.id) text += `  id: ${item.id}\n`
        if (item.text) text += `  "${item.text.slice(0, 60)}"\n`
      }
      appendOutput(text, result.total > 0 ? 'result' : 'error'); setBadge(result.total > 0 ? 'ok' : 'err')
    } catch (e: any) { appendOutput(e.message, 'error'); setBadge('err') }
  }

  // ─── Spawn Test (ACP/CLI) ───
  async function handleSpawnTest() {
    if (!provider) { appendOutput('Select a provider first', 'warn'); return }
    setSpawnTesting(true)
    try {
      const result = await api.spawnTest(provider)
      if (result.success) {
        appendOutput(`✅ Spawn OK (${result.elapsed}ms)\n  cmd: ${result.command}\n  exit: ${result.exitCode ?? 'killed'}\n  stdout: ${result.stdout || '(empty)'}\n  stderr: ${result.stderr || '(none)'}`, 'result')
        setBadge('ok')
      } else {
        appendOutput(`❌ Spawn FAILED (${result.elapsed}ms)\n  cmd: ${result.command}\n  error: ${result.error}`, 'error')
        setBadge('err')
      }
    } catch (e: any) { appendOutput(e.message, 'error'); setBadge('err') }
    finally { setSpawnTesting(false) }
  }

  // ─── Reload ───
  async function handleReload() {
    try {
      const result = await api.reload()
      if (result.reloaded) { appendOutput(`🔄 Reloaded: ${result.providers?.length || 0} providers`, 'log'); refresh() }
    } catch (e: any) { appendOutput(e.message, 'error') }
  }

  // ─── Edit Source ───
  async function editSource() {
    if (!provider) { appendOutput('Select a provider first', 'warn'); return }
    try {
      const result = await api.getSource(provider)
      setEditorCode(result.source); setActiveFile(null)
      appendOutput(`📄 Loaded source: ${result.path} (${result.lines} lines)`, 'log')
    } catch (e: any) { appendOutput(e.message, 'error') }
  }

  // ─── Save ───
  async function handleSave() {
    if (!provider) return
    if (activeFile) {
      try {
        const r = await api.writeFile(provider, activeFile, editorCode)
        appendOutput(`💾 Saved: ${activeFile} (${r.chars} chars)`, 'log'); setBadge('ok')
      } catch (e: any) { appendOutput(e.message, 'error') }
    } else {
      try { const r = await api.saveSource(provider, editorCode); appendOutput(`💾 Saved: ${r.path}`, 'log'); setBadge('ok') }
      catch (e: any) { appendOutput(e.message, 'error') }
    }
  }

  // ─── Load File ───
  async function loadFile(filePath: string) {
    if (!provider) return
    setActiveFile(filePath)
    try {
      const r = await api.readFile(provider, filePath)
      setEditorCode(r.content)
      appendOutput(`✏️ Editing: ${filePath} (${r.lines} lines)`, 'log')
    } catch (e: any) {
      setEditorCode(`// Error loading ${filePath}\n// ${e.message}`)
      appendOutput(`❌ Failed to load ${filePath}`, 'error')
    }
  }

  function createNewFile() {
    const name = prompt('New file name (e.g. scripts/my_script.js):')
    if (name) {
      api.writeFile(provider, name, name.endsWith('.json') ? '{}\n' : '// ' + name + '\n').then(() => {
        api.listFiles(provider).then(r => setFileList(r.files || []))
        loadFile(name)
        appendOutput(`✨ Created: ${name}`, 'log')
      }).catch(e => appendOutput(e.message, 'error'))
    }
  }

  // #6 Manual validate ("Validate Now")
  async function validateNow() {
    try {
      const content = activeFile === 'provider.json' ? editorCode : (await api.readFile(provider, 'provider.json')).content
      const result = await api.validate(provider, content)
      setValidationResult(result)
      appendOutput(`🔍 Validation: ${result.valid ? '✅ Valid' : `❌ ${result.errors.length} errors`}${result.warnings.length > 0 ? `, ⚠ ${result.warnings.length} warnings` : ''}`, result.valid ? 'result' : 'error')
    } catch (e: any) { appendOutput(e.message, 'error') }
  }

  // ═══ Render ═══
  return (
    <>
      {/* ─── Toolbar ─── */}
      <div className="toolbar">
        <span className="logo">🔧 ADHDev DevConsole</span>

        <div className="category-tabs">
          {CATEGORY_TABS.map(t => (
            <button key={t.key} className={category === t.key ? 'active' : ''} onClick={() => { setCategory(t.key); setProvider('') }}>
              {t.icon} {t.label}
              <span style={{ marginLeft: 4, opacity: 0.7 }}>({providers.filter(p => p.category === t.key).length})</span>
            </button>
          ))}
        </div>

        <select value={provider} onChange={e => { setProvider(e.target.value); setActiveFile(null) }} style={{ minWidth: 180 }}>
          <option value="">— Select Provider —</option>
          {filteredProviders.map(p => (
            <option key={p.type} value={p.type}>
              {p.category === 'ide' ? '💻' : p.category === 'extension' ? '🧩' : p.category === 'cli' ? '⌨️' : '🤖'} {p.name} ({p.type})
            </option>
          ))}
        </select>

        <button onClick={() => setShowScaffold(true)}>＋ New</button>

        {/* Version badge for selected provider */}
        {provider && versionInfo[provider] && (
          <span style={{
            fontSize: 10,
            padding: '2px 8px',
            borderRadius: 10,
            fontWeight: 600,
            background: versionInfo[provider].warning ? 'rgba(255,160,0,0.15)' : versionInfo[provider].installed ? 'rgba(0,200,80,0.15)' : 'rgba(255,60,60,0.15)',
            color: versionInfo[provider].warning ? '#ffa000' : versionInfo[provider].installed ? '#00c850' : '#ff3c3c',
            border: `1px solid ${versionInfo[provider].warning ? 'rgba(255,160,0,0.3)' : versionInfo[provider].installed ? 'rgba(0,200,80,0.3)' : 'rgba(255,60,60,0.3)'}`,
            cursor: versionInfo[provider].warning ? 'help' : 'default',
          }} title={versionInfo[provider].warning || (versionInfo[provider].installed ? `Installed: v${versionInfo[provider].version}` : 'Not installed')}>
            {versionInfo[provider].installed
              ? (versionInfo[provider].warning ? `⚠ v${versionInfo[provider].version}` : `v${versionInfo[provider].version || '?'}`)
              : '✗ Not installed'
            }
          </span>
        )}

        {/* CDP tools — only for IDE/Extension */}
        {isCdp && (
          <>
            <select value={ideTarget} onChange={e => setIdeTarget(e.target.value)} title="CDP Target">
              <option value="">Auto</option>
              {targets.map(t => (
                <option key={t.ide} value={t.ide}>{t.connected ? '🟢' : '🔴'} {t.ide} (:{t.port})</option>
              ))}
            </select>
            <button onClick={takeScreenshot}>📸</button>
            <button onClick={toggleLiveScreenshot} style={liveScreenshot ? { color: 'var(--accent-green)', borderColor: 'var(--accent-green)' } : {}}>
              {liveScreenshot ? '⏸ Live' : '▶ Live'}
            </button>
          </>
        )}

        {/* ACP/CLI tools */}
        {!isCdp && provider && (
          <>
            <button className="primary" onClick={handleSpawnTest} disabled={spawnTesting}>
              {spawnTesting ? '⏳ Testing...' : '🚀 Spawn Test'}
            </button>
          </>
        )}

        {/* Common tools */}
        <button onClick={editSource}>📄 Source</button>
        <button onClick={handleReload}>🔄</button>
        {provider && (
          <button onClick={handleSave} style={{ background: 'var(--accent-green)', color: '#000', borderColor: 'var(--accent-green)', fontWeight: 600 }}>
            💾 Save
          </button>
        )}

        {provider && isCdp && (
          <>
          <button onClick={() => setShowAutoImplDialog(true)} style={{ background: 'var(--accent-blue)', color: '#fff', borderColor: 'var(--accent-blue)', marginLeft: 8 }}>
            🤖 Auto-Impl
          </button>
          <button onClick={() => verifyProviderRuntime({ provider, isCdp, cdpConnected, ideTarget, appendOutput, setBadge })} style={{ background: 'var(--accent-yellow)', color: '#000', borderColor: 'var(--accent-yellow)', marginLeft: 8, fontWeight: 600 }}>
            ✅ Verify
          </button>
          </>
        )}

        <div className="spacer" />
        <div className="status-bar">
          <div className={`status-dot ${cdpConnected ? 'on' : ''}`} />
          {cdpConnected ? 'CDP Connected' : 'No CDP'} · {providerCount} providers
        </div>
      </div>

      {/* ─── Main ─── */}
      <div className="main">
        {/* Left: Editor */}
        <div className="editor-panel" style={{ display: 'flex', flexDirection: 'row' }}>
          {/* File Tree Sidebar */}
          {provider && (
            <FileTree
              isCdp={isCdp}
              selectedProvider={selectedProvider}
              scriptHints={scriptHints}
              fileList={fileList}
              activeFile={activeFile}
              runScript={runScript}
              openParamDialog={openParamDialog}
              loadFile={loadFile}
              onNewFile={createNewFile}
            />
          )}
          {/* Editor Main */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div className="editor-header">
            <span className="editor-filename">{activeFile || (isCdp ? 'editor' : 'source')}</span>
            {/* #6 Validation badge */}
            {activeFile === 'provider.json' && validationResult && (
              <span style={{
                marginLeft: 6, fontSize: 9, padding: '1px 6px', borderRadius: 8, fontWeight: 600,
                background: validationResult.valid
                  ? (validationResult.warnings.length > 0 ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.15)')
                  : 'rgba(239,68,68,0.15)',
                color: validationResult.valid
                  ? (validationResult.warnings.length > 0 ? '#f59e0b' : '#22c55e')
                  : '#ef4444',
              }}>
                {validationResult.valid ? (validationResult.warnings.length > 0 ? `⚠ ${validationResult.warnings.length}` : '✅ Valid') : `❌ ${validationResult.errors.length} error${validationResult.errors.length > 1 ? 's' : ''}`}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{execTime}</span>
          </div>
          <div className="editor-container">
            <Editor
              height="100%"
              language={activeFile?.endsWith('.json') ? 'json' : 'javascript'}
              theme="vs-dark"
              value={editorCode}
              onChange={v => setEditorCode(v || '')}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                padding: { top: 8 },
              }}
              onMount={(editor) => {
                editor.addAction({
                  id: 'run-code',
                  label: 'Run Code',
                  keybindings: [2048 | 3],
                  run: () => runEditor(),
                })
              }}
            />
          </div>
          </div>{/* end editor main */}
        </div>

        {/* Right Panel */}
        <div className="right-panel">
          {/* CDP mode: Screenshot + Selector; ACP/CLI mode: Tabbed Panel */}
          {isCdp ? (
            <CdpInspectorPanel
              screenshotUrl={screenshotUrl}
              imgRef={imgRef}
              handleScreenshotClick={handleScreenshotClick}
              crosshair={crosshair}
              selectorInput={selectorInput}
              setSelectorInput={setSelectorInput}
              querySel={querySel}
              selectorCount={selectorCount}
              rightTab={rightTab}
              setRightTab={setRightTab}
              inspectResult={inspectResult}
              analyzeResult={analyzeResult}
              copySel={copySel}
              analyzeElement={analyzeElement}
              insertSelectorCode={insertSelectorCode}
              wizard={wizard}
            />
          ) : (
            <AgentPanel
              category={category}
              provider={provider}
              selectedProvider={selectedProvider}
              providerConfig={providerConfig}
              acpTabs={acpTabs}
              acpRightTab={acpRightTab}
              setAcpRightTab={setAcpRightTab}
              settingsPreview={settingsPreview}
              validationResult={validationResult}
              onValidateNow={validateNow}
              chat={chat}
              cliTrace={cliTrace}
            />
          )}

          {/* Output Panel (always visible) */}
          <OutputPanel output={output} badge={badge} prevOutput={prevOutput} outputRef={outputRef} onClear={clearOutput} />
        </div>
      </div>

      {/* Script Params Dialog */}
      {paramScript && (
        <ScriptParamsDialog
          script={paramScript}
          scriptHints={scriptHints}
          paramFields={paramFields}
          setParamFields={setParamFields}
          onRun={() => runScriptWithParams(paramScript)}
          onClose={() => setParamScript(null)}
        />
      )}

      <ScaffoldDialog open={showScaffold} onClose={() => setShowScaffold(false)} onCreated={refresh} appendOutput={appendOutput} />

      {/* ─── Auto-Implement Dialog ─── */}
      <AutoImplDialog
        open={showAutoImplDialog}
        onClose={() => setShowAutoImplDialog(false)}
        provider={provider}
        providerName={selectedProvider?.name}
        providers={providers}
        appendOutput={appendOutput}
        onRefresh={refresh}
      />
    </>
  )
}
