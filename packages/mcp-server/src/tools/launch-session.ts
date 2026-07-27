import type { CommandTransport } from '../transports/mode.js';

export const LAUNCH_SESSION_TOOL = {
  name: 'launch_session',
  description:
    'Launch a new agent session on the daemon. Supports CLI agents (e.g. kimi, hermes-cli, claude-cli, gemini-cli), ACP agents (e.g. claude-acp), and IDEs (e.g. cursor, vscode).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        description:
          'Provider type to launch. CLI examples: kimi, hermes-cli, claude-cli, gemini-cli. ACP examples: claude-acp. IDE examples: cursor, vscode. Manifest aliases (e.g. codex → codex-cli) resolve to the canonical provider type.',
      },
      workspace: {
        type: 'string',
        description: 'Working directory for the session. Defaults to the daemon default workspace.',
      },
      model: {
        type: 'string',
        description: 'Model override for ACP agents (e.g. claude-opus-4-7).',
      },
    },
    required: ['type'],
  },
};

interface ProviderRoute {
  route: 'cli' | 'ide';
  /** Canonical provider type as declared by the daemon's provider catalog. */
  canonicalType: string;
}

/**
 * Legacy suffix heuristic kept ONLY as a fallback for older daemons that do not
 * answer `list_provider_availability` (e.g. a pre-catalog cloud daemon in ipc
 * mode). New routing decisions must come from the daemon's provider catalog —
 * canonical CLI types like `kimi` carry no `-cli` suffix and cannot be guessed.
 */
function legacyHeuristicRoute(type: string): ProviderRoute {
  const isCliOrAcp = type.includes('-cli') || type.includes('-acp') || type === 'codex';
  return { route: isCliOrAcp ? 'cli' : 'ide', canonicalType: type };
}

/**
 * Resolve the launch route (launch_cli vs launch_ide) and canonical provider
 * type from the daemon's authoritative provider catalog. An exact `type` match
 * or a manifest alias both resolve; anything else is rejected as an unknown
 * provider (fail closed — never silently route an unrecognized type to a
 * launch verb). When the catalog is unavailable the legacy heuristic applies,
 * preserving pre-fix behavior against older daemons.
 */
async function resolveProviderRoute(
  transport: CommandTransport,
  requestedType: string,
): Promise<ProviderRoute | { error: string }> {
  const type = requestedType.trim();
  if (!type) return { error: 'type is required' };
  let catalog: any;
  try {
    catalog = await transport.command('list_provider_availability', {});
  } catch {
    catalog = null;
  }
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : null;
  if (!catalog || catalog.success === false || !providers) {
    return legacyHeuristicRoute(type);
  }
  const query = type.toLowerCase();
  const hit = providers.find((p: any) => {
    if (!p || typeof p.type !== 'string') return false;
    if (p.type.toLowerCase() === query) return true;
    const aliases = Array.isArray(p.aliases) ? p.aliases : [];
    return aliases.some((alias: any) => typeof alias === 'string' && alias.toLowerCase() === query);
  });
  if (!hit) {
    const known = providers
      .map((p: any) => (p && typeof p.type === 'string' ? p.type : null))
      .filter(Boolean)
      .sort();
    return {
      error: `Unknown provider type '${type}'. Known provider types: ${known.join(', ')}`,
    };
  }
  const route = hit.category === 'cli' || hit.category === 'acp' ? 'cli' : 'ide';
  return { route, canonicalType: hit.type };
}

export async function launchSession(
  transport: CommandTransport,
  args: { type: string; workspace?: string; model?: string },
): Promise<string> {
  const resolved = await resolveProviderRoute(transport, args.type);
  if ('error' in resolved) return `Error: ${resolved.error}`;
  const commandType = resolved.route === 'cli' ? 'launch_cli' : 'launch_ide';
  const payload: Record<string, unknown> =
    resolved.route === 'cli'
      ? { cliType: resolved.canonicalType, dir: args.workspace ?? '~', ...(args.model ? { model: args.model } : {}) }
      : { ideType: resolved.canonicalType, enableCdp: true };
  const result = await transport.command(commandType, payload);
  if (result?.success === false) return `Error: ${result.error ?? 'launch failed'}`;
  const id = result?.id ?? result?.sessionId;
  return id ? `Session launched. id: ${id}, type: ${resolved.canonicalType}` : `Launched: ${JSON.stringify(result)}`;
}
