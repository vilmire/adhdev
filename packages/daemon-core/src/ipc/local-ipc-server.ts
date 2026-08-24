/**
 * LocalIpcServer — generic HTTP + WebSocket IPC endpoint for daemon processes.
 *
 * Both daemon-cloud and daemon-standalone need a local IPC surface so
 * external tools — the `adhdev mcp --mode ipc` MCP server and anything
 * else that wants to issue commands without going through the cloud
 * Worker — can connect over `ws://127.0.0.1:<port>/ipc`.
 *
 * Until now the implementation lived only in daemon-cloud. Standalone
 * sessions therefore couldn't host MCP mesh tools — codex/claude config
 * pointing at `--mode ipc` got `Cannot reach ipc daemon`. This module
 * moves the transport into daemon-core so both daemons can mount it.
 *
 * The transport itself is daemon-agnostic. Cloud-specific behaviors
 * (mesh relay, mandatory update gates) are injected via the caller's
 * `handleCommand` hook; the IPC layer just frames/unframes JSON and
 * routes messages.
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { LOG } from '../logging/logger.js';
import { DAEMON_WS_PATH } from '../ipc-protocol.js';

/** Parameters passed to `handleCommand` for each incoming ext:command frame. */
export interface IpcCommandContext {
    /** The raw `command` field from the message — caller decides routing. */
    command: string;
    /** Args provided by the client; may have been normalized by the caller. */
    args: Record<string, unknown>;
    /** Stable id correlating the request and the eventual ext:command_result. */
    requestId: string;
    /** The connected WebSocket — only needed if the caller wants to send extra events. */
    ws: WebSocket;
}

/** Result reported back to the client. `result` is optional context for success. */
export interface IpcCommandResult {
    success: boolean;
    result?: unknown;
    error?: string;
    /**
     * Additional fields the caller wants merged into the response payload
     * (e.g. the cloud daemon's mandatory-update-block fields). Reserved.
     */
    extra?: Record<string, unknown>;
}

/** Status payload returned from GET / on the IPC HTTP port. */
export interface IpcStatusPayload {
    ok: true;
    pid: number;
    wsPath: string;
    port: number;
    /** Arbitrary daemon-specific summary. Cloud daemon includes mesh state, etc. */
    status: Record<string, unknown> | null;
}

export interface LocalIpcServerOptions {
    /** TCP port to listen on. 19222 is the conventional default. */
    port: number;
    /** Build the GET / status payload. Called on every health probe. */
    buildStatusPayload: () => Record<string, unknown> | null;
    /** Build the welcome message sent to a freshly-connected client. */
    buildWelcomePayload: () => Record<string, unknown>;
    /** Handle a single ext:command frame. Caller decides routing and returns the result. */
    handleCommand: (ctx: IpcCommandContext) => Promise<IpcCommandResult>;
    /** Optional notification when a new client connects (lets daemon track them for broadcasts). */
    onClientConnected?: (ws: WebSocket) => void;
    /** Optional notification when a client disconnects. */
    onClientDisconnected?: (ws: WebSocket) => void;
    /** Optional logger label (defaults to "IPC"). */
    logCategory?: string;
}

/**
 * Returned controller for stopping the server and broadcasting to clients.
 * Stored by the daemon and torn down at shutdown.
 */
export interface LocalIpcServerHandle {
    /** True once `listen()` succeeded. */
    isListening(): boolean;
    /** Push a message to every connected client. */
    broadcast(type: string, payload: unknown): void;
    /** Close all client sockets + the HTTP server. */
    close(): Promise<void>;
}

/**
 * Build a JSON HTTP response describing the IPC endpoint. Exposed so caller
 * code (and tests) can build the same shape without spinning a real server.
 */
export function buildIpcStatusHttpResponse(
    method: string | undefined,
    url: string | undefined,
    payload: IpcStatusPayload,
): { statusCode: number; body: Record<string, unknown> } {
    if (method && method.toUpperCase() !== 'GET') {
        return { statusCode: 405, body: { ok: false, error: 'method not allowed' } };
    }
    // Route table mirrors the cloud daemon's local IPC HTTP responder so every
    // probe that works against daemon-cloud also works against this server:
    //   - `/health` is the liveness probe used by the MCP IpcTransport ping and
    //     the upgrade engine's pid-identity check (fetchLocalHealth).
    //   - `/api/v1/status` (and its `/api/status` alias) is the upgrade version
    //     gate: windows-atomic-upgrade.ts fetchLocalStatusVersion reads
    //     `payload.status.version` from it. Serving only `/`+`/status`+`/health`
    //     here 404'd that gate for standalone self-upgrades.
    //   - `/` and `/status` are kept for existing consumers.
    // All routes return the same full payload; query strings are ignored.
    const path = url ? url.split('?')[0] : url;
    const KNOWN_ROUTES = ['/', '/status', '/health', '/api/v1/status', '/api/status'];
    if (path && !KNOWN_ROUTES.includes(path)) {
        return { statusCode: 404, body: { ok: false, error: 'not found' } };
    }
    return { statusCode: 200, body: payload as unknown as Record<string, unknown> };
}

