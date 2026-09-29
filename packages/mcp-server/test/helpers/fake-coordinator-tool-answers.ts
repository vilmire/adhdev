/**
 * The suite's fake coordinator daemons answer the two commands a tool asks the
 * coordinator directly (data-path audit 2026-09-29 P1-6):
 *
 *   mesh_status_view    — composed from the fake's OWN sub-command answers with
 *                         daemon-core's real composer (composeMeshStatusView), the
 *                         same code the daemon runs in-process;
 *   mesh_dispatch_route — decided with daemon-core's real rule
 *                         (decideDispatchRoute) over the fake's get_mesh roster;
 *   mesh_node_route     — the same rule for every node (decideNodeRoutes), and
 *                         the `routes` a real mesh_status_view carries.
 *
 * Installed for every test transport by setup-test-env.ts: assigning
 * `transport.command = fn` on an IpcTransport / LocalTransport wraps `fn` so a
 * fake that never heard of these commands still answers them. A fake that
 * answers them itself (e.g. a test counting daemon calls) is left alone.
 */
import { composeMeshStatusView, decideDispatchRoute, decideNodeRoutes } from '@adhdev/daemon-core';

type CommandFn = (command: string, args?: Record<string, unknown>) => Promise<any>;

const WRAPPED = Symbol.for('adhdev.test.fakeCoordinatorToolAnswers');

/**
 * Which daemon the fake plays: its own status instance id when it answers
 * get_status_metadata, else the daemon of the mesh's configured coordinator node.
 */
async function fakeCoordinatorDaemonId(inner: CommandFn, mesh: any): Promise<string> {
    let sessions: any[] = [];
    try {
        const status = await inner('get_status_metadata', {});
        const payload = status?.result ?? status;
        const id = payload?.status?.instanceId;
        if (typeof id === 'string' && id.trim()) return id.trim();
        sessions = Array.isArray(payload?.status?.sessions) ? payload.status.sessions : [];
    } catch { /* fall through */ }
    const nodes: any[] = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
    const preferred = nodes.find((n: any) => n?.id === mesh?.coordinator?.preferredNodeId);
    if (typeof preferred?.daemonId === 'string') return preferred.daemonId;
    // The fake's own sessions name the coordinator daemon they report to.
    for (const session of sessions) {
        const id = session?.settings?.meshCoordinatorDaemonId;
        if (typeof id === 'string' && id.trim()) return id.trim();
    }
    return '';
}

/**
 * Every node's route as the fake coordinator decides it: daemon-core's real
 * decideNodeRoutes over the nodes the tool described, as the daemon the tool
 * believes it talks to (`callerDaemonId`). Never touches the fake's own command
 * log (tests count daemon calls). null when the fake cannot say which daemon it
 * is — the tool then has no answer and applies its identity-only rule.
 */
function fakeNodeRoutes(args: { nodes?: unknown; callerDaemonId?: unknown }, roster: any[] = []): Record<string, any> | null {
    const localDaemonId = typeof args.callerDaemonId === 'string' ? args.callerDaemonId : '';
    if (!localDaemonId) return null;
    const described: any[] = Array.isArray(args.nodes) ? args.nodes as any[] : [];
    return decideNodeRoutes(roster, described, { localDaemonId, localMachineId: '', hasMeshTransport: true });
}

