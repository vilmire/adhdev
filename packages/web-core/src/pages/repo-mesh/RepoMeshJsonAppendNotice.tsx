/**
 * RepoMeshJsonAppendNotice — read-only display of the coordinator prompt layer
 * that comes from the repo-committed `.adhdev/mesh.json`.
 *
 * WHY THIS EXISTS: the mesh settings editor seeds its Override/Append drafts from
 * the MACHINE-LOCAL mesh entry (meshes.json) only. A repo that declares
 * `coordinator.systemPromptAppend` in `.adhdev/mesh.json` therefore contributes
 * real text to every coordinator prompt while the settings page shows an empty
 * Append box — the operator sees a blank field and concludes nothing is appended.
 * The launch path and `coordinator_prompt_preview` both apply the repo overlay
 * (loadRepoMeshJsonConfig + applyRepoMeshConfig); this surfaces the same layer in
 * settings so the UI stops disagreeing with the prompt that actually ships.
 *
 * ★READ-ONLY BY DESIGN — DO NOT ADD AN EDITOR HERE. `.adhdev/mesh.json` is a
 * repo-committed file shared by everyone who clones the repo. The editable
 * Override/Append fields next to this notice write to update_mesh → meshes.json
 * (machine-local). Making this writable from the dashboard would turn a settings
 * tweak into an uncommitted working-tree change in the operator's repo. Editing
 * the repo layer is a deliberate commit, made in the repo.
 *
 * It also must NOT be merged into `coordinatorPromptDraft`: that draft is written
 * straight back to meshes.json on Save, so folding the repo text in would silently
 * copy repo-owned content into machine-local config and then stack it twice
 * (mergeEffectiveCoordinatorConfig already concatenates repo + local).
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** Normalized view of the repo `.adhdev/mesh.json` coordinator layer. */
export interface RepoMeshJsonCoordinatorLayer {
    /** Repo-declared append text, '' when absent. */
    append: string
    /** Repo-declared full-prompt override, '' when absent. */
    override: string
    /** Path of the repo file the values came from, when one was read. */
    path: string
    /** Loader outcome, mirroring RepoMeshJsonConfigLoadResult.sourceType. */
    sourceType: 'repo_file' | 'unavailable' | 'invalid'
    /** Parse error text when sourceType is 'invalid'. */
    error: string
}

/**
 * Project a `read_mesh_json_config` daemon response into the coordinator layer.
 *
 * Handles BOTH transport shapes: the cloud transport wraps the daemon body once
 * as `{ result: <body> }` while standalone returns the body directly (see the
 * TransportContext jsdoc). Reading only the outer object is the historical bug
 * class this unwrap avoids.
 *
 * Returns null when there is nothing to show — no repo file, or a repo file that
 * declares no coordinator prompt text. A null result means "render nothing",
 * which keeps the notice invisible for the (common) repo that has no mesh.json.
 */
export function extractRepoMeshJsonCoordinatorLayer(raw: any): RepoMeshJsonCoordinatorLayer | null {
    const body = (raw?.result && typeof raw.result === 'object') ? raw.result : raw
    if (!body || typeof body !== 'object') return null
    if (body.success === false) return null

    const sourceType = body.sourceType === 'repo_file' || body.sourceType === 'invalid'
        ? body.sourceType
        : 'unavailable'

    // A malformed repo file is worth surfacing: it means the repo intended to
    // contribute a layer and the daemon silently fell back to "no repo base".
    if (sourceType === 'invalid') {
        return {
            append: '',
            override: '',
            path: typeof body.path === 'string' ? body.path : '',
            sourceType: 'invalid',
            error: typeof body.error === 'string' ? body.error : '',
        }
    }

    const coord = body?.config?.coordinator
    const append = typeof coord?.systemPromptAppend === 'string' ? coord.systemPromptAppend : ''
    const override = typeof coord?.systemPromptOverride === 'string' ? coord.systemPromptOverride : ''
    if (!append.trim() && !override.trim()) return null

    return {
        append,
        override,
        path: typeof body.path === 'string' ? body.path : '',
        sourceType: 'repo_file',
        error: '',
    }
}

interface Props {
    /** Daemon that owns the repo workspace (the mesh host). */
    daemonId: string
    /** Workspace whose `.adhdev/mesh.json` is read. Empty = nothing to load. */
    workspace: string
    sendCommand: (daemonId: string, command: string, payload?: any) => Promise<any>
}

export default function RepoMeshJsonAppendNotice({ daemonId, workspace, sendCommand }: Props) {
    const { t } = useTranslation()
    const [layer, setLayer] = useState<RepoMeshJsonCoordinatorLayer | null>(null)

    const load = useCallback(async () => {
        if (!daemonId || !workspace) { setLayer(null); return }
        try {
            const raw = await sendCommand(daemonId, 'read_mesh_json_config', { workspace })
            setLayer(extractRepoMeshJsonCoordinatorLayer(raw))
        } catch {
            // Best-effort: the repo layer is supplementary context, so a transport
            // failure degrades to showing nothing rather than an error banner over
            // the editable fields that DO work.
            setLayer(null)
        }
    }, [daemonId, workspace, sendCommand])

    useEffect(() => { void load() }, [load])

    if (!layer) return null

    if (layer.sourceType === 'invalid') {
        return (
            <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                {t('repoMesh.detail.repoMeshJsonInvalid')}
                {layer.error && <span className="ml-1 font-mono text-2xs opacity-80">{layer.error}</span>}
            </div>
        )
    }

    return (
        <div className="mt-3 rounded-lg border border-border-subtle bg-bg-secondary/40 p-3">
            <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-[13px] leading-tight font-semibold">{t('repoMesh.detail.repoMeshJsonTitle')}</span>
                <span className="rounded-full border border-border-subtle bg-bg-secondary px-2 py-0.5 text-3xs font-medium text-text-muted">
                    {t('repoMesh.detail.repoMeshJsonReadOnly')}
                </span>
            </div>
            <p className="mb-2 text-xs text-text-muted">
                {t('repoMesh.detail.repoMeshJsonHint')}
                {layer.path && <span className="ml-1 font-mono text-2xs">{layer.path}</span>}
            </p>

            {layer.override.trim() && (
                <div className="mb-2">
                    <label className="mb-1 block text-2xs uppercase tracking-wide text-text-muted">
                        {t('repoMesh.detail.repoMeshJsonOverrideLabel')}
                    </label>
                    <textarea
                        readOnly
                        value={layer.override}
                        rows={4}
                        className="w-full rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 font-mono text-xs text-text-secondary"
                        onFocus={e => e.currentTarget.select()}
                    />
                </div>
            )}

            {layer.append.trim() && (
                <div>
                    <label className="mb-1 block text-2xs uppercase tracking-wide text-text-muted">
                        {t('repoMesh.detail.repoMeshJsonAppendLabel')}
                    </label>
                    <textarea
                        readOnly
                        value={layer.append}
                        rows={4}
                        className="w-full rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 font-mono text-xs text-text-secondary"
                        onFocus={e => e.currentTarget.select()}
                    />
                </div>
            )}
        </div>
    )
}
