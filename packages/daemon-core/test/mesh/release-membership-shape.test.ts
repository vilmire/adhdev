import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// Design 2026-11-01-release-objects L7 / acceptance 1: the daemon NEVER makes a mission a member of a release on its
// own. Membership rows are written in exactly one place (mesh-releases.ts), and the only caller of that code that is
// reachable from outside is the caller-classified command handler. Git evaluation, deploy recording, status
// transitions, mission completion and the housekeeping tick must not import the membership writers.
const SRC = join(__dirname, '../../src');

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
}
const files = walk(SRC).map(p => ({ rel: relative(SRC, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }));
const using = (needle: RegExp) => files.filter(f => needle.test(f.text)).map(f => f.rel).sort();

describe('release membership is explicit (no daemon-initiated membership)', () => {
    it('scans the whole src tree (guard against an empty scan)', () => {
        expect(files.length).toBeGreaterThan(500);
        expect(using(/export function scopeRelease/)).toEqual(['mesh/mesh-releases.ts']);
    });

    it('the store method that inserts a member row is called only from mesh-releases.ts', () => {
        expect(using(/\.addMember\(/)).toEqual(['mesh/mesh-releases.ts']);
        expect(using(/mesh_release_missions/)).toEqual([
            'mesh/host-handoff/snapshot-export.ts',
            'mesh/host-handoff/snapshot-import.ts',
            // Host move only: retires the target's row when the host's membership wins; adds no member.
            'mesh/host-handoff/snapshot-reconcile.ts',
            'mesh/mesh-mission-items-store.ts',
            'mesh/mesh-release-schema.ts',
            'mesh/mesh-release-store.ts',
        ]);
    });

    it('scopeRelease is called only by the release command handler', () => {
        expect(using(/\bscopeRelease\(/)).toEqual(['commands/high-family/mesh-release-commands.ts', 'mesh/mesh-releases.ts']);
    });

    it('git evaluation, deploy recording and the changelog draft never reach membership writers', () => {
        for (const rel of ['mesh/mesh-mission-git-eval.ts', 'mesh/mission-ref-evaluator.ts', 'mesh/mission-git-triggers.ts', 'mesh/mesh-release-changelog.ts', 'assistant/release-digest.ts', 'mesh/mesh-housekeeping-tick.ts']) {
            const text = files.find(f => f.rel === rel)?.text ?? '';
            expect(text.length, rel).toBeGreaterThan(0);
            expect(text, rel).not.toMatch(/scopeRelease|addMember|endMember/);
        }
        // recordReleaseDeploy changes release status/targets, never members
        const releases = files.find(f => f.rel === 'mesh/mesh-releases.ts')!.text;
        const body = releases.slice(releases.indexOf('export function recordReleaseDeploy'));
        expect(body).not.toMatch(/addMember|endMember|attach\(/);
        // suggestions are a read: no store write inside suggestMissionsForRelease
        const suggest = releases.slice(releases.indexOf('export function suggestMissionsForRelease'), releases.indexOf('// ─── read'));
        expect(suggest).not.toMatch(/\.insert\(|\.update\(|addMember|endMember|appendEvent/);
    });
});
