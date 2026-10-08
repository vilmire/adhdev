/**
 * Assistant project addressing (design 2026-10-07-assistant-layer.md §4.2).
 *
 * A project is one `LocalMeshEntry`; `projectId = meshId`. This module holds
 * only the pure parts the store verbs need now — slug derivation and
 * `resolveAssistantProject(ref)`. Aliases (`assistant.json aliases{}`) and
 * `ensureCoordinator` arrive with the registry unit; the resolver already
 * takes an alias map so that unit only has to pass it.
 *
 * Resolution order: exact meshId → the host's mesh id (`meshHost.hostMeshId`) →
 * `mesh.name` case-insensitive → alias →
 * slug → `repoIdentity` tail. The first step with any match decides; more than
 * one match at that step is `project_ambiguous`. It never guesses.
 */

export interface AssistantProjectMesh {
    id: string;
    name?: string;
    repoIdentity?: string;
    /** A standalone member's record of a mesh another daemon hosts keeps the HOST's id here. */
    meshHost?: { hostMeshId?: string } | null;
}

/** Last path segment of the repo identity, lowercased (`github.com/o/Repo` → `repo`). */
export function projectSlugBase(repoIdentity: string | undefined): string {
    const parts = String(repoIdentity ?? '').replace(/\.git$/i, '').split(/[/:]+/).filter(Boolean);
    return (parts[parts.length - 1] ?? '').toLowerCase();
}

function ownerSegment(repoIdentity: string | undefined): string {
    const parts = String(repoIdentity ?? '').replace(/\.git$/i, '').split(/[/:]+/).filter(Boolean);
    return (parts[parts.length - 2] ?? '').toLowerCase();
}

/**
 * Slug per mesh. On a collision of the base slug the owner segment is
 * prefixed (`owner-repo`); a collision that survives that keeps the prefixed
 * form for every colliding mesh, so a slug ref then resolves ambiguous.
 */
export function projectSlugs<T extends AssistantProjectMesh>(meshes: readonly T[]): Map<string, string> {
    const byBase = new Map<string, T[]>();
    for (const m of meshes) {
        const base = projectSlugBase(m.repoIdentity) || String(m.name ?? '').trim().toLowerCase();
        if (!base) continue;
        byBase.set(base, [...(byBase.get(base) ?? []), m]);
    }
    const out = new Map<string, string>();
    for (const [base, group] of byBase) {
        for (const m of group) {
            const owner = group.length > 1 ? ownerSegment(m.repoIdentity) : '';
            out.set(m.id, owner ? `${owner}-${base}` : base);
        }
    }
    return out;
}

export type ResolveAssistantProjectResult<T extends AssistantProjectMesh> =
    | { ok: true; mesh: T; slug: string }
    | { ok: false; code: 'project_not_found'; projects: string[] }
    | { ok: false; code: 'project_ambiguous'; candidates: Array<{ meshId: string; name?: string; slug: string }> };

export function resolveAssistantProject<T extends AssistantProjectMesh>(
    ref: unknown,
    meshes: readonly T[],
    aliases: Readonly<Record<string, string>> = {},
): ResolveAssistantProjectResult<T> {
    const slugs = projectSlugs(meshes);
    const slugOf = (m: T) => slugs.get(m.id) ?? '';
    const r = typeof ref === 'string' ? ref.trim() : '';
    const lower = r.toLowerCase();
    const steps: Array<(m: T) => boolean> = [
        (m) => m.id === r,
        // The id the host dashboard shows for a standalone-paired member mesh (it differs from
        // the member's local id); without this the host's mesh id answered project_not_found.
        (m) => !!r && typeof m.meshHost?.hostMeshId === 'string' && m.meshHost.hostMeshId.trim() === r,
        (m) => !!m.name && m.name.trim().toLowerCase() === lower,
        (m) => Object.entries(aliases).some(([alias, meshId]) => alias.trim().toLowerCase() === lower && meshId === m.id),
        (m) => slugOf(m) === lower,
        (m) => {
            const id = String(m.repoIdentity ?? '').toLowerCase().replace(/\.git$/i, '');
            return !!lower && (id === lower || id.endsWith(`/${lower}`));
        },
    ];
    if (r) {
        for (const step of steps) {
            const hits = meshes.filter(step);
            if (hits.length === 1) return { ok: true, mesh: hits[0], slug: slugOf(hits[0]) };
            if (hits.length > 1) {
                return {
                    ok: false,
                    code: 'project_ambiguous',
                    candidates: hits.map((m) => ({ meshId: m.id, ...(m.name ? { name: m.name } : {}), slug: slugOf(m) })),
                };
            }
        }
    }
    return { ok: false, code: 'project_not_found', projects: meshes.map((m) => slugOf(m) || m.name || m.id) };
}
