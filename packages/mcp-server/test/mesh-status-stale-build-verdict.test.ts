import assert from 'node:assert/strict';
import test from 'node:test';

import { applyHeldNodeGitToEntry } from '../src/tools/mesh-status-held-git.js';

// rc.65 fleet restart: every daemon reported the new build in daemonBuilds, but the
// held git snapshot still carried the previous process's "build is behind HEAD"
// verdict, so staleDaemonBuilds listed three up-to-date daemons and the deploy
// verifier timed out. A verdict computed for another build must not be rendered.

const OLD = 'e00a06c72d13ecd45d1d598d0f2e768ce2e5498a';
const NEW = '67e468e8d87781cb78700f36b79771dd906b5cb3';

function held(runningCommit: string | null) {
    return {
        git: {
            isGitRepo: true,
            branch: 'main',
            daemonBuildBehind: { scope: 'oss', buildCommit: OLD, buildCommitShort: OLD.slice(0, 8), head: NEW, isDaemonAffecting: true },
        },
        ...(runningCommit ? { heldRuntime: { daemonBuild: { commit: runningCommit, commitShort: runningCommit.slice(0, 8), version: 'x', track: 'preview' } } } : {}),
    };
}

const mesh = { id: 'mesh_1', nodes: [] } as any;
const node = { id: 'node_1', nodeId: 'node_1', workspace: '/w', policy: {} } as any;

test('drops a build-behind verdict computed by a previous daemon process', () => {
    const entry: Record<string, any> = {};
    applyHeldNodeGitToEntry(entry, { mesh, node, held: held(NEW) });
    assert.equal(entry.staleDaemonBuild, undefined);
});

test('keeps the verdict when it describes the running build', () => {
    const entry: Record<string, any> = {};
    applyHeldNodeGitToEntry(entry, { mesh, node, held: held(OLD) });
    assert.equal(entry.staleDaemonBuild?.buildCommit, OLD);
});

test('keeps the verdict when the running build is unknown (older coordinator)', () => {
    const entry: Record<string, any> = {};
    applyHeldNodeGitToEntry(entry, { mesh, node, held: held(null) });
    assert.equal(entry.staleDaemonBuild?.buildCommit, OLD);
});
