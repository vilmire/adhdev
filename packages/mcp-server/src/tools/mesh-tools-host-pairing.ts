// mesh_host_pairing — the supported recovery when a machine already attached to a
// project lacks the project host's artifact-signing key pin (remote artifact
// reads are then refused with host_pin_missing).
//
//   create_code   runs on the mesh host: mints a single-use pairing code (10 min).
//   pin_host_key  asks the named member machine to redeem that code against the
//                 host (pin_mesh_host_key). The member verifies the host answer
//                 itself; no key material is passed through this tool.

import type { MeshContext } from './mesh-tools-internal.js';
import { supportsMeshRelay } from '../transports/mode.js';

export const MESH_HOST_PAIRING_TOOL = {
    name: 'mesh_host_pairing',
    description: 'Fix "host_pin_missing" artifact refusals on a machine that is already attached to this project. Step 1: action=create_code on the host (returns a single-use pairing code valid 10 minutes; share it only with the owner). Step 2: action=pin_host_key with target_daemon_id (the member machine) and code; the member contacts the host with the code and stores the host\'s artifact signing key. Never pass a key; the code is the only credential and is verified by the host.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: { type: 'string', enum: ['create_code', 'pin_host_key'], description: 'create_code (on the host) or pin_host_key (on a member machine).' },
            target_daemon_id: { type: 'string', description: 'pin_host_key only: exact canonical daemon_mach_* of the member machine that must hold the pin.' },
            code: { type: 'string', description: 'pin_host_key only: the pairing code returned by create_code.' },
        },
        required: ['action'],
    },
};

export async function meshHostPairing(ctx: MeshContext, args: { action?: unknown; code?: unknown; target_daemon_id?: unknown }): Promise<string> {
    const action = typeof args?.action === 'string' ? args.action : '';
    if (action === 'create_code') {
        return JSON.stringify(await ctx.transport.command('create_mesh_host_pairing_token', { meshId: ctx.mesh.id }));
    }
    if (action === 'pin_host_key') {
        const target = typeof args?.target_daemon_id === 'string' ? args.target_daemon_id.trim() : '';
        const code = typeof args?.code === 'string' ? args.code.trim() : '';
        if (!/^daemon_mach_[a-zA-Z0-9]+$/.test(target)) {
            return JSON.stringify({ success: false, code: 'INVALID_TARGET', error: 'Pass the exact canonical daemon_mach_* of the member machine as target_daemon_id.' });
        }
        if (!code) {
            return JSON.stringify({ success: false, code: 'mesh_host_pin_token_required', error: 'Pass the pairing code from action=create_code as code.' });
        }
        if (!supportsMeshRelay(ctx.transport)) {
            return JSON.stringify({ success: false, code: 'mesh_relay_unavailable', error: 'This transport cannot reach other machines; run pin_host_key from the member machine or use the dashboard Mesh > Connect another machine card.' });
        }
        return JSON.stringify(await ctx.transport.meshCommand(target, 'pin_mesh_host_key', { meshId: ctx.mesh.id, token: code }));
    }
    return JSON.stringify({ success: false, code: 'INVALID_ARGUMENTS', error: 'action must be create_code or pin_host_key.' });
}
