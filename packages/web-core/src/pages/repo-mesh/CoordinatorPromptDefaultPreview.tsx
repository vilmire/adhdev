/**
 * Collapsible "View the default coordinator prompt" preview, plus a shared
 * `useCoordinatorPromptDefault` hook so other surfaces (e.g. a "Start from
 * default" button that seeds the override editor) can fetch the same
 * rendered default without duplicating the load logic.
 *
 * The Override textarea replaces the daemon's built-in base prompt, but when it
 * is left empty the operator sees only a blank field with no idea what that
 * default actually contains. This fetches the rendered default via the
 * `coordinator_prompt_preview` daemon command (daemon-core low-family handler)
 * and shows it read-only, on demand, so "leave empty to keep the default" is no
 * longer an invisible choice.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
    daemonId: string
    meshId: string
    cliType: string
    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
    /** Start expanded (and auto-load) instead of collapsed. Defaults false. */
    defaultOpen?: boolean
}

/** Shared fetch/state for the rendered default coordinator prompt (coordinator_prompt_preview). */
export function useCoordinatorPromptDefault(daemonId: string, meshId: string, cliType: string, sendCommand: Props['sendCommand']) {
    const { t } = useTranslation()
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [prompt, setPrompt] = useState<string | null>(null)
    const [bytes, setBytes] = useState<number | null>(null)

    const load = useCallback(async () => {
        if (!daemonId || !meshId) { setError(t('repoMesh.promptPreview.connectPrompt')); return }
        setLoading(true)
        setError(null)
        try {
            const raw: any = await sendCommand(daemonId, 'coordinator_prompt_preview', { meshId, cliType })
            // Cloud transport wraps once; standalone returns the daemon body directly.
            const result = (raw?.result && typeof raw.result === 'object') ? raw.result : raw
            if (!result?.success) { setError(result?.error || t('repoMesh.promptPreview.errorRender')); return null }
            const nextPrompt = typeof result.prompt === 'string' ? result.prompt : ''
            setPrompt(nextPrompt)
            setBytes(typeof result.bytes === 'number' ? result.bytes : null)
            return nextPrompt
        } catch (e: any) {
            setError(e?.message || String(e))
            return null
        } finally {
            setLoading(false)
        }
    }, [daemonId, meshId, cliType, sendCommand, t])

    return { loading, error, prompt, bytes, load }
}

export default function CoordinatorPromptDefaultPreview({ daemonId, meshId, cliType, sendCommand, defaultOpen = false }: Props) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(defaultOpen)
    const { loading, error, prompt, bytes, load } = useCoordinatorPromptDefault(daemonId, meshId, cliType, sendCommand)
    const loadedRef = useRef(false)

    useEffect(() => {
        if (open && !loadedRef.current) {
            loadedRef.current = true
            void load()
        }
    }, [open, load])

    const toggle = useCallback(() => {
        setOpen(next => !next)
    }, [])

    return (
        <div className="mt-2">
            <button
                type="button"
                onClick={toggle}
                className="inline-flex items-center gap-1 text-xs text-accent-primary bg-transparent border-none cursor-pointer p-0"
            >
                <span className={`transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>▸</span>
                {open ? t('repoMesh.promptPreview.hide') : t('repoMesh.promptPreview.view')}
                <span className="text-text-muted">({cliType})</span>
            </button>

            {open && (
                <div className="mt-2">
                    {loading && <div className="text-xs text-text-muted">{t('repoMesh.promptPreview.rendering')}</div>}
                    {error && (
                        <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                            {error}
                            <button type="button" onClick={() => void load()} className="ml-2 underline bg-transparent border-none cursor-pointer text-amber-300">{t('repoMesh.promptPreview.retry')}</button>
                        </div>
                    )}
                    {!loading && !error && prompt !== null && (
                        <>
                            <div className="mb-1 flex items-center justify-between text-2xs text-text-muted">
                                <span>{t('repoMesh.promptPreview.info')}</span>
                                {bytes !== null && <span>{(bytes / 1024).toFixed(1)} KB</span>}
                            </div>
                            <textarea
                                readOnly
                                value={prompt}
                                rows={14}
                                className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-subtle text-xs text-text-secondary font-mono"
                                onFocus={e => e.currentTarget.select()}
                            />
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

interface StartFromDefaultButtonProps {
    daemonId: string
    meshId: string
    cliType: string
    sendCommand: Props['sendCommand']
    disabled?: boolean
    /** Whether Override already has content — gates the overwrite confirm. */
    hasContent: boolean
    onApply: (text: string) => void
}

/**
 * "Start from default" — fetches the rendered default prompt and copies it into
 * the Override field, so an operator can make a small edit instead of writing an
 * override from scratch. Confirms before clobbering existing Override content.
 */
export function StartFromDefaultButton({ daemonId, meshId, cliType, sendCommand, disabled, hasContent, onApply }: StartFromDefaultButtonProps) {
    const { t } = useTranslation()
    const { loading, load } = useCoordinatorPromptDefault(daemonId, meshId, cliType, sendCommand)

    const handleClick = useCallback(async () => {
        if (hasContent && !window.confirm(t('repoMesh.detail.startFromDefaultConfirm'))) return
        const text = await load()
        if (typeof text === 'string') onApply(text)
    }, [hasContent, load, onApply, t])

    return (
        <button
            type="button"
            className="btn btn-secondary btn-sm mt-2"
            onClick={() => void handleClick()}
            disabled={disabled || loading || !daemonId || !meshId}
            title={t('repoMesh.detail.startFromDefaultTitle')}
        >
            {loading ? t('repoMesh.promptPreview.rendering') : t('repoMesh.detail.startFromDefault')}
        </button>
    )
}
