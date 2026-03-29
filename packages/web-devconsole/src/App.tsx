import { useState, useEffect, useRef, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import { api, type ProviderInfo, type CdpTarget } from './api'

type Category = 'ide' | 'extension' | 'cli' | 'acp'
type OutputType = 'log' | 'result' | 'error' | 'warn'
interface OutputEntry { id: number; time: string; icon: string; text: string; type: OutputType }

const CATEGORY_TABS: { key: Category; label: string; icon: string }[] = [
  { key: 'ide', label: 'IDE', icon: '💻' },
  { key: 'extension', label: 'Extension', icon: '🧩' },
  { key: 'cli', label: 'CLI', icon: '⌨️' },
  { key: 'acp', label: 'ACP', icon: '🤖' },
]

const ICONS: Record<OutputType, string> = { log: '📝', result: '✅', error: '❌', warn: '⚠️' }

const HELPER_PREAMBLE = `
var __logs = [];
function log() { var args = Array.prototype.slice.call(arguments); __logs.push(args.map(function(a) { return typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' ')); }
function queryAll(sel, limit) {
  var els = Array.from(document.querySelectorAll(sel)).slice(0, limit || 20);
  return els.map(function(el, i) {
    var r = el.getBoundingClientRect();
    return { index: i, tag: el.tagName.toLowerCase(), id: el.id || undefined, text: (el.textContent||'').trim().substring(0,100), visible: el.offsetWidth > 0, bounds: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } };
  });
}
function click(sel) { var el = document.querySelector(sel); if (!el) return false; el.click(); return true; }
function waitFor(sel, timeout) {
  timeout = timeout || 5000;
  return new Promise(function(resolve) {
    var start = Date.now();
    (function check() { var el = document.querySelector(sel); if (el) return resolve(el); if (Date.now() - start > timeout) return resolve(null); setTimeout(check, 200); })();
  });
}
`

function ts() { return new Date().toTimeString().split(' ')[0].substring(0, 8) }

// Determine if a category uses CDP tools
function isCdpCategory(cat: string | undefined): boolean {
  return cat === 'ide' || cat === 'extension'
}

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

  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)
  const [screenshotVp, setScreenshotVp] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [liveScreenshot, setLiveScreenshot] = useState(false)
  const [crosshair, setCrosshair] = useState<{ x: number; y: number } | null>(null)
  const [overlays, setOverlays] = useState<{ x: number; y: number; w: number; h: number; color: string }[]>([])

  const [inspectResult, setInspectResult] = useState<any>(null)
  const [analyzeResult, setAnalyzeResult] = useState<any>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [rightTab, setRightTab] = useState<'inspector' | 'analyze' | 'wizard'>('inspector')

  // Wizard state — tag-based conditions with auto search
  const [wizardSearch, setWizardSearch] = useState('')
  const [wizardIncludes, setWizardIncludes] = useState<string[]>([])
  const [wizardExcludes, setWizardExcludes] = useState<string[]>([])
  const [wizardResults, setWizardResults] = useState<any>(null)
  const [wizardPreview, setWizardPreview] = useState<{ selector: string; items: any[] } | null>(null)
  const [wizardSearching, setWizardSearching] = useState(false)

  const [selectorInput, setSelectorInput] = useState('')
  const [selectorCount, setSelectorCount] = useState<string>('')

  const [output, setOutput] = useState<OutputEntry[]>([])
  const [badge, setBadge] = useState<'ok' | 'err' | null>(null)
  const [outputFilter, setOutputFilter] = useState('')
  const [execTime, setExecTime] = useState('')

  const [fileList, setFileList] = useState<{ path: string; size: number; type: 'file' | 'dir' }[]>([])
  const [showScaffold, setShowScaffold] = useState(false)
  const [watching, setWatching] = useState(false)
  const [spawnTesting, setSpawnTesting] = useState(false)
  const [providerConfig, setProviderConfig] = useState<any>(null)

  // Version detection
  const [versionInfo, setVersionInfo] = useState<Record<string, { installed: boolean; version: string | null; warning?: string }>>({})

  // #1 provider.json live editor + #6 validation
  const [validationResult, setValidationResult] = useState<{ valid: boolean; errors: string[]; warnings: string[] } | null>(null)
  const validationTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // #2 Settings preview
  const [settingsPreview, setSettingsPreview] = useState<Record<string, any> | null>(null)

  // #3 ACP chat test
  const [acpChatInput, setAcpChatInput] = useState('')
  const [acpChatHistory, setAcpChatHistory] = useState<{ role: 'user' | 'assistant' | 'error'; text: string; elapsed?: number }[]>([])
  const [acpChatLoading, setAcpChatLoading] = useState(false)

  // #4 Output diff
  const [prevOutput, setPrevOutput] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)

  // #5 Quick script params — dialog
  const [paramScript, setParamScript] = useState<string | null>(null)
  const [paramFields, setParamFields] = useState<Record<string, any>>({})
  const [scriptHints, setScriptHints] = useState<Record<string, { template: Record<string, any>; description: string }>>({})

  // Right panel tab for ACP/CLI
  const [acpRightTab, setAcpRightTab] = useState<'config' | 'settings' | 'chat' | 'validate'>('config')

  // Auto-Implement State
  const [showAutoImplDialog, setShowAutoImplDialog] = useState(false)
  const [autoImplAgent, setAutoImplAgent] = useState('claude-cli')
  const [autoImplReference, setAutoImplReference] = useState('antigravity')
  const [autoImplFunctions, setAutoImplFunctions] = useState<Record<string, boolean>>({
    readChat: true, sendMessage: true, resolveAction: true, listSessions: true, listModels: true, setModel: true, switchSession: true, newSession: true, focusEditor: true, openPanel: true, listModes: true, setMode: true
  })
  const [autoImplStatus, setAutoImplStatus] = useState<{ running: boolean; functions: string[]; message: string; logs: { event: string; data: any }[] } | null>(null)
  const autoImplSSERef = useRef<EventSource | null>(null)

  const outputRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const nextId = useRef(0)

  const selectedProvider = providers.find(p => p.type === provider)
  const providerCategory = selectedProvider?.category
  const isCdp = isCdpCategory(providerCategory)

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
    setAcpChatHistory([])
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

  // ─── Output ───
  const appendOutput = useCallback((text: string, type: OutputType) => {
    const entry: OutputEntry = { id: nextId.current++, time: ts(), icon: ICONS[type], text, type }
    setOutput(prev => {
      // #4 Save last result for diff
      const lastResult = prev.filter(e => e.type === 'result').pop()
      if (lastResult && type === 'result') setPrevOutput(lastResult.text)
      return [...prev, entry]
    })
    setTimeout(() => { outputRef.current?.scrollTo(0, outputRef.current.scrollHeight) }, 50)
  }, [])

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

  // ─── Screenshot ───
  const screenshotTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const doCapture = useCallback(async () => {
    const result = await api.screenshot(ideTarget || undefined)
    if (result) {
      // Revoke old blob URL to avoid memory leak
      if (screenshotUrl) URL.revokeObjectURL(screenshotUrl)
      setScreenshotUrl(result.url)
      setScreenshotVp({ w: result.vpW, h: result.vpH })
    }
  }, [ideTarget, screenshotUrl])

  async function takeScreenshot() {
    setCrosshair(null); setOverlays([])
    await doCapture()
  }

  function toggleLiveScreenshot() {
    if (liveScreenshot) {
      // Stop
      if (screenshotTimerRef.current) clearInterval(screenshotTimerRef.current)
      screenshotTimerRef.current = null
      setLiveScreenshot(false)
    } else {
      // Start
      doCapture()
      screenshotTimerRef.current = setInterval(doCapture, 2000)
      setLiveScreenshot(true)
    }
  }

  // Cleanup on unmount or provider change
  useEffect(() => {
    return () => {
      if (screenshotTimerRef.current) clearInterval(screenshotTimerRef.current)
    }
  }, [provider])

  // ─── Click-to-Inspect ───
  async function handleScreenshotClick(e: React.MouseEvent<HTMLImageElement>) {
    const img = imgRef.current
    const panel = (e.target as HTMLElement).closest('.screenshot-panel') as HTMLElement | null
    if (!img || !panel) return

    const panelRect = panel.getBoundingClientRect()
    const imgRect = img.getBoundingClientRect()

    // Click position within img
    const clickInImgX = e.clientX - imgRect.left
    const clickInImgY = e.clientY - imgRect.top
    if (clickInImgX < 0 || clickInImgY < 0 || clickInImgX > imgRect.width || clickInImgY > imgRect.height) return

    // Crosshair position relative to panel (simple, correct)
    setCrosshair({
      x: e.clientX - panelRect.left,
      y: e.clientY - panelRect.top
    })

    // Map to CSS viewport coordinates for elementFromPoint
    const vpW = screenshotVp.w || img.naturalWidth
    const vpH = screenshotVp.h || img.naturalHeight
    const px = Math.round((clickInImgX / imgRect.width) * vpW)
    const py = Math.round((clickInImgY / imgRect.height) * vpH)

    try {
      const result = await api.inspect({ x: px, y: py, ideType: ideTarget || undefined })
      if ((result as any).error) { appendOutput((result as any).error, 'error'); return }
      setInspectResult(result)
      setRightTab('inspector')
      const { element } = result as any
      appendOutput(`🔍 ${element.fullSelector}`, 'result'); setBadge('ok')
    } catch (err: any) { appendOutput('Inspect failed: ' + err.message, 'error') }
  }

  // ─── Analyze Element ───
  async function analyzeElement(selector?: string) {
    if (!selector && !inspectResult?.element?.fullSelector) {
      appendOutput('Click an element first, then analyze', 'warn')
      return
    }
    const sel = selector || inspectResult?.element?.fullSelector
    setAnalyzing(true)
    try {
      const result = await api.analyze({ selector: sel, ideType: ideTarget || undefined })
      setAnalyzeResult(result)
      setRightTab('analyze')
      const sibCount = result?.siblingPattern?.count || 0
      const ancestorCount = result?.ancestorAnalysis?.length || 0
      appendOutput(`🔬 Analyzed: ${sibCount > 0 ? `${sibCount} siblings found` : 'no sibling pattern'}, ${ancestorCount} ancestors scanned`, 'result')
    } catch (err: any) { appendOutput('Analyze failed: ' + err.message, 'error') }
    setAnalyzing(false)
  }

  function copySel(selector: string) {
    navigator.clipboard.writeText(selector)
    appendOutput(`📋 Copied: ${selector}`, 'log')
  }

  // ─── Wizard: Tag-based condition builder ───
  async function addCondition() {
    if (!wizardSearch.trim()) return
    const raw = wizardSearch.trim()
    const isExclude = raw.startsWith('!') || raw.startsWith('-')
    const text = isExclude ? raw.slice(1).trim() : raw
    if (!text) return

    const newIncludes = isExclude ? wizardIncludes : [...wizardIncludes, text]
    const newExcludes = isExclude ? [...wizardExcludes, text] : wizardExcludes
    if (isExclude) setWizardExcludes(newExcludes)
    else setWizardIncludes(newIncludes)
    setWizardSearch('')
    appendOutput(`${isExclude ? '❌' : '✅'} ${isExclude ? 'Exclude' : 'Include'}: "${text}"`, 'log')

    // Auto-query
    if (newIncludes.length > 0) {
      await runWizardQuery(newIncludes, newExcludes)
    }
  }

  function removeCondition(text: string, type: 'include' | 'exclude') {
    const newIncludes = type === 'include' ? wizardIncludes.filter(t => t !== text) : wizardIncludes
    const newExcludes = type === 'exclude' ? wizardExcludes.filter(t => t !== text) : wizardExcludes
    if (type === 'include') setWizardIncludes(newIncludes)
    else setWizardExcludes(newExcludes)

    if (newIncludes.length > 0) {
      runWizardQuery(newIncludes, newExcludes)
    } else {
      setWizardResults(null)
    }
  }

  async function runWizardQuery(inc: string[], exc: string[]) {
    setWizardSearching(true)
    try {
      const result = await api.findCommon(inc, exc, ideTarget || undefined)
      setWizardResults(result)
      appendOutput(`🔍 ${result?.results?.length || 0} common ancestors for ${inc.length} includes`, 'result')
    } catch (err: any) { appendOutput('Query failed: ' + err.message, 'error') }
    setWizardSearching(false)
  }

  // Test a selector — show children text as inline preview in wizard
  async function testSelector(selector: string) {
    try {
      const expr = `(() => {
        const parent = document.querySelector(${JSON.stringify(selector)});
        if (!parent) return JSON.stringify({ error: 'Not found' });
        const children = [...parent.children];
        const rendered = children.filter(c => (c.innerText || '').trim().length > 0);
        return JSON.stringify({
          parentTag: parent.tagName.toLowerCase(),
          childCount: children.length,
          renderedCount: rendered.length,
          rect: { w: Math.round(parent.getBoundingClientRect().width), h: Math.round(parent.getBoundingClientRect().height) },
          items: rendered.slice(0, 30).map((el, i) => {
            const text = (el.innerText || el.textContent || '').trim();
            return {
              index: i,
              tag: el.tagName.toLowerCase(),
              cls: (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).slice(0, 2).join(' ') : '',
              text: text.substring(0, 200),
              childCount: el.children.length,
              h: Math.round(el.getBoundingClientRect().height),
            };
          })
        });
      })()`
      const raw = await api.evaluate(expr, ideTarget || undefined, 5000) as any
      const result = typeof raw?.result === 'string' ? JSON.parse(raw.result) : raw?.result
      if (result?.error) {
        appendOutput('❌ ' + result.error, 'error')
        return
      }
      setWizardPreview({ selector, items: result.items || [] })
      const info = result.renderedCount < result.childCount
        ? `${result.childCount} total, ${result.renderedCount} rendered (virtual scroll)`
        : `${result.childCount} children`
      appendOutput(`▶ ${selector}: ${info}`, 'result')
    } catch (err: any) { appendOutput('Test failed: ' + err.message, 'error') }
  }

  // Insert evaluation code into editor
  function useInEditor(selector: string, childCount: number) {
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

  // #3 ACP/CLI Chat
  async function sendAcpChat() {
    if (!acpChatInput.trim() || !provider) return
    const msg = acpChatInput.trim()
    setAcpChatInput('')
    setAcpChatHistory(prev => [...prev, { role: 'user', text: msg }])
    setAcpChatLoading(true)
    try {
      // CLI provider: use /api/cli/send then poll debug for response
      if (selectedProvider?.category === 'cli') {
        const sendResult = await api.cliSend(provider, msg)
        if (!sendResult.sent) {
          setAcpChatHistory(prev => [...prev, { role: 'error', text: sendResult.error || 'CLI send failed' }])
          appendOutput(`❌ CLI send failed: ${sendResult.error}`, 'error')
        } else {
          appendOutput(`📤 Sent to ${provider}`, 'log')
          // Poll for completion (generating → idle)
          const start = Date.now()
          let response = '(generating...)'
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 1000))
            try {
              const dbg = await fetch(`/api/cli/debug/${provider}`).then(r => r.json())
              if (dbg.debug?.status === 'idle' && dbg.debug?.messageCount > 0) {
                const lastMsg = dbg.debug.messages?.[dbg.debug.messages.length - 1]
                if (lastMsg?.role === 'assistant') {
                  response = lastMsg.content || '(empty response)'
                }
                break
              }
            } catch { /* ignore */ }
          }
          const elapsed = Date.now() - start
          setAcpChatHistory(prev => [...prev, { role: 'assistant', text: response, elapsed }])
          appendOutput(`💬 [${elapsed}ms] ${response.substring(0, 200)}`, 'result')
        }
      } else {
        // ACP provider: use existing acpChat endpoint
        const result = await api.acpChat(provider, msg)
        if (result.success) {
          setAcpChatHistory(prev => [...prev, { role: 'assistant', text: result.response || '(no output)', elapsed: result.elapsed }])
          appendOutput(`💬 [${result.elapsed}ms] ${(result.response || '').substring(0, 200)}`, 'result')
        } else {
          setAcpChatHistory(prev => [...prev, { role: 'error', text: result.error || 'Failed', elapsed: result.elapsed }])
          appendOutput(`❌ Chat failed: ${result.error}`, 'error')
        }
      }
    } catch (e: any) {
      setAcpChatHistory(prev => [...prev, { role: 'error', text: e.message }])
      appendOutput(`❌ ${e.message}`, 'error')
    }
    setAcpChatLoading(false)
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

  // ─── Watch ───
  const eventSourceRef = useRef<EventSource | null>(null)
  async function toggleWatch() {
    if (watching) { await api.watchStop(); eventSourceRef.current?.close(); setWatching(false); return }
    if (!provider) { appendOutput('Select a provider first', 'warn'); return }
    await api.watchStart(provider, 'readChat'); setWatching(true)
    const es = new EventSource('/api/watch/events'); eventSourceRef.current = es
    es.onmessage = (e) => { try { const d = JSON.parse(e.data); if (d.type === 'watch_result') appendOutput(`[watch ${d.elapsed}ms] ${JSON.stringify(d.result, null, 2)}`, 'result'); else if (d.type === 'watch_error') appendOutput(`[watch] ${d.error}`, 'error') } catch {} }
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

  // ─── Scaffold ───
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
      setShowScaffold(false)
      refresh()
    } catch (e: any) { appendOutput(e.message, 'error') }
  }

  // ─── Auto-Implement ───
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
          refresh()
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

  async function verifyProviderRuntime() {
    if (!provider) { appendOutput('Select a provider first', 'warn'); return }
    if (!isCdp) { appendOutput('Runtime verification only supports CDP providers', 'warn'); return }
    appendOutput(`🔍 [Verify] Starting automated runtime verification for ${provider}...`, 'log')
    
    try {
      if (!cdpConnected) {
         appendOutput('❌ No CDP connection. Please ensure IDE is running.', 'error')
         return
      }

      appendOutput(`▶ [Verify] Running readChat script...`, 'log')
      const start = Date.now()
      const raw = await api.runScript(provider, 'readChat', undefined, ideTarget || undefined)
      let res = (raw as any)?.result !== undefined ? (raw as any).result : raw
      if (typeof res === 'string') {
        try { res = JSON.parse(res) } catch {}
      }
      
      let pass = true
      if (!res || typeof res !== 'object') {
        appendOutput(`❌ readChat did not return an object. Returned: ${typeof res}`, 'error')
        pass = false
      } else {
        appendOutput(`✅ readChat returned object in ${Date.now()-start}ms`, 'result')
        
        // Assert Messages Array
        if (!Array.isArray(res.messages)) {
          appendOutput(`❌ res.messages is not an array`, 'error')
          pass = false
        } else {
          appendOutput(`✅ Found ${res.messages.length} messages`, 'result')
          
          const parsedTypes: Record<string, number> = { standard: 0, thought: 0, terminal: 0, tool: 0 }
          let hasMissingFields = false
          res.messages.forEach((m: any) => {
             const kind = m.kind || 'standard'
             parsedTypes[kind] = (parsedTypes[kind] || 0) + 1
             if (!m.role || !m.content) hasMissingFields = true
          })
          
          if (hasMissingFields) {
             appendOutput(`❌ Some messages missing 'role' or 'content' fields`, 'error')
             pass = false
          }
          
          appendOutput(`📊 Message kinds: ${JSON.stringify(parsedTypes)}`, 'log')
          if (parsedTypes.thought === 0) appendOutput(`⚠️ No 'thought' blocks found (may be normal if not used)`, 'warn')
          if (parsedTypes.tool === 0) appendOutput(`⚠️ No 'tool' blocks found (may be normal if not used)`, 'warn')
          
          if (res.messages.length > 0) {
            const lastMsg = res.messages[res.messages.length - 1]
            appendOutput(`📝 Latest msg preview (${lastMsg.role}):\n${lastMsg.content.slice(0, 150)}...`, 'log')
          }
        }
        
        // Assert Status
        if (!res.status) {
           appendOutput(`❌ res.status is missing`, 'error')
           pass = false
        } else {
           appendOutput(`✅ Status field found: ${res.status}`, 'result')
        }
      }

      if (pass) {
        appendOutput(`🎉 Runtime Verification Passed! The readChat output is correctly normalized.`, 'result')
        setBadge('ok')
      } else {
        appendOutput(`💥 Runtime Verification Failed. Please fix the provider's readChat script.`, 'error')
        setBadge('err')
      }
    } catch(e: any) {
      appendOutput(`❌ Verification exception: ${e.message}`, 'error')
      setBadge('err')
    }
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
          <button onClick={verifyProviderRuntime} style={{ background: 'var(--accent-yellow)', color: '#000', borderColor: 'var(--accent-yellow)', marginLeft: 8, fontWeight: 600 }}>
            ✅ Verify
          </button>
          </>
        )}

        <div className="spacer" />
        <div className={`watch-indicator ${watching ? 'active' : ''}`}>● Watch</div>
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
            <div className="file-tree">
              {/* Scripts Section */}
              {isCdp && (selectedProvider?.scripts || []).length > 0 && (
                <div className="ft-section">
                  <div className="ft-section-header">⚡ SCRIPTS</div>
                  {(selectedProvider?.scripts || []).map(s => (
                    <div key={s} className={`ft-item ft-script`}>
                      <span className="ft-name">{s}</span>
                      <div className="ft-actions always">
                        <button className="ft-run" onClick={() => runScript(s)} title="Run">▶</button>
                        <button className="ft-params" onClick={() => openParamDialog(s)} title={scriptHints[s]?.description || 'Run with params'}>⚙</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {/* Files Section */}
              <div className="ft-section">
                <div className="ft-section-header">
                  📂 FILES
                  <button className="ft-new-btn" onClick={() => {
                    const name = prompt('New file name (e.g. scripts/my_script.js):')
                    if (name) {
                      api.writeFile(provider, name, name.endsWith('.json') ? '{}\n' : '// ' + name + '\n').then(() => {
                        api.listFiles(provider).then(r => setFileList(r.files || []))
                        loadFile(name)
                        appendOutput(`✨ Created: ${name}`, 'log')
                      }).catch(e => appendOutput(e.message, 'error'))
                    }
                  }} title="New file">＋</button>
                </div>
                {fileList.length === 0 && <div className="ft-empty">No files found</div>}
                {/* Root files */}
                {fileList.filter(f => f.type === 'file' && !f.path.includes('/')).map(f => (
                  <div key={f.path} className={`ft-item ${activeFile === f.path ? 'active' : ''}`} onClick={() => loadFile(f.path)}>
                    <span className="ft-icon">{f.path.endsWith('.json') ? '📋' : '📄'}</span>
                    <span className="ft-name">{f.path}</span>
                    <span className="ft-size">{f.size > 1024 ? (f.size / 1024).toFixed(1) + 'K' : f.size + 'B'}</span>
                  </div>
                ))}
                {/* Grouped folders */}
                {[...new Set(fileList.filter(f => f.path.includes('/')).map(f => f.path.split('/')[0]))].map(folder => (
                  <details key={folder} open>
                    <summary className="ft-folder">📁 {folder}/</summary>
                    {fileList.filter(f => f.type === 'file' && f.path.startsWith(folder + '/')).map(f => {
                      const fileName = f.path.split('/').pop() || f.path
                      return (
                        <div key={f.path} className={`ft-item ft-nested ${activeFile === f.path ? 'active' : ''}`} onClick={() => loadFile(f.path)}>
                          <span className="ft-icon">📄</span>
                          <span className="ft-name">{fileName}</span>
                          <span className="ft-size">{f.size > 1024 ? (f.size / 1024).toFixed(1) + 'K' : f.size + 'B'}</span>
                        </div>
                      )
                    })}
                  </details>
                ))}
              </div>
            </div>
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
          {/* CDP mode: Screenshot + Selector */}
          {isCdp ? (
            <>
              <div className="screenshot-panel" id="screenshotPanel">
                {screenshotUrl ? (
                  <>
                    <img ref={imgRef} src={screenshotUrl} onClick={handleScreenshotClick} alt="IDE Screenshot" />
                    {crosshair && <div className="crosshair" style={{ left: crosshair.x, top: crosshair.y }} />}
                    {overlays.map((o, i) => (
                      <div key={i} className="overlay" style={{ left: o.x, top: o.y, width: o.w, height: o.h, borderColor: o.color }}>
                        <span className="label" style={{ background: o.color }}>{i}</span>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="placeholder">
                    Click 📸 to capture IDE<br />
                    <small>Then click on screenshot to inspect elements</small>
                  </div>
                )}
              </div>
              <div className="selector-bar">
                <input value={selectorInput} onChange={e => setSelectorInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && querySel()} placeholder="CSS selector to test..." />
                <button onClick={querySel}>Query</button>
                <span className="count">{selectorCount}</span>
              </div>

              {/* Inspector / Analyzer / Wizard Tabs */}
              <div className="inspect-tabs">
                <button className={rightTab === 'inspector' ? 'active' : ''} onClick={() => setRightTab('inspector')}>🌳 Inspector</button>
                <button className={rightTab === 'analyze' ? 'active' : ''} onClick={() => setRightTab('analyze')}>🔬 Analyze</button>
                <button className={rightTab === 'wizard' ? 'active' : ''} onClick={() => setRightTab('wizard')}>🧙 Wizard</button>
              </div>

              {/* Inspector Tree */}
              {rightTab === 'inspector' && inspectResult && (
                <div className="dom-tree">
                  {/* Ancestors */}
                  {inspectResult.ancestors?.map((a: any, i: number) => (
                    <div key={i} className="tree-node ancestor" style={{ paddingLeft: i * 12 + 4 }}>
                      <span className="tree-tag">&lt;{a.tag}&gt;</span>
                      {a.cls?.length > 0 && <span className="tree-cls">.{a.cls.join('.')}</span>}
                      <button className="tree-copy" onClick={() => copySel(a.selector)} title="Copy selector">📋</button>
                    </div>
                  ))}
                  {/* Current element */}
                  <div className="tree-node current" style={{ paddingLeft: (inspectResult.ancestors?.length || 0) * 12 + 4 }}>
                    <span className="tree-tag">&lt;{inspectResult.element?.tag}&gt;</span>
                    {inspectResult.element?.cls?.length > 0 && <span className="tree-cls">.{inspectResult.element.cls.join('.')}</span>}
                    {inspectResult.element?.rect && <span className="tree-size">{inspectResult.element.rect.w}×{inspectResult.element.rect.h}</span>}
                    <button className="tree-copy" onClick={() => copySel(inspectResult.element?.fullSelector || '')} title="Copy full selector">📋</button>
                    {inspectResult.element?.directText && (
                      <div className="tree-text">"{inspectResult.element.directText.substring(0, 60)}"</div>
                    )}
                  </div>
                  {/* Children */}
                  {inspectResult.children?.slice(0, 15).map((c: any, i: number) => (
                    <div key={i} className="tree-node child" style={{ paddingLeft: ((inspectResult.ancestors?.length || 0) + 1) * 12 + 4 }}>
                      <span className="tree-tag">&lt;{c.tag}&gt;</span>
                      {c.cls?.length > 0 && <span className="tree-cls">.{c.cls.slice(0, 2).join('.')}</span>}
                      {c.childCount > 0 && <span className="tree-count">({c.childCount})</span>}
                      <button className="tree-copy" onClick={() => copySel(c.selector)} title="Copy selector">📋</button>
                      {c.directText && <span className="tree-inline-text">{c.directText.substring(0, 40)}</span>}
                    </div>
                  ))}
                </div>
              )}

              {/* Analyze Results — element-focused */}
              {rightTab === 'analyze' && analyzeResult && !analyzeResult.error && (
                <div className="analyze-results">
                  {/* Target */}
                  <div className="analyze-section">
                    <div className="analyze-title">🎯 Target</div>
                    <div className="analyze-item">
                      <div className="analyze-sel">
                        <code>{analyzeResult.target?.selector}</code>
                        <button className="tree-copy" onClick={() => copySel(analyzeResult.target?.selector || '')}>📋</button>
                      </div>
                      {analyzeResult.target?.text && <div className="analyze-sample">"{analyzeResult.target.text.substring(0, 100)}"</div>}
                    </div>
                  </div>

                  {/* Sibling Pattern */}
                  {analyzeResult.siblingPattern && (
                    <div className="analyze-section">
                      <div className="analyze-title">🔁 Sibling Pattern — {analyzeResult.siblingPattern.count} matches (depth {analyzeResult.siblingPattern.depthFromTarget})</div>
                      <div className="analyze-item">
                        <div className="analyze-sel">
                          <code>{analyzeResult.siblingPattern.selector}</code>
                          <button className="tree-copy" onClick={() => copySel(analyzeResult.siblingPattern.selector)}>📋</button>
                        </div>
                      </div>
                      {/* Common/varying attrs */}
                      {Object.keys(analyzeResult.siblingPattern.varyingAttrs || {}).length > 0 && (
                        <div style={{ fontSize: 10, color: 'var(--text-dim)', padding: '2px 8px' }}>
                          Varying: {Object.entries(analyzeResult.siblingPattern.varyingAttrs).map(([k, v]) =>
                            `${k}=[${(v as string[]).slice(0, 3).join(', ')}${(v as string[]).length > 3 ? '...' : ''}]`
                          ).join(', ')}
                        </div>
                      )}
                      {/* Sibling texts */}
                      {analyzeResult.siblingPattern.siblings?.slice(0, 15).map((s: any, i: number) => (
                        <div key={i} className="analyze-item" style={{ paddingLeft: 8, borderLeft: '2px solid var(--border)' }}>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <span style={{ color: 'var(--text-dim)', fontSize: 10, minWidth: 20 }}>#{s.index}</span>
                            <span style={{ color: '#e5c07b', fontSize: 10 }}>&lt;{s.tag}&gt;</span>
                            {s.childCount > 0 && <span className="tree-count">({s.childCount})</span>}
                          </div>
                          {s.allText && <div className="analyze-sample" style={{ paddingLeft: 24 }}>"{s.allText.substring(0, 120)}"</div>}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Ancestor Analysis */}
                  {analyzeResult.ancestorAnalysis?.length > 0 && (
                    <div className="analyze-section">
                      <div className="analyze-title">⬆️ Ancestor Chain</div>
                      {analyzeResult.ancestorAnalysis.map((a: any, i: number) => (
                        <div key={i} className="analyze-item" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span style={{ color: 'var(--text-dim)', fontSize: 10, minWidth: 14 }}>↑{a.depth}</span>
                          <code style={{ fontSize: 10, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.fullSelector}</code>
                          <span style={{ color: a.matchingSiblings >= 3 ? 'var(--accent-green)' : 'var(--text-dim)', fontSize: 10, whiteSpace: 'nowrap' }}>
                            {a.matchingSiblings}/{a.totalChildren}
                          </span>
                          {a.matchingSiblings >= 3 && (
                            <button className="tree-copy" onClick={() => { copySel(a.fullSelector); analyzeElement(a.fullSelector); }} title="Analyze this level"
                              style={{ fontSize: 10, opacity: 0.7, background: 'none', border: 'none', cursor: 'pointer' }}>🔬</button>
                          )}
                          <button className="tree-copy" onClick={() => copySel(a.fullSelector)}>📋</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Subtree Texts */}
                  {analyzeResult.subtreeTexts?.length > 0 && (
                    <div className="analyze-section">
                      <div className="analyze-title">📝 Text Nodes ({analyzeResult.subtreeTexts.length})</div>
                      {analyzeResult.subtreeTexts.slice(0, 15).map((t: any, i: number) => (
                        <div key={i} className="analyze-item" style={{ display: 'flex', gap: 4 }}>
                          <span className="tree-tag" style={{ fontSize: 10 }}>&lt;{t.parentTag}&gt;</span>
                          <span className="analyze-sample" style={{ flex: 1, paddingLeft: 0 }}>"{t.text}"</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {rightTab === 'inspector' && !inspectResult && (
                <div className="placeholder" style={{ padding: 20 }}>
                  Click on screenshot to inspect DOM elements
                </div>
              )}
              {rightTab === 'analyze' && !analyzeResult && (
                <div className="placeholder" style={{ padding: 20 }}>
                  Click an element first, then 🔬 Analyze
                </div>
              )}

              {/* Wizard Tab */}
              {rightTab === 'wizard' && (
                <div className="analyze-results">
                  {/* Condition Builder */}
                  <div className="analyze-section">
                    <div className="analyze-title">🧙 Selector Finder</div>

                    {/* Condition tags */}
                    {(wizardIncludes.length > 0 || wizardExcludes.length > 0) && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: '3px 0' }}>
                        {wizardIncludes.map((t, i) => (
                          <span key={'i' + i} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 3,
                            padding: '1px 6px', borderRadius: 8, fontSize: 10,
                            background: 'rgba(152,195,121,0.15)', color: 'var(--accent-green)',
                            border: '1px solid rgba(152,195,121,0.3)',
                          }}>
                            ✓ {t}
                            <button onClick={() => removeCondition(t, 'include')} style={{
                              background: 'none', border: 'none', color: 'var(--accent-green)', 
                              cursor: 'pointer', padding: 0, fontSize: 10, lineHeight: 1,
                            }}>×</button>
                          </span>
                        ))}
                        {wizardExcludes.map((t, i) => (
                          <span key={'e' + i} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 3,
                            padding: '1px 6px', borderRadius: 8, fontSize: 10,
                            background: 'rgba(224,108,117,0.15)', color: '#e06c75',
                            border: '1px solid rgba(224,108,117,0.3)',
                          }}>
                            ✗ {t}
                            <button onClick={() => removeCondition(t, 'exclude')} style={{
                              background: 'none', border: 'none', color: '#e06c75',
                              cursor: 'pointer', padding: 0, fontSize: 10, lineHeight: 1,
                            }}>×</button>
                          </span>
                        ))}
                        <button onClick={() => { setWizardIncludes([]); setWizardExcludes([]); setWizardResults(null); }}
                          style={{ fontSize: 9, padding: '0 4px', background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 8, cursor: 'pointer' }}>
                          clear
                        </button>
                      </div>
                    )}

                    {/* Input */}
                    <div style={{ display: 'flex', gap: 4, padding: '3px 0' }}>
                      <input
                        value={wizardSearch}
                        onChange={e => setWizardSearch(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && addCondition()}
                        placeholder="text to include, !text to exclude"
                        style={{ flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', padding: '5px 8px', borderRadius: 4, fontSize: 11, fontFamily: 'inherit' }}
                      />
                      <button onClick={addCondition} disabled={wizardSearching} style={{ fontSize: 10, padding: '3px 8px' }}>
                        {wizardSearching ? '⏳' : '+ Add'}
                      </button>
                    </div>
                  </div>

                  {/* Results */}
                  {wizardResults?.results?.length > 0 && (
                    <div className="analyze-section">
                      <div className="analyze-title" style={{ color: 'var(--accent-green)' }}>
                        Common Ancestors ({wizardResults.results.length})
                        <span style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 400, marginLeft: 6 }}>
                          lists first
                        </span>
                      </div>
                      {wizardResults.results.slice(0, 10).map((r: any, i: number) => (
                        <div key={i} className="analyze-item" style={{
                          padding: '4px 0', borderBottom: '1px solid var(--border)',
                          borderLeft: r.isList ? '2px solid var(--accent-green)' : 'none',
                          paddingLeft: r.isList ? 6 : 0,
                        }}>
                          {/* Selector + meta */}
                          <div className="analyze-sel">
                            <code title={r.selector} style={{ fontSize: 9 }}>{r.selector}</code>
                          </div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 9, color: 'var(--text-dim)', padding: '1px 0' }}>
                            <span>&lt;{r.tag}&gt;</span>
                            {r.isList && <span style={{ color: 'var(--accent-green)', fontWeight: 600 }}>📋 list: {r.listItemCount} items</span>}
                            {!r.isList && <span>{r.childCount} children</span>}
                            {r.placeholderCount > 0 && <span style={{ color: '#e5c07b' }}>👁 {r.renderedCount} visible</span>}
                            <span>{r.rect.w}×{r.rect.h}</span>
                          </div>

                          {/* Virtual scroll notice */}
                          {r.placeholderCount > 0 && r.renderedCount <= 3 && (
                            <div style={{ fontSize: 8, color: '#e5c07b', padding: '2px 4px', background: 'rgba(229,192,123,0.1)', borderRadius: 3, marginTop: 2 }}>
                              ⚠ Virtual scroll: {r.listItemCount} total, only {r.renderedCount} rendered in DOM. Scroll to load more.
                            </div>
                          )}

                          {/* Item text samples — show like readChat output */}
                          {r.items?.length > 0 && (
                            <div style={{ paddingLeft: 4, maxHeight: 100, overflow: 'auto' }}>
                              {r.items.slice(0, 8).map((item: any, ii: number) => (
                                <div key={ii} style={{ fontSize: 8, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  <span style={{ color: 'var(--accent)', minWidth: 14, display: 'inline-block' }}>[{item.index}]</span>
                                  <span style={{ color: '#e06c75' }}>&lt;{item.tag}&gt;</span> {item.text ? `"${item.text.substring(0, 100)}"` : '(empty)'}
                                </div>
                              ))}
                              {r.items.length > 8 && (
                                <div style={{ fontSize: 8, color: 'var(--text-dim)' }}>...{r.items.length - 8} more</div>
                              )}
                            </div>
                          )}

                          {/* Action buttons */}
                          <div style={{ display: 'flex', gap: 4, paddingTop: 2 }}>
                            <button onClick={() => testSelector(r.selector)}
                              style={{ fontSize: 9, padding: '1px 6px', background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--accent-green)', borderRadius: 3, cursor: 'pointer' }}>
                              ▶ Test
                            </button>
                            <button onClick={() => useInEditor(r.selector, r.childCount)}
                              style={{ fontSize: 9, padding: '1px 6px', background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--accent)', borderRadius: 3, cursor: 'pointer' }}>
                              → Code
                            </button>
                            <button className="tree-copy" onClick={() => copySel(r.selector)} style={{ opacity: 0.7, fontSize: 9 }}>📋</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {wizardIncludes.length === 1 && (!wizardResults || wizardResults?.results?.length === 0) && (
                    <div className="analyze-section">
                      <div className="analyze-title" style={{ color: 'var(--accent)' }}>➕ Add one more text</div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                        Add text from a <b>different item in the same list</b> to find the common container.<br/>
                        e.g. text from another chat message, another menu item, etc.
                      </div>
                    </div>
                  )}

                  {wizardResults?.results?.length === 0 && wizardIncludes.length >= 2 && (
                    <div className="analyze-section">
                      <div className="analyze-title">⚠️ No common ancestors found</div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                        The texts might be in completely different DOM areas. Try text from the same UI section.
                      </div>
                    </div>
                  )}

                  {/* Inline Preview — shows after ▶ Test */}
                  {wizardPreview && (
                    <div className="analyze-section" style={{ borderLeft: '2px solid var(--accent-green)' }}>
                      <div className="analyze-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>📋 Preview: {wizardPreview.items.length} children</span>
                        <button onClick={() => setWizardPreview(null)}
                          style={{ fontSize: 9, background: 'none', border: 'none', color: '#e06c75', cursor: 'pointer' }}>✕</button>
                      </div>
                      <div style={{ fontSize: 8, color: 'var(--text-dim)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {wizardPreview.selector}
                      </div>
                      <div style={{ maxHeight: 250, overflow: 'auto' }}>
                        {wizardPreview.items.map((item: any, i: number) => (
                          <div key={i} style={{
                            padding: '2px 4px', fontSize: 9,
                            borderBottom: '1px solid var(--border)',
                            background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                          }}>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'baseline' }}>
                              <span style={{ color: 'var(--accent)', minWidth: 16 }}>[{item.index}]</span>
                              <span style={{ color: '#e06c75', minWidth: 30 }}>&lt;{item.tag}&gt;</span>
                              {item.cls && <span style={{ color: 'var(--text-dim)', fontSize: 8 }}>.{item.cls.split(' ')[0]}</span>}
                              <span style={{ color: 'var(--text-dim)', fontSize: 8 }}>{item.h}px</span>
                            </div>
                            <div style={{
                              color: 'var(--text)', paddingLeft: 16,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              maxWidth: '100%', fontSize: 9,
                            }}>
                              {item.text ? `"${item.text.substring(0, 120)}"` : <span style={{ color: 'var(--text-dim)' }}>(empty)</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Guide */}
                  {wizardIncludes.length === 0 && wizardExcludes.length === 0 && (
                    <div className="analyze-section">
                      <div className="analyze-title">📖 How to Use</div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.8 }}>
                        <b>Include:</b> Type visible text → Enter<br/>
                        <b>Exclude:</b> Prefix with <code>!</code> → Enter<br/><br/>
                        <b>Example — find chat container:</b><br/>
                        1. Add text from one message<br/>
                        2. Add text from another message<br/>
                        3. → Common Ancestors shows the chat container<br/>
                        4. ▶ Test to verify, → Code to insert template
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            /* ACP/CLI mode: Tabbed Panel */
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
                    {(['config', 'settings', 'chat', 'validate'] as const).map(tab => (
                      <button key={tab} onClick={() => setAcpRightTab(tab)} style={{
                        padding: '4px 10px', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                        background: 'none', border: 'none', borderBottom: acpRightTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                        color: acpRightTab === tab ? 'var(--accent)' : 'var(--text-dim)',
                      }}>
                        {tab === 'config' ? '📋 Config' : tab === 'settings' ? '⚙️ Settings' : tab === 'chat' ? '💬 Chat' : '🔍 Validate'}
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
                        {acpChatHistory.length === 0 && (
                          <div className="placeholder" style={{ padding: 20 }}>
                            Send a message to test the {selectedProvider.category.toUpperCase()} agent.
                            <br /><small>Messages are sent via spawn command + args.</small>
                          </div>
                        )}
                        {acpChatHistory.map((msg, i) => (
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
                        {acpChatLoading && <div style={{ padding: 8, fontSize: 11, color: 'var(--text-dim)' }}>⏳ Waiting for response...</div>}
                      </div>
                      <div style={{ display: 'flex', gap: 4, padding: 4, borderTop: '1px solid var(--border)' }}>
                        <input
                          value={acpChatInput}
                          onChange={e => setAcpChatInput(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendAcpChat()}
                          placeholder="Type message..."
                          disabled={acpChatLoading}
                          style={{ flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', padding: '5px 8px', borderRadius: 4, fontSize: 11, fontFamily: 'inherit' }}
                        />
                        <button onClick={sendAcpChat} disabled={acpChatLoading || !acpChatInput.trim()} style={{
                          background: 'var(--accent)', color: '#000', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                          opacity: acpChatLoading || !acpChatInput.trim() ? 0.4 : 1,
                        }}>Send</button>
                        {acpChatHistory.length > 0 && (
                          <button onClick={() => setAcpChatHistory([])} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 4, padding: '4px 6px', fontSize: 9, cursor: 'pointer' }}>Clear</button>
                        )}
                      </div>
                    </div>
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
                        <button onClick={async () => {
                          try {
                            const content = activeFile === 'provider.json' ? editorCode : (await api.readFile(provider, 'provider.json')).content
                            const result = await api.validate(provider, content)
                            setValidationResult(result)
                            appendOutput(`🔍 Validation: ${result.valid ? '✅ Valid' : `❌ ${result.errors.length} errors`}${result.warnings.length > 0 ? `, ⚠ ${result.warnings.length} warnings` : ''}`, result.valid ? 'result' : 'error')
                          } catch (e: any) { appendOutput(e.message, 'error') }
                        }} style={{ marginTop: 8, width: '100%', padding: '5px', fontSize: 10, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 4, cursor: 'pointer' }}>
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
          )}

          {/* Output Panel (always visible) */}
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
                onClick={() => { setOutput([]); setBadge(null); setPrevOutput(null); setShowDiff(false) }}>Clear</button>
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
        </div>
      </div>

      {/* Scaffold Modal */}
      {/* Script Params Dialog */}
      {paramScript && (
        <div className="modal-overlay" onClick={() => setParamScript(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <h3 style={{ marginBottom: 4 }}>⚡ {paramScript}</h3>
            {scriptHints[paramScript]?.description && (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
                {scriptHints[paramScript].description}
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
                        const newVal = typeof scriptHints[paramScript!]?.template[key] === 'number'
                          ? (e.target.value === '' ? 0 : Number(e.target.value))
                          : e.target.value
                        setParamFields(prev => ({ ...prev, [key]: newVal }))
                      }}
                      onKeyDown={e => e.key === 'Enter' && runScriptWithParams(paramScript!)}
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
              <button onClick={() => setParamScript(null)} style={{ padding: '8px 16px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-dim)', cursor: 'pointer' }}>Cancel</button>
              <button
                onClick={() => runScriptWithParams(paramScript!)}
                style={{ padding: '8px 16px', background: 'var(--accent-green)', color: '#000', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}
              >▶ Run</button>
            </div>
          </div>
        </div>
      )}

      {showScaffold && (
        <div className="modal-overlay" onClick={() => setShowScaffold(false)}>
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
                <button onClick={() => setShowScaffold(false)} style={{ padding: '8px 16px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-dim)', cursor: 'pointer' }}>Cancel</button>
                <button onClick={doScaffold} disabled={!scaffoldType || !scaffoldName} style={{ padding: '8px 16px', background: !scaffoldType || !scaffoldName ? 'var(--border)' : 'var(--accent)', color: '#000', border: 'none', borderRadius: 6, fontWeight: 600, cursor: !scaffoldType || !scaffoldName ? 'default' : 'pointer', opacity: !scaffoldType || !scaffoldName ? 0.5 : 1 }}>Create</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Auto-Implement Dialog ─── */}
      {showAutoImplDialog && (
        <div className="modal-overlay" onClick={() => !autoImplStatus?.running && setShowAutoImplDialog(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 500, maxWidth: '90vw' }}>
            <h3 style={{ marginBottom: 12 }}>🤖 Auto-Implement: {selectedProvider?.name || provider}</h3>
            
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
                    <button className="primary" onClick={() => { setShowAutoImplDialog(false); setAutoImplStatus(null) }}>Close</button>
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
                  <button onClick={() => setShowAutoImplDialog(false)}>Cancel</button>
                  <button className="primary" onClick={doAutoImpl}>🚀 Start Auto-Implement</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}


    </>
  )
}
