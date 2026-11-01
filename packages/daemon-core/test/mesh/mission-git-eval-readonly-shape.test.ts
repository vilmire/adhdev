import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-shape guard (design 2026-11-01-mission-git-refs §3.3, owner decision G3): a git verdict is a PROJECTION.
// The evaluation modules must never reach a mission/item write API, so `landed` can only drive a badge, notice
// wording and a digest list — never a status, outcome or item change. Row persistence (the one writer of
// mesh_mission_ref_evals + the transition-only git_state_changed event) lives in mesh-mission-ref-evals-store.ts,
// deliberately outside this file set.
const meshDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/mesh');
export const READ_ONLY_MODULES = [
    'mesh-mission-git-eval.ts',
    'mission-ref-evaluator.ts',
    'mission-ref-containment.ts',
    'mesh-git-cherry.ts',
] as const;

const FORBIDDEN_IMPORTS = /from\s+['"]\.\/(mesh-missions|mesh-mission-structured|mesh-mission-decisions|mesh-mission-owner-confirm|mesh-mission-change-notifier)(\.js)?['"]/;
const FORBIDDEN_IDENTIFIERS = /\b(upsertMeshMission|upsertStructuredMission|upsertMission|addNormalizedItem|insertItem|updateItem|deleteItem|bumpVersion|appendEvent|setMissionCloseCandidateEmittedAt|flagCarryOver|clearMissionsForMesh|acknowledgeAnsweredDecisions|notifyMissionChanged)\b/;

/** Violations found in one module's source (comments stripped so prose can mention the rule). */
export function findMissionWriteViolations(source: string): string[] {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const out: string[] = [];
    // A value import of the item store would hand out its write methods; type-only imports are fine.
    for (const m of code.matchAll(/^import\s+(?!type\b)[^;]*from\s+['"]\.\/mesh-mission-items-store(\.js)?['"]/gm)) out.push(`value import of the mission item store: ${m[0].slice(0, 60)}`);
    const imp = FORBIDDEN_IMPORTS.exec(code);
    if (imp) out.push(`imports ${imp[1]}`);
    const id = FORBIDDEN_IDENTIFIERS.exec(code);
    if (id) out.push(`uses ${id[1]}`);
    return out;
}

describe('mission git evaluation is read-only with respect to missions', () => {
    it('scans exactly the intended modules (count pinned so a rename cannot silently empty the guard)', () => {
        expect(READ_ONLY_MODULES).toHaveLength(4);
        for (const f of READ_ONLY_MODULES) expect(existsSync(join(meshDir, f)), f).toBe(true);
    });

    it.each(READ_ONLY_MODULES)('%s imports and calls no mission/item write API', (file) => {
        const source = readFileSync(join(meshDir, file), 'utf8');
        expect(source.length).toBeGreaterThan(200);
        expect(findMissionWriteViolations(source)).toEqual([]);
    });

    it('the guard turns red when a violation is injected (so a green run means something)', () => {
        const clean = readFileSync(join(meshDir, 'mesh-mission-git-eval.ts'), 'utf8');
        expect(findMissionWriteViolations(clean)).toEqual([]);
        expect(findMissionWriteViolations(`${clean}\nimport { upsertMeshMission } from './mesh-missions.js';`)).not.toEqual([]);
        expect(findMissionWriteViolations(`${clean}\nconst x = store.appendEvent(a, b, 'x', 'daemon', {});`)).not.toEqual([]);
        expect(findMissionWriteViolations(`${clean}\nimport { MissionItemStore } from './mesh-mission-items-store.js';`)).not.toEqual([]);
        expect(findMissionWriteViolations(`${clean}\nitems.updateItem(meshId, id, { state: 'done' });`)).not.toEqual([]);
        // Prose in comments may still name the rule.
        expect(findMissionWriteViolations(`${clean}\n// never call upsertMeshMission here\n/* appendEvent */`)).toEqual([]);
    });
});
