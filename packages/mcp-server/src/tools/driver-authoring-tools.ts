/**
 * Worker-only driver authoring tools (docs/design/2026-10-29-driver-authoring-and-sharing.md).
 * Credentials come from the MCP launch, never model arguments. Nothing here can
 * activate a driver: install stages an activation request the OWNER approves.
 */
import type { CommandTransport } from '../transports/mode.js';

const OBJ = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false });

export const DRIVER_SCAFFOLD_TOOL = {
  name: 'driver_scaffold',
  description: 'Create a driver package in the workspace that wraps an EXISTING MCP stdio server command (provider.v1.json + guidance). You must list the actions (MCP tool names) yourself; the daemon does not run the command to discover them. Unspecified risk defaults to "write". The package is inert until the owner approves its activation.',
  inputSchema: OBJ({
    type: { type: 'string', description: 'Lowercase kebab-case driver type, e.g. "my-browser".' },
    name: { type: 'string', description: 'Human-readable driver name.' },
    command: { type: 'string', description: 'Executable that starts the MCP stdio server (e.g. "npx", "node").' },
    args: { type: 'array', items: { type: 'string' }, description: 'Arguments. Use "./path" for files shipped inside the package.' },
    env: { type: 'array', items: { type: 'string' }, description: 'Names of parent environment variables the server may inherit.' },
    actions: { type: 'array', minItems: 1, items: OBJ({
      id: { type: 'string', description: 'Action id (^[a-z][a-z0-9_-]*$).' },
      tool: { type: 'string', description: 'MCP tool name the action calls.' },
      risk: { type: 'string', enum: ['read', 'write', 'destructive'] },
    }, ['id', 'tool']) },
    declared_access: OBJ({
      network: { type: 'array', items: { type: 'string' } },
      filesystem: { type: 'array', items: { type: 'string' } },
      desktopControl: { type: 'boolean' },
    }, []),
    guidance: { type: 'string', description: 'Usage notes for agents (markdown).' },
    dir: { type: 'string', description: 'Workspace-relative target directory (default drivers/<type>). Must not exist.' },
  }, ['type', 'name', 'command', 'actions']),
};
export const DRIVER_VALIDATE_TOOL = {
  name: 'driver_validate',
  description: 'Validate a driver package directory in the workspace (manifest schema, referenced files, no symlinks, size limits) and show what the owner will see: tree digest, risk class and reasons, declared access.',
  inputSchema: OBJ({ dir: { type: 'string', description: 'Workspace-relative package directory.' } }, ['dir']),
};
export const DRIVER_EXPORT_TOOL = {
  name: 'driver_export',
  description: 'Export a driver package directory as one shareable bundle file (<type>.driver-bundle.json, digest-bound). Then call artifact_register on the returned path to share it; another machine installs it with driver_install {artifact_id}.',
  inputSchema: OBJ({
    dir: { type: 'string', description: 'Workspace-relative package directory.' },
    out: { type: 'string', description: 'Workspace-relative .json output (default driver-bundles/<type>.driver-bundle.json).' },
  }, ['dir']),
};
export const DRIVER_INSTALL_TOOL = {
  name: 'driver_install',
  description: 'Install a driver on THIS machine from a workspace package directory, a bundle file, or a shared bundle artifact — no daemon restart. The driver is NOT active: an activation request is staged for the owner (dashboard "needs you"), and driver_invoke refuses it until approved. You cannot approve it. Tell the owner what to approve.',
  inputSchema: OBJ({
    dir: { type: 'string', description: 'Workspace-relative package directory.' },
    path: { type: 'string', description: 'Workspace-relative bundle (.driver-bundle.json) file.' },
    artifact_id: { type: 'string', description: 'Bundle artifact id (art_*), e.g. one the coordinator named in input_artifact_ids.' },
  }, []),
};

export type DriverAuthoringTool = 'driver_scaffold' | 'driver_validate' | 'driver_export' | 'driver_install';

export async function callDriverAuthoringTool(transport: CommandTransport, tool: DriverAuthoringTool, args: Record<string, unknown>,
  credentials: { bind?: string; token?: string } = {}): Promise<{ text: string; isError?: boolean }> {
  const payload: Record<string, unknown> = tool === 'driver_scaffold'
    ? { type: args.type, name: args.name, command: args.command, actions: args.actions,
        ...(args.args !== undefined ? { args: args.args } : {}), ...(args.env !== undefined ? { env: args.env } : {}),
        ...(args.declared_access !== undefined ? { declaredAccess: args.declared_access } : {}),
        ...(args.guidance !== undefined ? { guidance: args.guidance } : {}), ...(args.dir !== undefined ? { dir: args.dir } : {}) }
    : tool === 'driver_validate' ? { dir: args.dir }
    : tool === 'driver_export' ? { dir: args.dir, ...(args.out !== undefined ? { out: args.out } : {}) }
    : { ...(args.dir !== undefined ? { dir: args.dir } : {}), ...(args.path !== undefined ? { path: args.path } : {}),
        ...(args.artifact_id !== undefined ? { artifactId: args.artifact_id } : {}) };
  const result: any = await transport.command(tool, { ...payload, ...credentials });
  return { text: JSON.stringify(result), ...(result?.success === true ? {} : { isError: true }) };
}
