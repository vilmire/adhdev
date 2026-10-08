/**
 * RF-ROUTER LOW family — coordinator prompt preview.
 *
 * The per-machine override/append file commands (`list_coordinator_prompts`,
 * `write_coordinator_prompt`) were removed on 2026-10-08 together with the
 * `<configDir>/coordinator-prompts/` layer; existing files are ignored.
 */
import type { LowFamilyContext, LowFamilyHandler } from './types.js';
import { defineCommandSpecs } from '../command-registry.js';

export const coordinatorPromptHandlers: Record<string, LowFamilyHandler> = {
    /**
     * Render the coordinator system prompt for a mesh + CLI type, so the
     * dashboard can show the operator exactly what a coordinator session
     * receives by default. This resolves the mesh, applies its repo-mesh
     * config, and runs the SAME buildCoordinatorSystemPrompt the launch path
     * uses — minus the runtime-only best-effort sections (mission / recent
     * activity / operating notes), which are launch-scope and not part of the
     * static "default base" an operator is trying to preview here.
     *
     * It includes the mesh-level append (`systemPromptAppend`), so the preview
     * reflects the effective prompt: with no append configured it shows the
     * pure daemon default.
     */
    coordinator_prompt_preview: async (ctx: LowFamilyContext, args: any) => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const cliType = typeof args?.cliType === 'string' && args.cliType.trim() ? args.cliType.trim() : 'claude-cli';
        if (!meshId) return { success: false, error: 'meshId required' };
        try {
            // Prefer the router-bound resolver (inline cache aware); fall back to
            // local config when a bare context is used (e.g. unit tests).
            let mesh: any = null;
            if (ctx.getMeshForCommand) {
                const resolved = await ctx.getMeshForCommand(meshId);
                mesh = resolved?.mesh ?? null;
            }
            if (!mesh) {
                const { getMesh } = await import('../../config/mesh-config.js');
                mesh = getMesh(meshId);
            }
            if (!mesh) return { success: false, error: `mesh not found: ${meshId}` };

            // Apply the on-disk repo-mesh config overlay exactly as launch does,
            // so policy/nodes reflect the effective mesh.
            let effectiveMesh = mesh;
            try {
                const { loadRepoMeshJsonConfig, applyRepoMeshConfig } = await import('../../config/mesh-json-config.js');
                const workspace = typeof mesh?.workspace === 'string' ? mesh.workspace : undefined;
                if (workspace) {
                    const loaded = loadRepoMeshJsonConfig(workspace);
                    if (loaded?.sourceType !== 'invalid') {
                        effectiveMesh = applyRepoMeshConfig(mesh, loaded?.config);
                    }
                }
            } catch { /* overlay is best-effort — fall back to the raw mesh */ }

            const { buildCoordinatorSystemPrompt } = await import('../../mesh/coordinator-prompt.js');
            const prompt = buildCoordinatorSystemPrompt({ mesh: effectiveMesh, coordinatorCliType: cliType });
            return { success: true, prompt, cliType, meshId, bytes: Buffer.byteLength(prompt, 'utf8') };
        } catch (error: any) {
            return { success: false, error: error?.message || String(error) };
        }
    },
};

export const coordinatorPromptSpecs = defineCommandSpecs('low', coordinatorPromptHandlers, {}, { meshSender: 'authenticated_peer' });