export function withFakeCoordinatorToolAnswers(inner: CommandFn, owner?: any): CommandFn {
    if ((inner as any)[WRAPPED]) return inner;
    const wrapped: CommandFn = async (command, args = {}) => {
        if (command === 'mesh_status_view') {
            const own = await inner(command, args).catch(() => undefined);
            if (own && own.success !== false && own.status !== undefined) return own;
            // A fake daemon has no mesh record of its own for active_work_query to
            // resolve (a real daemon reads its own); hand it the roster it serves.
            let roster: any;
            const view = await composeMeshStatusView(
                async (cmd, cmdArgs) => {
                    try {
                        const answer = await inner(cmd, cmdArgs);
                        if (cmd === 'active_work_query' && cmdArgs.includeSchedulingRuntime && !cmdArgs.mesh && answer && !answer.schedulingRuntime) {
                            roster ??= (await inner('get_mesh', { meshId: args.meshId, membershipOnly: true }).catch(() => null))?.mesh;
                            if (roster) return await inner(cmd, { ...cmdArgs, mesh: roster });
                        }
                        return answer;
                    } catch (error: any) {
                        return { success: false, error: error?.message || String(error) };
                    }
                },
                args as any,
                {
                    // The fake serves the nodes of the daemon the tool believes it talks to.
                    isLocalNode: (node: any) => (!!args.callerDaemonId && node?.daemonId === args.callerDaemonId),
                },
            );
            const rosterNodes = Array.isArray((view as any).membership?.mesh?.nodes) ? (view as any).membership.mesh.nodes : [];
            const routes = fakeNodeRoutes({ callerDaemonId: args.callerDaemonId }, rosterNodes);
            return { success: true, ...view, ...(routes ? { routes } : {}) };
        }
        if (command === 'mesh_node_route') {
            // A test playing the coordinator's routing decision itself opts in.
            if ((inner as any).answersMeshNodeRoute === true) return inner(command, args);
            const routes = fakeNodeRoutes(args as any);
            if (!routes) return { success: false, error: 'the fake cannot say which daemon it is' };
            return { success: true, meshId: args.meshId, routes };
        }
        if (command === 'mesh_dispatch_route') {
            const own = await inner(command, args).catch(() => undefined);
            if (own && typeof own.route === 'string') return own;
            let mesh: any = null;
            try { mesh = (await inner('get_mesh', { meshId: args.meshId, membershipOnly: true }))?.mesh; } catch { mesh = null; }
            const node = (Array.isArray(mesh?.nodes) ? mesh.nodes.find((n: any) => n?.id === args.nodeId) : undefined) ?? args.node;
            if (!node) return { success: false, error: `Node ${String(args.nodeId)} is not on the fake roster` };
            // The fake plays the daemon the tool believes it talks to (a real daemon uses its own id).
            const localDaemonId = typeof args.callerDaemonId === 'string' && args.callerDaemonId
                ? args.callerDaemonId
                : await fakeCoordinatorDaemonId(inner, mesh);
            // A fake that never says which daemon it is: a fake with a mesh channel
            // (meshCommand) plays a coordinator the node is remote from; one without plays the node's own daemon.
            if (!localDaemonId) {
                return typeof owner?.meshCommand === 'function' && node.daemonId
                    ? { success: true, route: 'remote', ownerDaemonId: node.daemonId, reason: 'fake_daemon_identity_unknown' }
                    : { success: true, route: 'local', reason: 'fake_daemon_identity_unknown' };
            }
            return { success: true, ...decideDispatchRoute(node, { localDaemonId, localMachineId: '', hasMeshTransport: true }) };
        }
        return inner(command, args);
    };
    (wrapped as any)[WRAPPED] = true;
    return wrapped;
}

/**
 * A plain-object fake transport with the same behavior as the patched
 * IpcTransport / LocalTransport: whatever `command` it is given (now or by a
 * later assignment) also answers mesh_status_view / mesh_dispatch_route.
 */
export function fakeCoordinatorTransport<T extends Record<string, any>>(base: T = {} as T): T {
    const initial = base.command;
    // Keep the fake's prototype (tools check `instanceof IpcTransport`) and its own fields.
    const target: any = Object.create(Object.getPrototypeOf(base));
    for (const key of Object.keys(base)) if (key !== 'command') target[key] = (base as any)[key];
    let current: CommandFn | undefined;
    Object.defineProperty(target, 'command', {
        configurable: true,
        enumerable: true,
        get() { return current; },
        set(fn: CommandFn) { current = typeof fn === 'function' ? withFakeCoordinatorToolAnswers(fn, target) : fn; },
    });
    if (typeof initial === 'function') target.command = initial;
    return target as T;
}
