import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

type PhaseEntry = Pick<MeshWorkQueueEntry, 'id' | 'phase' | 'dependsOn'>;

/** Validate reachable edges too: a recovered ordinary intermediary must not
 * launder source-only completion, and completed legacy cycles are not authority.
 */
function dependencyViolation(entries: readonly PhaseEntry[], graph: ReadonlyMap<string, PhaseEntry>): string | undefined {
    const done = new Set<string>(), visiting = new Set<string>();
    for (const entry of entries) {
        const stack: Array<{ entry: PhaseEntry; leaving?: boolean }> = [{ entry }];
        while (stack.length) {
            const { entry: dependent, leaving } = stack.pop()!;
            if (leaving) { visiting.delete(dependent.id); done.add(dependent.id); continue; }
            if (visiting.has(dependent.id)) return `dependency_cycle_detected: ${dependent.id}`;
            if (done.has(dependent.id)) continue;
            visiting.add(dependent.id);
            stack.push({ entry: dependent, leaving: true });
            for (const id of dependent.dependsOn ?? []) {
                const source = graph.get(id);
                if (!source) continue; // Missing readiness still fails closed at admission.
                if (source.phase === 'source' && dependent.phase !== 'integration') {
                    return `source_phase_requires_integration_dependents: ${dependent.id} -> ${id}`;
                }
                stack.push({ entry: source });
            }
        }
    }
    return undefined;
}

/** A source completion is input authority only for an explicit integration task. */
export function sourceDependencyViolation(entry: PhaseEntry, graph: ReadonlyMap<string, PhaseEntry>): string | undefined {
    return dependencyViolation([entry], graph);
}

/** Validate the prospective graph before publishing any phase/edge mutation. */
export function assertSourceDependencyGraph(entries: readonly PhaseEntry[]): void {
    const violation = dependencyViolation(entries, new Map(entries.map(entry => [entry.id, entry])));
    if (violation) throw new Error(violation);
}
