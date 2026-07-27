/**
 * RF-ROUTER LOW family — coordinator-prompt override/append file commands.
 *
 * Extracted verbatim from DaemonCommandRouter.executeDaemonCommand. Both handlers
 * read/write only the on-disk <configDir>/coordinator-prompts directory (no router
 * instance state) and return the same CommandRouterResult the inlined cases did.
 * The directory follows the instance config dir so one instance's prompt
 * overrides never rewrite another's.
 */
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

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
     * It respects mesh-level and user-file override/append layering, so the
     * preview reflects the effective prompt: with no overrides configured it
     * shows the pure daemon default; with an override set it shows that.
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

    list_coordinator_prompts: async (_ctx: LowFamilyContext, _args: any) => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { getConfigDir } = await import('../../config/config.js');
        const dir = path.join(getConfigDir(), 'coordinator-prompts');
        const entries: Record<string, { override: string; append: string }> = {};
        try {
            if (fs.existsSync(dir)) {
                for (const name of fs.readdirSync(dir)) {
                    // Bucket files into <key>.{md|append.md}; ignore others
                    // so a stray README or .DS_Store doesn't show up.
                    const matchOverride = name.match(/^([a-zA-Z0-9_.-]+)\.md$/);
                    const matchAppend = name.match(/^([a-zA-Z0-9_.-]+)\.append\.md$/);
                    // append-pattern wins when both match (file is `.append.md`).
                    const m = matchAppend || matchOverride;
                    if (!m) continue;
                    const isAppend = !!matchAppend;
                    const key = m[1];
                    const full = path.join(dir, name);
                    let content = '';
                    try { content = fs.readFileSync(full, 'utf8'); } catch { /* skip */ }
                    if (!entries[key]) entries[key] = { override: '', append: '' };
                    if (isAppend) entries[key].append = content;
                    else entries[key].override = content;
                }
            }
        } catch (error: any) {
            return { success: false, error: error?.message || String(error) };
        }
        return { success: true, dir, entries };
    },

    write_coordinator_prompt: async (_ctx: LowFamilyContext, args: any) => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { getConfigDir } = await import('../../config/config.js');
        const key = typeof args?.key === 'string' ? args.key.trim() : '';
        const kind = args?.kind === 'append' ? 'append' : 'override';
        const content = typeof args?.content === 'string' ? args.content : '';
        // Whitelist key chars so a malicious caller can't write
        // ../../etc/passwd. Same charset readUserPromptFile accepts.
        if (!key || !/^[a-zA-Z0-9_.-]+$/.test(key)) {
            return { success: false, error: 'key must match [a-zA-Z0-9_.-]+' };
        }
        const dir = path.join(getConfigDir(), 'coordinator-prompts');
        const filename = kind === 'append' ? `${key}.append.md` : `${key}.md`;
        const full = path.join(dir, filename);
        try {
            fs.mkdirSync(dir, { recursive: true });
            if (content.trim()) {
                fs.writeFileSync(full, content, { encoding: 'utf8', mode: 0o600 });
            } else if (fs.existsSync(full)) {
                // Empty content = "reset to default" — delete the file
                // so the daemon's readUserPromptFile path falls through.
                fs.unlinkSync(full);
            }
            return { success: true, path: full, kind, key };
        } catch (error: any) {
            return { success: false, error: error?.message || String(error) };
        }
    },
};
