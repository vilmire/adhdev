#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  SessionHostServer: () => SessionHostServer
});
module.exports = __toCommonJS(index_exports);
var import_crypto = require("crypto");
var fs4 = __toESM(require("fs"));
var os3 = __toESM(require("os"));
var path2 = __toESM(require("path"));
var import_session_host_core3 = require("@adhdev/session-host-core");

// src/server.ts
var import_events = require("events");
var fs3 = __toESM(require("fs"));
var net = __toESM(require("net"));
var import_session_host_core2 = require("@adhdev/session-host-core");

// src/runtime.ts
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var pty = __toESM(require("node-pty"));
var import_session_host_core = require("@adhdev/session-host-core");
var terminalMirrorFactory;
var terminalMirrorWarning = null;
var terminalMirrorBackendLogged = false;
(0, import_session_host_core.ensureNodePtySpawnHelperPermissions)((msg) => console.log(`[session-host] ${msg}`));
function logTerminalMirrorBackend(message, level = "info") {
  if (terminalMirrorBackendLogged) return;
  terminalMirrorBackendLogged = true;
  const prefix = "[session-host]";
  if (level === "warn") console.warn(`${prefix} ${message}`);
  else console.log(`${prefix} ${message}`);
}
var buildRuntimeEnv = import_session_host_core.sanitizeSpawnEnv;
function computeTerminalQueryTail(buffer) {
  const prefixes = ["\x1B[6n", "\x1B[?6n"];
  const maxLength = prefixes.reduce((n, value) => Math.max(n, value.length), 0) - 1;
  const start = Math.max(0, buffer.length - maxLength);
  for (let i = start; i < buffer.length; i++) {
    const suffix = buffer.slice(i);
    if (prefixes.some((pattern) => suffix.length < pattern.length && pattern.startsWith(suffix))) {
      return suffix;
    }
  }
  return "";
}
function formatXtermViewportPlain(terminal, rows) {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY || 0);
  const end = Math.max(start, Math.min(buffer.length || 0, start + Math.max(1, rows | 0)));
  const lines = [];
  for (let i = start; i < end; i++) {
    const line = buffer.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }
  let first = 0;
  let last = lines.length;
  while (first < last && !lines[first]?.trim()) first++;
  while (last > first && !lines[last - 1]?.trim()) last--;
  return lines.slice(first, last).join("\r\n");
}
function createXtermSerializeAddon(terminal) {
  try {
    const mod = require("@xterm/addon-serialize");
    const SerializeAddon = mod.SerializeAddon || mod.default?.SerializeAddon || mod.default;
    if (!SerializeAddon) return null;
    const addon = new SerializeAddon();
    terminal.loadAddon(addon);
    return addon;
  } catch {
    return null;
  }
}
function formatCursorRestore(terminal, rows) {
  const buffer = terminal.buffer.active;
  const row = Math.max(0, Math.min(Math.max(0, rows | 0) - 1, buffer.cursorY || 0));
  const col = Math.max(0, buffer.cursorX || 0);
  return `\x1B[${row + 1};${col + 1}H`;
}
function serializeXtermViewport(terminal, serializer, rows) {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY || 0);
  const end = Math.max(start, Math.min(Math.max(0, buffer.length || 0) - 1, start + Math.max(1, rows | 0) - 1));
  if (end < start) return "";
  const viewport = serializer.serialize({
    range: { start, end },
    excludeModes: true
  });
  return `${viewport}${formatCursorRestore(terminal, rows)}`;
}
function createXtermMirror(options) {
  const mod = require("@xterm/xterm");
  const Terminal = mod.Terminal || mod.default?.Terminal || mod.default;
  if (!Terminal) {
    throw new Error("@xterm/xterm Terminal export not found");
  }
  let currentRows = Math.max(1, options.rows | 0);
  const terminal = new Terminal({
    cols: Math.max(1, options.cols | 0),
    rows: currentRows,
    scrollback: Math.max(0, options.scrollback | 0)
  });
  const serializer = createXtermSerializeAddon(terminal);
  return {
    write(data) {
      if (!data) return;
      terminal.write(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    },
    resize(cols, rows) {
      currentRows = Math.max(1, rows | 0);
      terminal.resize(Math.max(1, cols | 0), currentRows);
    },
    formatVT() {
      if (serializer) return serializeXtermViewport(terminal, serializer, currentRows);
      return formatXtermViewportPlain(terminal, currentRows);
    },
    getCursorPosition() {
      const buffer = terminal.buffer.active;
      return {
        col: Math.max(0, buffer.cursorX || 0),
        row: Math.max(0, buffer.cursorY || 0)
      };
    },
    dispose() {
      serializer?.dispose();
      terminal.dispose();
    }
  };
}
function normalizeGhosttyBinding(mod) {
  const raw = mod?.default?.createTerminal ? mod.default : mod?.createTerminal ? mod : null;
  if (!raw) return null;
  return {
    createTerminal(options) {
      const handle = raw.createTerminal(options);
      const viewportSnapshot = createXtermMirror(options);
      return {
        write(data) {
          handle.write(data);
          viewportSnapshot.write(data);
        },
        resize(cols, rows) {
          handle.resize(cols, rows);
          viewportSnapshot.resize(cols, rows);
        },
        formatVT() {
          return viewportSnapshot.formatVT();
        },
        getCursorPosition() {
          if (typeof handle.getCursorPosition === "function") return handle.getCursorPosition();
          return viewportSnapshot.getCursorPosition();
        },
        dispose() {
          handle.dispose();
          viewportSnapshot.dispose();
        }
      };
    }
  };
}
function getTerminalMirrorFactory() {
  if (terminalMirrorFactory) return terminalMirrorFactory;
  if (terminalMirrorFactory === null) {
    throw new Error(terminalMirrorWarning || "No terminal mirror backend available");
  }
  try {
    const ghosttyMod = require("@adhdev/ghostty-vt-node");
    const binding = normalizeGhosttyBinding(ghosttyMod);
    if (!binding) {
      throw new Error("@adhdev/ghostty-vt-node does not export createTerminal()");
    }
    terminalMirrorFactory = (options) => binding.createTerminal(options);
    logTerminalMirrorBackend("terminal mirror backend=ghostty-vt");
    return terminalMirrorFactory;
  } catch (ghosttyError) {
    try {
      terminalMirrorFactory = createXtermMirror;
      terminalMirrorWarning = `Ghostty VT unavailable; falling back to xterm mirror (${ghosttyError?.message || String(ghosttyError)})`;
      logTerminalMirrorBackend(terminalMirrorWarning, "warn");
      return terminalMirrorFactory;
    } catch (xtermError) {
      terminalMirrorFactory = null;
      terminalMirrorWarning = `No terminal mirror backend available (ghostty: ${ghosttyError?.message || String(ghosttyError)}; xterm: ${xtermError?.message || String(xtermError)})`;
      logTerminalMirrorBackend(terminalMirrorWarning, "warn");
      throw new Error(terminalMirrorWarning);
    }
  }
}
var PtySessionRuntime = class {
  sessionId;
  payload;
  cols;
  rows;
  ptyProcess = null;
  screenMirror = null;
  pendingQueryScanTail = "";
  onDataCallback;
  onExitCallback;
  constructor(options) {
    this.sessionId = options.sessionId;
    this.payload = options.payload;
    this.cols = (0, import_session_host_core.resolveSessionHostCols)(options.payload.cols);
    this.rows = (0, import_session_host_core.resolveSessionHostRows)(options.payload.rows);
    this.onDataCallback = options.onData;
    this.onExitCallback = options.onExit;
  }
  start() {
    if (this.ptyProcess) return this.ptyProcess.pid;
    const command = this.payload.launchCommand.command;
    const args = this.payload.launchCommand.args || [];
    const env = buildRuntimeEnv(process.env, this.payload.launchCommand.env);
    let cwd = this.payload.workspace || process.cwd();
    if (cwd) {
      try {
        const stat = fs.statSync(cwd);
        if (!stat.isDirectory()) cwd = os.homedir();
      } catch {
        cwd = os.homedir();
      }
    }
    this.ptyProcess = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd,
      env
    });
    this.screenMirror = getTerminalMirrorFactory()({
      cols: this.cols,
      rows: this.rows,
      scrollback: 32768
    });
    this.ptyProcess.onData((data) => {
      this.screenMirror?.write(data);
      this.respondToTerminalQueries(data);
      this.onDataCallback(data);
    });
    this.ptyProcess.onExit(({ exitCode }) => {
      this.ptyProcess = null;
      this.screenMirror?.dispose();
      this.screenMirror = null;
      this.pendingQueryScanTail = "";
      this.onExitCallback(exitCode ?? null);
    });
    return this.ptyProcess.pid;
  }
  write(data) {
    if (!this.ptyProcess) throw new Error(`Session not running: ${this.sessionId}`);
    this.ptyProcess.write(data);
  }
  resize(cols, rows) {
    if (!this.ptyProcess) throw new Error(`Session not running: ${this.sessionId}`);
    this.ptyProcess.resize(cols, rows);
    this.screenMirror?.resize(cols, rows);
  }
  stop() {
    if (!this.ptyProcess) return;
    this.ptyProcess.kill();
  }
  sendSignal(signal) {
    if (!this.ptyProcess) throw new Error(`Session not running: ${this.sessionId}`);
    const normalized = String(signal || "").trim().toUpperCase();
    if (!normalized) throw new Error("signal is required");
    try {
      process.kill(this.ptyProcess.pid, normalized);
    } catch {
      if (normalized === "SIGTERM" || normalized === "SIGKILL") {
        this.ptyProcess.kill();
        return;
      }
      throw new Error(`Unsupported signal for runtime ${this.sessionId}: ${normalized}`);
    }
  }
  getSnapshotText() {
    return this.screenMirror?.formatVT() || "";
  }
  respondToTerminalQueries(data) {
    if (!this.ptyProcess || !this.screenMirror || !data) return;
    const combined = this.pendingQueryScanTail + data;
    const regex = /\x1b\[(\?)?6n/g;
    let match;
    while ((match = regex.exec(combined)) !== null) {
      const cursor = this.screenMirror.getCursorPosition();
      const row = Math.max(1, (cursor.row | 0) + 1);
      const col = Math.max(1, (cursor.col | 0) + 1);
      const response = match[1] ? `\x1B[?${row};${col}R` : `\x1B[${row};${col}R`;
      this.ptyProcess.write(response);
    }
    this.pendingQueryScanTail = computeTerminalQueryTail(combined);
  }
};

