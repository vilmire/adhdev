import type { CommandTransport } from '../transports/mode.js';

/** Standard operator toolset only. The daemon still requires trusted owner
 * ingress on every call; mesh/worker/assistant tools never advertise this. */
export const PROJECT_HOST_HANDOFF_TOOL = {
    name: 'project_host_handoff',
    description: 'Move the actual project main coordinator host to an owner-selected member machine. Requires an owner-authenticated local management connection. Preflight verifies target readiness; status reports durable migration state. This does not change worker routing.',
    inputSchema: { type: 'object' as const, additionalProperties: false,
        properties: {
            op: { type: 'string', enum: ['preflight', 'start', 'status', 'abort', 'retry'] },
            meshId: { type: 'string' }, targetDaemonId: { type: 'string' }, targetNodeId: { type: 'string' }, handoffId: { type: 'string' },
        }, required: ['op'] },
};

export function canAdvertiseOwnerHandoff(opts: { mode: string; password?: string; daemonAuthFile?: string; worker?: boolean; assistant?: boolean; meshId?: string }, env: NodeJS.ProcessEnv = process.env): boolean {
    return opts.mode === 'local' && !!opts.password && !opts.daemonAuthFile && !opts.worker && !opts.assistant && !opts.meshId
        && !env.ADHDEV_MCP_SESSION_CREDENTIAL && !env.ADHDEV_WORKER_SESSION_BIND && !env.ADHDEV_WORKER_TASK_TOKEN;
}

export async function projectHostHandoff(transport: CommandTransport, args: Record<string, unknown>): Promise<string> {
    const allowed = new Set(['op', 'meshId', 'targetDaemonId', 'targetNodeId', 'handoffId']);
    if (Object.keys(args).some(k => !allowed.has(k)) || !['preflight', 'start', 'status', 'abort', 'retry'].includes(String(args.op))) {
        return JSON.stringify({ success: false, code: 'invalid_args' });
    }
    return JSON.stringify(await transport.command('mesh_host_handoff', args));
}
