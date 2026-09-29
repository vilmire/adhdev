// Shared types, constants and small helpers for the DevConsole panels.

export type Category = 'ide' | 'extension' | 'cli' | 'acp'
export type OutputType = 'log' | 'result' | 'error' | 'warn'
export interface OutputEntry { id: number; time: string; icon: string; text: string; type: OutputType }
export type AppendOutput = (text: string, type: OutputType) => void
export type Badge = 'ok' | 'err' | null
export type ValidationResult = { valid: boolean; errors: string[]; warnings: string[] }

export const CATEGORY_TABS: { key: Category; label: string; icon: string }[] = [
  { key: 'ide', label: 'IDE', icon: '💻' },
  { key: 'extension', label: 'Extension', icon: '🧩' },
  { key: 'cli', label: 'CLI', icon: '⌨️' },
  { key: 'acp', label: 'ACP', icon: '🤖' },
]

export const ICONS: Record<OutputType, string> = { log: '📝', result: '✅', error: '❌', warn: '⚠️' }

export const HELPER_PREAMBLE = `
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

export function ts() { return new Date().toTimeString().split(' ')[0].substring(0, 8) }

export function relativeTs(timestamp: number | undefined): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Determine if a category uses CDP tools
export function isCdpCategory(cat: string | undefined): boolean {
  return cat === 'ide' || cat === 'extension'
}
