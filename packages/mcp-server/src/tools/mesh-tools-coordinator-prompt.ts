// Mesh tool implementations — coordinator prompt (user-level, APPEND ONLY).
//
// Coordinator prompt files live per-machine at
// ~/.adhdev/coordinator-prompts/<cli>.{md,append.md} on the daemon the MCP server
// talks to (see oss/packages/daemon-core/src/commands/low-family/coordinator-prompt.ts
// and readUserPromptFile() in oss/packages/daemon-core/src/mesh/coordinator-prompt.ts).
// They are daemon-local config, not mesh config, so these tools are driven off the raw
// ctx.transport (same pattern as mesh_refine_batch / mesh_remove_node) rather than a
// specific mesh node.
//
// ★SECURITY BOUNDARY (owner decision, do not widen): only the APPEND file is exposed
// to a coordinator agent via MCP. The OVERRIDE file (which wholesale-replaces the
// daemon's base coordinator prompt) is intentionally never exposed here — a
// self-modifying coordinator that can override its own base prompt could accidentally
// erase its own operating rules. Append-only makes that structurally impossible: the
// tool schemas below have no override field, and the daemon commands are invoked with
// kind: 'append' hardcoded, never read from caller input. If you are tempted to add an
// override parameter, stop — this is a deliberate safety boundary, not an oversight.

import type { MeshContext } from './mesh-tools-internal.js';
import { readString, unwrapCommandPayload } from './mesh-tools-internal.js';

const DEFAULT_CLI_TYPE_KEY = 'default';

export async function meshCoordinatorPromptAppendGet(
    ctx: MeshContext,
    args: { cli_type?: string } = {},
): Promise<string> {
    const key = readString(args.cli_type) || DEFAULT_CLI_TYPE_KEY;
    const result = unwrapCommandPayload(await ctx.transport.command('list_coordinator_prompts', {}));
    if (!result?.success) {
        return JSON.stringify({ success: false, error: result?.error || 'list_coordinator_prompts failed' }, null, 2);
    }
    const entry = result.entries?.[key];
    return JSON.stringify({
        success: true,
        cli_type: key,
        append: entry?.append || '',
        dir: result.dir,
    }, null, 2);
}

/**
 * Write (or clear) the user-level APPEND file for a CLI type. Always stacks after
 * whichever base prompt wins (daemon default, or a mesh-level / user-level override)
 * — it can never replace the base. Empty content deletes the file (same "reset to
 * default" contract as the dashboard editor).
 */
export async function meshCoordinatorPromptAppendSet(
    ctx: MeshContext,
    args: { cli_type?: string; content?: string },
): Promise<string> {
    const key = readString(args.cli_type) || DEFAULT_CLI_TYPE_KEY;
    const content = typeof args.content === 'string' ? args.content : '';
    const result = unwrapCommandPayload(await ctx.transport.command('write_coordinator_prompt', {
        key,
        kind: 'append',
        content,
    }));
    if (!result?.success) {
        return JSON.stringify({ success: false, error: result?.error || 'write_coordinator_prompt failed' }, null, 2);
    }
    return JSON.stringify({
        success: true,
        cli_type: key,
        cleared: !content.trim(),
        path: result.path,
    }, null, 2);
}
