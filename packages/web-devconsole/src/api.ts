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
