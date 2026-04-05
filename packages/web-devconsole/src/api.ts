const API = '/api'

export interface ProviderInfo {
  type: string
  name: string
  category: 'ide' | 'extension' | 'cli' | 'acp'
  icon: string | null
  displayName: string
  // IDE/Extension
  scripts?: string[]
  inputMethod?: string | null
  inputSelector?: string | null
  extensionId?: string | null
  cdpPorts?: number[]
  // ACP/CLI
  spawn?: { command: string; args?: string[]; shell?: boolean } | null
  auth?: { type: string; id: string; name: string; description: string }[] | null
  install?: string | null
  hasSettings?: boolean
  settingsCount?: number
}

export interface CdpTarget {
  ide: string
  connected: boolean
  port: number
}

export interface DevStatus {
  devMode: boolean
  providers: { type: string; name: string; category: string }[]
  cdp: Record<string, { connected: boolean }>
  uptime: number
}

export interface CliTraceEntry {
  id: number
  at: number
  type: string
  status: string
  isWaitingForResponse: boolean
  activeModal: { message: string; buttons: string[] } | null
  payload: Record<string, any>
}

export interface CliTraceResponse {
  instanceId: string
  providerState: {
    type: string
    name: string
    status: string
    mode?: string
  }
  debug: Record<string, any> | null
  trace: {
    sessionId: string
    entryCount: number
    entries: CliTraceEntry[]
    screenText: string
    recentOutputBuffer: string
    responseBuffer: string
    status: string
    activeModal: { message: string; buttons: string[] } | null
    currentTurnScope: {
      prompt: string
      startedAt: number
      bufferStart: number
      rawBufferStart: number
    } | null
    messages: { role: string; content: string; timestamp?: number }[]
  } | null
  message?: string
}

export interface CliExerciseResponse {
  exercised: boolean
  instanceId: string
  providerState: {
    type: string
    name: string
    status: string
    mode?: string
  }
  initialDebug: Record<string, any> | null
  initialTrace: CliTraceResponse['trace'] | null
  debug: Record<string, any> | null
  trace: CliTraceResponse['trace'] | null
  statusesSeen: string[]
  approvalsResolved: { at: number; buttonIndex: number; label: string | null }[]
  elapsedMs: number
  timedOut: boolean
  error?: string
}

export interface CliFixtureInfo {
  name: string
  path: string
  createdAt: string | null
  notes: string | null
  requestText: string
  assertions: {
    mustContainAny?: string[]
    mustNotContainAny?: string[]
    statusesSeen?: string[]
    requireNotTimedOut?: boolean
  }
}

export interface CliFixtureCaptureResponse {
  saved: boolean
  name: string
  path: string
  fixture: Record<string, any>
  verification: {
    pass: boolean
    failures: string[]
  }
  error?: string
}

export interface CliFixtureReplayResponse {
  replayed: boolean
  pass: boolean
  failures: string[]
  fixture: Record<string, any>
  result: CliExerciseResponse
  assertions: Record<string, any>
  error?: string
}

export interface DomQueryResult {
  total: number
  results: {
    index: number; tag: string; id: string | null; class: string | null
    role: string | null; text: string; visible: boolean
    rect: { x: number; y: number; w: number; h: number } | null
  }[]
}

export interface InspectResult {
  element: {
    tag: string; cls: string[]; attrs: Record<string, string>
    text: string; directText: string; childCount: number
    selector: string; fullSelector: string
    rect: { x: number; y: number; w: number; h: number } | null
  }
  ancestors: { tag: string; selector: string; cls: string[] }[]
  children: {
    tag: string; cls: string[]; attrs: Record<string, string>
    directText: string; childCount: number; selector: string
    rect: { x: number; y: number; w: number; h: number } | null
  }[]
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(API + path, opts)
  return res.json()
}

