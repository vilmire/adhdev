/**
 * DevServer — CLI Debug Handlers
 *
 * Extracted from dev-server.ts for maintainability.
 * All functions take a DevServerContext as their first argument.
 */

import type * as http from 'http';
import type { DevServerContext } from './dev-server-types.js';

// ─── Helpers ──────────────────────────────────────

function findCliTarget(ctx: DevServerContext, type?: string, instanceId?: string): any | null {
  if (!ctx.instanceManager) return null;
  const cliStates = ctx.instanceManager
    .collectAllStates()
    .filter(s => s.category === 'cli' || s.category === 'acp');
  if (instanceId) return cliStates.find(s => s.instanceId === instanceId) || null;
  if (!type) return cliStates[cliStates.length - 1] || null;
  const matches = cliStates.filter(s => s.type === type);
  return matches[matches.length - 1] || null;
}

// ─── Handlers ─────────────────────────────────────

/** GET /api/cli/status — list all running CLI/ACP instances with state */
export async function handleCliStatus(ctx: DevServerContext, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available (daemon not fully initialized)' });
    return;
  }
  const allStates = ctx.instanceManager.collectAllStates();
  const cliStates = allStates.filter(s => s.category === 'cli' || s.category === 'acp');
  const result = cliStates.map(s => ({
    instanceId: s.instanceId,
    type: s.type,
    name: s.name,
    category: s.category,
    status: s.status,
    mode: s.mode,
    workspace: s.workspace,
    messageCount: s.activeChat?.messages?.length || 0,
    lastMessage: s.activeChat?.messages?.slice(-1)[0] || null,
    activeModal: s.activeChat?.activeModal || null,
    pendingEvents: s.pendingEvents || [],
    currentModel: s.currentModel,
    settings: s.settings,
  }));
  ctx.json(res, 200, { instances: result, count: result.length });
}

/** POST /api/cli/launch — launch a CLI agent { type, workingDir?, args? } */
export async function handleCliLaunch(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!ctx.cliManager) {
    ctx.json(res, 503, { error: 'CliManager not available' });
    return;
  }
  const body = await ctx.readBody(req);
  const { type, workingDir, args } = body;
  if (!type) {
    ctx.json(res, 400, { error: 'type required (e.g. claude-cli, gemini-cli)' });
    return;
  }
  try {
    await ctx.cliManager.startSession(type, workingDir || process.cwd(), args || []);
    ctx.json(res, 200, { launched: true, type, workspace: workingDir || process.cwd() });
  } catch (e: any) {
    ctx.json(res, 500, { error: `Launch failed: ${e.message}` });
  }
}

/** POST /api/cli/send — send message to a running CLI { type, text } */
export async function handleCliSend(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available' });
    return;
  }
  const body = await ctx.readBody(req);
  const { type, text, instanceId } = body;
  if (!text) {
    ctx.json(res, 400, { error: 'text required' });
    return;
  }

  const target = findCliTarget(ctx, type, instanceId);
  if (!target) {
    ctx.json(res, 404, { error: `No running instance found for: ${type || instanceId}` });
    return;
  }

  try {
    ctx.instanceManager!.sendEvent(target.instanceId, 'send_message', { text });
    ctx.json(res, 200, { sent: true, type: target.type, instanceId: target.instanceId });
  } catch (e: any) {
    ctx.json(res, 500, { error: `Send failed: ${e.message}` });
  }
}

/** POST /api/cli/stop — stop a running CLI { type } */
export async function handleCliStop(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available' });
    return;
  }
  const body = await ctx.readBody(req);
  const { type, instanceId } = body;

  const target = findCliTarget(ctx, type, instanceId);
  if (!target) {
    ctx.json(res, 404, { error: `No running instance found for: ${type || instanceId}` });
    return;
  }

  try {
    ctx.instanceManager!.removeInstance(target.instanceId);
    ctx.json(res, 200, { stopped: true, type: target.type, instanceId: target.instanceId });
  } catch (e: any) {
    ctx.json(res, 500, { error: `Stop failed: ${e.message}` });
  }
}

/** GET /api/cli/events — SSE stream of CLI status events */
export function handleCliSSE(ctx: DevServerContext, cliSSEClients: http.ServerResponse[], _req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: {"type":"connected"}\n\n');
  cliSSEClients.push(res);

  // Register event listener if first client + instanceManager available
  if (cliSSEClients.length === 1 && ctx.instanceManager) {
    ctx.instanceManager.onEvent((event) => {
      ctx.sendCliSSE(event);
    });
  }

  // Send current state snapshot immediately
  if (ctx.instanceManager) {
    const allStates = ctx.instanceManager.collectAllStates();
    const cliStates = allStates.filter(s => s.category === 'cli' || s.category === 'acp');
    for (const s of cliStates) {
      ctx.sendCliSSE({ event: 'snapshot', providerType: s.type, status: s.status, instanceId: s.instanceId });
    }
  }

  _req.on('close', () => {
    const idx = cliSSEClients.indexOf(res);
    if (idx >= 0) cliSSEClients.splice(idx, 1);
  });
}

