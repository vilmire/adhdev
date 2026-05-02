import type { LocalTransport } from '../transports/local.js';
import type { CloudTransport } from '../transports/cloud.js';

export const SCREENSHOT_TOOL = {
  name: 'screenshot',
  description: 'Capture a screenshot of the current IDE window. Returns the image.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Target session ID. Omit to use the active session.',
      },
      daemon_id: {
        type: 'string',
        description: 'Daemon ID (cloud mode only).',
      },
    },
    required: [],
  },
};

export async function screenshot(
  transport: LocalTransport | CloudTransport,
  args: { session_id?: string; daemon_id?: string },
): Promise<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> {
  let result: any;

  if ('command' in transport) {
    result = await (transport as LocalTransport).command('screenshot', {
      ...(args.session_id ? { targetSessionId: args.session_id } : {}),
    });
  } else {
    // CloudTransport: use shortcuts status endpoint — screenshot not on shortcuts, fall back to error
    return { type: 'text', text: 'Screenshots are not available in cloud mode. Run adhdev mcp in local mode (requires standalone daemon).' };
  }

  if (result?.success === false) {
    return { type: 'text', text: `Error: ${result.error ?? 'screenshot failed'}` };
  }

  const b64: string | undefined = result?.base64 ?? result?.screenshot ?? result?.result;
  if (!b64) {
    return { type: 'text', text: 'Screenshot captured but no image data returned.' };
  }

  const mimeType = result?.format === 'png' ? 'image/png' : 'image/webp';
  return { type: 'image', data: b64, mimeType };
}
