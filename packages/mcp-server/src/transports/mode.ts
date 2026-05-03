import type { LocalTransport } from './local.js';
import type { CloudTransport } from './cloud.js';

/**
 * Local and cloud transports are intentionally detected by an operation that is
 * unique to standalone/local mode. CloudTransport also exposes getStatus(targetId),
 * so checking for getStatus incorrectly routes cloud tools through local code.
 */
export function isLocalTransport(
  transport: LocalTransport | CloudTransport,
): transport is LocalTransport {
  return typeof (transport as { command?: unknown }).command === 'function';
}