/** GET /api/cli/debug/:type — full internal debug state of a CLI adapter */
export async function handleCliDebug(ctx: DevServerContext, type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available' });
    return;
  }

  const target = findCliTarget(ctx, type);
  if (!target) {
    const allStates = ctx.instanceManager.collectAllStates();
    ctx.json(res, 404, { error: `No running instance for: ${type}`, available: allStates.filter(s => s.category === 'cli' || s.category === 'acp').map(s => s.type) });
    return;
  }

  // Get the ProviderInstance and access adapter debug state
  const instance = ctx.instanceManager.getInstance(target.instanceId) as any;
  if (!instance) {
    ctx.json(res, 404, { error: `Instance not found: ${target.instanceId}` });
    return;
  }

  try {
    const adapter = instance.getAdapter?.() || instance.adapter;
    if (adapter && typeof adapter.getDebugState === 'function') {
      const debugState = adapter.getDebugState();
      ctx.json(res, 200, {
        instanceId: target.instanceId,
        providerState: {
          type: target.type,
          name: target.name,
          status: target.status,
          mode: 'mode' in target ? target.mode : undefined,
        },
        debug: debugState,
      });
    } else {
      // Fallback: return what we can from the state
      ctx.json(res, 200, {
        instanceId: target.instanceId,
        providerState: target,
        debug: null,
        message: 'No debug state available (adapter.getDebugState not found)',
      });
    }
  } catch (e: any) {
    ctx.json(res, 500, { error: `Debug state failed: ${e.message}` });
  }
}

/** POST /api/cli/resolve — resolve an approval modal { type, buttonIndex } */
export async function handleCliResolve(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { type, buttonIndex, instanceId } = body;
  if (buttonIndex === undefined || buttonIndex === null) {
    ctx.json(res, 400, { error: 'buttonIndex required (0=Yes, 1=Always, 2=Deny)' });
    return;
  }

  if (!ctx.cliManager) {
    ctx.json(res, 503, { error: 'CliManager not available' });
    return;
  }
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available' });
    return;
  }

  const target = findCliTarget(ctx, type, instanceId);
  if (!target) {
    ctx.json(res, 404, { error: `No running adapter for: ${type || instanceId}` });
    return;
  }

  const instance = ctx.instanceManager.getInstance(target.instanceId) as any;
  const adapter = instance?.getAdapter?.() || instance?.adapter;
  if (!adapter) {
    ctx.json(res, 404, { error: `Adapter not found for instance: ${target.instanceId}` });
    return;
  }

  try {
    if (typeof adapter.resolveModal === 'function') {
      adapter.resolveModal(buttonIndex);
      ctx.json(res, 200, { resolved: true, type: target.type, instanceId: target.instanceId, buttonIndex });
    } else {
      ctx.json(res, 400, { error: 'resolveModal not available on this adapter' });
    }
  } catch (e: any) {
    ctx.json(res, 500, { error: `Resolve failed: ${e.message}` });
  }
}

/** POST /api/cli/raw — send raw keystrokes to PTY { type, keys } */
export async function handleCliRaw(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { type, keys, instanceId } = body;
  if (!keys) {
    ctx.json(res, 400, { error: 'keys required (raw string to send to PTY)' });
    return;
  }

  if (!ctx.cliManager) {
    ctx.json(res, 503, { error: 'CliManager not available' });
    return;
  }
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available' });
    return;
  }

  const target = findCliTarget(ctx, type, instanceId);
  if (!target) {
    ctx.json(res, 404, { error: `No running adapter for: ${type || instanceId}` });
    return;
  }

  const instance = ctx.instanceManager.getInstance(target.instanceId) as any;
  const adapter = instance?.getAdapter?.() || instance?.adapter;
  if (!adapter) {
    ctx.json(res, 404, { error: `Adapter not found for instance: ${target.instanceId}` });
    return;
  }

  try {
    if (typeof adapter.writeRaw === 'function') {
      adapter.writeRaw(keys);
      ctx.json(res, 200, { sent: true, type: target.type, instanceId: target.instanceId, keysLength: keys.length });
    } else {
      ctx.json(res, 400, { error: 'writeRaw not available on this adapter' });
    }
  } catch (e: any) {
    ctx.json(res, 500, { error: `Raw send failed: ${e.message}` });
  }
}
