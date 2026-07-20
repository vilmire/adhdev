import { useCallback, useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MeshGraphThemeContext } from './meshSurfaceTheme'
import { Badge } from './meshSurfacePrimitives'

// ─── Notes tab ───────────────────────────────────────────────────────────────
// Manual CRUD for coordinator operating notes (runtime-accumulated lessons:
// provider quirks, patterns to avoid, recovery lessons) persisted in the mesh
// ledger. Previously these were writable only via the stdio MCP coordinator
// tools; this surface wires the same three ledger operations over P2P
// (list_mesh_notes / record_mesh_note / forget_mesh_note) so an operator can
// curate them from the dashboard. "Edit" is forget(noteId) + record(new text),
// since the ledger has no in-place update.

const NOTE_CATEGORIES = ['provider_quirk', 'pattern_to_avoid', 'recovery_lesson'] as const
type NoteCategory = (typeof NOTE_CATEGORIES)[number]

interface OperatingNote {
    id: string
    text: string
    category?: string
    createdAt?: string
    sourceCoordinator?: string
}

// Distinct badge tone per category so the three lesson kinds read apart at a glance.
const CATEGORY_TONE: Record<NoteCategory, 'warn' | 'danger' | 'good'> = {
    provider_quirk: 'warn',
    pattern_to_avoid: 'danger',
    recovery_lesson: 'good',
}

function categoryLabel(t: (k: string) => string, category?: string): string {
    if (category === 'provider_quirk') return t('meshGraph.notes.categoryProviderQuirk')
    if (category === 'pattern_to_avoid') return t('meshGraph.notes.categoryPatternToAvoid')
    if (category === 'recovery_lesson') return t('meshGraph.notes.categoryRecoveryLesson')
    return t('meshGraph.notes.categoryUncategorized')
}

function formatCreatedAt(iso?: string): string {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleString()
}