// src/storage.ts
var fs2 = __toESM(require("fs"));
var os2 = __toESM(require("os"));
var path = __toESM(require("path"));
var SessionHostStorage = class {
  rootDir;
  runtimesDir;
  constructor(options = {}) {
    const appName = options.appName || "adhdev";
    this.rootDir = path.join(os2.homedir(), ".adhdev", "session-host", appName);
    this.runtimesDir = path.join(this.rootDir, "runtimes");
  }
  loadAll() {
    if (!fs2.existsSync(this.runtimesDir)) return [];
    const entries = fs2.readdirSync(this.runtimesDir, { withFileTypes: true });
    const states = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const fullPath = path.join(this.runtimesDir, entry.name);
      try {
        const parsed = JSON.parse(fs2.readFileSync(fullPath, "utf8"));
        if (parsed?.record?.sessionId) {
          states.push(parsed);
        }
      } catch {
      }
    }
    return states.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  save(record, snapshot) {
    fs2.mkdirSync(this.runtimesDir, { recursive: true });
    const filePath = path.join(this.runtimesDir, `${record.sessionId}.json`);
    const payload = {
      record,
      snapshot,
      updatedAt: Date.now()
    };
    fs2.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  }
  remove(sessionId) {
    const filePath = path.join(this.runtimesDir, `${sessionId}.json`);
    try {
      fs2.unlinkSync(filePath);
    } catch {
    }
  }
};

