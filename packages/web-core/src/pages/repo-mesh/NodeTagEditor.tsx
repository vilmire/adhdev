/**
 * Per-node routing-tag editor.
 *
 * Auto-derived tags (os=/arch=/provider=/worktree=) are shown read-only — they
 * come from the node's platform/arch/providers and can't be hand-edited. Custom
 * capability tags (e.g. windows-build, test-runner, gpu) are operator-authored:
 * add/remove chips here, then Save persists them via update_mesh_node so a task's
 * required_tags can route to this node. The coordinator prompt surfaces these
 * same tags so an agent can route by them.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { deriveNodeCapabilityTags } from './node-providers'
import type { MeshNode } from './types'

interface Props {
    node: MeshNode
    saving: boolean
    onSave: (capabilities: string[]) => void
}

/** Read the node's saved custom capability tags (the operator-authored subset). */
function readCustomTags(node: MeshNode): string[] {
    const raw = (node as any).capabilities
    if (!Array.isArray(raw)) return []
    return raw.map((t: any) => typeof t === 'string' ? t.trim() : '').filter(Boolean)
}

// Reserved auto-tag prefixes an operator shouldn't hand-author as a custom tag
// (they're derived). Guard the input so a custom "os=win32" doesn't shadow the
// real derived one.
const RESERVED_PREFIXES = ['os=', 'arch=', 'provider=', 'worktree=', 'converge=']

export default function NodeTagEditor({ node, saving, onSave }: Props) {
    const { t } = useTranslation('common')
    const autoTags = useMemo(() => deriveNodeCapabilityTags(node).filter(t => !t.custom), [node])
    const savedCustom = useMemo(() => readCustomTags(node), [node])
    const [custom, setCustom] = useState<string[]>(savedCustom)
    const [draft, setDraft] = useState('')

    const dirty = JSON.stringify(custom) !== JSON.stringify(savedCustom)

    const invalidReason = (raw: string): string | null => {
        const v = raw.trim()
        if (!v) return null
        if (/\s/.test(v)) return t('repoMesh.tagEditor.noSpaces')
        if (RESERVED_PREFIXES.some(p => v.toLowerCase().startsWith(p))) return t('repoMesh.tagEditor.reservedPrefix')
        if (custom.includes(v)) return t('repoMesh.tagEditor.alreadyAdded')
        return null
    }
    const draftError = invalidReason(draft)

    function addDraft() {
        const v = draft.trim()
        if (!v || draftError) return
        setCustom(prev => [...prev, v])
        setDraft('')
    }
    function removeTag(t: string) {
        setCustom(prev => prev.filter(x => x !== t))
    }

    return (
        <div className="mt-2" onClick={e => e.stopPropagation()}>
            <div className="flex flex-wrap items-center gap-1">
                <span className="text-3xs uppercase tracking-wide text-text-muted mr-1">{t('repoMesh.tagEditor.routingTags')}</span>
                {autoTags.map(at => (
                    <span key={at.tag} className="rounded-full border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-3xs text-text-muted" title={t('repoMesh.tagEditor.autoDerivedTitle')}>
                        {at.tag}
                    </span>
                ))}
                {custom.map(ct => (
                    <span key={ct} className="inline-flex items-center gap-1 rounded-full border border-accent-primary/40 bg-accent-primary/10 px-1.5 py-0.5 font-mono text-3xs text-accent-primary" title={t('repoMesh.tagEditor.customTagTitle')}>
                        {ct}
                        <button type="button" className="text-accent-primary/70 hover:text-accent-primary bg-transparent border-none cursor-pointer p-0 leading-none"
                            onClick={() => removeTag(ct)} disabled={saving} aria-label={t('repoMesh.tagEditor.remove', { tag: ct })}>×</button>
                    </span>
                ))}
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input
                    type="text"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDraft() } }}
                    placeholder={t('repoMesh.tagEditor.addPlaceholder')}
                    disabled={saving}
                    className="min-w-[12rem] flex-1 px-2 py-1 rounded-lg bg-bg-secondary border border-border-subtle text-[12px] text-text-primary"
                />
                <button type="button" className="btn btn-secondary btn-sm" onClick={addDraft} disabled={saving || !draft.trim() || !!draftError}>{t('repoMesh.tagEditor.add')}</button>
                {dirty && (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => onSave(custom)} disabled={saving}>
                        {saving ? t('repoMesh.tagEditor.saving') : t('repoMesh.tagEditor.saveTags')}
                    </button>
                )}
            </div>
            {draftError && <div className="mt-1 text-2xs text-amber-400">{draftError}</div>}
            {custom.length === 0 && autoTags.length === 0 && (
                <div className="mt-1 text-2xs text-text-muted">{t('repoMesh.tagEditor.empty')}</div>
            )}
        </div>
    )
}