export function MeshNotesTab({
    meshId,
    daemonId,
    sendDaemonCommand,
}: {
    meshId: string
    daemonId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
}) {
    const { t } = useTranslation('common')
    const meshTheme = useContext(MeshGraphThemeContext)

    const [notes, setNotes] = useState<OperatingNote[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    // Add form
    const [draftText, setDraftText] = useState('')
    const [draftCategory, setDraftCategory] = useState<NoteCategory | ''>('')

    // Inline edit
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editText, setEditText] = useState('')
    const [editCategory, setEditCategory] = useState<NoteCategory | ''>('')

    const canOperate = !!(sendDaemonCommand && daemonId && meshId)

    const loadNotes = useCallback(async () => {
        if (!sendDaemonCommand || !daemonId || !meshId) return
        setLoading(true)
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'list_mesh_notes', { meshId, tail: 100 })
            // Cloud wraps the daemon response in { success, result }; standalone returns it directly.
            const res = raw?.result ?? raw
            if (res && res.success === false) {
                setError(typeof res.error === 'string' ? res.error : t('meshGraph.notes.loadFailed'))
                setNotes([])
                return
            }
            const list = Array.isArray(res?.notes) ? (res.notes as OperatingNote[]) : []
            // Freshest first for the operator; the ledger returns oldest→newest.
            setNotes([...list].reverse())
        } catch (e) {
            setError(e instanceof Error ? e.message : t('meshGraph.notes.loadFailed'))
            setNotes([])
        } finally {
            setLoading(false)
        }
    }, [sendDaemonCommand, daemonId, meshId, t])

    useEffect(() => {
        void loadNotes()
    }, [loadNotes])

    const handleAdd = useCallback(async () => {
        if (!sendDaemonCommand || !daemonId || !meshId) return
        const text = draftText.trim()
        if (!text || busy) return
        setBusy(true)
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'record_mesh_note', {
                meshId,
                text,
                ...(draftCategory ? { category: draftCategory } : {}),
            })
            const res = raw?.result ?? raw
            if (res && res.success === false) {
                setError(typeof res.error === 'string' ? res.error : t('meshGraph.notes.saveFailed'))
                return
            }
            setDraftText('')
            setDraftCategory('')
            await loadNotes()
        } catch (e) {
            setError(e instanceof Error ? e.message : t('meshGraph.notes.saveFailed'))
        } finally {
            setBusy(false)
        }
    }, [sendDaemonCommand, daemonId, meshId, draftText, draftCategory, busy, loadNotes, t])

    const handleDelete = useCallback(async (noteId: string) => {
        if (!sendDaemonCommand || !daemonId || !meshId || busy) return
        setBusy(true)
        setError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'forget_mesh_note', { meshId, noteId })
            const res = raw?.result ?? raw
            if (res && res.success === false) {
                setError(typeof res.error === 'string' ? res.error : t('meshGraph.notes.deleteFailed'))
                return
            }
            await loadNotes()
        } catch (e) {
            setError(e instanceof Error ? e.message : t('meshGraph.notes.deleteFailed'))
        } finally {
            setBusy(false)
        }
    }, [sendDaemonCommand, daemonId, meshId, busy, loadNotes, t])

    const beginEdit = useCallback((note: OperatingNote) => {
        setEditingId(note.id)
        setEditText(note.text)
        setEditCategory(NOTE_CATEGORIES.includes(note.category as NoteCategory) ? (note.category as NoteCategory) : '')
    }, [])

    const cancelEdit = useCallback(() => {
        setEditingId(null)
        setEditText('')
        setEditCategory('')
    }, [])

    // Edit = forget the old note by id, then record the new text (no in-place ledger update).
    const handleSaveEdit = useCallback(async (noteId: string) => {
        if (!sendDaemonCommand || !daemonId || !meshId || busy) return
        const text = editText.trim()
        if (!text) return
        setBusy(true)
        setError(null)
        try {
            const forgetRaw = await sendDaemonCommand(daemonId, 'forget_mesh_note', { meshId, noteId })
            const forgetRes = forgetRaw?.result ?? forgetRaw
            if (forgetRes && forgetRes.success === false) {
                setError(typeof forgetRes.error === 'string' ? forgetRes.error : t('meshGraph.notes.editFailed'))
                return
            }
            const recordRaw = await sendDaemonCommand(daemonId, 'record_mesh_note', {
                meshId,
                text,
                ...(editCategory ? { category: editCategory } : {}),
            })
            const recordRes = recordRaw?.result ?? recordRaw
            if (recordRes && recordRes.success === false) {
                setError(typeof recordRes.error === 'string' ? recordRes.error : t('meshGraph.notes.editFailed'))
                return
            }
            cancelEdit()
            await loadNotes()
        } catch (e) {
            setError(e instanceof Error ? e.message : t('meshGraph.notes.editFailed'))
        } finally {
            setBusy(false)
        }
    }, [sendDaemonCommand, daemonId, meshId, editText, editCategory, busy, cancelEdit, loadNotes, t])

    const categorySelectClass = meshTheme.isDark
        ? 'rounded-lg border border-white/10 bg-slate-950/40 px-2.5 py-1.5 text-xs text-slate-200'
        : 'rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700'
    const textInputClass = meshTheme.isDark
        ? 'w-full rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500'
        : 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400'
    const actionClass = (tone: 'default' | 'info' | 'success') =>
        `rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${meshTheme.actionButton(tone)}`

    if (!canOperate) {
        return (
            <div className={`${meshTheme.cardClass} rounded-2xl p-4 text-[12px] ${meshTheme.textSecondary}`}>
                {t('meshGraph.notes.unavailable')}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            {/* Add form */}
            <div className={`${meshTheme.cardClass} rounded-2xl p-4`}>
                <div className={`mb-2 text-sm font-semibold ${meshTheme.textPrimary}`}>{t('meshGraph.notes.addTitle')}</div>
                <textarea
                    value={draftText}
                    onChange={e => setDraftText(e.target.value)}
                    rows={2}
                    placeholder={t('meshGraph.notes.textPlaceholder')}
                    className={textInputClass}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <select
                        value={draftCategory}
                        onChange={e => setDraftCategory(e.target.value as NoteCategory | '')}
                        className={categorySelectClass}
                        aria-label={t('meshGraph.notes.categoryLabel')}
                    >
                        <option value="">{t('meshGraph.notes.categoryUncategorized')}</option>
                        {NOTE_CATEGORIES.map(c => (
                            <option key={c} value={c}>{categoryLabel(t, c)}</option>
                        ))}
                    </select>
                    <button
                        type="button"
                        onClick={() => { void handleAdd() }}
                        disabled={busy || !draftText.trim()}
                        className={actionClass('success')}
                    >
                        {t('meshGraph.notes.add')}
                    </button>
                </div>
            </div>

            {error && (
                <div className={meshTheme.isDark ? 'rounded-xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-100' : 'rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700'}>
                    {error}
                </div>
            )}

            {/* List */}
            <div className={`${meshTheme.cardClass} rounded-2xl p-4`}>
                <div className="mb-2 flex items-center justify-between gap-2">
                    <div className={`text-sm font-semibold ${meshTheme.textPrimary}`}>{t('meshGraph.notes.listTitle')}</div>
                    <button
                        type="button"
                        onClick={() => { void loadNotes() }}
                        disabled={loading || busy}
                        className={actionClass('default')}
                    >
                        {t('meshGraph.notes.refresh')}
                    </button>
                </div>
                {loading ? (
                    <div className={`py-6 text-center text-sm ${meshTheme.textMuted}`}>{t('meshGraph.notes.loading')}</div>
                ) : notes.length === 0 ? (
                    <div className={`py-6 text-center text-sm ${meshTheme.textMuted}`}>{t('meshGraph.notes.empty')}</div>
                ) : (
                    <div className="flex flex-col gap-2">
                        {notes.map(note => (
                            <div
                                key={note.id}
                                className={`rounded-xl border px-3 py-2.5 ${meshTheme.isDark ? 'border-white/8 bg-white/[0.03]' : 'border-slate-200 bg-slate-50/80'}`}
                            >
                                {editingId === note.id ? (
                                    <div className="flex flex-col gap-2">
                                        <textarea
                                            value={editText}
                                            onChange={e => setEditText(e.target.value)}
                                            rows={2}
                                            className={textInputClass}
                                        />
                                        <div className="flex flex-wrap items-center gap-2">
                                            <select
                                                value={editCategory}
                                                onChange={e => setEditCategory(e.target.value as NoteCategory | '')}
                                                className={categorySelectClass}
                                                aria-label={t('meshGraph.notes.categoryLabel')}
                                            >
                                                <option value="">{t('meshGraph.notes.categoryUncategorized')}</option>
                                                {NOTE_CATEGORIES.map(c => (
                                                    <option key={c} value={c}>{categoryLabel(t, c)}</option>
                                                ))}
                                            </select>
                                            <button
                                                type="button"
                                                onClick={() => { void handleSaveEdit(note.id) }}
                                                disabled={busy || !editText.trim()}
                                                className={actionClass('success')}
                                            >
                                                {t('meshGraph.notes.save')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={cancelEdit}
                                                disabled={busy}
                                                className={actionClass('default')}
                                            >
                                                {t('meshGraph.notes.cancel')}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <div className={`whitespace-pre-wrap break-words text-sm ${meshTheme.textPrimary}`}>{note.text}</div>
                                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                            <Badge
                                                label={categoryLabel(t, note.category)}
                                                tone={NOTE_CATEGORIES.includes(note.category as NoteCategory) ? CATEGORY_TONE[note.category as NoteCategory] : 'default'}
                                            />
                                            {formatCreatedAt(note.createdAt) && (
                                                <span className={`text-[11px] ${meshTheme.textMuted}`}>{formatCreatedAt(note.createdAt)}</span>
                                            )}
                                            <div className="ml-auto flex items-center gap-1.5">
                                                <button
                                                    type="button"
                                                    onClick={() => beginEdit(note)}
                                                    disabled={busy}
                                                    className={actionClass('info')}
                                                >
                                                    {t('meshGraph.notes.edit')}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => { void handleDelete(note.id) }}
                                                    disabled={busy}
                                                    className={actionClass('default')}
                                                >
                                                    {t('meshGraph.notes.delete')}
                                                </button>
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
