// SDK client-path smoke probe: issue `driver_list` exactly once over a daemon's
// existing local command transport and report whether the command succeeded.
//
//   standalone → POST http://127.0.0.1:<port>/api/v1/command  { type, payload }
//   cloud      → WS   ws://127.0.0.1:<port>/ipc  ext:command → ext:command_result
//
// Both transports are OSS daemon surfaces, so the probe lives in the OSS tree:
// OSS-only clones (and the OSS CI) can test it, and a host boot-smoke script
// can import it instead of carrying its own copy.

import WebSocket from 'ws';

export async function probeDriverList(target, port, timeoutMs = 3000) {
  if (target === 'standalone') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'driver_list', payload: {} }), signal: controller.signal,
      });
      const result = await response.json();
      return response.ok && result?.success === true;
    } catch { return false; }
    finally { clearTimeout(timer); }
  }
  return new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ipc`);
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.terminate(); resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('open', () => socket.send(JSON.stringify({ type: 'ext:command',
      payload: { command: 'driver_list', args: {}, requestId: 'boot-smoke-driver-list' } })));
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'ext:command_result' && message.payload?.requestId === 'boot-smoke-driver-list') {
          finish(message.payload.success === true && message.payload.result?.success !== false);
        }
      } catch { finish(false); }
    });
  });
}