export const api = {
  getProviders: () => request<{ providers: ProviderInfo[]; count: number }>('/providers'),
  getTargets: () => request<{ targets: CdpTarget[] }>('/cdp/targets'),
  getStatus: () => request<DevStatus>('/status'),

  runScript: (type: string, script: string, params?: unknown, ideType?: string) =>
    request<{ type: string; script: string; result: unknown }>(`/providers/${type}/script`, 'POST', {
      script, params: params || {}, ideType,
    }),

  evaluate: (expression: string, ideType?: string, timeout = 30000) =>
    request<{ result: unknown }>('/cdp/evaluate', 'POST', { expression, timeout, ideType }),

  querySelector: (selector: string, limit = 20, ideType?: string) =>
    request<DomQueryResult>('/cdp/dom/query', 'POST', { selector, limit, ideType }),

  inspect: (opts: { x?: number; y?: number; selector?: string; ideType?: string }) =>
    request<InspectResult>('/cdp/dom/inspect', 'POST', opts),

  children: (selector: string, ideType?: string) =>
    request<any>('/cdp/dom/children', 'POST', { selector, ideType }),

  analyze: (opts: { selector?: string; x?: number; y?: number; ideType?: string }) =>
    request<any>('/cdp/dom/analyze', 'POST', opts),

  findByText: (text: string, ideType?: string, containerSelector?: string) =>
    request<any>('/cdp/dom/find-text', 'POST', { text, ideType, containerSelector }),

  findCommon: (include: string[], exclude: string[], ideType?: string) =>
    request<any>('/cdp/dom/find-common', 'POST', { include, exclude, ideType }),

  screenshot: async (ideType?: string): Promise<{ url: string; vpW: number; vpH: number } | null> => {
    const apiUrl = API + '/cdp/screenshot' + (ideType ? '?ideType=' + ideType : '')
    const res = await fetch(apiUrl)
    if (!res.ok) return null
    const vpW = parseInt(res.headers.get('X-Viewport-Width') || '0', 10)
    const vpH = parseInt(res.headers.get('X-Viewport-Height') || '0', 10)
    const blob = await res.blob()
    return { url: URL.createObjectURL(blob), vpW, vpH }
  },

  getSource: (type: string) =>
    request<{ type: string; path: string; source: string; lines: number }>(`/providers/${type}/source`),

  saveSource: (type: string, source: string) =>
    request<{ saved: boolean; path: string }>(`/providers/${type}/save`, 'POST', { source }),

  saveScript: (type: string, script: string, code: string) =>
    request<{ saved: boolean; script: string; path: string }>(`/providers/${type}/script-save`, 'POST', { script, code }),

  reload: () => request<{ reloaded: boolean; providers: unknown[] }>('/providers/reload', 'POST'),

  scaffold: (opts: { type: string; name: string; category: string; [k: string]: unknown }) =>
    request<{ created: boolean; path: string }>('/scaffold', 'POST', opts),

  watchStart: (type: string, script: string, interval = 2000) =>
    request<{ watching: boolean }>('/watch/start', 'POST', { type, script, interval }),

  watchStop: () => request<{ watching: boolean }>('/watch/stop', 'POST'),

  getConfig: (type: string) =>
    request<{ type: string; config: any }>(`/providers/${type}/config`),

  spawnTest: (type: string) =>
    request<{ success: boolean; command: string; elapsed: number; stdout?: string; stderr?: string; error?: string; exitCode?: number | null }>(`/providers/${type}/spawn-test`, 'POST'),

  listFiles: (type: string) =>
    request<{ type: string; dir: string; files: { path: string; size: number; type: 'file' | 'dir' }[] }>(`/providers/${type}/files`),

  readFile: (type: string, filePath: string) =>
    request<{ type: string; path: string; content: string; lines: number }>(`/providers/${type}/file?path=${encodeURIComponent(filePath)}`),

  writeFile: (type: string, filePath: string, content: string) =>
    request<{ saved: boolean; path: string; chars: number }>(`/providers/${type}/file`, 'POST', { path: filePath, content }),

  validate: (type: string, content: string) =>
    request<{ valid: boolean; errors: string[]; warnings: string[] }>(`/providers/${type}/validate`, 'POST', { content }),

  acpChat: (type: string, message: string, timeout = 30000) =>
    request<{ success: boolean; response?: string; error?: string; elapsed: number; exitCode?: number | null }>(`/providers/${type}/acp-chat`, 'POST', { message, timeout }),

  cliSend: (type: string, text: string) =>
    request<{ sent: boolean; type: string; instanceId?: string; error?: string }>('/api/cli/send', 'POST', { type, text }),

  cliLaunch: (type: string, workingDir?: string, args?: string[]) =>
    request<{ launched: boolean; type: string; workspace: string; error?: string }>('/api/cli/launch', 'POST', { type, workingDir, args }),

  cliStop: (type: string, instanceId?: string) =>
    request<{ stopped: boolean; type: string; instanceId?: string; error?: string }>('/api/cli/stop', 'POST', { type, instanceId }),

  cliResolve: (type: string, buttonIndex: number, instanceId?: string) =>
    request<{ resolved: boolean; type: string; instanceId?: string; buttonIndex: number; error?: string }>('/api/cli/resolve', 'POST', { type, buttonIndex, instanceId }),

  cliRaw: (type: string, keys: string, instanceId?: string) =>
    request<{ sent: boolean; type: string; instanceId?: string; keysLength: number; error?: string }>('/api/cli/raw', 'POST', { type, keys, instanceId }),

  cliDebug: (type: string) =>
    request<{ instanceId: string; providerState: Record<string, any>; debug: Record<string, any> | null; error?: string }>(`/api/cli/debug/${encodeURIComponent(type)}`),

  cliTrace: (type: string, limit = 120) =>
    request<CliTraceResponse>(`/api/cli/trace/${encodeURIComponent(type)}?limit=${limit}`),

  cliExercise: (type: string, opts: {
    text: string
    instanceId?: string
    workingDir?: string
    args?: string[]
    autoLaunch?: boolean
    freshSession?: boolean
    autoResolveApprovals?: boolean
    approvalButtonIndex?: number
    timeoutMs?: number
    readyTimeoutMs?: number
    idleSettledMs?: number
    traceLimit?: number
    stopWhenDone?: boolean
  }) =>
    request<CliExerciseResponse>('/api/cli/exercise', 'POST', { type, ...opts }),

  cliFixtures: (type: string) =>
    request<{ fixtures: CliFixtureInfo[]; count: number }>(`/api/cli/fixtures/${encodeURIComponent(type)}`),

  cliFixtureCapture: (type: string, opts: {
    name?: string
    request: Record<string, any>
    assertions?: {
      mustContainAny?: string[]
      mustNotContainAny?: string[]
      statusesSeen?: string[]
      requireNotTimedOut?: boolean
    }
    notes?: string
  }) =>
    request<CliFixtureCaptureResponse>('/api/cli/fixture/capture', 'POST', { type, ...opts }),

  cliFixtureReplay: (type: string, name: string, assertions?: Record<string, any>) =>
    request<CliFixtureReplayResponse>('/api/cli/fixture/replay', 'POST', { type, name, assertions }),

  scriptHints: (type: string) =>
    request<{ hints: Record<string, { template: Record<string, any>; description: string }> }>(`/providers/${type}/script-hints`),

  versions: () =>
    request<{ total: number; installed: number; providers: { type: string; name: string; category: string; installed: boolean; version: string | null; path: string | null; binary: string | null; warning?: string }[]; history: Record<string, { version: string; detectedAt: string; os: string }[]> }>('/providers/versions'),

  // Phase 1: DOM Context API
  domContext: (type: string, ideType?: string) =>
    request<{
      screenshot: string | null
      domSnapshot: {
        contentEditables: { selector: string; tag: string; contenteditable: string | null; role: string | null; ariaLabel: string | null; placeholder: string | null; rect: any; visible: boolean }[]
        chatContainers: { selector: string; childCount: number; rect: any; hasScrollable: boolean }[]
        buttons: { text: string; ariaLabel: string | null; selector: string; rect: any; disabled: boolean }[]
        sidebars: { selector: string; position: string; rect: any; childCount: number }[]
        dropdowns: { selector: string; tag: string; role: string | null; visible: boolean; rect: any }[]
      }
      pageTitle: string
      pageUrl: string
      providerType: string
      timestamp: string
    }>(`/providers/${type}/dom-context`, 'POST', { ideType }),

  // Phase 2: Auto-Implement
  autoImplement: (type: string, opts: { agent?: string; functions: string[]; reference?: string }) =>
    request<{ started: boolean; type: string; agent: string; functions: string[]; providerDir: string; message: string; sseUrl: string }>(`/providers/${type}/auto-implement`, 'POST', opts),

  autoImplementCancel: (type: string) =>
    request<{ cancelled: boolean; message?: string }>(`/providers/${type}/auto-implement/cancel`, 'POST'),

  autoImplementStatus: (type: string): EventSource =>
    new EventSource(`${API}/providers/${type}/auto-implement/status`),
}
