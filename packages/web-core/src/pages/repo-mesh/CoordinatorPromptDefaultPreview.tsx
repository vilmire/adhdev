/**
 * Collapsible "View the default coordinator prompt" preview.
 *
 * The Override textarea replaces the daemon's built-in base prompt, but when it
 * is left empty the operator sees only a blank field with no idea what that
 * default actually contains. This fetches the rendered default via the
 * `coordinator_prompt_preview` daemon command (daemon-core low-family handler)
 * and shows it read-only, on demand, so "leave empty to keep the default" is no
 * longer an invisible choice.
 */
import { useCallback, useState } from 'react'

interface Props {
    daemonId: string
    meshId: string
    cliType: string
    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
}

export default function CoordinatorPromptDefaultPreview({ daemonId, meshId, cliType, sendCommand }: Props) {
    const [open, setOpen] = useState(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [prompt, setPrompt] = useState<string | null>(null)
    const [bytes, setBytes] = useState<number | null>(null)

    const load = useCallback(async () => {
        if (!daemonId || !meshId) { setError('Connect a daemon to preview the default.'); return }
        setLoading(true)
        setError(null)
        try {
            const raw: any = await sendCommand(daemonId, 'coordinator_prompt_preview', { meshId, cliType })
            // Cloud transport wraps once; standalone returns the daemon body directly.
            const result = (raw?.result && typeof raw.result === 'object') ? raw.result : raw
            if (!result?.success) { setError(result?.error || 'Failed to render the default prompt'); return }
            setPrompt(typeof result.prompt === 'string' ? result.prompt : '')
            setBytes(typeof result.bytes === 'number' ? result.bytes : null)
        } catch (e: any) {
            setError(e?.message || String(e))
        } finally {
            setLoading(false)
        }
    }, [daemonId, meshId, cliType, sendCommand])

    const toggle = useCallback(() => {
        const next = !open
        setOpen(next)
        if (next && prompt === null && !loading) void load()
    }, [open, prompt, loading, load])

    return (
        <div className="mt-2">
            <button
                type="button"
                onClick={toggle}
                className="inline-flex items-center gap-1 text-[12px] text-accent-primary bg-transparent border-none cursor-pointer p-0"
            >
                <span className={`transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>▸</span>
                {open ? 'Hide the default prompt' : 'View the default prompt'}
                <span className="text-text-muted">({cliType})</span>
            </button>

            {open && (
                <div className="mt-2">
                    {loading && <div className="text-[12px] text-text-muted">Rendering…</div>}
                    {error && (
                        <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
                            {error}
                            <button type="button" onClick={() => void load()} className="ml-2 underline bg-transparent border-none cursor-pointer text-amber-300">Retry</button>
                        </div>
                    )}
                    {!loading && !error && prompt !== null && (
                        <>
                            <div className="mb-1 flex items-center justify-between text-[11px] text-text-muted">
                                <span>This is what a coordinator session gets when Override is empty.</span>
                                {bytes !== null && <span>{(bytes / 1024).toFixed(1)} KB</span>}
                            </div>
                            <textarea
                                readOnly
                                value={prompt}
                                rows={14}
                                className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-[12px] text-text-secondary font-mono"
                                onFocus={e => e.currentTarget.select()}
                            />
                        </>
                    )}
                </div>
            )}
        </div>
    )
}
