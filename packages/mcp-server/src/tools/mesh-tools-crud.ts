// Mesh tool implementations — bootstrap CRUD domain (mesh_create / mesh_add_node).
//
// These two tools let an MCP-only agent bootstrap a mesh from scratch: create the
// mesh record, then register the first (base) node. Unlike every other mesh tool,
// they do NOT require an existing MeshContext — mesh_create is by definition called
// when no mesh exists yet. They are therefore driven off the raw daemon transport so
// they can be dispatched in BOTH standard mode (adhdev mcp, no --repo-mesh) and mesh
// mode (adhdev mcp --repo-mesh <id>). See server.ts for the boot-gate note: mesh_create
// is only reachable in standard mode / against an already-created mesh, because mesh
// mode itself refuses to boot without an existing meshId.
//
// Both wrap med-family daemon commands (create_mesh / add_mesh_node, handled in
// daemon-core commands/med-family/mesh-crud.ts). The daemon owns validation, ID
// generation and persistence to ~/.adhdev/meshes.json; we only shape the input and
// surface the returned ids so the agent can chain the next step.

import type { CommandTransport } from '../transports/mode.js';
import { unwrapCommandPayload } from './mesh-session-helpers.js';

/**
 * mesh_create — create a new mesh for a Git repository.
 *
 * Mirrors `adhdev mesh create <name>` plus its `--add-current` convenience: after
 * the mesh is created, optionally register the current working directory (or an
 * explicit `workspace`) as the first node in one call. Returns `mesh_id` (and the
 * first `node_id` when add_current is used) so the agent can chain mesh_add_node /
 * mesh mode next.
 */
export async function meshCreate(
    transport: CommandTransport,
    args: {
        name: string;
        repo_remote_url?: string;
        repo_identity?: string;
        default_branch?: string;
        add_current?: boolean;
        workspace?: string;
    },
): Promise<string> {
    const name = typeof args?.name === 'string' ? args.name.trim() : '';
    if (!name) {
        return JSON.stringify({ success: false, error: 'name required' }, null, 2);
    }

    const repoRemoteUrl = typeof args?.repo_remote_url === 'string' ? args.repo_remote_url.trim() : '';
    const repoIdentity = typeof args?.repo_identity === 'string' ? args.repo_identity.trim() : '';
    const defaultBranch = typeof args?.default_branch === 'string' ? args.default_branch.trim() : '';
    if (!repoRemoteUrl && !repoIdentity) {
        return JSON.stringify({
            success: false,
            error: 'Either repo_remote_url or repo_identity is required. Pass the repo\'s git remote URL (e.g. git@github.com:user/repo.git) or an explicit identity (e.g. github.com/user/repo).',
        }, null, 2);
    }

    const createResult = await transport.command('create_mesh', {
        name,
        ...(repoRemoteUrl ? { repoRemoteUrl } : {}),
        ...(repoIdentity ? { repoIdentity } : {}),
        ...(defaultBranch ? { defaultBranch } : {}),
    });
    const createPayload = unwrapCommandPayload(createResult);
    const mesh = createPayload?.mesh;
    if (!createPayload?.success || !mesh?.id) {
        return JSON.stringify({
            success: false,
            error: createPayload?.error || 'create_mesh failed',
            raw: createPayload ?? createResult,
        }, null, 2);
    }

    const out: Record<string, unknown> = {
        success: true,
        mesh_id: mesh.id,
        name: mesh.name,
        repo_identity: mesh.repoIdentity,
        default_branch: mesh.defaultBranch,
        node_count: Array.isArray(mesh.nodes) ? mesh.nodes.length : 0,
        next_step: `Add the base node with mesh_add_node (mesh_id: "${mesh.id}", workspace: <repo path>), then start mesh mode with: adhdev mcp --repo-mesh ${mesh.id}`,
    };

    // --add-current parity: register the caller's workspace as the first node.
    if (args?.add_current === true) {
        const workspace = typeof args?.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : '';
        const addResult = await transport.command('add_mesh_node', {
            meshId: mesh.id,
            ...(workspace ? { workspace } : {}),
            inlineMesh: mesh,
        });
        const addPayload = unwrapCommandPayload(addResult);
        if (addPayload?.success && addPayload?.node?.id) {
            out.node_id = addPayload.node.id;
            out.node_workspace = addPayload.node.workspace;
        } else {
            out.add_current_error = addPayload?.error || 'add_mesh_node failed (mesh was still created)';
        }
    }

    return JSON.stringify(out, null, 2);
}

/**
 * mesh_add_node — register a workspace as a node in an existing mesh.
 *
 * Mirrors `adhdev mesh add-node <mesh_id>` and its `--workspace / --read-only /
 * --provider-priority` flags. `mesh_id` is required in standard mode; in mesh mode it
 * defaults to the active mesh. Returns the created `node_id` and workspace so the
 * agent can immediately target it with mesh_launch_session / mesh_send_task.
 */
export async function meshAddNode(
    transport: CommandTransport,
    args: {
        mesh_id?: string;
        workspace: string;
        read_only?: boolean;
        provider_priority?: string[] | string;
        is_worktree?: boolean;
        inline_mesh?: unknown;
    },
    defaultMeshId?: string,
): Promise<string> {
    const meshId = (typeof args?.mesh_id === 'string' && args.mesh_id.trim())
        ? args.mesh_id.trim()
        : (typeof defaultMeshId === 'string' ? defaultMeshId.trim() : '');
    const workspace = typeof args?.workspace === 'string' ? args.workspace.trim() : '';
    if (!meshId) {
        return JSON.stringify({ success: false, error: 'mesh_id required (create one first with mesh_create).' }, null, 2);
    }
    if (!workspace) {
        return JSON.stringify({ success: false, error: 'workspace required (absolute path to the repo checkout on the target daemon).' }, null, 2);
    }

    const providerPriority = Array.isArray(args?.provider_priority)
        ? args.provider_priority.map(v => typeof v === 'string' ? v.trim() : '').filter(Boolean)
        : (typeof args?.provider_priority === 'string'
            ? args.provider_priority.split(',').map(v => v.trim()).filter(Boolean)
            : []);

    const addResult = await transport.command('add_mesh_node', {
        meshId,
        workspace,
        ...(args?.read_only === true ? { readOnly: true } : {}),
        ...(providerPriority.length ? { providerPriority } : {}),
        ...(args?.is_worktree === true ? { isLocalWorktree: true } : {}),
        ...(args?.inline_mesh ? { inlineMesh: args.inline_mesh } : {}),
    });
    const addPayload = unwrapCommandPayload(addResult);
    if (!addPayload?.success || !addPayload?.node?.id) {
        return JSON.stringify({
            success: false,
            error: addPayload?.error || 'add_mesh_node failed',
            code: addPayload?.code,
            raw: addPayload ?? addResult,
        }, null, 2);
    }

    return JSON.stringify({
        success: true,
        mesh_id: meshId,
        node_id: addPayload.node.id,
        workspace: addPayload.node.workspace,
        read_only: addPayload.node.policy?.readOnly === true,
        provider_priority: addPayload.node.policy?.providerPriority,
        next_step: `Node registered. Launch an agent on it with mesh_launch_session (node_id: "${addPayload.node.id}") or delegate work with mesh_send_task / mesh_enqueue_task.`,
    }, null, 2);
}
