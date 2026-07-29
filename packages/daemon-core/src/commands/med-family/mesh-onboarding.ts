/**
 * Read-only Git-aware Repo Mesh onboarding discovery/plan command.
 */
import { detectCLIs } from '../../detection/cli-detector.js';
import { planMeshOnboarding } from '../../mesh/mesh-onboarding-plan.js';
import type { MedFamilyHandler } from './types.js';

export const meshOnboardingHandlers: Record<string, MedFamilyHandler> = {
    plan_mesh_onboarding: async (ctx, args: any) => {
        const workspace = typeof args?.workspace === 'string' && args.workspace.trim()
            ? args.workspace.trim()
            : process.cwd();
        try {
            const detectedProviders = await detectCLIs(ctx.deps.providerLoader, { includeVersion: true });
            return await planMeshOnboarding({
                workspace,
                meshId: typeof args?.meshId === 'string' ? args.meshId.trim() || undefined : undefined,
                operation: ['auto', 'add_existing', 'clone_worktree', 'create_mesh'].includes(args?.operation)
                    ? args.operation
                    : 'auto',
                branch: typeof args?.branch === 'string' ? args.branch.trim() || undefined : undefined,
                detectedProviders,
                ...(
                    Array.isArray(args?.meshInventory)
                        ? { meshes: args.meshInventory.filter((mesh: unknown) => !!mesh && typeof mesh === 'object') }
                        : args?.inlineMesh && typeof args.inlineMesh === 'object'
                            ? { meshes: [args.inlineMesh] }
                            : {}
                ),
            }) as any;
        } catch (error: any) {
            return {
                success: false,
                dryRun: true,
                code: 'git_discovery_failed',
                error: error?.message || String(error),
                action: 'Verify that Git is installed and the workspace is readable, then retry.',
            } as any;
        }
    },
};
