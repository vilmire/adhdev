/**
 * Regression (mission b295ce35 U5): `artifacts.ts` builds `artifactHandlers`
 * from `artifact-sharing.ts` exports at module-evaluation time. When
 * `artifact-sharing.ts` imported values back from `artifacts.ts`, loading
 * `artifact-sharing.ts` first threw `ReferenceError: Cannot access
 * 'handleArtifactIndexForwarded' before initialization` under native ESM (and
 * silently registered `undefined` handlers under vitest's module runner).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('artifact command module graph', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('registers the forwarded-index and origin-fetch handlers when artifact-sharing.ts is loaded first', async () => {
        const sharing = await import('../../src/commands/med-family/artifact-sharing.js');
        const artifacts = await import('../../src/commands/med-family/artifacts.js');
        expect(typeof sharing.handleArtifactIndexForwarded).toBe('function');
        expect(artifacts.artifactHandlers.artifact_index_forwarded).toBe(sharing.handleArtifactIndexForwarded);
        expect(artifacts.artifactHandlers.artifact_fetch_origin).toBe(sharing.handleArtifactFetchOrigin);
    });

    it('keeps the store accessors reachable from artifacts.ts for existing importers', async () => {
        const artifacts = await import('../../src/commands/med-family/artifacts.js');
        const runtime = await import('../../src/commands/med-family/artifact-runtime.js');
        expect(artifacts.getArtifactStore).toBe(runtime.getArtifactStore);
        expect(artifacts.getMeshRuntimeStore).toBe(runtime.getMeshRuntimeStore);
        expect(artifacts.setArtifactCommandRuntimeForDeps).toBe(runtime.setArtifactCommandRuntimeForDeps);
    });
});
