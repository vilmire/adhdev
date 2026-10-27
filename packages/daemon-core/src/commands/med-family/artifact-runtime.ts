/**
 * Artifact command runtime accessors (store injection per router deps).
 *
 * Leaf module shared by `artifacts.ts` and `artifact-sharing.ts`. It must not
 * import either of them: `artifacts.ts` builds its handler table from
 * `artifact-sharing.ts` exports at module-evaluation time, so a value import
 * from `artifact-sharing.ts` back into `artifacts.ts` forms a cycle that throws
 * `ReferenceError: Cannot access 'handleArtifactIndexForwarded' before
 * initialization` whenever `artifact-sharing.ts` is the first module loaded.
 */

import { ArtifactStore } from '../../artifacts/index.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import type { CommandRouterDeps } from '../router.js';
import type { MedFamilyContext } from './types.js';

export type ArtifactCommandContext = Pick<
    MedFamilyContext,
    'deps' | 'getMeshForCommand' | 'getCachedInlineMesh'
>;

export interface ArtifactCommandRuntime {
    readonly artifactStore?: ArtifactStore;
    readonly meshRuntimeStore?: MeshRuntimeStore;
}

const ARTIFACT_RUNTIME_BY_DEPS_KEY = Symbol.for('adhdev.daemon-core.artifactCommandRuntimeByDeps');
function getRuntimeByDepsMap(): WeakMap<CommandRouterDeps, ArtifactCommandRuntime> {
    const g = globalThis as Record<symbol, WeakMap<CommandRouterDeps, ArtifactCommandRuntime> | undefined>;
    let map = g[ARTIFACT_RUNTIME_BY_DEPS_KEY];
    if (!map) {
        map = new WeakMap<CommandRouterDeps, ArtifactCommandRuntime>();
        Object.defineProperty(globalThis, ARTIFACT_RUNTIME_BY_DEPS_KEY, {
            value: map,
            writable: false,
            enumerable: false,
            configurable: false,
        });
    }
    return map;
}
const runtimeByDeps = getRuntimeByDepsMap();

/** Optional test/embedding injection hook for custom store instances per router deps. */
export function setArtifactCommandRuntimeForDeps(
    deps: CommandRouterDeps,
    runtime: ArtifactCommandRuntime | null,
): void {
    if (!runtime) {
        runtimeByDeps.delete(deps);
        return;
    }
    runtimeByDeps.set(deps, runtime);
}

export function getMeshRuntimeStore(ctx: ArtifactCommandContext): MeshRuntimeStore {
    const injected = ctx.deps ? runtimeByDeps.get(ctx.deps)?.meshRuntimeStore : undefined;
    return injected ?? MeshRuntimeStore.getInstance();
}

export function getArtifactStore(ctx: ArtifactCommandContext): ArtifactStore {
    if (ctx.deps) {
        const existing = runtimeByDeps.get(ctx.deps)?.artifactStore;
        if (existing) return existing;
    }
    const meshStore = getMeshRuntimeStore(ctx);
    const store = new ArtifactStore(meshStore.db);
    if (ctx.deps) {
        const prev = runtimeByDeps.get(ctx.deps) ?? {};
        runtimeByDeps.set(ctx.deps, { ...prev, artifactStore: store });
    }
    return store;
}
