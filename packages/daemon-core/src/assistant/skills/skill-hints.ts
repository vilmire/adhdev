/**
 * Hint-acceptance tracker for `project_send` skill hints (design
 * 2026-11-01-procedure-skills.md §6.3): remembers, per project, which skills
 * the last send hinted at, so the NEXT send that attaches one of them within
 * 10 minutes counts as the hint being accepted. In-memory on purpose — it is
 * instrumentation; a daemon restart forgetting it is acceptable.
 */

export const SKILL_HINT_ACCEPT_WINDOW_MS = 10 * 60_000;

export class SkillHintTracker {
    private readonly byMesh = new Map<string, { names: Set<string>; at: number }>();

    shown(meshId: string, names: readonly string[], at: number): void {
        this.byMesh.set(meshId, { names: new Set(names), at });
        if (this.byMesh.size > 64) this.byMesh.delete(this.byMesh.keys().next().value as string);
    }

    /** Names among `attached` that were hinted for this project within the window; each hint is accepted once. */
    accepted(meshId: string, attached: readonly string[], at: number): string[] {
        const h = this.byMesh.get(meshId);
        if (!h || at - h.at > SKILL_HINT_ACCEPT_WINDOW_MS) return [];
        const hit = attached.filter((n) => h.names.has(n));
        for (const n of hit) h.names.delete(n);
        return hit;
    }

    clear(): void {
        this.byMesh.clear();
    }
}

let tracker = new SkillHintTracker();
export function getSkillHintTracker(): SkillHintTracker {
    return tracker;
}
/** Tests. */
export function resetSkillHintTracker(): void {
    tracker = new SkillHintTracker();
}
