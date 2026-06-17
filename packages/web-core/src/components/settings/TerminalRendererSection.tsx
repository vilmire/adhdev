/**
 * TerminalRendererSection — opt-in toggle for the experimental @wterm/ghostty
 * (libghostty WASM) terminal renderer. Device-local preference persisted to
 * localStorage; the renderer is selected at mount time by
 * selectTerminalRendererBackend() in @adhdev/terminal-render-web, which reads
 * the same key. Defaults to the proven xterm renderer.
 *
 * Shared between cloud and standalone settings pages.
 */
import { useState } from 'react'
import { ToggleRow } from './ToggleRow'
import { IconTerminal, IconZap } from '../Icons'

export const TERMINAL_RENDERER_KEY = 'adhdev:terminalRenderer'
export type TerminalRendererBackend = 'xterm' | 'wterm'

export function getTerminalRendererBackend(): TerminalRendererBackend {
    try {
        const raw = localStorage.getItem(TERMINAL_RENDERER_KEY)
        return raw === 'wterm' ? 'wterm' : 'xterm'
    } catch {
        return 'xterm'
    }
}

export function setTerminalRendererBackend(backend: TerminalRendererBackend) {
    try {
        localStorage.setItem(TERMINAL_RENDERER_KEY, backend)
    } catch {}
}

export function TerminalRendererSection() {
    const [backend, setBackend] = useState<TerminalRendererBackend>(() => getTerminalRendererBackend())

    const handleToggle = (enabled: boolean) => {
        const next: TerminalRendererBackend = enabled ? 'wterm' : 'xterm'
        setBackend(next)
        setTerminalRendererBackend(next)
    }

    return (
        <ToggleRow
            label={
                <span className="flex items-center gap-1.5">
                    <IconTerminal size={15} /> Experimental Ghostty renderer
                    <span
                        className="inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        style={{ color: 'var(--accent-primary)' }}
                    >
                        <IconZap size={11} /> Beta
                    </span>
                </span>
            }
            description="Render terminals with libghostty (WebAssembly) instead of xterm.js. Reload the page or reopen the terminal to apply."
            checked={backend === 'wterm'}
            onChange={handleToggle}
        />
    )
}
