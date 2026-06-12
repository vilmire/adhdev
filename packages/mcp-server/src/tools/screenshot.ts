import type { CommandTransport } from '../transports/mode.js';

export const SCREENSHOT_TOOL = {
  name: 'screenshot',
  description:
    'Capture a screenshot of the current IDE window. Returns the image.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Target session ID. Omit to use the active session.',
      },
    },
    required: [],
  },
};

export async function screenshot(
  transport: CommandTransport,
  args: { session_id?: string },
): Promise<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> {
  const result: any = await transport.command('screenshot', {
    ...(args.session_id ? { targetSessionId: args.session_id } : {}),
  });

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