/**
 * Start the local IPC server. Returns a handle the caller can use to broadcast
 * events and tear down at shutdown.
 */
export async function startLocalIpcServer(opts: LocalIpcServerOptions): Promise<LocalIpcServerHandle> {
    const logCategory = opts.logCategory || 'IPC';
    const clients = new Set<WebSocket>();
    let httpServer: HttpServer | null = null;
    let wss: WebSocketServer | null = null;
    let listening = false;

    httpServer = createServer((req, res) => {
        const payload: IpcStatusPayload = {
            ok: true,
            pid: process.pid,
            wsPath: DAEMON_WS_PATH,
            port: opts.port,
            status: opts.buildStatusPayload(),
        };
        const response = buildIpcStatusHttpResponse(req.method, req.url, payload);
        const body = JSON.stringify(response.body);
        res.writeHead(response.statusCode, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Connection': 'close',
        });
        res.end(body);
    });

    wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (ws) => handleConnection(ws));

    httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
        const wsUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
        if (wsUrl.pathname !== DAEMON_WS_PATH) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }
        wss!.handleUpgrade(req, socket, head, (ws) => {
            wss!.emit('connection', ws, req);
        });
    });

    function handleConnection(ws: WebSocket): void {
        clients.add(ws);
        sendWelcome(ws);
        opts.onClientConnected?.(ws);

        ws.on('message', (raw) => {
            void handleMessage(ws, raw.toString());
        });
        ws.on('close', () => {
            clients.delete(ws);
            opts.onClientDisconnected?.(ws);
        });
        ws.on('error', () => {
            clients.delete(ws);
            opts.onClientDisconnected?.(ws);
        });
    }

    function sendWelcome(ws: WebSocket): void {
        try {
            ws.send(JSON.stringify({
                type: 'daemon:welcome',
                payload: opts.buildWelcomePayload(),
            }));
        } catch (error: any) {
            LOG.warn(logCategory, `Failed to send welcome: ${error?.message || error}`);
        }
    }

    async function handleMessage(ws: WebSocket, raw: string): Promise<void> {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        if (!msg || typeof msg !== 'object') return;

        // Re-issue welcome on client request (used by reconnecting MCP servers).
        if (msg.type === 'ext:register') {
            sendWelcome(ws);
            return;
        }
        if (msg.type !== 'ext:command') return;

        const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
        const command = typeof payload.command === 'string' ? payload.command : '';
        const args = payload.args && typeof payload.args === 'object'
            ? payload.args as Record<string, unknown>
            : {};
        const requestId = typeof payload.requestId === 'string'
            ? payload.requestId
            : typeof payload.messageId === 'string'
                ? payload.messageId
                : `ipc-${Date.now()}`;

        if (!command) {
            ws.send(JSON.stringify({
                type: 'ext:command_result',
                payload: { requestId, success: false, error: 'command required' },
            }));
            return;
        }

        try {
            const result = await opts.handleCommand({ command, args, requestId, ws });
            ws.send(JSON.stringify({
                type: 'ext:command_result',
                payload: {
                    requestId,
                    success: result.success,
                    result: result.result,
                    error: result.error,
                    ...(result.extra || {}),
                },
            }));
        } catch (error: any) {
            ws.send(JSON.stringify({
                type: 'ext:command_result',
                payload: {
                    requestId,
                    success: false,
                    error: error?.message || String(error),
                },
            }));
        }
    }

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            httpServer?.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            httpServer?.off('error', onError);
            listening = true;
            resolve();
        };
        httpServer!.once('error', onError);
        httpServer!.once('listening', onListening);
        httpServer!.listen(opts.port, '127.0.0.1');
    });

    LOG.info(logCategory, `Local IPC listening on ws://127.0.0.1:${opts.port}${DAEMON_WS_PATH}`);

    return {
        isListening: () => listening,
        broadcast(type, payload) {
            const message = JSON.stringify({ type, payload });
            for (const client of clients) {
                if (client.readyState !== WebSocket.OPEN) continue;
                try { client.send(message); } catch { /* drop silently */ }
            }
        },
        async close() {
            for (const client of clients) {
                try { client.close(); } catch { /* ignore */ }
            }
            clients.clear();
            await new Promise<void>((resolve) => {
                if (!httpServer) { resolve(); return; }
                httpServer.close(() => resolve());
            });
            httpServer = null;
            wss = null;
            listening = false;
        },
    };
}