// src/server.ts
var SessionHostServer = class _SessionHostServer extends import_events.EventEmitter {
  static MAX_RECENT_DIAGNOSTICS = 200;
  endpoint;
  registry = new import_session_host_core2.SessionHostRegistry();
  runtimes = /* @__PURE__ */ new Map();
  storage;
  ipcServer = null;
  sockets = /* @__PURE__ */ new Set();
  // Tracks which sessionIds each socket has subscribed to (via create/attach).
  // Used to avoid broadcasting session-specific events to uninterested sockets.
  socketSessions = /* @__PURE__ */ new Map();
  persistTimers = /* @__PURE__ */ new Map();
  startedAt = Date.now();
  recentLogs = [];
  recentRequests = [];
  recentTransitions = [];
  exitWaiters = /* @__PURE__ */ new Map();
  lastNoOutputInputWarnAt = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    super();
    this.endpoint = options.endpoint || (0, import_session_host_core2.getDefaultSessionHostEndpoint)(options.appName || "adhdev");
    this.storage = new SessionHostStorage({ appName: options.appName || "adhdev" });
  }
  async start() {
    if (this.endpoint.kind === "unix") {
      try {
        fs3.unlinkSync(this.endpoint.path);
      } catch {
      }
    }
    this.ipcServer = net.createServer((socket) => {
      this.sockets.add(socket);
      const removeSocket = () => {
        this.sockets.delete(socket);
        this.socketSessions.delete(socket);
      };
      socket.on("close", removeSocket);
      socket.on("end", removeSocket);
      socket.on("error", () => {
        removeSocket();
        try {
          socket.destroy();
        } catch {
        }
      });
      socket.on("data", (0, import_session_host_core2.createLineParser)((envelope) => {
        if (envelope.kind !== "request") return;
        void this.handleIncomingRequest(socket, envelope);
      }));
    });
    await new Promise((resolve, reject) => {
      this.ipcServer?.once("listening", () => resolve());
      this.ipcServer?.once("error", reject);
      this.ipcServer?.listen(this.endpoint.path);
    });
    this.recordHostLog("info", `session host endpoint ready: ${this.endpoint.path}`);
    setTimeout(() => {
      try {
        this.restorePersistedRuntimes();
      } catch (error) {
        this.recordHostLog("error", `session host restore failed: ${error?.message || String(error)}`);
      }
    }, 0);
  }
  async stop() {
    this.flushAllPersistence();
    for (const runtime of this.runtimes.values()) {
      try {
        runtime.stop();
      } catch {
      }
    }
    this.runtimes.clear();
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }
    this.persistTimers.clear();
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.socketSessions.clear();
    if (this.ipcServer) {
      const server = this.ipcServer;
      this.ipcServer = null;
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (this.endpoint.kind === "unix") {
      try {
        fs3.unlinkSync(this.endpoint.path);
      } catch {
      }
    }
    this.removeAllListeners();
  }
  async handleRequest(request) {
    try {
      switch (request.type) {
        case "create_session": {
          const record = this.registry.createSession(request.payload);
          this.schedulePersist(record.sessionId);
          this.emitEvent({ type: "session_created", sessionId: record.sessionId, record });
          this.recordRuntimeTransition(record.sessionId, "create_session", "starting", `provider=${record.providerType}`, true);
          try {
            const startedRecord = this.startRuntime(record, request.payload, "session_started");
            return { success: true, result: startedRecord };
          } catch (error) {
            this.registry.markStopped(record.sessionId, "failed");
            this.persistNow(record.sessionId);
            this.recordRuntimeTransition(record.sessionId, "create_session_failed", "failed", void 0, false, error?.message || String(error));
            return { success: false, error: error?.message || String(error) };
          }
        }
        case "list_sessions":
          return { success: true, result: this.registry.listSessions() };
        case "attach_session": {
          const record = this.registry.attachClient(request.payload);
          this.schedulePersist(record.sessionId);
          const client = record.attachedClients.find((item) => item.clientId === request.payload.clientId);
          if (client) {
            this.emitEvent({ type: "client_attached", sessionId: record.sessionId, client });
          }
          this.recordRuntimeTransition(record.sessionId, "attach_client", record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        case "detach_session": {
          const record = this.registry.detachClient(request.payload);
          this.schedulePersist(record.sessionId);
          this.emitEvent({ type: "client_detached", sessionId: record.sessionId, clientId: request.payload.clientId });
          this.recordRuntimeTransition(record.sessionId, "detach_client", record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        case "acquire_write": {
          const record = this.registry.acquireWrite(request.payload);
          this.persistNow(record.sessionId);
          this.emitEvent({ type: "write_owner_changed", sessionId: record.sessionId, owner: record.writeOwner });
          this.recordRuntimeTransition(record.sessionId, "acquire_write", record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        case "release_write": {
          const record = this.registry.releaseWrite(request.payload);
          this.persistNow(record.sessionId);
          this.emitEvent({ type: "write_owner_changed", sessionId: record.sessionId, owner: record.writeOwner });
          this.recordRuntimeTransition(record.sessionId, "release_write", record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        case "get_snapshot":
          return { success: true, result: this.getSnapshot(request.payload.sessionId, request.payload.sinceSeq) };
        case "get_host_diagnostics":
          return { success: true, result: this.getHostDiagnostics(request.payload) };
        case "clear_session_buffer": {
          const record = this.registry.clearBuffer(request.payload.sessionId);
          this.persistNow(record.sessionId);
          this.emitEvent({ type: "session_cleared", sessionId: record.sessionId });
          this.recordRuntimeTransition(record.sessionId, "clear_buffer", record.lifecycle, void 0, true);
          return { success: true, result: record };
        }
        case "update_session_meta": {
          const record = this.registry.updateSessionMeta(
            request.payload.sessionId,
            request.payload.meta || {},
            request.payload.replace === true
          );
          this.persistNow(record.sessionId);
          this.recordRuntimeTransition(record.sessionId, "update_meta", record.lifecycle, void 0, true);
          return { success: true, result: record };
        }
        case "send_input": {
          const client = this.getAttachedClient(request.payload.sessionId, request.payload.clientId);
          if (client?.readOnly) {
            return { success: false, error: `Client ${request.payload.clientId} is read-only` };
          }
          const session = this.registry.getSession(request.payload.sessionId);
          if (session?.writeOwner && session.writeOwner.clientId !== request.payload.clientId) {
            return { success: false, error: `Write owned by ${session.writeOwner.clientId}` };
          }
          const runtime = this.requireRuntime(request.payload.sessionId);
          const beforeSnapshotSeq = this.registry.getSnapshot(request.payload.sessionId)?.seq ?? 0;
          runtime.write(request.payload.data);
          this.scheduleNoOutputInputDiagnostic({
            sessionId: request.payload.sessionId,
            clientId: request.payload.clientId,
            input: request.payload.data,
            beforeSnapshotSeq
          });
          return { success: true, result: this.registry.getSession(request.payload.sessionId) };
        }
        case "resize_session": {
          this.requireRuntime(request.payload.sessionId).resize(request.payload.cols, request.payload.rows);
          const record = this.registry.getSession(request.payload.sessionId);
          if (record) {
            this.registry.restoreSession(
              {
                ...record,
                meta: {
                  ...record.meta || {},
                  sessionHostCols: request.payload.cols,
                  sessionHostRows: request.payload.rows
                }
              },
              this.registry.getSnapshot(request.payload.sessionId)
            );
          }
          this.schedulePersist(request.payload.sessionId);
          this.emitEvent({
            type: "session_resized",
            sessionId: request.payload.sessionId,
            cols: request.payload.cols,
            rows: request.payload.rows
          });
          return { success: true, result: this.registry.getSession(request.payload.sessionId) };
        }
        case "stop_session": {
          this.registry.setLifecycle(request.payload.sessionId, "stopping");
          this.persistNow(request.payload.sessionId);
          this.requireRuntime(request.payload.sessionId).stop();
          this.emitEvent({ type: "session_stopped", sessionId: request.payload.sessionId });
          this.recordRuntimeTransition(request.payload.sessionId, "stop_session", "stopping", void 0, true);
          return { success: true, result: this.registry.getSession(request.payload.sessionId) };
        }
        case "delete_session": {
          const record = this.registry.getSession(request.payload.sessionId);
          if (!record) return { success: false, error: `Unknown session: ${request.payload.sessionId}` };
          if (this.runtimes.has(record.sessionId)) {
            if (!request.payload.force) {
              return { success: false, error: `Session ${record.sessionId} is still running; pass force to stop and delete it` };
            }
            this.registry.setLifecycle(record.sessionId, "stopping");
            this.persistNow(record.sessionId);
            this.requireRuntime(record.sessionId).stop();
            await this.waitForRuntimeExit(record.sessionId).catch((error) => {
              this.recordRuntimeTransition(record.sessionId, "delete_session_timeout", "stopping", void 0, false, error?.message || String(error));
            });
          }
          this.registry.deleteSession(record.sessionId);
          this.storage.remove(record.sessionId);
          this.emitEvent({ type: "session_deleted", sessionId: record.sessionId });
          this.recordRuntimeTransition(record.sessionId, "delete_session", record.lifecycle, void 0, true);
          return { success: true, result: { sessionId: record.sessionId, deleted: true } };
        }
        case "resume_session": {
          const existing = this.registry.getSession(request.payload.sessionId);
          if (!existing) {
            return { success: false, error: `Unknown session: ${request.payload.sessionId}` };
          }
          if (this.runtimes.has(request.payload.sessionId)) {
            return { success: true, result: existing };
          }
          const resumed = this.startRuntime(existing, this.buildPayloadFromRecord(existing), "session_resumed");
          this.recordRuntimeTransition(request.payload.sessionId, "resume_session", resumed.lifecycle, void 0, true);
          return { success: true, result: resumed };
        }
        case "restart_session": {
          const restarted = await this.restartRuntime(request.payload.sessionId);
          return { success: true, result: restarted };
        }
        case "prune_duplicate_sessions": {
          const result = await this.pruneDuplicateSessions(request.payload);
          return { success: true, result };
        }
        case "send_signal": {
          const runtime = this.requireRuntime(request.payload.sessionId);
          runtime.sendSignal(request.payload.signal);
          const record = this.registry.getSession(request.payload.sessionId);
          this.recordRuntimeTransition(request.payload.sessionId, "send_signal", record?.lifecycle, request.payload.signal, true);
          return { success: true, result: record };
        }
        case "force_detach_client": {
          const session = this.registry.getSession(request.payload.sessionId);
          if (session?.writeOwner?.clientId === request.payload.clientId) {
            const released = this.registry.releaseWrite({
              sessionId: request.payload.sessionId,
              clientId: request.payload.clientId
            });
            this.emitEvent({ type: "write_owner_changed", sessionId: released.sessionId, owner: released.writeOwner });
          }
          const record = this.registry.detachClient({
            sessionId: request.payload.sessionId,
            clientId: request.payload.clientId
          });
          this.schedulePersist(record.sessionId);
          this.emitEvent({ type: "client_detached", sessionId: record.sessionId, clientId: request.payload.clientId });
          this.recordRuntimeTransition(record.sessionId, "force_detach_client", record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        default:
          return { success: false, error: `Unsupported session host request: ${request?.type || "unknown"}` };
      }
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }
  requireRuntime(sessionId) {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) throw new Error(`Runtime not found for session: ${sessionId}`);
    return runtime;
  }
  getAttachedClient(sessionId, clientId) {
    const session = this.registry.getSession(sessionId);
    return session?.attachedClients.find((client) => client.clientId === clientId) || null;
  }
  emitEvent(event) {
    const diagnosticOnly = event.type === "request_trace" || event.type === "runtime_transition" || event.type === "host_log";
    if (!diagnosticOnly) {
      const targetSessionId = "sessionId" in event ? event.sessionId : null;
      for (const socket of [...this.sockets]) {
        if (targetSessionId && event.type === "session_output") {
          const sessions = this.socketSessions.get(socket);
          if (!sessions?.has(targetSessionId)) continue;
        } else if (targetSessionId && this.socketSessions.size > 0) {
          const sessions = this.socketSessions.get(socket);
          if (sessions && !sessions.has(targetSessionId)) continue;
        }
        this.writeEnvelopeSafely(socket, {
          kind: "event",
          event
        });
      }
    }
    this.emit("event", event);
  }
  subscribeSocketToSession(socket, sessionId) {
    let sessions = this.socketSessions.get(socket);
    if (!sessions) {
      sessions = /* @__PURE__ */ new Set();
      this.socketSessions.set(socket, sessions);
    }
    sessions.add(sessionId);
  }
  async handleIncomingRequest(socket, envelope) {
    const sessionId = this.getRequestSessionId(envelope.request);
    if (sessionId && (envelope.request.type === "create_session" || envelope.request.type === "attach_session")) {
      this.subscribeSocketToSession(socket, sessionId);
    }
    const startedAt = Date.now();
    const response = await this.handleRequest(envelope.request);
    if (sessionId && envelope.request.type === "create_session" && response.success) {
      const createdId = response.result?.sessionId;
      if (createdId && createdId !== sessionId) this.subscribeSocketToSession(socket, createdId);
    }
    this.recordRequestTrace({
      timestamp: startedAt,
      requestId: envelope.requestId,
      type: envelope.request.type,
      sessionId: this.getRequestSessionId(envelope.request),
      clientId: this.getRequestClientId(envelope.request),
      success: response.success,
      durationMs: Math.max(0, Date.now() - startedAt),
      error: response.success ? void 0 : response.error
    });
    this.writeEnvelopeSafely(socket, (0, import_session_host_core2.createResponseEnvelope)(envelope.requestId, response));
  }
  writeEnvelopeSafely(socket, envelope) {
    if (socket.destroyed || !socket.writable || socket.writableEnded) {
      this.sockets.delete(socket);
      return;
    }
    const payload = `${JSON.stringify(envelope)}
`;
    try {
      socket.write(payload, (error) => {
        if (!error) return;
        this.sockets.delete(socket);
        try {
          socket.destroy();
        } catch {
        }
      });
    } catch {
      this.sockets.delete(socket);
      try {
        socket.destroy();
      } catch {
      }
    }
  }
  schedulePersist(sessionId) {
    const existing = this.persistTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.persistTimers.set(sessionId, setTimeout(() => {
      this.persistTimers.delete(sessionId);
      this.persistNow(sessionId);
    }, 200));
  }
  persistNow(sessionId) {
    const record = this.registry.getSession(sessionId);
    if (!record) return;
    const snapshot = this.getSnapshot(sessionId);
    try {
      this.storage.save(record, snapshot);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "persist_failed";
      console.error(`[session-host] Persist failed for ${sessionId}: ${code}: ${error?.message || error}`);
    }
  }
  getSessionHostRecoveryLabel(record) {
    const recoveryState = typeof record.meta?.runtimeRecoveryState === "string" ? String(record.meta.runtimeRecoveryState).trim() : "";
    if (!recoveryState) return null;
    if (recoveryState === "auto_resumed") return "restored after restart";
    if (recoveryState === "resume_failed") return "restore failed";
    if (recoveryState === "host_restart_interrupted") return "host restart interrupted";
    if (recoveryState === "orphan_snapshot") return "snapshot recovered";
    return recoveryState.replace(/_/g, " ");
  }
  getSessionSurfaceKind(record) {
    if (["starting", "running", "stopping", "interrupted"].includes(record.lifecycle)) {
      return "live_runtime";
    }
    if ((record.lifecycle === "stopped" || record.lifecycle === "failed") && (record.meta?.restoredFromStorage === true || this.getSessionHostRecoveryLabel(record))) {
      return "recovery_snapshot";
    }
    return "inactive_record";
  }
  annotateSessionSurface(record) {
    return {
      ...record,
      surfaceKind: this.getSessionSurfaceKind(record)
    };
  }
  sanitizeDiagnosticsRecord(record) {
    return {
      ...record,
      launchCommand: {
        command: record.launchCommand.command,
        args: Array.isArray(record.launchCommand.args) ? [...record.launchCommand.args] : []
      }
    };
  }
  getHostDiagnostics(payload) {
    const limit = Math.max(1, Math.min(200, Number(payload?.limit) || 50));
    const allSessions = payload?.includeSessions === false ? void 0 : this.registry.listSessions().map((record) => this.annotateSessionSurface(record)).map((record) => this.sanitizeDiagnosticsRecord(record));
    const liveRuntimes = allSessions?.filter((record) => record.surfaceKind === "live_runtime");
    const recoverySnapshots = allSessions?.filter((record) => record.surfaceKind === "recovery_snapshot").slice(0, limit);
    const inactiveRecords = allSessions?.filter((record) => record.surfaceKind === "inactive_record").slice(0, limit);
    const sessions = allSessions ? [
      ...liveRuntimes || [],
      ...recoverySnapshots || [],
      ...inactiveRecords || []
    ] : void 0;
    return {
      hostStartedAt: this.startedAt,
      endpoint: this.endpoint.path,
      runtimeCount: this.runtimes.size,
      supportedRequestTypes: [...import_session_host_core2.SESSION_HOST_SUPPORTED_REQUEST_TYPES],
      sessions,
      liveRuntimes,
      recoverySnapshots,
      inactiveRecords,
      recentLogs: this.recentLogs.slice(-limit),
      recentRequests: this.recentRequests.slice(-limit),
      recentTransitions: this.recentTransitions.slice(-limit)
    };
  }
  getRequestSessionId(request) {
    const payload = request.payload;
    return typeof payload?.sessionId === "string" ? payload.sessionId : void 0;
  }
  getRequestClientId(request) {
    const payload = request.payload;
    return typeof payload?.clientId === "string" ? payload.clientId : void 0;
  }
  pushRecent(bucket, entry) {
    bucket.push(entry);
    if (bucket.length > _SessionHostServer.MAX_RECENT_DIAGNOSTICS) {
      bucket.splice(0, bucket.length - _SessionHostServer.MAX_RECENT_DIAGNOSTICS);
    }
  }
  recordHostLog(level, message, sessionId, data) {
    const entry = {
      timestamp: Date.now(),
      level,
      message,
      sessionId,
      data
    };
    this.pushRecent(this.recentLogs, entry);
    this.emitEvent({ type: "host_log", entry });
    this.emit("log", `[${level}] ${message}`);
  }
  recordRequestTrace(trace) {
    this.pushRecent(this.recentRequests, trace);
    this.emitEvent({ type: "request_trace", trace });
    if (!trace.success) {
      this.recordHostLog(
        "warn",
        `request ${trace.type} failed after ${trace.durationMs}ms${trace.error ? `: ${trace.error}` : ""}`,
        trace.sessionId,
        { requestId: trace.requestId, clientId: trace.clientId }
      );
    }
  }
  scheduleNoOutputInputDiagnostic(params) {
    if (!params.input || /^\x1b/.test(params.input)) {
      return;
    }
    const hasPotentialEcho = /[^\x00-\x1F\x7F]/.test(params.input);
    if (!hasPotentialEcho && params.input !== "\r" && params.input !== "\n") {
      return;
    }
    setTimeout(() => {
      let afterSnapshotSeq = params.beforeSnapshotSeq;
      try {
        afterSnapshotSeq = this.registry.getSnapshot(params.sessionId)?.seq ?? params.beforeSnapshotSeq;
      } catch {
        return;
      }
      if (afterSnapshotSeq > params.beforeSnapshotSeq) {
        return;
      }
      const now = Date.now();
      const lastWarnAt = this.lastNoOutputInputWarnAt.get(params.sessionId) || 0;
      if (now - lastWarnAt < 1e4) {
        return;
      }
      this.lastNoOutputInputWarnAt.set(params.sessionId, now);
      const record = this.registry.getSession(params.sessionId);
      this.recordHostLog(
        "warn",
        "send_input produced no terminal output after PTY write; runtime may be ignoring stdin or stuck in a hidden input reader",
        params.sessionId,
        {
          clientId: params.clientId,
          inputLength: params.input.length,
          beforeSnapshotSeq: params.beforeSnapshotSeq,
          afterSnapshotSeq,
          lifecycle: record?.lifecycle,
          osPid: record?.osPid,
          providerType: record?.providerType
        }
      );
      this.recordRuntimeTransition(
        params.sessionId,
        "send_input_no_output_after_write",
        record?.lifecycle,
        `clientId=${params.clientId} inputLength=${params.input.length} seq=${params.beforeSnapshotSeq}`,
        false,
        "no terminal output after PTY write"
      );
    }, 250);
  }
  recordRuntimeTransition(sessionId, action, lifecycle, detail, success = true, error) {
    const transition = {
      timestamp: Date.now(),
      sessionId,
      action,
      lifecycle,
      detail,
      success,
      error
    };
    this.pushRecent(this.recentTransitions, transition);
    this.emitEvent({ type: "runtime_transition", transition });
  }
  waitForRuntimeExit(sessionId, timeoutMs = 5e3) {
    if (!this.runtimes.has(sessionId)) {
      return Promise.resolve(this.registry.getSession(sessionId)?.lifecycle === "failed" ? 1 : 0);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiters2 = this.exitWaiters.get(sessionId) || [];
        this.exitWaiters.set(sessionId, waiters2.filter((waiter) => waiter !== onExit));
        reject(new Error(`Timed out waiting for runtime ${sessionId} to exit`));
      }, timeoutMs);
      const onExit = (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      };
      const waiters = this.exitWaiters.get(sessionId) || [];
      waiters.push(onExit);
      this.exitWaiters.set(sessionId, waiters);
    });
  }
  resolveExitWaiters(sessionId, exitCode) {
    const waiters = this.exitWaiters.get(sessionId);
    if (!waiters?.length) return;
    this.exitWaiters.delete(sessionId);
    for (const waiter of waiters) {
      try {
        waiter(exitCode);
      } catch {
      }
    }
  }
  getSnapshot(sessionId, sinceSeq) {
    const snapshot = this.registry.getSnapshot(sessionId, sinceSeq);
    const record = this.registry.getSession(sessionId);
    if (typeof sinceSeq === "number") {
      return {
        ...snapshot,
        cols: typeof record?.meta?.sessionHostCols === "number" ? record.meta.sessionHostCols : 80,
        rows: typeof record?.meta?.sessionHostRows === "number" ? record.meta.sessionHostRows : 24
      };
    }
    const runtime = this.runtimes.get(sessionId);
    const runtimeText = runtime?.getSnapshotText?.() || "";
    if (!runtimeText) {
      return {
        ...snapshot,
        cols: typeof record?.meta?.sessionHostCols === "number" ? record.meta.sessionHostCols : 80,
        rows: typeof record?.meta?.sessionHostRows === "number" ? record.meta.sessionHostRows : 24
      };
    }
    return {
      ...snapshot,
      text: runtimeText,
      truncated: false,
      cols: typeof record?.meta?.sessionHostCols === "number" ? record.meta.sessionHostCols : 80,
      rows: typeof record?.meta?.sessionHostRows === "number" ? record.meta.sessionHostRows : 24
    };
  }
  flushAllPersistence() {
    for (const sessionId of this.runtimes.keys()) {
      this.persistNow(sessionId);
    }
    for (const record of this.registry.listSessions()) {
      this.persistNow(record.sessionId);
    }
  }
  async restartRuntime(sessionId) {
    const existing = this.registry.getSession(sessionId);
    if (!existing) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (this.runtimes.has(sessionId)) {
      this.registry.setLifecycle(sessionId, "stopping");
      this.persistNow(sessionId);
      this.recordRuntimeTransition(sessionId, "restart_requested", "stopping", void 0, true);
      this.requireRuntime(sessionId).stop();
      await this.waitForRuntimeExit(sessionId);
    }
    const latest = this.registry.getSession(sessionId) || existing;
    const restarted = this.startRuntime(latest, this.buildPayloadFromRecord(latest), "session_resumed");
    this.recordRuntimeTransition(sessionId, "restart_completed", restarted.lifecycle, void 0, true);
    return restarted;
  }
  async pruneDuplicateSessions(payload) {
    const providerFilter = typeof payload?.providerType === "string" ? payload.providerType.trim() : "";
    const workspaceFilter = typeof payload?.workspace === "string" ? payload.workspace.trim() : "";
    const dryRun = payload?.dryRun === true;
    const sessions = this.registry.listSessions().filter((record) => ["starting", "running", "stopping", "interrupted"].includes(record.lifecycle)).filter((record) => !providerFilter || record.providerType === providerFilter).filter((record) => !workspaceFilter || record.workspace === workspaceFilter);
    const groups = /* @__PURE__ */ new Map();
    for (const record of sessions) {
      const providerSessionId = typeof record.meta?.providerSessionId === "string" ? String(record.meta.providerSessionId).trim() : "";
      if (!providerSessionId) continue;
      const bindingKey = `${record.providerType}::${record.workspace}::${providerSessionId}`;
      const bucket = groups.get(bindingKey) || [];
      bucket.push(record);
      groups.set(bindingKey, bucket);
    }
    const duplicateGroups = [];
    const keptSessionIds = [];
    const prunedSessionIds = [];
    for (const [bindingKey, records] of groups.entries()) {
      if (records.length < 2) continue;
      const sorted = [...records].sort((a, b) => this.compareDuplicateCandidates(a, b));
      const kept = sorted[0];
      const duplicates = sorted.slice(1);
      const providerSessionId = typeof kept.meta?.providerSessionId === "string" ? String(kept.meta.providerSessionId) : "";
      duplicateGroups.push({
        bindingKey,
        providerType: kept.providerType,
        workspace: kept.workspace,
        providerSessionId,
        keptSessionId: kept.sessionId,
        prunedSessionIds: duplicates.map((record) => record.sessionId)
      });
      keptSessionIds.push(kept.sessionId);
      if (dryRun) continue;
      for (const duplicate of duplicates) {
        await this.pruneDuplicateRuntime(duplicate);
        prunedSessionIds.push(duplicate.sessionId);
      }
    }
    this.recordHostLog(
      dryRun ? "info" : "warn",
      `${dryRun ? "session host dry-run found" : "session host pruned"} ${duplicateGroups.length} duplicate group(s)`,
      void 0,
      {
        providerType: providerFilter || void 0,
        workspace: workspaceFilter || void 0,
        dryRun,
        prunedSessionIds,
        keptSessionIds
      }
    );
    return {
      duplicateGroupCount: duplicateGroups.length,
      keptSessionIds,
      prunedSessionIds,
      groups: duplicateGroups
    };
  }
  restorePersistedRuntimes() {
    const states = this.storage.loadAll();
    let skippedAutoResumeSessions = 0;
    for (const persisted of states) {
      const wasLiveRuntime = !["stopped", "failed"].includes(persisted.record.lifecycle);
      const hadAttachedClients = Array.isArray(persisted.record.attachedClients) && persisted.record.attachedClients.length > 0;
      const hadWriteOwner = !!persisted.record.writeOwner;
      const hadRecoveryInterest = hadAttachedClients || hadWriteOwner;
      const recoveredRecord = {
        ...persisted.record,
        attachedClients: [],
        writeOwner: null,
        lifecycle: wasLiveRuntime ? "stopped" : persisted.record.lifecycle,
        lastActivityAt: Date.now(),
        meta: {
          ...persisted.record.meta || {},
          restoredFromStorage: true,
          runtimeRecoveryState: wasLiveRuntime ? "orphan_snapshot" : "snapshot",
          runtimeHadAttachedClientsAtCrash: hadAttachedClients,
          runtimeHadWriteOwnerAtCrash: hadWriteOwner,
          runtimeAutoResumeSkipped: wasLiveRuntime && hadRecoveryInterest
        }
      };
      this.registry.restoreSession(recoveredRecord, persisted.snapshot);
      this.storage.save(recoveredRecord, persisted.snapshot);
      if (wasLiveRuntime && hadRecoveryInterest) {
        skippedAutoResumeSessions += 1;
      }
    }
    if (skippedAutoResumeSessions > 0) {
      this.recordHostLog("warn", `session host restored ${skippedAutoResumeSessions} live runtime snapshot(s) without auto-resume`);
    }
  }
  compareDuplicateCandidates(a, b) {
    const score = (record) => {
      const lifecycleScore = record.lifecycle === "running" ? 4 : record.lifecycle === "starting" ? 3 : record.lifecycle === "stopping" ? 2 : record.lifecycle === "interrupted" ? 1 : 0;
      return [
        lifecycleScore,
        record.writeOwner ? 1 : 0,
        Array.isArray(record.attachedClients) ? record.attachedClients.length : 0,
        record.lastActivityAt || 0,
        record.startedAt || 0,
        record.createdAt || 0
      ];
    };
    const aScore = score(a);
    const bScore = score(b);
    for (let i = 0; i < aScore.length; i += 1) {
      if (aScore[i] === bScore[i]) continue;
      return bScore[i] - aScore[i];
    }
    return 0;
  }
  async pruneDuplicateRuntime(record) {
    const providerSessionId = typeof record.meta?.providerSessionId === "string" ? String(record.meta.providerSessionId) : void 0;
    this.recordRuntimeTransition(
      record.sessionId,
      "prune_duplicate_session",
      record.lifecycle,
      providerSessionId ? `providerSessionId=${providerSessionId}` : void 0,
      true
    );
    if (this.runtimes.has(record.sessionId)) {
      this.registry.setLifecycle(record.sessionId, "stopping");
      this.persistNow(record.sessionId);
      this.requireRuntime(record.sessionId).stop();
      await this.waitForRuntimeExit(record.sessionId).catch((error) => {
        this.recordRuntimeTransition(record.sessionId, "prune_duplicate_timeout", "stopping", void 0, false, error?.message || String(error));
      });
    }
    this.registry.deleteSession(record.sessionId);
    this.storage.remove(record.sessionId);
  }
  buildPayloadFromRecord(record) {
    return {
      sessionId: record.sessionId,
      runtimeKey: record.runtimeKey,
      displayName: record.displayName,
      providerType: record.providerType,
      category: record.category,
      workspace: record.workspace,
      launchCommand: record.launchCommand,
      cols: (0, import_session_host_core2.resolveSessionHostCols)(typeof record.meta?.sessionHostCols === "number" ? record.meta.sessionHostCols : void 0),
      rows: (0, import_session_host_core2.resolveSessionHostRows)(typeof record.meta?.sessionHostRows === "number" ? record.meta.sessionHostRows : void 0),
      meta: record.meta
    };
  }
  startRuntime(record, payload, startEventType) {
    const runtime = new PtySessionRuntime({
      sessionId: record.sessionId,
      payload,
      onData: (data) => {
        const { seq } = this.registry.appendOutput(record.sessionId, data);
        this.schedulePersist(record.sessionId);
        this.emitEvent({ type: "session_output", sessionId: record.sessionId, seq, data });
      },
      onExit: (exitCode) => {
        this.registry.markStopped(record.sessionId, exitCode === 0 ? "stopped" : "failed");
        this.runtimes.delete(record.sessionId);
        this.resolveExitWaiters(record.sessionId, exitCode);
        this.persistNow(record.sessionId);
        this.emitEvent({ type: "session_exit", sessionId: record.sessionId, exitCode });
        this.recordRuntimeTransition(
          record.sessionId,
          "session_exit",
          exitCode === 0 ? "stopped" : "failed",
          void 0,
          exitCode === 0,
          exitCode === 0 ? void 0 : `exitCode=${exitCode}`
        );
        setTimeout(() => this.storage.remove(record.sessionId), 5e3);
      }
    });
    this.registry.setLifecycle(record.sessionId, "starting");
    const pid = runtime.start();
    this.runtimes.set(record.sessionId, runtime);
    const startedRecord = this.registry.markStarted(record.sessionId, pid);
    this.persistNow(record.sessionId);
    this.emitEvent({ type: startEventType, sessionId: record.sessionId, pid });
    this.recordRuntimeTransition(record.sessionId, startEventType, startedRecord.lifecycle, `pid=${pid}`, true);
    return startedRecord;
  }
};

// src/index.ts
var SESSION_HOST_APP_NAME = process.env.ADHDEV_SESSION_HOST_NAME || "adhdev";
function getSessionHostPidFile(appName) {
  const dir = path2.join(os3.homedir(), ".adhdev");
  if (!fs4.existsSync(dir)) fs4.mkdirSync(dir, { recursive: true });
  return path2.join(dir, `${appName}-session-host.pid`);
}
function writeSessionHostPid(appName) {
  fs4.writeFileSync(getSessionHostPidFile(appName), String(process.pid), "utf8");
}
function removeSessionHostPid(appName) {
  try {
    fs4.unlinkSync(getSessionHostPidFile(appName));
  } catch {
  }
}
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const readOnly = rest.includes("--read-only");
  const takeover = rest.includes("--takeover");
  const showAll = rest.includes("--all");
  const positional = rest.filter((arg) => arg !== "--read-only" && arg !== "--takeover" && arg !== "--all");
  return {
    command: command || "serve",
    positional,
    readOnly,
    takeover,
    showAll
  };
}
async function runServer() {
  const server = new SessionHostServer({ appName: SESSION_HOST_APP_NAME });
  writeSessionHostPid(SESSION_HOST_APP_NAME);
  await server.start();
  process.on("SIGINT", async () => {
    await server.stop();
    removeSessionHostPid(SESSION_HOST_APP_NAME);
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await server.stop();
    removeSessionHostPid(SESSION_HOST_APP_NAME);
    process.exit(0);
  });
  process.on("exit", () => {
    server.flushAllPersistence();
    removeSessionHostPid(SESSION_HOST_APP_NAME);
  });
  await new Promise(() => {
  });
}
async function listRuntimes(showAll = false) {
  const client = new import_session_host_core3.SessionHostClient({ endpoint: (0, import_session_host_core3.getDefaultSessionHostEndpoint)(SESSION_HOST_APP_NAME) });
  try {
    const response = await client.request({
      type: "list_sessions",
      payload: {}
    });
    if (!response.success) {
      throw new Error(response.error || "Failed to list runtimes");
    }
    const runtimes = (response.result || []).filter((runtime) => showAll || runtime.lifecycle !== "stopped");
    if (runtimes.length === 0) {
      console.log("No runtimes.");
      return;
    }
    console.log("runtimeKey	lifecycle	owner	workspace	id	displayName");
    for (const runtime of runtimes) {
      console.log([
        runtime.runtimeKey,
        runtime.lifecycle,
        (0, import_session_host_core3.formatRuntimeOwner)(runtime),
        runtime.workspaceLabel,
        runtime.sessionId,
        runtime.displayName
      ].join("	"));
    }
  } finally {
    await client.close().catch(() => {
    });
  }
}
async function attachRuntime(target, readOnly = false, takeover = false) {
  const client = new import_session_host_core3.SessionHostClient({ endpoint: (0, import_session_host_core3.getDefaultSessionHostEndpoint)(SESSION_HOST_APP_NAME) });
  const clientId = `local-terminal-${process.pid}-${(0, import_crypto.randomUUID)().slice(0, 8)}`;
  let lastSeq = 0;
  let restoredRawMode = false;
  let runtimeId = "";
  let localReadOnly = readOnly;
  const cleanup = async () => {
    process.stdout.off("resize", handleResize);
    process.stdin.off("data", handleInput);
    process.stdin.pause();
    if (process.stdin.isTTY && restoredRawMode) {
      process.stdin.setRawMode(false);
    }
    await client.request({
      type: "release_write",
      payload: {
        sessionId: runtimeId,
        clientId
      }
    }).catch(() => ({ success: false }));
    await client.request({
      type: "detach_session",
      payload: {
        sessionId: runtimeId,
        clientId
      }
    }).catch(() => ({ success: false }));
    await client.close().catch(() => {
    });
  };
  const handleResize = () => {
    void client.request({
      type: "resize_session",
      payload: {
        sessionId: runtimeId,
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24
      }
    }).catch(() => ({ success: false }));
  };
  const sendInputWithTakeover = async (data) => {
    let response = await client.request({
      type: "send_input",
      payload: {
        sessionId: runtimeId,
        clientId,
        data
      }
    });
    if (!response.success && response.error?.startsWith("Write owned by ")) {
      const ownerResponse = await client.request({
        type: "acquire_write",
        payload: {
          sessionId: runtimeId,
          clientId,
          ownerType: "user",
          force: true
        }
      });
      if (ownerResponse.success && ownerResponse.result) {
        response = await client.request({
          type: "send_input",
          payload: {
            sessionId: runtimeId,
            clientId,
            data
          }
        });
        if (response.success) {
          process.stderr.write(`Took control of ${ownerResponse.result.runtimeKey}.
`);
        }
      }
    }
    return response;
  };
  const handleInput = (chunk) => {
    if (!localReadOnly && chunk.length === 1 && chunk[0] === 29) {
      void cleanup().finally(() => process.exit(0));
      return;
    }
    if (localReadOnly) return;
    void sendInputWithTakeover(chunk.toString("utf8")).catch(() => ({ success: false }));
  };
  try {
    if (readOnly && takeover) {
      throw new Error("Use either --read-only or --takeover, not both");
    }
    const listResponse = await client.request({
      type: "list_sessions",
      payload: {}
    });
    if (!listResponse.success || !listResponse.result) {
      throw new Error(listResponse.error || "Failed to list runtimes");
    }
    let runtimeRecord = (0, import_session_host_core3.resolveAttachableRuntimeRecord)(listResponse.result, target);
    runtimeId = runtimeRecord.sessionId;
    if (runtimeRecord.lifecycle === "interrupted" && !readOnly) {
      const resumeResponse = await client.request({
        type: "resume_session",
        payload: {
          sessionId: runtimeId
        }
      });
      if (resumeResponse.success && resumeResponse.result) {
        runtimeRecord = resumeResponse.result;
      } else {
        process.stderr.write(
          `Runtime ${runtimeRecord.runtimeKey} could not be resumed automatically: ${resumeResponse.error || "unknown error"}
`
        );
      }
    }
    let effectiveReadOnly = readOnly;
    if (!effectiveReadOnly && runtimeRecord.writeOwner && runtimeRecord.writeOwner.clientId !== clientId && !takeover) {
      process.stderr.write(
        `Runtime ${runtimeRecord.runtimeKey} is currently owned by ${runtimeRecord.writeOwner.clientId}; first input will take control here.
`
      );
    }
    localReadOnly = effectiveReadOnly;
    const attachResponse = await client.request({
      type: "attach_session",
      payload: {
        sessionId: runtimeId,
        clientId,
        clientType: "local-terminal",
        readOnly: effectiveReadOnly
      }
    });
    if (!attachResponse.success) {
      throw new Error(attachResponse.error || `Failed to attach runtime ${runtimeId}`);
    }
    const attachedRecord = attachResponse.result || null;
    if (!effectiveReadOnly && takeover) {
      const ownerResponse = await client.request({
        type: "acquire_write",
        payload: {
          sessionId: runtimeId,
          clientId,
          ownerType: "user",
          force: takeover
        }
      });
      if (!ownerResponse.success) {
        throw new Error(ownerResponse.error || `Failed to acquire write owner for runtime ${runtimeId}`);
      }
    }
    const snapshotResponse = await client.request({
      type: "get_snapshot",
      payload: { sessionId: runtimeId }
    });
    if (!snapshotResponse.success) {
      throw new Error(snapshotResponse.error || `Failed to read runtime snapshot ${runtimeId}`);
    }
    lastSeq = snapshotResponse.result?.seq || 0;
    if (snapshotResponse.result?.text) {
      process.stdout.write(snapshotResponse.result.text);
    }
    if (attachedRecord?.lifecycle === "stopped" || attachedRecord?.lifecycle === "failed" || attachedRecord?.lifecycle === "interrupted") {
      process.stderr.write(`Runtime ${attachedRecord.runtimeKey} is already ${attachedRecord.lifecycle}. Detached after snapshot.
`);
      await cleanup();
      return;
    }
    const stopSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const signalHandlers = stopSignals.map((signal) => {
      const handler = () => {
        void cleanup().finally(() => process.exit(0));
      };
      process.on(signal, handler);
      return { signal, handler };
    });
    const unsubscribe = client.onEvent((event) => {
      if (!("sessionId" in event)) return;
      if (event.sessionId !== runtimeId) return;
      if (event.type === "session_output") {
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        process.stdout.write(event.data);
        return;
      }
      if (event.type === "session_exit") {
        void cleanup().finally(() => {
          for (const { signal, handler } of signalHandlers) {
            process.off(signal, handler);
          }
          unsubscribe();
          process.exit(event.exitCode ?? 0);
        });
      }
    });
    process.stdout.on("resize", handleResize);
    process.stdin.on("data", handleInput);
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      restoredRawMode = true;
    }
    handleResize();
    if (!effectiveReadOnly) {
      process.stderr.write(`Attached to runtime ${attachedRecord?.runtimeKey || runtimeId}. Press Ctrl+] to detach.
`);
    } else {
      process.stderr.write(`Attached to runtime ${attachedRecord?.runtimeKey || runtimeId} (read-only).
`);
    }
    await new Promise(() => {
    });
  } catch (error) {
    await cleanup().catch(() => {
    });
    throw error;
  }
}
async function main() {
  const { command, positional, readOnly, takeover, showAll } = parseArgs(process.argv.slice(2));
  if (command === "serve") {
    await runServer();
    return;
  }
  if (command === "list") {
    await listRuntimes(showAll);
    return;
  }
  if (command === "attach") {
    const target = positional[0];
    if (!target) {
      throw new Error("runtime target is required: adhdev-sessiond attach <runtimeId|runtimeKey>");
    }
    await attachRuntime(target, readOnly, takeover);
    return;
  }
  if (command === "resume") {
    const target = positional[0];
    if (!target) {
      throw new Error("runtime target is required: adhdev-sessiond resume <runtimeId|runtimeKey>");
    }
    const client = new import_session_host_core3.SessionHostClient({ endpoint: (0, import_session_host_core3.getDefaultSessionHostEndpoint)(SESSION_HOST_APP_NAME) });
    try {
      const listResponse = await client.request({ type: "list_sessions", payload: {} });
      if (!listResponse.success || !listResponse.result) {
        throw new Error(listResponse.error || "Failed to list runtimes");
      }
      const runtimeRecord = (0, import_session_host_core3.resolveRuntimeRecord)(listResponse.result, target);
      const resumeResponse = await client.request({
        type: "resume_session",
        payload: {
          sessionId: runtimeRecord.sessionId
        }
      });
      if (!resumeResponse.success || !resumeResponse.result) {
        throw new Error(resumeResponse.error || `Failed to resume runtime ${runtimeRecord.runtimeKey}`);
      }
      console.log(`Resumed ${resumeResponse.result.runtimeKey} (${resumeResponse.result.sessionId})`);
    } finally {
      await client.close().catch(() => {
      });
    }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
if (require.main === module) {
  process.on("uncaughtException", (err) => {
    console.error(`[session-host] Uncaught exception: ${err?.message}
${err?.stack || ""}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[session-host] Unhandled rejection: ${reason?.message || reason}`);
  });
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SessionHostServer
});
//# sourceMappingURL=index.js.map