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
  parseArgs: () => parseArgs
});
module.exports = __toCommonJS(index_exports);

// src/transports/ipc.ts
var DEFAULT_IPC_PORT = 19222;
var DEFAULT_IPC_PATH = "/ipc";
var DEFAULT_IPC_COMMAND_TIMEOUT_MS = 15e3;
var IPC_COMMAND_TIMEOUTS_MS = {
  mesh_relay_command: 12e4,
  agent_command: 3e4,
  git_status: 45e3,
  git_diff_summary: 45e3,
  fast_forward_mesh_node: 12e4,
  mesh_status: 12e4,
  // Heavy repo-mutating worktree ops (relay budgets: clone 90s, remove 60s). A local
  // clone synchronously creates a worktree (~30s) plus a bounded setup-wait (~14s);
  // 120s leaves headroom and matches the relay-wrapped remote path.
  clone_mesh_node: 12e4,
  remove_mesh_node: 6e4,
  // Retention plan/execute runs the same git probes as a remove dry-run plus
  // queue/session/ledger reads; 60s matches the remove budget.
  cleanup_worktree_nodes: 6e4,
  // A5: plan_mesh_refine_node is the SYNCHRONOUS refine dry-run — it runs several git
  // probes (status/merge-tree/submodule) inline before replying, which can approach the
  // 15s default on a slow (Windows) host. 45s defensively, matching git_status/diff.
  plan_mesh_refine_node: 45e3,
  // A2: refine_mesh_node / batch_refine_mesh_nodes are async-job-ack (the responder
  // returns { async:true, status:'accepted' } immediately and works in the background),
  // so 15s already suffices. 30s is a defensive floor guarding a future sync-dry-run
  // regression; it is intentionally BELOW the relay 90s budget because the synchronous
  // ack reply is sub-second and never bounded by the relay deadline.
  refine_mesh_node: 3e4,
  batch_refine_mesh_nodes: 3e4
};
var WS_CONNECTING = 0;
var WS_OPEN = 1;
var POOL_IDLE_EVICT_MS = 5 * 6e4;
var POOL_MAX_AGE_MS = 10 * 6e4;
var connectionPool = /* @__PURE__ */ new Map();
function buildRequestId() {
  return `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function getTimeoutMs(type, nestedCommand) {
  return Math.max(
    IPC_COMMAND_TIMEOUTS_MS[type] ?? DEFAULT_IPC_COMMAND_TIMEOUT_MS,
    IPC_COMMAND_TIMEOUTS_MS[nestedCommand] ?? DEFAULT_IPC_COMMAND_TIMEOUT_MS
  );
}
function getOrCreateConnection(WebSocketCtor, url) {
  const existing = connectionPool.get(url);
  if (existing) {
    const { readyState } = existing.ws;
    const now2 = Date.now();
    const isAlive = readyState === WS_CONNECTING || readyState === WS_OPEN;
    const isIdle = now2 - existing.lastUsedAt > POOL_IDLE_EVICT_MS && existing.pending.size === 0;
    const isTooOld = now2 - existing.createdAt > POOL_MAX_AGE_MS && existing.pending.size === 0;
    if (isAlive && !isIdle && !isTooOld) {
      return existing;
    }
    if (isAlive && (isIdle || isTooOld)) {
      try {
        existing.ws.close();
      } catch {
      }
      connectionPool.delete(url);
    }
    connectionPool.delete(url);
  }
  const now = Date.now();
  const conn = {
    ws: new WebSocketCtor(url),
    ready: false,
    commandQueue: [],
    pending: /* @__PURE__ */ new Map(),
    lastUsedAt: now,
    createdAt: now
  };
  connectionPool.set(url, conn);
  const drainQueue = () => {
    conn.ready = true;
    for (const { type, args, requestId } of conn.commandQueue) {
      conn.ws.send(JSON.stringify({ type: "ext:command", payload: { command: type, args, requestId } }));
    }
    conn.commandQueue = [];
  };
  let tornDown = false;
  const teardown = (error) => {
    if (tornDown) return;
    tornDown = true;
    connectionPool.delete(url);
    conn.ready = false;
    for (const [, req] of conn.pending) {
      clearTimeout(req.timer);
      req.reject(error);
    }
    conn.pending.clear();
    conn.commandQueue = [];
  };
  conn.ws.addEventListener("open", () => {
    conn.ws.send(JSON.stringify({
      type: "ext:register",
      payload: {
        ideType: "mcp-server",
        ideVersion: "1.0.0",
        extensionVersion: "1.0.0",
        instanceId: `mcp-server-${process.pid}`,
        machineId: "mcp-server",
        workspaceFolders: []
      }
    }));
  });
  conn.ws.addEventListener("message", (event) => {
    try {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const msg = JSON.parse(raw);
      if (msg?.type === "daemon:welcome") {
        drainQueue();
        return;
      }
      if (msg?.type !== "ext:command_result") return;
      const req = conn.pending.get(msg?.payload?.requestId);
      if (!req) return;
      conn.pending.delete(msg.payload.requestId);
      clearTimeout(req.timer);
      const payload = msg.payload;
      const hasStructuredResult = payload != null && payload.result != null;
      if (payload?.success === false && !hasStructuredResult) {
        req.reject(new Error(payload.error || "Daemon IPC command failed"));
      } else {
        req.resolve(payload?.result ?? payload);
      }
    } catch {
    }
  });
  conn.ws.addEventListener("error", () => {
    teardown(new Error(`Cannot connect to daemon IPC at ${url}`));
  });
  conn.ws.addEventListener("close", () => {
    teardown(new Error(`Daemon IPC connection closed: ${url}`));
  });
  return conn;
}
var IpcTransport = class {
  port;
  path;
  constructor(opts = {}) {
    this.port = opts.port ?? DEFAULT_IPC_PORT;
    this.path = opts.path || DEFAULT_IPC_PATH;
  }
  async ping() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
  async getStatus() {
    return this.command("get_status_metadata");
  }
  async command(type, args = {}) {
    return this.sendIpcCommand(type, args);
  }
  async meshCommand(targetDaemonId, command, args = {}) {
    return this.sendIpcCommand("mesh_relay_command", {
      targetDaemonId,
      command,
      args
    });
  }
  sendIpcCommand(type, args) {
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) {
      return Promise.reject(new Error("WebSocket is not available in this Node runtime; Node 20+ is required for daemon IPC mode"));
    }
    const requestId = buildRequestId();
    const nestedCommand = typeof args?.command === "string" ? args.command : "";
    const timeoutMs = getTimeoutMs(type, nestedCommand);
    const targetDaemonId = typeof args?.targetDaemonId === "string" ? args.targetDaemonId : "";
    const diagnosticParts = [
      `command='${type}'`,
      ...nestedCommand ? [`relayedCommand='${nestedCommand}'`] : [],
      ...targetDaemonId ? [`targetDaemonId='${targetDaemonId.slice(0, 12)}'`] : [],
      ...typeof args?.nodeId === "string" ? [`nodeId='${args.nodeId}'`] : [],
      ...typeof args?.workspace === "string" ? [`workspace='${args.workspace}'`] : []
    ];
    const url = `ws://127.0.0.1:${this.port}${this.path}`;
    return new Promise((resolve, reject) => {
      let conn;
      try {
        conn = getOrCreateConnection(WebSocketCtor, url);
      } catch (e) {
        return reject(new Error(`Failed to create IPC connection: ${e?.message || e}`));
      }
      const timer = setTimeout(() => {
        conn.pending.delete(requestId);
        reject(new Error(`Daemon IPC ${diagnosticParts.join(" ")} timed out after ${Math.round(timeoutMs / 1e3)}s (requestId=${requestId})`));
      }, timeoutMs);
      conn.pending.set(requestId, { resolve, reject, timer });
      conn.lastUsedAt = Date.now();
      if (conn.ready) {
        conn.ws.send(JSON.stringify({ type: "ext:command", payload: { command: type, args, requestId } }));
      } else {
        conn.commandQueue.push({ type, args, requestId });
      }
    });
  }
};

// src/tools/chat-compact.ts
function messageContent(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("");
  }
  return "";
}
function isCoordinatorVisibleMessage(message) {
  if (!message || typeof message !== "object") return false;
  const role = String(message.role ?? "").toLowerCase();
  if (role === "tool" || role === "system" || role === "debug") return false;
  const kind = String(message.kind ?? message.type ?? message.messageKind ?? "").toLowerCase();
  if (["tool", "tool_call", "tool_result", "terminal", "internal", "control", "debug", "status"].includes(kind)) return false;
  const meta = message.meta ?? message.metadata;
  if (meta?.internal === true || meta?.debug === true || meta?.control === true || meta?.userVisible === false || meta?.user_visible === false) return false;
  return role === "user" || role === "assistant" || role === "agent";
}
function summarizeToolMessage(message) {
  if (!message || typeof message !== "object") return null;
  const kind = String(message.kind ?? message.type ?? message.messageKind ?? "").toLowerCase();
  const role = String(message.role ?? "").toLowerCase();
  if (kind === "terminal" || kind === "bash") {
    const cmd = message.command ?? message.cmd ?? message.input ?? messageContent(message);
    const exit = message.exitCode ?? message.exit_code ?? message.code;
    const cmdShort = typeof cmd === "string" ? cmd.split("\n")[0].slice(0, 120) : null;
    if (!cmdShort) return null;
    return exit !== void 0 && exit !== null ? `[Bash] ${cmdShort} \u2192 exit ${exit}` : `[Bash] ${cmdShort}`;
  }
  if (kind === "tool_call" || kind === "tool" || role === "tool") {
    const name = message.name ?? message.toolName ?? message.tool_name ?? message.function?.name;
    if (typeof name === "string" && name.trim()) return `[Tool] ${name.trim()}`;
    return null;
  }
  if (kind === "tool_result") {
    const exit = message.exitCode ?? message.exit_code ?? message.code;
    const name = message.name ?? message.toolName ?? message.tool_name;
    const label = typeof name === "string" && name.trim() ? name.trim() : "tool";
    return exit !== void 0 && exit !== null ? `[Tool result: ${label}] exit ${exit}` : null;
  }
  return null;
}
function buildCompactMessageTail(visibleMessages, opts) {
  const tail = visibleMessages.slice(-opts.limit);
  if (opts.finalAssistant && !tail.includes(opts.finalAssistant)) {
    return [opts.finalAssistant, ...tail];
  }
  return tail;
}
function normalizeForSummaryEquality(value) {
  return value.replace(/\s+/g, " ").trim();
}
function dedupeSummaryFromTail(messages, summary) {
  const normalizedSummary = summary ? normalizeForSummaryEquality(summary) : "";
  if (!normalizedSummary) return messages;
  return messages.map((message) => {
    const role = String(message?.role ?? "").toLowerCase();
    if (role !== "assistant" && role !== "agent") return message;
    const content = messageContent(message);
    if (!content.trim()) return message;
    if (normalizeForSummaryEquality(content) !== normalizedSummary) return message;
    const { content: _omitted, ...rest } = message;
    return { ...rest, content: "", _sameAsSummary: true };
  });
}
var TURN_IDENTITY_FIELDS = [
  "authority",
  "status",
  "stage",
  "terminalOutcome",
  "terminalReason",
  "meshId",
  "taskId",
  "attemptId",
  "attemptSeq",
  "sessionId",
  "nodeId",
  "providerType",
  "acceptedAt",
  "deliveredAt",
  "consumedAt",
  "terminalAt",
  "updatedAt"
];
function slimTurnPresentation(turn) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
  const slim = {};
  for (const key of TURN_IDENTITY_FIELDS) {
    if (turn[key] !== void 0) slim[key] = turn[key];
  }
  return Object.keys(slim).length > 0 ? slim : null;
}
function compactChatPayload(payload, opts = {}) {
  const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
  const visible = rawMessages.filter(isCoordinatorVisibleMessage);
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 10));
  const finalAssistant = [...visible].reverse().find((message) => {
    const role = String(message?.role ?? "").toLowerCase();
    return (role === "assistant" || role === "agent") && messageContent(message).trim();
  });
  const summary = typeof payload?.summary === "string" && payload.summary.trim() ? payload.summary.trim() : messageContent(finalAssistant).trim();
  const messages = dedupeSummaryFromTail(
    buildCompactMessageTail(visible, { summary, finalAssistant, limit }),
    summary
  );
  const toolSummaries = rawMessages.filter((m) => !isCoordinatorVisibleMessage(m)).map(summarizeToolMessage).filter((s) => s !== null);
  const omittedMessages = Math.max(0, rawMessages.length - messages.length);
  const filteredMessages = Math.max(0, rawMessages.length - visible.length);
  const slimTurn = opts.preserveTurn ? slimTurnPresentation(payload?.turn) : null;
  return {
    success: payload?.success !== false,
    compact: true,
    ...opts.nodeId ? { nodeId: opts.nodeId } : {},
    ...opts.sessionId !== void 0 ? { sessionId: opts.sessionId } : {},
    status: payload?.status ?? null,
    providerSessionId: payload?.providerSessionId ?? null,
    ...slimTurn ? { turn: slimTurn } : {},
    ...slimTurn?.attemptId !== void 0 ? { attemptId: slimTurn.attemptId } : {},
    ...slimTurn?.stage !== void 0 ? { turnStage: slimTurn.stage } : {},
    totalMessages: rawMessages.length,
    visibleMessages: visible.length,
    filteredMessages,
    omittedMessages,
    ...toolSummaries.length > 0 ? { toolSummaries } : {},
    summary,
    ...payload?.changedFiles !== void 0 ? { changedFiles: payload.changedFiles } : {},
    ...payload?.testsRun !== void 0 ? { testsRun: payload.testsRun } : {},
    messages
  };
}

// ../mesh-shared/dist/index.mjs
var MESH_TASK_DIFFICULTIES = ["easy", "medium", "difficult", "freeform"];
function isMeshTaskDifficulty(value) {
  return typeof value === "string" && MESH_TASK_DIFFICULTIES.includes(value);
}
function normalizeNodeCapabilitySlot(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const provider = typeof r.provider === "string" ? r.provider.trim() : "";
  if (!provider) return null;
  const model = typeof r.model === "string" ? r.model.trim() : "";
  const thinkingLevel = typeof r.thinkingLevel === "string" ? r.thinkingLevel.trim() : "";
  const difficulty = Array.isArray(r.difficulty) ? r.difficulty.filter(isMeshTaskDifficulty) : [];
  const capability = Array.isArray(r.capability) ? r.capability.filter((t) => typeof t === "string" && !!t.trim()).map((t) => t.trim()) : [];
  const maxParallelNum = Number(r.maxParallel);
  const maxParallel = Number.isFinite(maxParallelNum) && maxParallelNum > 0 ? Math.floor(maxParallelNum) : void 0;
  return {
    provider,
    ...model ? { model } : {},
    ...thinkingLevel ? { thinkingLevel } : {},
    ...difficulty.length ? { difficulty } : {},
    ...capability.length ? { capability } : {},
    ...maxParallel !== void 0 ? { maxParallel } : {}
  };
}
function normalizeNodeCapabilitySlots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const slot = normalizeNodeCapabilitySlot(entry);
    if (slot) out.push(slot);
  }
  return out;
}
var CANONICAL_MESH_TOOL_NAMES = [
  "mesh_status",
  "mesh_list_nodes",
  "mesh_enqueue_task",
  "mesh_view_queue",
  "mesh_queue_cancel",
  "mesh_queue_requeue",
  "mesh_send_task",
  "mesh_read_chat",
  "mesh_read_debug",
  "mesh_read_terminal",
  "mesh_send_keys",
  "mesh_launch_session",
  "mesh_git_status",
  "mesh_read_node_logs",
  "mesh_fast_forward_node",
  "mesh_restart_daemon",
  "mesh_checkpoint",
  "mesh_approve",
  "mesh_answer_question",
  "mesh_list_pending_approvals",
  "mesh_plan_onboarding",
  "mesh_create",
  "mesh_add_node",
  "mesh_clone_node",
  "mesh_remove_node",
  "mesh_cleanup_worktree_nodes",
  "mesh_refine_node",
  "mesh_refine_batch",
  "mesh_refine_config",
  "mesh_change_impact_config",
  "mesh_init",
  "mesh_reinit",
  "mesh_write_mesh_json_config",
  "mesh_refine_plan",
  "mesh_cleanup_sessions",
  "mesh_prune_stale_direct",
  "mesh_task_history",
  "mesh_ledger_query",
  "mesh_record_note",
  "mesh_forget_note",
  "mesh_reconcile_ledger",
  "mesh_requeue_held_events",
  "mesh_mission_upsert",
  "mesh_mission_list",
  "mesh_review_inbox",
  "mesh_magi_review",
  "mesh_magi_collect",
  "mesh_magi_kind_panel_set",
  "mesh_magi_kind_panel_list",
  "mesh_node_slots_set",
  "mesh_node_slots_list"
];
var CANONICAL_MESH_TOOL_COUNT = CANONICAL_MESH_TOOL_NAMES.length;
var STATUS_PROBE_ARG_KEY = "_statusProbe";
function withStatusProbeMarker(args = {}) {
  return { ...args, [STATUS_PROBE_ARG_KEY]: true };
}

// src/tools/mesh-tools-internal.ts
var import_daemon_core3 = require("@adhdev/daemon-core");

// src/tools/mesh-tool-shared.ts
function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readNumeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
var LARGE_LEDGER_FIELD_KEYS = /* @__PURE__ */ new Set(["plan", "validationPlan", "suggestedConfig", "payload"]);
var LARGE_LEDGER_OBJECT_THRESHOLD = 800;
var LARGE_LEDGER_NESTED_BYTES_THRESHOLD = 2e3;
function summarizeLargeLedgerField(key, value) {
  if (typeof value === "string") {
    return value.length > 500 ? value.slice(0, 500) + "\u2026" : value;
  }
  if (Array.isArray(value)) {
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length > LARGE_LEDGER_OBJECT_THRESHOLD) {
      return `[${key} summarized: ${value.length} items \u2014 use verbose=true or mesh_reconcile_ledger]`;
    }
    return value;
  }
  if (value && typeof value === "object") {
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length > LARGE_LEDGER_OBJECT_THRESHOLD) {
      return `[${key} summarized: ${Object.keys(value).length} keys \u2014 use verbose=true or mesh_reconcile_ledger]`;
    }
    return value;
  }
  return value;
}
function elideLargeNestedValue(key, value) {
  if (value === null || value === void 0) return value;
  if (typeof value === "string") {
    return value.length > 1e3 ? value.slice(0, 1e3) + "\u2026" : value;
  }
  if (typeof value !== "object") return value;
  const serialized = JSON.stringify(value);
  const bytes = serialized ? serialized.length : 0;
  if (bytes <= LARGE_LEDGER_NESTED_BYTES_THRESHOLD) return value;
  return {
    _elided: true,
    _kind: key,
    _bytes: bytes,
    _hint: "full evidence via mesh_reconcile_ledger"
  };
}

// src/tools/mesh-session-helpers.ts
var import_daemon_core = require("@adhdev/daemon-core");
function readSessionRecordId(session) {
  return readString(session?.id) || readString(session?.sessionId) || readString(session?.session_id) || readString(session?.runtimeSessionId) || readString(session?.runtime_session_id) || readString(session?.instanceId) || readString(session?.instance_id);
}
function extractStatusMetadataSessions(value) {
  const payload = unwrapCommandPayload(value);
  const status = payload?.status && typeof payload.status === "object" ? payload.status : payload;
  return Array.isArray(status?.sessions) ? status.sessions : [];
}
function resolveSessionProviderType(session) {
  return readString(session?.providerType) || readString(session?.cliType) || readString(session?.agentType) || "";
}
function isMeshCoordinatorSessionRecord(session) {
  return Boolean(
    readString(session?.settings?.meshCoordinatorFor) || readString(session?.meta?.meshCoordinatorFor) || readString(session?.metadata?.meshCoordinatorFor) || readString(session?.meshCoordinatorFor)
  );
}
function isUnmanagedSessionRecord(session) {
  const hasMeshNodeFor = Boolean(
    readString(session?.settings?.meshNodeFor) || readString(session?.meta?.meshNodeFor) || readString(session?.metadata?.meshNodeFor) || readString(session?.meshNodeFor)
  );
  if (hasMeshNodeFor) return false;
  if (isMeshCoordinatorSessionRecord(session)) return false;
  const launchedByCoordinator = Boolean(
    session?.settings?.launchedByCoordinator === true || session?.meta?.launchedByCoordinator === true || session?.launchedByCoordinator === true
  );
  return !launchedByCoordinator;
}
function isWorkerTaskMode(taskMode, readonly) {
  return !(0, import_daemon_core.isTaskReadonly)({ readonly, taskMode });
}
function addSessionRecord(target, session) {
  if (!session || typeof session !== "object" || isTerminalSessionRecord(session)) return;
  const sessionId = readSessionRecordId(session);
  if (sessionId) target.add(sessionId);
}
function collectNodeSessionIds(node) {
  const sessions = /* @__PURE__ */ new Set();
  const sessionArrays = [
    node?.sessions,
    node?.activeSessions,
    node?.active_sessions,
    node?.lastProbe?.sessions,
    node?.last_probe?.sessions,
    node?.lastProbe?.status?.sessions,
    node?.last_probe?.status?.sessions
  ];
  for (const value of sessionArrays) {
    if (Array.isArray(value)) value.forEach((session) => addSessionRecord(sessions, session));
  }
  const sessionRecords = [
    node?.activeSession,
    node?.active_session,
    node?.currentSession,
    node?.current_session,
    node?.runtimeSession,
    node?.runtime_session,
    node?.session,
    node?.lastProbe?.activeSession,
    node?.last_probe?.active_session,
    node?.lastProbe?.currentSession,
    node?.last_probe?.current_session,
    node?.lastProbe?.session,
    node?.last_probe?.session
  ];
  sessionRecords.forEach((session) => addSessionRecord(sessions, session));
  return sessions;
}
function unwrapCommandPayload(value) {
  let current = value;
  const seen = /* @__PURE__ */ new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    const nested = current.result ?? current.payload;
    if (!nested || typeof nested !== "object") break;
    current = nested;
  }
  return current;
}
function isTerminalSessionRecord(session) {
  const status = typeof session?.status === "string" ? session.status.toLowerCase() : "";
  const lifecycle = typeof session?.lifecycle === "string" ? session.lifecycle.toLowerCase() : "";
  const state = typeof session?.state === "string" ? session.state.toLowerCase() : "";
  return [status, lifecycle, state].some((value) => ["stopped", "failed", "terminated", "exited", "closed"].includes(value));
}
function isIdleSessionRecord(session) {
  if (isTerminalSessionRecord(session)) return false;
  const status = typeof session?.status === "string" ? session.status.toLowerCase() : "";
  const chatStatus = typeof session?.activeChat?.status === "string" ? session.activeChat.status.toLowerCase() : "";
  return status === "idle" || chatStatus === "waiting_input";
}

// src/tools/mesh-node-identity.ts
var import_daemon_core2 = require("@adhdev/daemon-core");
function resolveCoordinatorNode(ctx) {
  const preferredNodeId = typeof ctx.mesh.coordinator?.preferredNodeId === "string" ? ctx.mesh.coordinator.preferredNodeId.trim() : "";
  if (preferredNodeId) {
    const preferred = ctx.mesh.nodes.find((n) => n.id === preferredNodeId && typeof n.daemonId === "string" && n.daemonId.trim());
    if (preferred) return preferred;
  }
  if (ctx.localMachineId) {
    const byMachine = ctx.mesh.nodes.find((n) => readNodeMachineId(n) === ctx.localMachineId);
    if (byMachine) return byMachine;
  }
  if (ctx.localDaemonId) {
    return ctx.mesh.nodes.find((n) => (0, import_daemon_core2.daemonIdsEquivalent)(readNodeDaemonId(n), ctx.localDaemonId));
  }
  return void 0;
}
function resolveCoordinatorDaemonId(ctx) {
  const resolved = readString(resolveCoordinatorNode(ctx)?.daemonId) || readString(ctx.localDaemonId) || readString(ctx.localMachineId);
  return (0, import_daemon_core2.canonicalDaemonId)(resolved) ?? readString(resolved);
}
function readNodeMachineId(node) {
  return readString(node.machineId) || readString(node.machine_id) || readString(node.machine?.id) || readString(node.machine?.machineId) || readString(node.lastProbe?.machineId) || readString(node.last_probe?.machine_id) || readString(node.lastProbe?.machine?.id) || readString(node.lastProbe?.machine?.machineId) || readString(node.last_probe?.machine?.id) || readString(node.last_probe?.machine?.machine_id);
}
function readNodeDaemonId(node) {
  return readString(node.daemonId) || readString(node.daemon_id) || readString(node.machine?.daemonId) || readString(node.machine?.daemon_id) || readString(node.lastProbe?.daemonId) || readString(node.last_probe?.daemon_id) || readString(node.lastProbe?.machine?.daemonId) || readString(node.lastProbe?.machine?.daemon_id) || readString(node.last_probe?.machine?.daemonId) || readString(node.last_probe?.machine?.daemon_id);
}
function normalizeHostname(value) {
  const hostname = readString(value);
  if (!hostname) return void 0;
  return hostname.toLowerCase().replace(/\.$/, "");
}
function readNodeHostname(node) {
  return readString(node.hostname) || readString(node.host) || readString(node.machineHostname) || readString(node.machine_hostname) || readString(node.machine?.hostname) || readString(node.machine?.host) || readString(node.lastProbe?.hostname) || readString(node.last_probe?.hostname) || readString(node.lastProbe?.machine?.hostname) || readString(node.last_probe?.machine?.hostname);
}
function readNodeDisplayMachineName(node) {
  return readString(node.machineName) || readString(node.machine_name) || readString(node.machineLabel) || readString(node.machine_label) || readString(node.machineNickname) || readString(node.machine_nickname) || readString(node.alias) || readString(node.machine?.name) || readString(node.machine?.displayName) || readString(node.machine?.display_name) || readString(node.lastProbe?.machineName) || readString(node.last_probe?.machine_name) || readString(node.lastProbe?.machine?.name) || readString(node.last_probe?.machine?.name) || readNodeHostname(node);
}
function compactIdentityEvidence(value) {
  if (!value) return void 0;
  return value.length > 24 ? `${value.slice(0, 12)}\u2026${value.slice(-8)}` : value;
}
function pushIdentityEvidence(evidence, label, value) {
  const compact = compactIdentityEvidence(value);
  if (compact) evidence.push(`${label}:${compact}`);
}
function buildNodeMachineIdentity(ctx, node) {
  const machineId = readNodeMachineId(node);
  const daemonId = readNodeDaemonId(node);
  const hostname = readNodeHostname(node);
  const machineName = readNodeDisplayMachineName(node);
  const coordinatorHostname = readString(ctx.coordinatorHostname);
  const localControlPlaneReason = getLocalControlPlaneMatchReason(ctx, node);
  const directLocal = !!localControlPlaneReason;
  const hostnameMatches = Boolean(
    normalizeHostname(hostname) && normalizeHostname(coordinatorHostname) && normalizeHostname(hostname) === normalizeHostname(coordinatorHostname)
  );
  const sameMachine = directLocal || hostnameMatches;
  const evidence = [];
  pushIdentityEvidence(evidence, "machineName", machineName);
  pushIdentityEvidence(evidence, "hostname", hostname);
  pushIdentityEvidence(evidence, "machineId", machineId);
  pushIdentityEvidence(evidence, "daemonId", daemonId);
  if (localControlPlaneReason) {
    pushIdentityEvidence(evidence, "localMatch", localControlPlaneReason);
    pushIdentityEvidence(evidence, "localMachineId", ctx.localMachineId);
    pushIdentityEvidence(evidence, "localDaemonId", ctx.localDaemonId);
  }
  const locality = sameMachine ? "same_machine" : evidence.length > 0 ? "remote_known" : "remote_or_unknown";
  const localityReason = sameMachine ? localControlPlaneReason || "matched coordinator hostname" : evidence.length > 0 ? `known remote/other machine identity; no local coordinator match (${evidence.join(", ")})` : "no useful machine identity evidence available";
  return {
    daemonId,
    machineId,
    hostname,
    machineName,
    displayName: machineName || hostname || daemonId || machineId,
    coordinatorHostname,
    sameMachine,
    locality,
    localityReason,
    identityEvidence: evidence
  };
}
function nodeHasLocalDaemonEvidence(ctx, node) {
  const isLocal = (session) => {
    if (!session || typeof session !== "object") return false;
    if (ctx.localDaemonId && (0, import_daemon_core2.daemonIdsEquivalent)(session.runtime?.owner, ctx.localDaemonId)) return true;
    if (ctx.localDaemonId && (0, import_daemon_core2.daemonIdsEquivalent)(session.daemonClient?.daemonId, ctx.localDaemonId)) return true;
    return false;
  };
  const sessionArrays = [
    node?.sessions,
    node?.activeSessions,
    node?.active_sessions,
    node?.lastProbe?.sessions,
    node?.last_probe?.sessions,
    node?.lastProbe?.status?.sessions,
    node?.last_probe?.status?.sessions
  ];
  for (const arr of sessionArrays) {
    if (Array.isArray(arr) && arr.some(isLocal)) return true;
  }
  const sessionRecords = [
    node?.activeSession,
    node?.active_session,
    node?.currentSession,
    node?.current_session,
    node?.runtimeSession,
    node?.runtime_session,
    node?.session,
    node?.lastProbe?.activeSession,
    node?.last_probe?.active_session,
    node?.lastProbe?.currentSession,
    node?.last_probe?.current_session,
    node?.lastProbe?.session,
    node?.last_probe?.session
  ];
  for (const session of sessionRecords) {
    if (isLocal(session)) return true;
  }
  return false;
}
function isDirectLocalNode(ctx, node) {
  const machineId = readNodeMachineId(node);
  const daemonId = readNodeDaemonId(node);
  return Boolean(
    ctx.localMachineId && (0, import_daemon_core2.daemonIdsEquivalent)(machineId, ctx.localMachineId) || ctx.localDaemonId && (0, import_daemon_core2.daemonIdsEquivalent)(daemonId, ctx.localDaemonId) || nodeHasLocalDaemonEvidence(ctx, node)
  );
}
function isConfiguredCoordinatorNode(ctx, node) {
  if (!ctx.localMachineId && !ctx.localDaemonId) return false;
  const nodeId = readString(node.id) || readString(node.nodeId) || readString(node.node_id);
  if (!nodeId) return false;
  const nodeDaemonId = readNodeDaemonId(node);
  const nodeMachineId = readNodeMachineId(node);
  if (nodeDaemonId && ctx.localDaemonId && !(0, import_daemon_core2.daemonIdsEquivalent)(nodeDaemonId, ctx.localDaemonId)) return false;
  if (nodeMachineId && ctx.localMachineId && !(0, import_daemon_core2.daemonIdsEquivalent)(nodeMachineId, ctx.localMachineId)) return false;
  const preferredNodeId = readString(ctx.mesh.coordinator?.preferredNodeId) || readString(ctx.mesh.coordinator?.preferred_node_id);
  if (preferredNodeId) return nodeId === preferredNodeId;
  const first = ctx.mesh.nodes?.[0];
  const firstNodeId = readString(first?.id) || readString(first?.nodeId) || readString(first?.node_id);
  return !!firstNodeId && nodeId === firstNodeId;
}
function getLocalControlPlaneMatchReason(ctx, node) {
  if (isDirectLocalNode(ctx, node)) return "matched coordinator daemon or machine id";
  if (isConfiguredCoordinatorNode(ctx, node)) return "matched configured coordinator node";
  if (node.isLocalWorktree === true) {
    const sourceNode = findClonedFromNode(ctx, node);
    if (sourceNode && isDirectLocalNode(ctx, sourceNode)) return "matched local cloned-from node";
    if (sourceNode && isConfiguredCoordinatorNode(ctx, sourceNode)) return "matched configured coordinator source node";
  }
  return void 0;
}
function findClonedFromNode(ctx, node) {
  const clonedFromNodeId = readString(node.clonedFromNodeId) || readString(node.cloned_from_node_id);
  if (!clonedFromNodeId) return void 0;
  return ctx.mesh.nodes.find((n) => (0, import_daemon_core2.meshNodeIdMatches)(n, clonedFromNodeId));
}
function resolvePreferredWorktreeNodeId(ctx) {
  const worktreeNodes = (ctx.mesh.nodes || []).filter((n) => n.isLocalWorktree === true);
  if (worktreeNodes.length === 0) return void 0;
  const chosen = worktreeNodes[worktreeNodes.length - 1];
  return readString(chosen?.id) || readString(chosen?.nodeId) || readString(chosen?.node_id);
}
function isLocalControlPlaneNode(ctx, node) {
  return !!getLocalControlPlaneMatchReason(ctx, node);
}

// src/tools/mesh-tool-schemas.ts
var MESH_STATUS_TOOL = {
  name: "mesh_status",
  description: "Get the current status of all nodes in the repo mesh \u2014 health, git state, active sessions, recovery hints, and recommended next steps. Use this to decide which node to send work to or how to recover from failures. Also reports the running daemon build per daemonId under top-level daemonBuilds ({commit, commitShort, version}); when a live daemon was built from a commit BEHIND its workspace HEAD it adds staleDaemonBuilds[] + staleDaemonBuildWarning \u2014 meaning a just-merged refinery/mesh-tool fix is NOT yet live on that daemon (awaiting deploy/restart; a local dist rebuild does not update a cloud daemon). Do not repeatedly call this to wait for generating delegated work; wait for pendingCoordinatorEvents/completion events or an explicit user status request.",
  inputSchema: {
    type: "object",
    properties: {
      _gemini_compat: { type: "string", description: "Dummy property for Gemini compatibility. Ignore this." },
      includeStaleDirectWorkDetails: { type: "boolean", description: "Opt in to the full staleDirectWork array. Defaults false; normal status returns compact staleDirectWorkSummary only." },
      includeSessions: { type: "boolean", description: "Opt in to per-node live session arrays. Default false: compact mode returns a per-node sessionSummary (counts) and de-duplicated full session lists under top-level daemonSessions keyed by daemonId (sessions are not repeated for every node that shares a daemon). Set true to also include the full session array on each node." },
      compact: { type: "boolean", description: "Slim payload for LLM callers. Default true. Folds per-node session arrays to sessionSummary and de-duplicates daemon-shared sessions into daemonSessions. Set false (or verbose=true) for the full dashboard-grade payload." },
      verbose: { type: "boolean", description: "Force the full payload; overrides compact." }
    }
  }
};
var MESH_LIST_NODES_TOOL = {
  name: "mesh_list_nodes",
  description: "List all nodes in the mesh with their capabilities, platform, and workspace paths.",
  inputSchema: {
    type: "object",
    properties: {
      _gemini_compat: { type: "string", description: "Dummy property for Gemini compatibility. Ignore this." }
    }
  }
};
var MESH_ENQUEUE_TASK_TOOL = {
  name: "mesh_enqueue_task",
  description: "Add a new task to the mesh work queue. Idle nodes will automatically pull and execute tasks from this queue. Use this instead of mesh_send_task when you do not need to target a specific node. Supports task-level priority (high tasks are pulled ahead of older normal/low tasks), not_before delayed execution (hold a task pending until a time), maxRetries (auto-fail after N requeues), and duplicate detection (by default warns in the response when an in-flight task with the same message+target already exists; pass block_duplicate=true to refuse instead, or allow_duplicate=true to silence the warning).",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "The task instruction for the agent." },
      task_mode: { type: "string", enum: ["code_change", "validation", "live_debug_readonly", "launch_app", "convergence"], description: "Optional task-mode contract. live_debug_readonly rejects obvious write/commit/push/deploy/destructive instructions before dispatch." },
      taskMode: { type: "string", enum: ["code_change", "validation", "live_debug_readonly", "launch_app", "convergence"], description: "CamelCase alias for task_mode." },
      readonly: { type: "boolean", description: "Optional read-only axis (orthogonal to task_mode). When true the task runs without the one-active-per-node write isolation (N read-only tasks may run in parallel on one node), is counted under the read-only safety cap, and rejects write/commit/push/deploy/destructive instructions like live_debug_readonly. Equivalent to task_mode=live_debug_readonly but composable with any task_mode." },
      read_only: { type: "boolean", description: "Snake-case alias for readonly." },
      requiredTags: { type: "array", items: { type: "string" }, description: "Optional capability tags that every eligible node must have, e.g. os=darwin, provider=codex-cli, gpu." },
      required_tags: { type: "array", items: { type: "string" }, description: "Snake_case alias for requiredTags." },
      target_node_id: { type: "string", description: "Optional HARD constraint: ONLY this node may claim the task. No other node (especially a different machine) will ever claim it \u2014 if the target node has no idle session the task stays pending until it does. Use to route a queued task to a specific (e.g. freshly cloned) worktree node instead of letting the first idle base node claim it. Takes priority over prefer_worktree. An unresolvable target id is rejected at enqueue (no silent unpin)." },
      targetNodeId: { type: "string", description: "CamelCase alias for target_node_id." },
      target_node: { type: "string", description: "Alias for target_node_id." },
      targetNode: { type: "string", description: "CamelCase alias for target_node_id." },
      prefer_worktree: { type: "boolean", description: "Optional: when true, route this task to the most recently cloned idle worktree node (avoids the main/base workspace preemptively claiming an isolated task). No-op if no worktree node exists; resolves to a target_node_id when one does." },
      preferWorktree: { type: "boolean", description: "CamelCase alias for prefer_worktree." },
      depends_on: { type: "array", items: { type: "string" }, description: "Task ids that must complete before this task becomes claimable. Cycles are rejected at enqueue." },
      dependsOn: { type: "array", items: { type: "string" }, description: "CamelCase alias for depends_on." },
      mission_id: { type: "string", description: "Mission this task belongs to (mesh_mission record id)." },
      missionId: { type: "string", description: "CamelCase alias for mission_id." },
      priority: { type: "string", enum: ["low", "normal", "high"], description: "G6 (task-level scheduling priority). Within the claim tier a high task is pulled ahead of an older normal/low task (created_at is the tie-break); low is pulled last. Defaults to normal. This is the TASK priority (which task a node pulls first) \u2014 distinct from a node's schedulingPriority (which node work goes to). Use high to jump an urgent fix ahead of a backlog without cancelling the queue." },
      model: { type: "string", description: "Optional model override for the agent that runs this task, e.g. opus, sonnet, haiku. Best-effort: applied at launch for providers that support a model flag (claude-cli --model, ACP setConfigOption); ignored by providers that cannot honor it. Use a cheaper model for simple tasks to save tokens, a stronger one for hard work. Blank = the provider default." },
      thinkingLevel: { type: "string", enum: ["low", "medium", "high"], description: "Optional reasoning-effort level for this task. Best-effort: applied at launch for providers that support it (claude-cli --effort, codex-cli reasoning effort, ACP thought_level); ignored otherwise. Use low for simple tasks (fewer tokens), high for hard reasoning." },
      difficulty: { type: "string", enum: ["easy", "medium", "difficult", "freeform"], description: "Optional task execution difficulty. When set, the mesh per-difficulty brain preset fills in the model + thinkingLevel you did not pass explicitly (easy \u2192 cheap model / low effort to save tokens; difficult \u2192 strong model / high effort). Classify each task you enqueue so simple work runs cheaply. An explicit model/thinkingLevel above always wins over the preset." },
      notBefore: { type: "number", description: "CamelCase alias for not_before. Also accepts an ISO-8601 timestamp string." },
      max_retries: { type: "number", description: "P3 (retry cap). Max automatic requeue attempts before the task auto-fails instead of returning to pending. When requeueCount reaches this, mesh_queue_requeue auto-fails the task unless force=true. Omit to use the mesh policy default (maxTaskRetries, typically 1)." },
      maxRetries: { type: "number", description: "CamelCase alias for max_retries." },
      block_duplicate: { type: "boolean", description: "G4 (duplicate detection, block mode). Default false = warn-only: if an in-flight (pending/assigned) task with the same message (+ target node when pinned) already exists, the task is still enqueued but the response carries duplicateSuspect. Set true to REFUSE the enqueue with code duplicate_suspect instead (structural TASKBUBBLE-DUP defense \u2014 use when re-sending a task that a slow prior turn may have already enqueued)." },
      blockDuplicate: { type: "boolean", description: "CamelCase alias for block_duplicate." },
      allow_duplicate: { type: "boolean", description: "G4. Set true to skip duplicate detection entirely (no warning, no block) for an intentional re-enqueue of the same instruction." },
      allowDuplicate: { type: "boolean", description: "CamelCase alias for allow_duplicate." }
    },
    required: ["message"]
  }
};
var MESH_VIEW_QUEUE_TOOL = {
  name: "mesh_view_queue",
  description: "View the mesh work queue with source-of-truth active counts separated from historical completed/failed/cancelled records. Do not repeatedly call this to wait for generating assigned work; wait for pendingCoordinatorEvents/completion events or an explicit user status request.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "array",
        items: { type: "string" },
        description: "Explicit row filter by task status: pending, assigned, completed, failed, cancelled. Source-of-truth counts remain unfiltered; visible* counts describe returned rows."
      },
      view: {
        type: "string",
        enum: ["all", "active", "historical"],
        description: "Optional row view. active returns pending/assigned rows, historical returns completed/failed/cancelled rows, all returns every persisted queue row. Defaults to all for compatibility."
      },
      compact: { type: "boolean", description: "Slim payload for LLM callers. Default true. Drops large historical (completed/failed/cancelled) queue row arrays, the full staleDirectWork orphan array (kept as staleDirectWorkSummary counts), and per-row maintenance cleanupCandidates in favor of counts; pending/assigned active rows are retained. Set false (or verbose=true) for the full dashboard-grade payload." },
      verbose: { type: "boolean", description: "Force the full payload; overrides compact." }
    }
  }
};
var MESH_QUEUE_CANCEL_TOOL = {
  name: "mesh_queue_cancel",
  description: "Cancel a pending/assigned/completed/failed mesh queue task without deleting audit history. Use this to retire stale queue items that target dead sessions.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Queue task ID to cancel." },
      reason: { type: "string", description: "Optional operator-visible reason for cancellation." }
    },
    required: ["task_id"]
  }
};
var MESH_QUEUE_REQUEUE_TOOL = {
  name: "mesh_queue_requeue",
  description: "Return a mesh queue task to pending for retry. By default clears stale assigned owner and target session so another live session can claim it. When the task has exceeded its retry cap it is auto-failed instead; use force=true to override.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Queue task ID to requeue." },
      reason: { type: "string", description: "Optional operator-visible reason for requeueing." },
      target_node_id: { type: "string", description: "Optional replacement target node ID." },
      target_session_id: { type: "string", description: "Optional replacement target runtime session ID." },
      clear_target_node: { type: "boolean", description: "When true, remove any existing target node constraint." },
      keep_target_session: { type: "boolean", description: "When true, preserve an existing target session if target_session_id is not provided. Defaults false to avoid stale session targets." },
      force: { type: "boolean", description: "When true, bypass the retry cap and requeue even if maxRetries has been exceeded. Use only for explicit operator recovery." }
    },
    required: ["task_id"]
  }
};
var MESH_SEND_TASK_TOOL = {
  name: "mesh_send_task",
  description: "Legacy push-based task assignment. Enqueues a task specifically targeted at a given node. The node will pull it immediately if idle.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID (from mesh_list_nodes)." },
      session_id: { type: "string", description: "Agent session ID on the target node." },
      message: { type: "string", description: "Natural-language task to send to the agent." },
      task_mode: { type: "string", enum: ["code_change", "validation", "live_debug_readonly", "launch_app", "convergence"], description: "Optional task-mode contract. live_debug_readonly rejects obvious write/commit/push/deploy/destructive instructions before local or remote direct dispatch." },
      taskMode: { type: "string", enum: ["code_change", "validation", "live_debug_readonly", "launch_app", "convergence"], description: "CamelCase alias for task_mode." },
      readonly: { type: "boolean", description: "Optional read-only axis (orthogonal to task_mode). When true the task runs without write isolation, is counted under the read-only cap, and rejects write/commit/push/deploy/destructive instructions like live_debug_readonly. Composable with any task_mode." },
      read_only: { type: "boolean", description: "Snake-case alias for readonly." },
      mission_id: { type: "string", description: "Mission this task belongs to (mesh_mission record id). When set, the directly dispatched task is attributed to the mission task aggregates exactly like mesh_enqueue_task, including terminal completion. Omit for an unattributed direct dispatch." },
      missionId: { type: "string", description: "CamelCase alias for mission_id." }
    },
    required: ["node_id", "session_id", "message"]
  }
};
var MESH_READ_CHAT_TOOL = {
  name: "mesh_read_chat",
  description: "Read recent chat messages from a delegated agent session on a mesh node. Use compact=true for coordinator context-efficient review: it filters tool/internal/debug chatter and returns the final user-visible summary plus recent key messages. If the runtime session has completed, provider_session_id can explicitly target provider transcript history.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID." },
      session_id: { type: "string", description: "Agent session ID to read from." },
      provider_session_id: { type: "string", description: "Optional provider transcript/session ID for completed sessions." },
      tail: { type: "number", description: "Number of recent messages to return (default: 10)." },
      compact: { type: "boolean", description: "When true, return a compact coordinator summary instead of the full transcript: tool/internal/control/debug messages are excluded and only recent user-visible key messages plus the final assistant summary are included." }
    },
    required: ["node_id", "session_id"]
  }
};
var MESH_READ_DEBUG_TOOL = {
  name: "mesh_read_debug",
  description: "Collect a daemon-side chat/parser debug bundle for a delegated agent session on a mesh node without opening the browser UI. Defaults to daemon_file delivery and returns a saved bundle locator.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID." },
      session_id: { type: "string", description: "Agent session ID to debug." },
      provider_session_id: { type: "string", description: "Optional provider transcript/session ID for completed session history." },
      tail: { type: "number", description: "Number of recent read_chat messages to embed (default: 40)." },
      delivery: { type: "string", enum: ["daemon_file", "inline"], description: "daemon_file saves the full sanitized bundle on the daemon; inline returns it directly. Default: daemon_file." }
    },
    required: ["node_id", "session_id"]
  }
};
var MESH_READ_TERMINAL_TOOL = {
  name: "mesh_read_terminal",
  description: "Read the CURRENT raw terminal screen (the rendered PTY viewport \u2014 what a human would see on screen right now) of a delegated agent session on a mesh node. This is the LIVE screen, not the parsed chat transcript: use it to see exactly what the worker is showing \u2014 a prompt it is parked on, a modal, a spinner, or unparsed output that mesh_read_chat does not surface. For the conversation transcript use mesh_read_chat instead. The reply is byte-bounded (default 32KiB, max 64KiB; the BOTTOM of the screen \u2014 prompt/modal/recent output \u2014 is kept when truncated) and returns truncated/original_bytes/returned_bytes plus the cursor position and viewport size. Scoped to coordinator-spawned mesh worker sessions only. NOTE: the raw screen can contain tokens / command args / env values, so treat the returned text as sensitive.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID." },
      session_id: { type: "string", description: "Agent session ID whose live terminal viewport to read." },
      max_bytes: { type: "number", description: "Optional UTF-8 byte cap for the returned screen text (default 32768, clamped to [1024, 65536]). When the screen exceeds it, the bottom (most recent) lines are kept." }
    },
    required: ["node_id", "session_id"]
  }
};
var MESH_SEND_KEYS_TOOL = {
  name: "mesh_send_keys",
  description: `Inject a STRUCTURED key sequence into a delegated worker session's live PTY (keystrokes a human would type). Use for interactions mesh_send_task cannot express: dismiss/answer a non-approval prompt, navigate a picker (arrows/TAB), submit an already-typed line (ENTER), correct input (BACKSPACE), or interrupt a runaway command (CTRL_C). For sending a task/message, use mesh_send_task; for an APPROVAL modal, use mesh_approve (send_keys is refused on an actionable approval modal by design). Each sequence item is either {"text":"literal"} or {"key":NAME} where NAME \u2208 ENTER|ESC|CTRL_C|UP|DOWN|LEFT|RIGHT|TAB|BACKSPACE. text+ENTER is submitted atomically. DESTRUCTIVE keys (CTRL_C, ESC) can kill/derail the worker and require BOTH confirm_destructive=true AND mesh policy allowSendKeysDestructive \u2014 otherwise refused. The injection is refused if the session has a pending submit/echo race, or (for non-destructive keys) an actionable approval modal. Scoped to coordinator-spawned mesh worker sessions. Each injection is audited (key enums + result; the literal text body is NOT recorded).`,
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID." },
      session_id: { type: "string", description: "Agent session ID whose PTY to inject into." },
      sequence: {
        type: "array",
        description: 'Ordered key sequence. Each item is {"text":"literal UTF-8"} OR {"key":"ENTER|ESC|CTRL_C|UP|DOWN|LEFT|RIGHT|TAB|BACKSPACE"}. Max 64 items, 4096 total text bytes.',
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "Literal UTF-8 text to type." },
            key: { type: "string", enum: ["ENTER", "ESC", "CTRL_C", "UP", "DOWN", "LEFT", "RIGHT", "TAB", "BACKSPACE"], description: "Named key." }
          }
        }
      },
      confirm_destructive: { type: "boolean", description: "Required true when the sequence contains a destructive key (CTRL_C/ESC). Also requires mesh policy allowSendKeysDestructive." },
      allow_modal_override: { type: "boolean", description: "Override the actionable-approval-modal fail-closed refusal for NON-destructive keys. Use only when you deliberately need to inject into a modal-parked session that is NOT an approval you should route through mesh_approve." }
    },
    required: ["node_id", "session_id", "sequence"]
  }
};
var MESH_LAUNCH_SESSION_TOOL = {
  name: "mesh_launch_session",
  description: "Launch a new agent session on a mesh node. Returns the session ID for subsequent send_task/read_chat calls. If the user names a provider, preserve it exactly: Hermes = hermes-cli, Claude Code/Claude = claude-cli, Codex = codex-cli, Gemini = gemini-cli. If type is omitted, resolve strictly from the node policy providerPriority and provider detection; fail closed when no configured provider is usable. Do not default to claude-cli.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID." },
      type: { type: "string", description: "Optional provider type to launch. Use hermes-cli for Hermes, claude-cli for Claude Code, codex-cli for Codex, gemini-cli for Gemini. When omitted, node.policy.providerPriority is probed in order." },
      force: { type: "boolean", description: "Set true to launch an ADDITIONAL session even when this node already has a live mesh-owned worker session. Default false: if a live worker session for this mesh+node already exists (e.g. an enqueue auto-launch just spawned one), the existing session is returned idempotently instead of creating an empty duplicate. Only pass force when you intentionally want a second concurrent provider/session on the node." }
    },
    required: ["node_id"]
  }
};
var MESH_GIT_STATUS_TOOL = {
  name: "mesh_git_status",
  description: "Get git status for a mesh node workspace \u2014 branch, dirty state, changed files.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID." }
    },
    required: ["node_id"]
  }
};
var MESH_READ_NODE_LOGS_TOOL = {
  name: "mesh_read_node_logs",
  description: "Fetch a recent daemon LOG tail directly from a (possibly remote) mesh node over P2P \u2014 no session launch, no PowerShell/shell grep on the remote machine. Use this to debug a node's daemon: read its error/warn lines, grep for a pattern, or read since a timestamp. The reply is byte-bounded (\u2264128KB, default 64KB; truncated:true when the file was larger, newest lines kept) and secrets (API keys, machine secrets, bearer tokens, JWTs, TURN credentials) are redacted before transmission. This reads the DAEMON log, not an agent session transcript \u2014 for a session transcript use mesh_read_chat / mesh_read_debug.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID (the daemon owning it serves its own log)." },
      grep: { type: "string", description: "Optional regex (case-insensitive) \u2014 only matching log lines are returned. Invalid regex falls back to a literal substring match." },
      since_ms: { type: "number", description: "Optional epoch-ms floor \u2014 only log lines at/after this time are returned (lines without a parseable timestamp are kept)." },
      tail_bytes: { type: "number", description: "Max bytes of log tail to read (default 65536, capped at 131072). Larger files are truncated to the newest tail_bytes." },
      date: { type: "string", description: "Optional YYYY-MM-DD log date (defaults to today). Falls back to the size-rotation backup when the active file is absent." }
    },
    required: ["node_id"]
  }
};
var MESH_FAST_FORWARD_NODE_TOOL = {
  name: "mesh_fast_forward_node",
  description: 'Safely dry-run or execute an obvious direct fast-forward for a mesh node without launching an agent session. mode="merge" (default) absorbs upstream commits into the local branch via git merge --ff-only (ahead=0, behind>0). mode="push" publishes local commits to origin via a strict ff-only push (HEAD must be a descendant of origin/<branch>). Defaults to dry-run; execution requires execute=true. Never force-pushes, rebases, resets, cleans, or checks out arbitrary revisions. When the merge path finds the branch ahead with nothing to merge, it returns code "ahead_needs_push" pointing at mode="push".',
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID." },
      mode: { type: "string", enum: ["merge", "push"], description: "merge (default): git merge --ff-only to absorb upstream. push: strict ff-only push of local commits to origin/<branch>; refuses any non-fast-forward." },
      branch: { type: "string", description: "Optional guard: require the node's current branch to match this branch before planning/executing." },
      execute: { type: "boolean", description: "When true, apply the fast-forward/push if all safety gates pass. Defaults false/dry-run." },
      dry_run: { type: "boolean", description: "Preview only. Defaults true unless execute=true; dry_run=true overrides execute." },
      update_submodules: { type: "boolean", description: 'mode="merge" only: when true, if the root fast-forward changes gitlinks, run only git submodule update --init --recursive and verify submodules clean.' },
      push_submodules: { type: "boolean", description: 'mode="push" only: also ff-only push submodule HEADs to their origin main. Gated by mesh policy allowAutoPublishSubmoduleMainCommits \u2014 skipped unless that policy is enabled. Defaults false (root push only).' }
    },
    required: ["node_id"]
  }
};
var MESH_RESTART_DAEMON_TOOL = {
  name: "mesh_restart_daemon",
  description: `Restart a mesh node's daemon, optionally updating it first \u2014 the same path as the dashboard "preview update" button, exposed as a mesh command so a coordinator can roll a worker daemon without a manual restart round-trip. No agent session is launched. mode="upgrade" (default): update to the latest published version on the release channel, then restart; already-latest is a no-op (no restart, returns alreadyLatest:true). mode="restart": pure re-spawn with no reinstall \u2014 restarts even when already latest, with much shorter downtime; use it to reset wedged daemon state (memory leaks, zombie sessions). Idle-gated: a node whose daemon has an active session (generating / waiting_approval / starting) is refused with code "blocking_sessions" so an in-flight turn is never interrupted. self_only=true waives ONLY this mesh's own coordinator session (the structural self-deadlock case \u2014 the coordinator is always generating while it calls). Other sessions still refuse. force=true bypasses the gate entirely: in-flight turns die and the unpersisted pendingOutboundQueue is lost. when_idle=true schedules the restart to run automatically once the daemon goes idle (the safest path \u2014 no queue loss); cancel_when_idle=true cancels it and every response reports the schedule under deferredRestart. kill_session_host=true additionally stops the session-host process, destroying ALL hosted CLI sessions (hard refresh; this is what Windows already does on every upgrade). Default off. Note: on Windows any daemon restart/upgrade terminates all hosted sessions regardless of options; on POSIX hosted sessions survive a plain restart and rebind on next boot. Passing channel switches the daemon's release channel (and server URL) before restarting; omit it to keep the daemon on its configured channel.`,
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID \u2014 the daemon that owns this node is restarted (and updated, in upgrade mode)." },
      channel: { type: "string", enum: ["stable", "preview"], description: "Optional release channel to update from (upgrade mode only). Defaults to the daemon's configured updateChannel. Setting it also repoints the daemon's server URL to that channel." },
      mode: { type: "string", enum: ["upgrade", "restart"], description: "upgrade (default): update to latest on channel, then restart (already-latest is a no-op). restart: pure re-spawn, no reinstall \u2014 restarts even when already latest." },
      force: { type: "boolean", description: "Bypass the idle-gate entirely. Destructive: in-flight turns are killed and the in-memory pendingOutboundQueue is permanently lost. Default false." },
      self_only: { type: "boolean", description: "Waive only this mesh's own coordinator session when it blocks the restart (the coordinator self-deadlock). Other nodes' active sessions still refuse. Default false." },
      when_idle: { type: "boolean", description: "If blocked, schedule the restart to execute automatically once the daemon goes idle (safest \u2014 no pendingOutboundQueue loss). The schedule expires after timeout_ms (default 30 min). Default false." },
      cancel_when_idle: { type: "boolean", description: "Cancel a previously scheduled when_idle restart on the owning daemon." },
      timeout_ms: { type: "number", description: "Expiry for a when_idle schedule in milliseconds (default 1800000 = 30 min, max 6 h)." },
      kill_session_host: { type: "boolean", description: "Hard refresh: also stop the session-host process, destroying ALL hosted CLI sessions on the machine. Default false." }
    },
    required: ["node_id"]
  }
};
var MESH_CHECKPOINT_TOOL = {
  name: "mesh_checkpoint",
  description: "Create a git checkpoint (commit) on a mesh node workspace.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID." },
      message: { type: "string", description: "Checkpoint commit message." }
    },
    required: ["node_id", "message"]
  }
};
var MESH_MISSION_UPSERT_TOOL = {
  name: "mesh_mission_upsert",
  description: "Create or update a persistent mission record so the plan survives coordinator restarts. Create a mission before enqueueing a multi-task batch, attach tasks via mesh_enqueue_task mission_id, and update status to completed/abandoned when the outcome is decided. Progress is derived from task statuses \u2014 there is no separate progress field. Single mission: pass title (and optionally mission_id to update an existing one). Bulk status transition (e.g. one-time stale cleanup): pass mission_ids (array) + status to apply that status to many missions at once; title/goal are ignored and a per-mission result array is returned. mission_ids takes precedence over mission_id when both are given.",
  inputSchema: {
    type: "object",
    properties: {
      mission_id: { type: "string", description: "Mission id to update. Omit to create a new mission. Ignored when mission_ids is provided." },
      mission_ids: {
        type: "array",
        items: { type: "string" },
        description: "Bulk mode: apply `status` to every listed mission id in one call (stale cleanup). Requires `status`. Returns a per-mission { id, ok, status?, error? } result array. Overrides mission_id/title/goal."
      },
      title: { type: "string", description: "Short mission title. Required to create/update a single mission; ignored in bulk (mission_ids) mode." },
      goal: { type: "string", description: "Free-text mission goal/definition of done. Ignored in bulk (mission_ids) mode." },
      status: { type: "string", enum: ["active", "paused", "completed", "abandoned"], description: "Mission lifecycle status. Defaults to active on create. Required in bulk (mission_ids) mode." }
    },
    // No hard-required field: the single path requires `title` and the bulk path
    // requires `mission_ids` + `status`; the handler enforces the mode-specific rule
    // and returns a clear error, rather than the schema forcing `title` on bulk calls.
    required: []
  }
};
var MESH_MISSION_LIST_TOOL = {
  name: "mesh_mission_list",
  description: 'List missions with their goal, status, and live task progress (total/pending/assigned/completed/failed). Default (no `status`): non-terminal missions (active/paused) return in detail, while completed/abandoned missions are folded into a `historyFold` summary (counts by status + newest-first `missionIds`) rather than listed one-by-one \u2014 this keeps the payload bounded as a mesh accumulates hundreds of finished missions. To read finished missions in full, pass `status` explicitly (e.g. ["completed"]); those are returned in detail but still capped by `limit` (default 50), with overflow reported as truncated=true + overflowIds. Completed MAGI cross-verification missions (one auto-created per mesh_magi_review) are hidden by default to keep the list coordinator-focused \u2014 in-progress MAGI missions still show; pass include_magi=true to list completed ones too. Per-mission stats (ledger-scanned durations/attempts) are OMITTED by default \u2014 the `tasks` aggregate carries progress; pass include_stats=true (or verbose=true) to attach them. Compact (default) elides the full goal to a capped preview; pass verbose=true for full goal text. Read-only.',
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "array",
        items: { type: "string", enum: ["active", "paused", "completed", "abandoned"] },
        description: 'Optional status filter. Omit for the default folded view (active/paused in detail, completed/abandoned summarized). Provide it (e.g. ["completed"]) to list those missions in detail \u2014 bounded by `limit`.'
      },
      limit: {
        type: "number",
        description: "Max missions returned in detail (default 50). Overflow beyond the cap is reported as truncated=true + overflowIds."
      },
      verbose: { type: "boolean", description: "Return full goal text instead of a capped preview (also attaches stats). Defaults to false (compact)." },
      include_stats: { type: "boolean", description: "Attach per-mission ledger stats (durations/attempts). Off by default; tasks aggregate is usually enough." },
      include_magi: { type: "boolean", description: "Include completed MAGI cross-verification missions (hidden by default). Defaults to false." }
    }
  }
};
var MESH_APPROVE_TOOL = {
  name: "mesh_approve",
  description: "Approve or reject a pending action on a delegated agent session.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID." },
      session_id: { type: "string", description: "Agent session ID with pending approval." },
      action: { type: "string", enum: ["approve", "reject"], description: "Action to take." }
    },
    required: ["node_id", "session_id", "action"]
  }
};
var MESH_ANSWER_QUESTION_TOOL = {
  name: "mesh_answer_question",
  description: 'Answer a multi-choice QUESTION (AskUserQuestion) a delegated agent session is waiting on. This is the counterpart to mesh_approve: a QUESTION (surfaced as an agent:waiting_choice event / status "awaiting_choice") is NOT a yes/no approval \u2014 it offers labelled options (optionally multi-select, optionally a freeform "Type something") and must be answered here, never with mesh_approve. Supply the promptId from the waiting_choice event and one answer per question. Each answer selects option(s) by their exact label OR 1-based index; for a multi-select question pass an array of selections; a freeform answer passes text instead. The daemon drives the correct keystrokes into the provider TUI to submit the selection.',
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID (from the waiting_choice event / mesh_list_nodes)." },
      session_id: { type: "string", description: "Agent session ID that is awaiting the question answer." },
      promptId: { type: "string", description: "The InteractivePrompt promptId from the agent:waiting_choice event. Ensures the answer matches the active prompt." },
      answers: {
        type: "array",
        description: "One entry per question in the prompt (in question order). Each entry answers a single question by selecting option label(s)/index(es), or by supplying freeform text.",
        items: {
          type: "object",
          properties: {
            questionId: { type: "string", description: "Optional question id from the prompt payload. When omitted, entries are matched to the prompt questions by array position." },
            select: {
              description: "The chosen option(s): an option label (string), a 1-based option index (number), or an array of labels/indices for a multi-select question.",
              oneOf: [
                { type: "string" },
                { type: "number" },
                { type: "array", items: { type: ["string", "number"] } }
              ]
            },
            freeform: { type: "string", description: 'Freeform text answer (for a "Type something" option). Mutually exclusive with select.' }
          }
        }
      }
    },
    required: ["node_id", "session_id", "promptId", "answers"]
  }
};
var MESH_LIST_PENDING_APPROVALS_TOOL = {
  name: "mesh_list_pending_approvals",
  description: "List every session across the mesh that is currently awaiting an approval decision (status awaiting_approval) \u2014 the mesh-wide approval inbox. mesh_approve resolves ONE (node_id, session_id) at a time; this read-only tool enumerates the full pending set so you can see all blocked sessions at once and drive a mesh_approve for each. Each row carries nodeId, sessionId, providerType, taskTitle, and how long it has been waiting (waitingSince/waitingMs), longest-waiting first. Does not mutate anything.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};
var MESH_CREATE_TOOL = {
  name: "mesh_create",
  description: "Bootstrap a brand-new mesh for a Git repository \u2014 the first step for an MCP-only agent that has no mesh yet. Mirrors `adhdev mesh create <name>`. A mesh groups one repo's workspaces/nodes so the coordinator can delegate work across them. Pass workspace to auto-detect Git identity/branch/worktree metadata through the read-only planner, or explicitly pass repo_remote_url / repo_identity for backward compatibility. This is a persistent write: call mesh_plan_onboarding first and obtain explicit user approval before invoking it. Set add_current:true to also register a node in the same call (uses workspace if given, else the daemon's current working directory). BOOT-GATE / WHEN CALLABLE: this tool is reachable in STANDARD mode (adhdev mcp, no --repo-mesh) \u2014 the bootstrap context where no mesh exists \u2014 and also in mesh mode (where it creates a SEPARATE additional mesh). It is NOT reachable before any mesh exists via mesh mode, because `adhdev mcp --repo-mesh <id>` refuses to start without an existing meshId. So the intended flow is: run standard-mode MCP \u2192 mesh_create \u2192 mesh_add_node \u2192 then relaunch as `adhdev mcp --repo-mesh <returned mesh_id>`. Returns mesh_id (and node_id when add_current is used); use mesh_id for the follow-up mesh_add_node call and to launch mesh mode.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: 'Human-readable mesh name (e.g. "adhdev-main"). Trimmed, max 100 chars.' },
      repo_remote_url: { type: "string", description: "Optional explicit Git remote URL. When omitted with repo_identity, identity is read-only auto-detected from workspace." },
      repo_identity: { type: "string", description: "Optional explicit normalized repo identity. Wins over repo_remote_url; when both are omitted, workspace is auto-detected." },
      default_branch: { type: "string", description: 'Default branch for the repo (e.g. "main"). Optional; used as the merge/convergence target.' },
      add_current: { type: "boolean", description: "Also register a node in this same call (parity with CLI --add-current). Uses `workspace` if provided, otherwise the daemon's current working directory." },
      workspace: { type: "string", description: "Absolute workspace path used for Git auto-detection and, when add_current:true, node registration. Defaults to the daemon cwd." }
    },
    required: ["name"]
  }
};
var MESH_PLAN_ONBOARDING_TOOL = {
  name: "mesh_plan_onboarding",
  description: "Read-only Git-aware Repo Mesh discovery and dry-run planning for a workspace path. Detects the Git root, normalized remotes/repo identity, current/default branch, main checkout vs linked worktree/common-dir metadata, dirty/conflict state, and existing mesh/node membership. Returns a typed create+onboarding, add-existing-workspace, or clone-new-worktree plan with suggested .adhdev configs. It never fetches, writes config, creates a mesh/node/branch/worktree, or otherwise mutates state. Use this before mesh_create, mesh_add_node, or mesh_clone_node; execute write steps only after explicit user approval.",
  inputSchema: {
    type: "object",
    properties: {
      workspace: { type: "string", description: "Absolute path on the daemon that owns the Git checkout." },
      mesh_id: { type: "string", description: "Optional existing mesh to validate against. In mesh mode defaults to the active mesh." },
      operation: {
        type: "string",
        enum: ["auto", "add_existing", "clone_worktree", "create_mesh"],
        description: "Planning intent. auto chooses create+onboard when no compatible mesh exists, otherwise add existing. clone_worktree requires branch and a clean source."
      },
      branch: { type: "string", description: "New branch name when operation=clone_worktree." }
    },
    required: ["workspace"]
  }
};
var MESH_ADD_NODE_TOOL = {
  name: "mesh_add_node",
  description: "Register a workspace as a node in an EXISTING mesh \u2014 the second bootstrap step after mesh_create (or to add more nodes later). Mirrors `adhdev mesh add-node <mesh_id>` with --workspace / --read-only / --provider-priority. A node is a repo checkout on a daemon that the coordinator can launch agents on and delegate tasks to. mesh_id is REQUIRED in standard mode (pass the id returned by mesh_create); in mesh mode it defaults to the active mesh. workspace is the absolute path to the repo checkout ON THE DAEMON that owns it \u2014 the local base node is added by the daemon that created the mesh. This is a persistent mesh write: call mesh_plan_onboarding first and obtain explicit user approval. The implementation re-runs that preflight before writing. NOTE: this registers an EXISTING directory as a node (including auto-detected linked worktrees). To CREATE a fresh git worktree + branch for isolated parallel work, use mesh_clone_node instead \u2014 that runs the actual `git worktree add`. Returns node_id + workspace so you can immediately target the node with mesh_launch_session / mesh_send_task / mesh_enqueue_task.",
  inputSchema: {
    type: "object",
    properties: {
      mesh_id: { type: "string", description: "Target mesh id (from mesh_create / mesh_status). Required in standard mode; defaults to the active mesh in mesh mode." },
      workspace: { type: "string", description: "Absolute path to the repo checkout on the owning daemon (e.g. /Users/me/work/repo). Must be unique within the mesh." },
      read_only: { type: "boolean", description: "Mark the node read-only (no launches/mutations targeted here). Parity with CLI --read-only." },
      provider_priority: {
        type: "array",
        items: { type: "string" },
        description: 'Ordered provider types this node prefers when mesh_launch_session omits an explicit type (e.g. ["claude-cli","codex"]). Parity with CLI --provider-priority. A comma-separated string is also accepted.'
      },
      is_worktree: { type: "boolean", description: "Mark this workspace as an existing local git worktree (parity with CLI --worktree). This only tags an already-present worktree dir; it does NOT create one \u2014 use mesh_clone_node to create a worktree+branch." }
    },
    required: ["workspace"]
  }
};
var MESH_CLONE_NODE_TOOL = {
  name: "mesh_clone_node",
  description: "Create a new worktree-based node from an existing node for isolated parallel work. Creates a git worktree on a new branch so multiple tasks can run on separate branches simultaneously. This writes a branch, worktree and mesh node: call mesh_plan_onboarding with operation=clone_worktree and obtain explicit user approval first; the implementation re-runs the clean/source preflight.",
  inputSchema: {
    type: "object",
    properties: {
      source_node_id: { type: "string", description: "Node ID to clone from (from mesh_list_nodes)." },
      branch: { type: "string", description: 'Branch name for the new worktree (e.g. "feat/auth-refactor").' },
      base_branch: { type: "string", description: "Starting point for the branch (default: current HEAD)." }
    },
    required: ["source_node_id", "branch"]
  }
};
var MESH_REMOVE_NODE_TOOL = {
  name: "mesh_remove_node",
  description: "Remove a node from the mesh. If the node is a worktree, also cleans up the git worktree and directory. Session cleanup is controlled by mesh policy sessionCleanupOnNodeRemove unless session_cleanup_mode overrides it for this call. The coordinator's own local base node (same machine, NOT a worktree) is protected \u2014 removing it breaks live mesh membership and is rejected unless force:true is passed.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Node ID to remove." },
      session_cleanup_mode: {
        type: "string",
        enum: ["preserve", "stop", "delete_stopped", "stop_and_delete"],
        description: "Optional override for cleanup of delegated sessions attached to this node. preserve keeps history/processes; stop stops live runtimes only; delete_stopped removes completed transcripts only; stop_and_delete stops live runtimes and deletes records."
      },
      force: { type: "boolean", description: "Override the coordinator-base-node guard. Only set true to intentionally tear down this mesh; the coordinator must then be re-registered/restarted. Worktree nodes never need force." }
    },
    required: ["node_id"]
  }
};
var MESH_CLEANUP_WORKTREE_NODES_TOOL = {
  name: "mesh_cleanup_worktree_nodes",
  description: "Plan (dry-run, default) or execute safe removal of CONVERGED local worktree nodes (lifecycle retention). A node is eligible only when its feature branch is proven merged/pushed/converged AND every safety exclusion passes: no dirty/conflicted/stashed/submodule-drift state, no live session, no queue/direct-dispatch reference, no in-flight or blocked_review Refinery job, not the coordinator/base/cwd/evidence node. The automatic reconcile pass additionally requires two consecutive eligible ticks spanning a grace window (default 48h). Per-node reason codes are always returned; removal never uses force and branch refs are deleted only when proven fully merged.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Optional: restrict the plan/execute to a single node. When omitted, every node in the mesh is evaluated." },
      dry_run: { type: "boolean", description: "Default true. true = read-only reason-coded plan (identical shape to the automatic pass); false = execute removal for every currently-eligible node (never forces; the non-destructive precheck re-runs immediately before each removal)." }
    },
    required: []
  }
};
var MESH_CLEANUP_SESSIONS_TOOL = {
  name: "mesh_cleanup_sessions",
  description: "Manually clean up delegated session records for a mesh node without removing the node. Defaults should preserve reviewable history unless the caller chooses a mode explicitly.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Node ID whose delegated sessions should be considered for cleanup." },
      mode: {
        type: "string",
        enum: ["preserve", "stop", "delete_stopped", "stop_and_delete"],
        description: "preserve = no-op; stop = release process occupancy by stopping live runtimes; delete_stopped = remove completed/stopped records while leaving live runtimes alone; stop_and_delete = stop live runtimes and delete records."
      },
      session_ids: {
        type: "array",
        items: { type: "string" },
        description: "Optional explicit session IDs to limit cleanup to. When omitted, sessions are matched by node/workspace metadata."
      },
      dry_run: { type: "boolean", description: "Preview matched/stopped/deleted/skipped session IDs without mutating session-host state." }
    },
    required: ["node_id", "mode"]
  }
};
var MESH_TASK_HISTORY_TOOL = {
  name: "mesh_task_history",
  description: "Read the task ledger for this mesh \u2014 dispatched tasks, completions, failures, checkpoints, node lifecycle events, and mission lifecycle (mission_created / mission_status_changed / mission_goal_updated). Use to understand what has been done before deciding next steps, to detect repeated failures, to audit mission goal/status changes, and to inform recovery decisions.",
  inputSchema: {
    type: "object",
    properties: {
      tail: { type: "number", description: "Number of recent entries to return (default: 20; clamped to 40 in compact mode, 200 in verbose)." },
      kind: { type: "string", description: "Filter by entry kind: task_dispatched, task_completed, task_failed, task_stalled, session_launched, checkpoint_created, node_cloned, node_removed, direct_fast_forward, mission_created, mission_status_changed, mission_goal_updated." },
      compact: { type: "boolean", description: "Slim payload for LLM callers. Default true. Truncates long payload strings (message/taskSummary \u2264200, finalSummary \u2264300) and elides any large nested evidence blob (>2KB serialized \u2014 e.g. validationSummary/result/patchEquivalence/submoduleReachability) to a {_elided,_kind,_bytes,_hint} placeholder; full evidence stays accessible via mesh_reconcile_ledger. Set false (or verbose=true) for full untruncated payloads." },
      verbose: { type: "boolean", description: "Force the full untruncated payload; overrides compact." }
    }
  }
};
var MESH_LEDGER_QUERY_TOOL = {
  name: "mesh_ledger_query",
  description: 'Read-only ledger query along the kind / time / node axes \u2014 the complement to mesh_task_history (which is task-axis-centric). Use this to answer "what happened on node X", "what failed since <time>", or "show every checkpoint_created" without scanning transcripts. Filters compose (AND): kind narrows to one or more entry kinds, since bounds the time window, node restricts to one node (identity-form-agnostic), tail caps the returned count to the most recent N. Returns the filtered ledger entries (oldest\u2192newest) plus a small summary. Does not mutate anything.',
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", description: 'Filter by entry kind. Accepts one kind, or a comma-separated list (e.g. "task_failed,task_stalled"). Valid kinds include: task_dispatched, task_completed, task_failed, task_stalled, task_approval_needed, session_launched, session_stopped, checkpoint_created, node_cloned, node_joined, node_removed, direct_fast_forward, ledger_reconciled, event_held, mission_created, mission_status_changed, mission_goal_updated, magi_dispatched, magi_synthesis.' },
      since: { type: "string", description: 'Only return entries at/after this time. ISO-8601 string (e.g. "2026-07-05T00:00:00Z") or epoch-milliseconds. Omit for no lower bound.' },
      node: { type: "string", description: "Only return entries originating from this node (nodeId). Matched by daemon-id equivalence, so any identifier form (mach_X / daemon_mach_X) resolves." },
      tail: { type: "number", description: "Return only the most recent N matching entries (default 50; clamped to 500)." }
    }
  }
};
var MESH_RECORD_NOTE_TOOL = {
  name: "mesh_record_note",
  description: "Record a durable operating note for this mesh \u2014 a runtime-accumulated lesson that future coordinators inherit. Unlike Claude-only memory/CLAUDE.md, this is provider-neutral: it persists in the mesh ledger and is injected into every coordinator's system prompt at launch (codex, hermes, antigravity, claude alike). Use it when you learn something durable: a provider quirk, a pattern to avoid, or a recovery lesson. Keep each note to one concrete, reusable fact. Not for transient task status \u2014 use missions/checkpoints for that.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The note \u2014 one concrete, reusable operating fact/lesson. Phrase it so a future coordinator can act on it without this conversation's context." },
      category: {
        type: "string",
        enum: ["provider_quirk", "pattern_to_avoid", "recovery_lesson"],
        description: "Optional classification: provider_quirk (a provider/runtime behaves unexpectedly), pattern_to_avoid (an approach that caused problems), recovery_lesson (how a failure was recovered). Category also governs default read-side retention: recovery_lesson ages out of the injected prompt after ~14 days, pattern_to_avoid after ~30, provider_quirk and uncategorized are durable (never age out). The ledger entry is always kept for audit regardless."
      },
      pinned: {
        type: "boolean",
        description: "Pin this note so it ALWAYS rides into every coordinator prompt: never dropped by TTL expiry and kept ahead of unpinned notes when the injection cap is hit. Use for durable, high-value operating knowledge you never want to lose from the prompt."
      },
      ttl_days: {
        type: "number",
        description: "Optional explicit read-side lifespan in days. Resolved to an absolute expiry at record time; after it passes an UNPINNED note is hidden from the injected prompt (but retained in the ledger for audit). Overrides the category default TTL. Ignored when pinned is true."
      },
      supersedes: {
        type: "string",
        description: "Optional version-supersede: the note_id of an earlier note this one replaces, OR a subject_key shared with earlier notes. At injection any earlier LIVE note matching this id/subject is hidden from the prompt (its ledger entry is retained for audit). Use when you record an updated lesson that makes a prior one obsolete. Pinned notes are never hidden by supersede."
      },
      subject_key: {
        type: "string",
        description: "Optional stable subject key grouping notes about the same subject. Drives version-supersede targeting and read-side same-class folding (multiple live notes with the same category AND subject_key collapse to one injected entry, newest kept, older ids listed). When omitted, folding falls back to a leading [tag] bracket in the text."
      }
    },
    required: ["text"]
  }
};
var MESH_FORGET_NOTE_TOOL = {
  name: "mesh_forget_note",
  description: "Retract a stale or wrong operating note recorded via mesh_record_note. Appends a tombstone to the mesh ledger so the targeted note(s) stop riding into future coordinators' system prompts and drop out of the operating-notes list. History is preserved (append-only) \u2014 this suppresses, it does not rewrite. Target by note_id (from mesh_record_note / mesh_task_history) for an exact match, or by text to retract every note with that exact wording. Provide at least one.",
  inputSchema: {
    type: "object",
    properties: {
      note_id: { type: "string", description: "The ledger note id to retract (exact). Returned by mesh_record_note as noteId, or visible in mesh_task_history entries." },
      text: { type: "string", description: "Retract every operating note whose trimmed text exactly matches this string. Use when you do not have the note id." },
      reason: { type: "string", description: "Optional short reason for the retraction, recorded on the tombstone for audit." }
    }
  }
};
var MESH_RECONCILE_LEDGER_TOOL = {
  name: "mesh_reconcile_ledger",
  description: "Reconcile daemon-local mesh ledgers by querying bounded ledger slices over P2P/DataChannel and importing missing entries into the coordinator local JSONL ledger. Cloud/D1 is not used as a ledger source of truth.",
  inputSchema: {
    type: "object",
    properties: {
      node_ids: { type: "array", items: { type: "string" }, description: "Optional node IDs to query. Defaults to all mesh nodes." },
      limit: { type: "number", description: "Bounded slice size per node. Defaults to 100 and is clamped by daemon-core." },
      after_id: { type: "string", description: "Optional cursor entry ID; remote slices return entries strictly after this ID when present." },
      since: { type: "string", description: "Optional ISO timestamp lower bound for queried entries." },
      import_entries: { type: "boolean", description: "When false, query and report evidence without importing remote entries. Defaults true." }
    }
  }
};
var MESH_REQUEUE_HELD_EVENTS_TOOL = {
  name: "mesh_requeue_held_events",
  description: "Restore recoverable held coordinator events back to the pending queue. T6 quarantine (v2 enforce) and the pending-events trim mirror a destructively-drained-but-undelivered event into the ledger as a recoverable `event_held` entry \u2014 this is the operator path that actually requeues them (event_held\u2192pending), so a coordinator drains them on its next poll. Lossless: the full original event is restored, the pending-queue dedup suppresses any still-live duplicate, and each held entry is marked once so a second call does not requeue it again. Read-only by default? No \u2014 it mutates the pending queue; scope it with `filter` when you only want a subset.",
  inputSchema: {
    type: "object",
    properties: {
      filter: {
        type: "object",
        description: "Optional narrowing filter within this mesh. Omit to requeue every not-yet-recovered held event.",
        properties: {
          task_id: { type: "string", description: "Only requeue held events for this worker task id." },
          node_id: { type: "string", description: "Only requeue held events originating from this node." },
          event: { type: "string", description: "Only requeue held events of this event name (e.g. session:completed)." },
          reason: { type: "string", description: "Only requeue held entries with this hold reason (e.g. pending_trim_dropped, v2_enforce_validation_failed_quarantined)." },
          since: { type: "string", description: "Only requeue held entries recorded at/after this ISO timestamp." }
        }
      }
    }
  }
};
var MESH_PRUNE_STALE_DIRECT_TOOL = {
  name: "mesh_prune_stale_direct",
  description: "Prune orphaned staleDirect dispatch records \u2014 direct task dispatches whose original node/session is no longer present in the live mesh. dry_run (default) reports exactly which records would be pruned without mutating anything; pass execute=true to delete them. Active/pending/assigned/generating work and fresh unacknowledged dispatch failures (node/session still live) are always preserved. The append-only mesh ledger audit history is left intact.",
  inputSchema: {
    type: "object",
    properties: {
      execute: { type: "boolean", description: "When true, actually delete the orphaned records. Defaults false (dry run). Ignored when dry_run=true." },
      dry_run: { type: "boolean", description: "Force a preview without mutation even if execute=true. Defaults to dry-run behavior when execute is not set." },
      include_terminal: { type: "boolean", description: "Also prune terminal (completed/failed) direct dispatch store rows in addition to orphans. Defaults false." }
    }
  }
};
var MESH_REFINE_NODE_TOOL = {
  name: "mesh_refine_node",
  description: "The Refinery: validate \u2192 merge \u2192 push \u2192 clean up a completed worktree node onto the base branch. Defaults to dry-run (plan only): returns the validation plan with mergeWillRun:false/cleanupWillRun:false and performs NO merge/push/cleanup. Pass execute=true to actually converge the node. execute=true is async: the immediate response includes async:true, status:'accepted', jobId, interactionId, target node, and startedAt; completion/failure evidence is delivered through pending mesh events and the mesh task ledger. dry_run=true overrides execute. Matches the mesh_refine_batch / mesh_fast_forward_node dry_run/execute contract.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Node ID of the completed worktree node to refine and merge." },
      execute: { type: "boolean", description: "When true, run validation/merge/push/cleanup for this node. Defaults false/dry-run." },
      dry_run: { type: "boolean", description: "Preview the validation plan without merging. Defaults true unless execute=true; dry_run=true overrides execute." }
    },
    required: ["node_id"]
  }
};
var MESH_REFINE_BATCH_TOOL = {
  name: "mesh_refine_batch",
  description: "Batch Refinery: converge multiple sibling worktree nodes onto the base branch in one conflict-aware sequential pipeline. Orders nodes by change-area (non-submodule nodes first, submodule-touching nodes serialized last) so each merged sibling advances the base and the next node auto-rebases + re-checks patch-equivalence before its own merge. Each node runs the same validation/patch-equivalence/submodule-reachability/merge/cleanup gates as mesh_refine_node. Conflicting or blocked nodes are isolated as blocked_review while the rest of the batch proceeds. Defaults to dry-run (plan only); set execute=true to converge. Never force-pushes or resets. execute=true is async: the immediate response is async:true / status:'accepted' with the batch jobId and ordered target node list; per-node convergence runs in the background and the aggregate completion/failure (with per-node merged / blocked_review / not_mergeable results) is delivered as a terminal refine event via pending mesh events and the ledger \u2014 do not re-invoke while a batch is in flight. dry_run returns the plan synchronously.",
  inputSchema: {
    type: "object",
    properties: {
      node_ids: {
        type: "array",
        items: { type: "string" },
        description: "Optional explicit node IDs to converge, in any order (the tool computes the safe merge order). When omitted, all local worktree nodes that need convergence are auto-collected."
      },
      execute: { type: "boolean", description: "When true, run validation/rebase/merge for each node in order. Defaults false/dry-run." },
      dry_run: { type: "boolean", description: "Preview the ordering + per-node validation plan without executing. Defaults true unless execute=true; dry_run=true overrides execute." }
    },
    required: []
  }
};
var MESH_REFINE_CONFIG_TOOL = {
  name: "mesh_refine_config",
  description: "Repo Mesh Refinery config helper \u2014 unified read-only entry for the three refine-config operations. Select the operation with `mode` (REQUIRED). mode='schema': return the Refinery config JSON schema and supported repo-local config locations (the validation source of truth; heuristic command detection is suggestions-only) \u2014 takes no other parameters. mode='validate': validate the repo mesh/refine config for a node/workspace without running validation commands or merging \u2014 accepts optional `node_id` (defaults to the first mesh node) and an optional inline `config` object (validated instead of loading from the repo). mode='suggest': suggest a refine config scaffold from project context/package scripts (never executed until saved) \u2014 accepts optional `node_id`. Does NOT run validation commands or git merges \u2014 use mesh_refine_node / mesh_refine_plan for execution.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["schema", "validate", "suggest"],
        description: "Which config operation to run (required). schema: return the config JSON schema (no other params). validate: validate a node/workspace refine config (optional node_id, optional inline config). suggest: scaffold a config from project context (optional node_id)."
      },
      node_id: { type: "string", description: "Optional node/workspace. Used by mode=validate (config to load) and mode=suggest (context source); defaults to the first mesh node. Ignored by mode=schema." },
      config: { type: "object", description: "Optional inline config object to validate instead of loading from the repo. Only used by mode=validate." }
    },
    required: ["mode"]
  }
};
var MESH_CHANGE_IMPACT_CONFIG_TOOL = {
  name: "mesh_change_impact_config",
  description: "Repo Mesh Change Impact config helper \u2014 unified read-only entry for the three change-impact config operations. Change Impact config declaratively classifies which package/file changes between the live daemon build and workspace HEAD require a daemon rebuild/restart vs. a web-only redeploy vs. nothing (parsed, never executed). Select the operation with `mode` (REQUIRED). mode='schema': return the Change Impact config JSON schema and supported repo-local config locations \u2014 takes no other parameters. mode='validate': validate a Change Impact config for a node/workspace and report valid/errors \u2014 loads .adhdev/change-impact.{json,yaml,yml} (or repo-mesh-change-impact.* alias) unless an inline `config` object is provided; accepts optional `node_id` (defaults to the first mesh node). mode='suggest': suggest a Change Impact config scaffold from the repo package layout (web-* \u2192 web-only, others \u2192 daemon-runtime, plus docs/license markers as non-runtime) \u2014 the draft must be reviewed and saved before it takes effect; accepts optional `node_id`. Declarative only \u2014 nothing is executed.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["schema", "validate", "suggest"],
        description: "Which config operation to run (required). schema: return the config JSON schema (no other params). validate: validate a node/workspace change-impact config (optional node_id, optional inline config). suggest: scaffold a config from the repo package layout (optional node_id)."
      },
      node_id: { type: "string", description: "Optional node/workspace. Used by mode=validate (config to load) and mode=suggest (context source); defaults to the first mesh node. Ignored by mode=schema." },
      config: { type: "object", description: "Optional inline config object to validate instead of loading from the repo. Only used by mode=validate." }
    },
    required: ["mode"]
  }
};
var MESH_INIT_TOOL = {
  name: "mesh_init",
  description: "One-click mesh onboarding for an existing git project. Detects installed CLI providers, suggests all three repo `.adhdev/*` config families \u2014 Refinery (.adhdev/refine.json), worktree bootstrap (.adhdev/worktree_bootstrap.json) AND change-impact (.adhdev/change-impact.json) \u2014 optionally writes them to disk, and recommends a node providerPriority from the detected providers. Also returns `currentConfig`: the currently-saved config per domain (repo files + machine-local magiKindPanels) so you can present a current-vs-suggested diff before overwriting. Suggestions are scaffold only and never execute until saved; providerPriority is a recommendation to apply to node policy, not auto-applied. Defaults to dry-run (no files written) and never overwrites an existing config unless overwrite=true. For an already-onboarded repo that needs refreshing, use mesh_reinit (overwrite semantics + enforced diff).",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Optional node/workspace to onboard. Defaults to the first mesh node with a workspace." },
      write: { type: "boolean", description: "When true, persist the suggested configs to disk. Defaults false (dry-run preview only)." },
      overwrite: { type: "boolean", description: "When true, overwrite an existing config file. Defaults false (never clobber an existing refine/bootstrap config)." }
    }
  }
};
var MESH_REINIT_TOOL = {
  name: "mesh_reinit",
  description: "Re-onboard an ALREADY-initialized repo: re-suggest the repo `.adhdev/*` configs (refine / worktree_bootstrap / change-impact) with OVERWRITE semantics and return a current-vs-suggested diff so you can replace stale config. This is NOT a new write engine \u2014 it reuses mesh_init's suggest\u2192validate\u2192gated-write with overwrite=true (default) plus the current-config echo (`currentConfig`). CONTRACT: overwrite is a WHOLESALE replacement, so it must NOT silently drop operator hand-edits \u2014 the first call (write=false, the default) is a DRY-RUN preview that surfaces the per-section diff; you MUST present that current-vs-suggested diff and get EXPLICIT per-section user approval, then re-invoke with write=true. Use mesh_init (not reinit) for a fresh, never-onboarded repo.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Optional node/workspace to re-onboard. Defaults to the first mesh node with a workspace." },
      write: { type: "boolean", description: "When true, persist the overwritten configs. Defaults false (dry-run preview surfacing the current-vs-suggested diff \u2014 approve per-section first)." },
      overwrite: { type: "boolean", description: "Defaults true (reinit replaces existing config). Pass false to fall back to existing-wins (equivalent to mesh_init)." }
    }
  }
};
var MESH_REFINE_PLAN_TOOL = {
  name: "mesh_refine_plan",
  description: "Dry-run Refinery plan for a worktree node: reports config source, validation commands, suggestions/unavailable reason, and merge/cleanup intent without executing validation or git merge.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Node ID of the worktree node to plan." }
    },
    required: ["node_id"]
  }
};
var MESH_REVIEW_INBOX_TOOL = {
  name: "mesh_review_inbox",
  description: "List local worktree nodes that need human review: merge candidates (pushed feature branches ready to merge) and Refinery-blocked review results. Returns evidence summaries, diff stats vs. the default branch, and suggested actions (Refine / Requeue / Dismiss). Remote nodes are excluded in M4.0.",
  inputSchema: {
    type: "object",
    properties: {
      mesh_id: { type: "string", description: "Mesh ID (optional \u2014 inferred from active mesh if omitted)." }
    },
    required: []
  }
};
var MESH_MAGI_REVIEW_TOOL = {
  name: "mesh_magi_review",
  description: 'Cross-verify a read-only investigation across a standing panel of independent mesh agents (different machines/providers), instead of sending a SINGLE read-only worker. Drop-in for any read-only investigation \u2014 bug RCA, defect/regression measurement, "why does this code do X?", or doc/design/API review. Fans the SAME question out to N independent (node \xD7 provider) replicas, then synthesizes consensus/disagreement/unique evidence into a needs_verification list \u2014 NOT a majority vote (high agreement among coupled agents \u2260 correct). Read-only is FORCED (no execute/write flag exists). COST: multiplies token spend by the total replica count (the call is the opt-in). PANEL RESOLUTION: the panel is resolved SOLELY from the USER-CONFIGURED kind-panel binding for the given `task_kind` (mesh settings \u2192 magiKindPanels: task_kind \u2192 (node \xD7 provider \xD7 model) slots). `task_kind` is REQUIRED \u2014 there is NO named-panel, inline-members, or automatic-preset path. A task_kind with no configured kind-panel errors `magi_kind_not_configured` (configure slots in mesh settings first). The binding must resolve to \u22652 (node, provider) targets; never silently degrades to N=1 (errors magi_insufficient_targets if the live mesh cannot supply the configured slots).',
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: 'The single investigation question every agent answers \u2014 e.g. "What is the root cause of this defect?", "Refute this RCA.", "Why does this code do X?". Not only "review this".' },
      target: { type: "string", description: "What to investigate \u2014 file path(s), a bug symptom / error / stack trace, a code area / symbol, or omitted when the question is self-contained." },
      artifacts: { type: "array", items: { type: "string" }, description: "Inline content when not file-backed: a doc/diff, a log/error dump, or a prior single-worker RCA to refute." },
      n: { type: "number", description: "Global replica override per slot (clamped by the total-replica guard cap, default 12)." },
      task_kind: { type: "string", enum: ["claim_audit", "rca", "design", "freeform"], description: "REQUIRED. Selects (1) the SINGLE output schema injected into each replica prompt and the strict parser used at collection (no schema-on-schema conflict), AND (2) the user-configured kind-panel binding that supplies the fan-out slots (mesh settings \u2192 magiKindPanels; errors magi_kind_not_configured if that kind has no configured slots \u2014 no named-panel/inline/preset fallback). claim_audit: {claims[],top_findings[],open_questions[]}. rca: {rootCause,failsAt,mechanism,evidence[],fixDirection,confidence}. design: {recommendation,rationale,alternatives[],tradeoffs[],risks[],evidence[],confidence}. freeform: no schema \u2014 natural-language answer, parsing/evidence checks waived, cross-verification is weak. Every kind except freeform requires non-empty evidence[]; an empty-evidence or schema-invalid answer triggers ONE delta re-request before being dropped as unparseable. Do NOT also embed an output-format schema in the question \u2014 it collides with this contract (a warning is surfaced if detected)." },
      mode: { type: "string", enum: ["rca", "investigation", "claim_audit", "design_review", "code_audit"], description: "Synthesis emphasis hint \u2014 affects labels only, never the agent count or schema. Distinct from task_kind (which selects the output schema)." },
      require_independent_evidence: { type: "boolean", description: "Default true \u2014 high-impact claims with no file:line/source evidence are routed to needs_verification." },
      include_stale: { type: "boolean", description: "Default false. By default, panel slots whose node HEAD commit differs from the coordinator reference commit are EXCLUDED (they would investigate different code). Set true to fan out to them anyway \u2014 results will be git-skewed and a warning is surfaced. If exclusion drops the panel below 2 independent targets the call errors rather than degrading to N=1; include_stale=true is one way to recover." },
      wait: { type: "boolean", description: "Default true \u2014 collect replica outputs and return the synthesis. Set false to dispatch async and return a consensusGroupId handle; collect later with mesh_magi_collect." },
      wait_timeout_ms: { type: "number", description: 'Max time to wait for replica completion before returning a partial "missing K of N" synthesis. Default ~4 min.' },
      auto_cleanup: { type: "boolean", description: "Default = mesh policy magiSessionCleanup (ON / stop_and_delete unless overridden). Once all replicas are terminal, stop+delete ONLY the worker sessions THIS fan-out auto-launched (marker-verified) so repeated reviews don't accumulate idle worker sessions. Reused/coordinator/other sessions are never touched. Set false to preserve auto-launched worker sessions for inspection. No effect on a partial (non-terminal) collection." }
    },
    required: ["question", "task_kind"]
  }
};
var MESH_MAGI_COLLECT_TOOL = {
  name: "mesh_magi_collect",
  description: "Collect + synthesize a previously dispatched MAGI fan-out by its consensus group id \u2014 the async companion to mesh_magi_review({ wait:false }). Rediscovers the replica tasks from the queue and runs the SAME diversity-weighted synthesis (consensus/disagreement/unique-evidence \u2192 needs_verification list). Defaults to a SNAPSHOT (wait=false): returns whatever replicas are terminal right now, with a pending note if some are still generating; pass wait=true to block for the rest. Read-only. Drive off mission completion / pendingCoordinatorEvents rather than polling this in a tight loop.",
  inputSchema: {
    type: "object",
    properties: {
      consensus_group_id: { type: "string", description: "The consensusGroupId returned by a wait=false mesh_magi_review." },
      task_kind: { type: "string", enum: ["claim_audit", "rca", "design", "freeform"], description: "Optional override of the task_kind used to parse replica answers. Normally recovered automatically from the original dispatch \u2014 only set this if the dispatched ledger entry was pruned and auto-recovery falls back to claim_audit incorrectly." },
      require_independent_evidence: { type: "boolean", description: "Default true \u2014 high-impact claims with no file:line/source evidence are routed to needs_verification." },
      wait: { type: "boolean", description: "Default false (snapshot). Set true to block for outstanding replicas up to wait_timeout_ms before synthesizing." },
      wait_timeout_ms: { type: "number", description: "When wait=true, max time to wait for remaining replica completion. Default ~4 min." },
      auto_cleanup: { type: "boolean", description: "Default = mesh policy magiSessionCleanup (ON / stop_and_delete). When the collection is terminal, stop+delete ONLY the worker sessions THIS fan-out auto-launched (marker-verified). Reused/coordinator/other sessions are never touched. Set false to preserve them. No effect on a partial (non-terminal) snapshot." },
      verbose: { type: "boolean", description: "Default false. When true, each synthesis.replicas[] entry also carries rawAnswer \u2014 the replica's raw end-user answer text (capped). Omitted by default to keep the payload small; the structured clusters already carry the parsed claims." }
    },
    required: ["consensus_group_id"]
  }
};
var MESH_MAGI_KIND_PANEL_SET_TOOL = {
  name: "mesh_magi_kind_panel_set",
  description: "Bind a task_kind to its MAGI kind-panel slot list (machine-local ~/.adhdev/meshes.json `magiKindPanels`). This binding is what a `mesh_magi_review({ task_kind })` resolves to \u2014 it is the SOLE panel-resolution path (there is no named-panel or inline-members alternative). IMPORTANT \u2014 WHOLESALE REPLACEMENT: a task_kind has exactly one binding, so the `slots` you pass become the COMPLETE new slot set and any prior slots for that kind are dropped (not merged). Because it silently replaces the current binding, get EXPLICIT user approval before writing and present the current-vs-new slot lists (the dry-run returns `currentSlots`). Defaults to dry-run (write=false). Machine-local scope (NOT a repo-committed file).",
  inputSchema: {
    type: "object",
    properties: {
      task_kind: { type: "string", description: "The task_kind key to bind, e.g. claim_audit / rca / design / freeform." },
      slots: {
        type: "array",
        description: "The COMPLETE desired slot list for this kind (wholesale replacement). Each slot: { provider (REQUIRED), nodeId?, model?, capabilityTags?, n? }.",
        items: {
          type: "object",
          properties: {
            provider: { type: "string", description: "REQUIRED \u2014 provider type, e.g. claude-cli / codex-cli / gemini-cli / hermes-cli." },
            nodeId: { type: "string", description: "Optional \u2014 pin to a specific mesh node id." },
            model: { type: "string", description: "Optional \u2014 pin a specific model for this slot." },
            capabilityTags: { type: "array", items: { type: "string" }, description: "Optional routing tags (ANDed with the provider tag) when nodeId is absent." },
            n: { type: "number", description: "Optional per-slot replica count (default 1)." }
          },
          required: ["provider"]
        }
      },
      write: { type: "boolean", description: "When true, persist the slot list (wholesale replacement) to meshes.json. Defaults false (dry-run preview of the normalized slots + currentSlots)." }
    },
    required: ["task_kind", "slots"]
  }
};
var MESH_MAGI_KIND_PANEL_LIST_TOOL = {
  name: "mesh_magi_kind_panel_list",
  description: "List the configured MAGI kind\u2192panel slot bindings (machine-local). Read-only. Use to confirm what a `task_kind` resolves to before mesh_magi_review, and to diff current-vs-new before an overwrite via mesh_magi_kind_panel_set.",
  inputSchema: {
    type: "object",
    properties: {
      task_kind: { type: "string", description: "Optional \u2014 show only this task_kind's binding. Omit to list all configured kind bindings." }
    }
  }
};
var MESH_NODE_SLOTS_SET_TOOL = {
  name: "mesh_node_slots_set",
  description: "PROPOSE (dry-run) or APPLY a mesh node's capability-slot list (policy.slots) \u2014 the orchestrator's surface for autonomously adjusting a node's AI-tool profile mid-run (ORCHESTRATION_NODE_SLOTS.md \xA75). A node's slots drive task\u2192node fitness routing and MAGI fan-out, so changing them changes how work is distributed. IMPORTANT \u2014 WHOLESALE REPLACEMENT: the `slots` you pass become the node's COMPLETE new slot list; any prior slot not in the list is dropped (not merged). Because it silently replaces the profile, get EXPLICIT user approval before writing: the default dry-run (write=false) returns `currentSlots` vs `proposedSlots` for you to present as a diff \u2014 re-run with write=true ONLY after the user approves. Apply goes through update_mesh_node (machine-local node policy).",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "REQUIRED \u2014 the mesh node id whose capability slots to set." },
      slots: {
        type: "array",
        description: "The COMPLETE desired capability-slot list for this node (wholesale replacement). Each slot: { provider (REQUIRED), model?, thinkingLevel?, difficulty?, capability?, maxParallel? }.",
        items: {
          type: "object",
          properties: {
            provider: { type: "string", description: "REQUIRED \u2014 provider type, e.g. claude-cli / codex-cli / gemini-cli / hermes-cli." },
            model: { type: "string", description: "Optional \u2014 model for this slot (best-effort at launch, e.g. opus / gpt-5-codex)." },
            thinkingLevel: { type: "string", description: "Optional \u2014 provider-specific thinking level verbatim (e.g. low/medium/high/max, or codex minimal/xhigh)." },
            difficulty: { type: "array", items: { type: "string" }, description: "Optional \u2014 task difficulties this slot handles (easy/medium/difficult/freeform). Empty = all (general-purpose)." },
            capability: { type: "array", items: { type: "string" }, description: "Optional \u2014 capability tags this slot satisfies (matched against a task's requiredTags)." },
            maxParallel: { type: "number", description: "Optional \u2014 per-node\xB7per-slot max concurrent tasks. Omit = no per-slot cap." }
          },
          required: ["provider"]
        }
      },
      reason: { type: "string", description: "Optional \u2014 a short rationale for the proposal, echoed in the dry-run so the user sees WHY the change is suggested." },
      write: { type: "boolean", description: "When true, apply the slot list (wholesale replacement) to the node. Defaults false (dry-run preview of proposedSlots + currentSlots)." }
    },
    required: ["node_id", "slots"]
  }
};
var MESH_NODE_SLOTS_LIST_TOOL = {
  name: "mesh_node_slots_list",
  description: "List a mesh node's capability slots (policy.slots). Read-only. Use to confirm the current AI-tool profile of a node and to diff current-vs-proposed before a mesh_node_slots_set overwrite.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "REQUIRED \u2014 the mesh node id whose capability slots to list." }
    },
    required: ["node_id"]
  }
};
var MESH_WRITE_MESH_JSON_CONFIG_TOOL = {
  name: "mesh_write_mesh_json_config",
  description: "Write `.adhdev/mesh.json` (the repo-committed coordinator prompt override/append + declarative config) from the machine-local mesh entry. Gated WRITE sibling of the draft-only export_mesh_json_config. Follows the mesh_init write/overwrite/dry-run precedent: defaults to dry-run (write=false), never clobbers an existing repo mesh.json unless overwrite=true, and validates before writing. Overwrite silently replaces the file, so present a current-vs-suggested diff and get explicit approval first. REPO-COMMITTED scope (commit target) \u2014 distinct from the machine-local MAGI kind-panel writes.",
  inputSchema: {
    type: "object",
    properties: {
      write: { type: "boolean", description: "When true, persist .adhdev/mesh.json to the repo (commit target). Defaults false (dry-run preview)." },
      overwrite: { type: "boolean", description: "When true, replace an existing .adhdev/mesh.json. Defaults false (never clobber an existing repo mesh.json)." },
      workspace: { type: "string", description: "Optional workspace path whose .adhdev/mesh.json is written. Defaults to the coordinator node workspace." }
    }
  }
};
var ALL_MESH_TOOLS = [
  MESH_STATUS_TOOL,
  MESH_LIST_NODES_TOOL,
  MESH_ENQUEUE_TASK_TOOL,
  MESH_VIEW_QUEUE_TOOL,
  MESH_QUEUE_CANCEL_TOOL,
  MESH_QUEUE_REQUEUE_TOOL,
  MESH_SEND_TASK_TOOL,
  MESH_READ_CHAT_TOOL,
  MESH_READ_DEBUG_TOOL,
  MESH_READ_TERMINAL_TOOL,
  MESH_SEND_KEYS_TOOL,
  MESH_LAUNCH_SESSION_TOOL,
  MESH_GIT_STATUS_TOOL,
  MESH_READ_NODE_LOGS_TOOL,
  MESH_FAST_FORWARD_NODE_TOOL,
  MESH_RESTART_DAEMON_TOOL,
  MESH_CHECKPOINT_TOOL,
  MESH_APPROVE_TOOL,
  MESH_ANSWER_QUESTION_TOOL,
  MESH_LIST_PENDING_APPROVALS_TOOL,
  MESH_PLAN_ONBOARDING_TOOL,
  MESH_CREATE_TOOL,
  MESH_ADD_NODE_TOOL,
  MESH_CLONE_NODE_TOOL,
  MESH_REMOVE_NODE_TOOL,
  MESH_CLEANUP_WORKTREE_NODES_TOOL,
  MESH_REFINE_NODE_TOOL,
  MESH_REFINE_BATCH_TOOL,
  MESH_REFINE_CONFIG_TOOL,
  MESH_CHANGE_IMPACT_CONFIG_TOOL,
  MESH_INIT_TOOL,
  MESH_REINIT_TOOL,
  MESH_WRITE_MESH_JSON_CONFIG_TOOL,
  MESH_REFINE_PLAN_TOOL,
  MESH_CLEANUP_SESSIONS_TOOL,
  MESH_PRUNE_STALE_DIRECT_TOOL,
  MESH_TASK_HISTORY_TOOL,
  MESH_LEDGER_QUERY_TOOL,
  MESH_RECORD_NOTE_TOOL,
  MESH_FORGET_NOTE_TOOL,
  MESH_RECONCILE_LEDGER_TOOL,
  MESH_REQUEUE_HELD_EVENTS_TOOL,
  MESH_MISSION_UPSERT_TOOL,
  MESH_MISSION_LIST_TOOL,
  MESH_REVIEW_INBOX_TOOL,
  MESH_MAGI_REVIEW_TOOL,
  MESH_MAGI_COLLECT_TOOL,
  MESH_MAGI_KIND_PANEL_SET_TOOL,
  MESH_MAGI_KIND_PANEL_LIST_TOOL,
  MESH_NODE_SLOTS_SET_TOOL,
  MESH_NODE_SLOTS_LIST_TOOL
];

// src/tools/mesh-compact.ts
function buildCompactGitSnapshot(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return void 0;
  const slim = {};
  const carry = [
    "isGitRepo",
    "branch",
    "headCommit",
    "upstream",
    "upstreamStatus",
    "ahead",
    "behind",
    "dirty",
    "detached",
    "submodules"
  ];
  for (const key of carry) {
    if (status[key] !== void 0) slim[key] = status[key];
  }
  return slim;
}
function summarizeCompactSubmodules(submodules) {
  if (!Array.isArray(submodules) || submodules.length === 0) return void 0;
  const outOfSync = submodules.filter((s) => s?.outOfSync).map((s) => s?.path).filter(Boolean);
  return {
    count: submodules.length,
    ...outOfSync.length > 0 ? { outOfSyncPaths: outOfSync } : {}
  };
}
var MESH_COMPACT_PRESERVED_MARKER_FIELDS = ["dataFreshness"];
function compactMeshStatusNode(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const next = { ...entry };
  if (next.git !== void 0) {
    const slimGit = buildCompactGitSnapshot(next.git);
    if (slimGit) {
      if (slimGit.submodules !== void 0) {
        const subSummary = summarizeCompactSubmodules(slimGit.submodules);
        if (subSummary) slimGit.submodules = subSummary;
        else delete slimGit.submodules;
      }
      next.git = slimGit;
    }
  }
  if (next.machine && typeof next.machine === "object") {
    const m = next.machine;
    next.machine = {
      daemonId: m.daemonId,
      machineId: m.machineId,
      hostname: m.hostname,
      displayName: m.displayName,
      sameMachine: m.sameMachine,
      locality: m.locality
    };
  }
  if (typeof next.submoduleWarning === "string") {
    next.submodulesOutOfSync = true;
    delete next.submoduleWarning;
  }
  if (next.staleDaemonBuild && typeof next.staleDaemonBuild === "object") {
    const b = next.staleDaemonBuild;
    next.staleDaemonBuild = {
      scope: b.scope,
      isDaemonAffecting: b.isDaemonAffecting !== false,
      seeStaleDaemonBuilds: true
    };
  }
  delete next.capabilityTagsByProvider;
  const elideSkip = /* @__PURE__ */ new Set(["git", "machine", "branchConvergence", "staleDaemonBuild", "sessions", ...MESH_COMPACT_PRESERVED_MARKER_FIELDS]);
  for (const k of Object.keys(next)) {
    if (elideSkip.has(k)) continue;
    next[k] = elideLargeNestedValue(k, next[k]);
  }
  return next;
}
function compactNodeSeverity(entry) {
  if (!entry || typeof entry !== "object") return 0;
  if (entry.error || entry.health && entry.health !== "online" && entry.health !== "dirty") return 5;
  if (entry.launchReady === false) return 4;
  if (entry.isDirty === true || entry.health === "dirty") return 3;
  if (entry.branchConvergence?.needsConvergence === true) return 2;
  if (entry.staleDaemonBuild || entry.submodulesOutOfSync || entry.recoveryHints) return 1;
  return 0;
}
function isNoteworthyCompactNode(entry) {
  if (!entry || typeof entry !== "object") return true;
  if (entry.health && entry.health !== "online") return true;
  if (entry.isDirty === true) return true;
  if (entry.error) return true;
  if (entry.launchReady === false) return true;
  if (entry.staleDaemonBuild) return true;
  if (entry.submoduleWarning || entry.submodulesOutOfSync) return true;
  if (entry.recoveryHints) return true;
  if (Array.isArray(entry.nextStepHints) && entry.nextStepHints.length > 0) return true;
  if (entry.branchConvergence?.needsConvergence === true) return true;
  const sessionCount = Array.isArray(entry.sessions) ? entry.sessions.length : entry.sessionSummary?.total ?? 0;
  if (sessionCount > 0) return true;
  return false;
}
function minimalCompactNode(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const bc = entry.branchConvergence && typeof entry.branchConvergence === "object" ? {
    status: entry.branchConvergence.status,
    needsConvergence: entry.branchConvergence.needsConvergence,
    reason: entry.branchConvergence.reason,
    branch: entry.branchConvergence.branch
  } : void 0;
  const preservedMarkers = {};
  for (const field of MESH_COMPACT_PRESERVED_MARKER_FIELDS) {
    if (entry[field] !== void 0) preservedMarkers[field] = entry[field];
  }
  return {
    nodeId: entry.nodeId,
    workspace: entry.workspace,
    daemonId: entry.daemonId,
    health: entry.health,
    branch: entry.branch,
    launchReady: entry.launchReady,
    ...entry.providerPriority !== void 0 ? { providerPriority: entry.providerPriority } : {},
    // Keep the routable tag set on quiet/folded nodes — a coordinator planning
    // required_tags routing needs it even for nodes with nothing to converge.
    ...entry.capabilityTags !== void 0 ? { capabilityTags: entry.capabilityTags } : {},
    ...entry.launchBlockedReason !== void 0 ? { launchBlockedReason: entry.launchBlockedReason } : {},
    ...bc ? { branchConvergence: bc } : {},
    ...entry.sessionSummary ? { sessionSummary: entry.sessionSummary } : {},
    ...preservedMarkers,
    folded: true
  };
}
function summarizeNodeSessions(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const byStatus = {};
  const providerCounts = {};
  const selfCoordinatorSessionIds = [];
  for (const s of list) {
    const status = typeof s?.status === "string" && s.status ? s.status : "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const provider = typeof s?.providerType === "string" && s.providerType ? s.providerType : "unknown";
    providerCounts[provider] = (providerCounts[provider] ?? 0) + 1;
    if (s?.isSelfCoordinator === true && s.id) selfCoordinatorSessionIds.push(String(s.id));
  }
  const summary = {
    total: list.length,
    byStatus,
    providerCounts
  };
  if (selfCoordinatorSessionIds.length > 0) {
    summary.selfCoordinatorSessionIds = selfCoordinatorSessionIds;
  }
  return summary;
}

// src/tools/mesh-queue-helpers.ts
var STALE_ASSIGNED_QUEUE_MS = 30 * 6e4;
var OLD_HISTORICAL_QUEUE_RECORD_MS = 7 * 24 * 60 * 6e4;
var ACTIVE_QUEUE_STATUSES = /* @__PURE__ */ new Set(["pending", "assigned"]);
var HISTORICAL_QUEUE_STATUSES = /* @__PURE__ */ new Set(["completed", "failed", "cancelled"]);
function buildQueueLivenessIndex(mesh) {
  const nodeIds = /* @__PURE__ */ new Set();
  const nodeSessionIds = /* @__PURE__ */ new Map();
  for (const node of Array.isArray(mesh?.nodes) ? mesh.nodes : []) {
    const nodeId = readString(node.id) || readString(node.nodeId) || readString(node.node_id);
    if (!nodeId) continue;
    nodeIds.add(nodeId);
    const sessions = collectNodeSessionIds(node);
    if (sessions.size > 0) nodeSessionIds.set(nodeId, sessions);
  }
  return { nodeIds, nodeSessionIds };
}
function queueAssignmentStaleReason(task, liveness) {
  if (task?.status !== "assigned") return void 0;
  const nodeId = readString(task.assignedNodeId) || readString(task.nodeId) || readString(task.node_id) || readString(task.targetNodeId);
  const sessionId = readString(task.assignedSessionId) || readString(task.sessionId) || readString(task.session_id) || readString(task.targetSessionId);
  if (nodeId && liveness.nodeIds.size > 0 && !liveness.nodeIds.has(nodeId)) {
    return "assigned node is not present in the current mesh snapshot";
  }
  if (nodeId && sessionId && liveness.nodeSessionIds.has(nodeId) && !liveness.nodeSessionIds.get(nodeId).has(sessionId)) {
    return "assigned session is not live on the assigned node";
  }
  const updatedAt = new Date(task.updatedAt).getTime();
  const ageMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : null;
  if (!nodeId && ageMs !== null && ageMs >= STALE_ASSIGNED_QUEUE_MS) {
    return "assigned task has no assigned node metadata";
  }
  return void 0;
}
function buildQueueStatusSummary(queue) {
  const counts = { pending: 0, assigned: 0, completed: 0, failed: 0, cancelled: 0 };
  let staleAssigned = 0;
  for (const task of queue) {
    const status = typeof task?.status === "string" ? task.status : void 0;
    if (status && Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    }
    if (status === "assigned" && task?.staleAssigned === true) staleAssigned += 1;
  }
  const liveAssigned = Math.max(0, counts.assigned - staleAssigned);
  return {
    totalCount: queue.length,
    activeCount: counts.pending + liveAssigned,
    historicalCount: counts.completed + counts.failed + counts.cancelled,
    counts,
    activeCounts: {
      pending: counts.pending,
      assigned: liveAssigned
    },
    staleAssignedCount: staleAssigned,
    rawActiveCounts: {
      pending: counts.pending,
      assigned: counts.assigned
    },
    historicalCounts: {
      completed: counts.completed,
      failed: counts.failed,
      cancelled: counts.cancelled
    }
  };
}
function normalizeQueueViewMode(value) {
  return value === "active" || value === "historical" || value === "all" ? value : "all";
}
function sanitizeQueueStatusFilter(value) {
  if (!Array.isArray(value)) return void 0;
  const statuses = value.map((item) => typeof item === "string" ? item.trim() : "").filter((status) => ACTIVE_QUEUE_STATUSES.has(status) || HISTORICAL_QUEUE_STATUSES.has(status));
  return statuses.length ? Array.from(new Set(statuses)) : void 0;
}
function filterQueueForView(queue, view, statuses) {
  if (statuses?.length) {
    const allowed = new Set(statuses);
    return queue.filter((task) => allowed.has(String(task?.status || "")));
  }
  if (view === "active") return queue.filter((task) => ACTIVE_QUEUE_STATUSES.has(String(task?.status || "")));
  if (view === "historical") return queue.filter((task) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || "")));
  return queue;
}
function prioritizeActiveQueueRows(queue) {
  const active = [];
  const historical = [];
  const other = [];
  for (const task of queue) {
    const status = String(task?.status || "");
    if (ACTIVE_QUEUE_STATUSES.has(status)) active.push(task);
    else if (HISTORICAL_QUEUE_STATUSES.has(status)) historical.push(task);
    else other.push(task);
  }
  return [...active, ...other, ...historical];
}
function slimQueueTask(task) {
  return {
    id: task?.id,
    status: task?.status,
    assignedNodeId: task?.assignedNodeId,
    assignedSessionId: task?.assignedSessionId,
    targetNodeId: task?.targetNodeId,
    targetSessionId: task?.targetSessionId,
    updatedAt: task?.updatedAt,
    staleAssigned: task?.staleAssigned === true,
    staleReason: task?.staleReason
  };
}
function buildQueueMaintenanceReport(queue) {
  const now = Date.now();
  const staleAssignedTasks = queue.filter((task) => task?.status === "assigned" && task?.staleAssigned === true).map(slimQueueTask);
  const historicalTasks = queue.filter((task) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || "")));
  const oldHistoricalTasks = historicalTasks.filter((task) => {
    const updatedAt = new Date(task?.updatedAt).getTime();
    return Number.isFinite(updatedAt) && now - updatedAt >= OLD_HISTORICAL_QUEUE_RECORD_MS;
  }).map((task) => ({
    ...slimQueueTask(task),
    cleanupClass: "old_historical_record",
    reason: "terminal queue record is older than the read-only maintenance threshold"
  }));
  const cleanupCandidates = [
    ...staleAssignedTasks.map((task) => ({
      ...task,
      cleanupClass: "stale_assigned",
      reason: typeof task.staleReason === "string" ? task.staleReason : "active assigned task does not match current live mesh node/session state",
      suggestedOperation: "operator_review_then_requeue_or_cancel"
    })),
    ...oldHistoricalTasks.map((task) => ({
      ...task,
      suggestedOperation: "operator_review_then_archive_or_keep"
    }))
  ];
  return {
    readOnly: true,
    mutationPerformed: false,
    sourceOfTruth: "mesh_work_queue_file",
    staleAssignedDefinition: "Only active assigned queue rows are stale candidates, and only when the assigned node/session is absent from the current live mesh snapshot.",
    historicalDefinition: "completed/failed/cancelled rows are historical ledger records and never active assignments.",
    staleAssignedTasks,
    staleAssignedCount: staleAssignedTasks.length,
    historicalRecordCount: historicalTasks.length,
    oldHistoricalRecordCount: oldHistoricalTasks.length,
    cleanupCandidates,
    cleanupCandidateCount: cleanupCandidates.length
  };
}
function buildCompactQueueMaintenanceReport(maintenance) {
  const staleAssignedTasks = Array.isArray(maintenance.staleAssignedTasks) ? maintenance.staleAssignedTasks : [];
  const cleanupCandidateCount = maintenance.cleanupCandidateCount ?? 0;
  return {
    readOnly: true,
    mutationPerformed: false,
    sourceOfTruth: "mesh_work_queue_file",
    payloadMode: "compact",
    staleAssignedDefinition: maintenance.staleAssignedDefinition,
    historicalDefinition: maintenance.historicalDefinition,
    // staleAssignedTasks are active assigned rows (not historical) — retain a
    // bounded sample so coordinators can still see drift without the full array.
    staleAssignedTasks: staleAssignedTasks.slice(0, 5),
    staleAssignedSampleLimit: 5,
    staleAssignedCount: maintenance.staleAssignedCount ?? staleAssignedTasks.length,
    historicalRecordCount: maintenance.historicalRecordCount ?? 0,
    oldHistoricalRecordCount: maintenance.oldHistoricalRecordCount ?? 0,
    cleanupCandidateCount,
    cleanupCandidatesOmitted: true,
    cleanupCandidatesHint: "Per-row cleanup candidates are omitted in compact mode; call mesh_view_queue with verbose=true for the full maintenance/cleanupDryRun rows."
  };
}
var COMPACT_MAX_ACTIVE_QUEUE_ROWS = 15;
var COMPACT_QUEUE_MESSAGE_CAP = 140;
var COMPACT_MAX_ACTIVE_WORK_ROWS = 12;
var COMPACT_ACTIVE_WORK_TITLE_CAP = 80;
function truncateForCompact(value, cap) {
  if (typeof value !== "string") return value;
  return value.length > cap ? value.slice(0, cap) + "\u2026" : value;
}
function compactQueueRow(task) {
  if (!task || typeof task !== "object") return task;
  const slim = {};
  for (const [k, v] of Object.entries(task)) {
    if (k === "message") slim[k] = truncateForCompact(v, COMPACT_QUEUE_MESSAGE_CAP);
    else slim[k] = elideLargeNestedValue(k, v);
  }
  return slim;
}
function compactQueueRows(rows) {
  const capped = rows.slice(0, COMPACT_MAX_ACTIVE_QUEUE_ROWS).map(compactQueueRow);
  return { rows: capped, omitted: Math.max(0, rows.length - capped.length) };
}
function compactActiveWorkRecord(record) {
  if (!record || typeof record !== "object") return record;
  const slim = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === "message" || k === "taskSummary") continue;
    else if (k === "taskTitle") slim[k] = truncateForCompact(v, COMPACT_ACTIVE_WORK_TITLE_CAP);
    else slim[k] = elideLargeNestedValue(k, v);
  }
  return slim;
}
function compactActiveWorkRecords(records) {
  if (!Array.isArray(records)) return { records, omitted: 0 };
  const capped = records.slice(0, COMPACT_MAX_ACTIVE_WORK_ROWS).map(compactActiveWorkRecord);
  return { records: capped, omitted: Math.max(0, records.length - capped.length) };
}
function annotateQueueStaleness(queue, mesh) {
  const liveness = buildQueueLivenessIndex(mesh);
  const now = Date.now();
  return queue.map((task) => {
    const taskStatus = typeof task?.status === "string" ? task.status : void 0;
    const annotated = {
      ...task,
      taskStatus,
      isActive: taskStatus ? ACTIVE_QUEUE_STATUSES.has(taskStatus) : false,
      isHistorical: taskStatus ? HISTORICAL_QUEUE_STATUSES.has(taskStatus) : false,
      dispatchedAt: task?.createdAt,
      ...taskStatus === "assigned" ? { activeTaskId: task.id } : {},
      ...taskStatus === "completed" || taskStatus === "failed" ? {
        completedAt: task.updatedAt
      } : {}
    };
    if (taskStatus !== "assigned") return annotated;
    const updatedAt = new Date(task.updatedAt).getTime();
    const ageMs = Number.isFinite(updatedAt) ? now - updatedAt : null;
    const staleReason = queueAssignmentStaleReason(task, liveness);
    if (!staleReason) return annotated;
    return {
      ...annotated,
      stale: true,
      staleAssigned: true,
      staleReason,
      ...ageMs !== null ? { assignedAgeMs: ageMs } : {}
    };
  });
}

// src/tools/read-chat-polling-advisory.ts
var RAPID_READ_CHAT_ADVISORY_WINDOW_MS = 5e3;
var ACTIVE_READ_STATUSES = /* @__PURE__ */ new Set([
  "generating",
  "running",
  "streaming",
  "starting",
  "busy"
]);
var recentReads = /* @__PURE__ */ new Map();
function isActiveReadChatStatus(status) {
  return typeof status === "string" && ACTIVE_READ_STATUSES.has(status.toLowerCase());
}
function annotateRapidReadChatAdvisory(payload, options) {
  const now = options.now ?? Date.now();
  const status = options.status ?? payload?.status ?? payload?.data?.status ?? payload?.result?.status;
  const active = isActiveReadChatStatus(status);
  const previous = recentReads.get(options.key);
  if (!active) {
    recentReads.set(options.key, { at: now, status: typeof status === "string" ? status : void 0 });
    return payload;
  }
  recentReads.set(options.key, { at: now, status: typeof status === "string" ? status : void 0 });
  if (!previous || !isActiveReadChatStatus(previous.status)) return payload;
  const elapsedMs = now - previous.at;
  if (elapsedMs < 0 || elapsedMs >= RAPID_READ_CHAT_ADVISORY_WINDOW_MS) return payload;
  return {
    ...payload,
    pollingAdvisory: {
      type: "rapid_read_chat_polling",
      toolName: options.toolName,
      windowMs: RAPID_READ_CHAT_ADVISORY_WINDOW_MS,
      elapsedMs,
      nextSuggestedReadAt: previous.at + RAPID_READ_CHAT_ADVISORY_WINDOW_MS,
      completionCallbackExpected: Boolean(options.completionCallbackExpected),
      message: `This session is still ${String(status)}. Avoid repeated ${options.toolName} polling for the same generating session; wait for the completion callback/status event or retry after the suggested time if you are debugging a real stall.`
    }
  };
}

// src/tools/mesh-tools-internal.ts
var import_daemon_core4 = require("@adhdev/daemon-core");
var import_node_crypto = require("crypto");
var SESSION_PROVIDER_METADATA_TTL_MS = 30 * 6e4;
var meshSessionProviderMetadata = /* @__PURE__ */ new Map();
function getSessionMetadata(key) {
  const entry = meshSessionProviderMetadata.get(key);
  if (!entry) return void 0;
  if (entry.expiresAt <= Date.now()) {
    meshSessionProviderMetadata.delete(key);
    return void 0;
  }
  return entry;
}
var ACTIVE_WORK_POLLING_BACKOFF_MS = 6e4;
function buildActiveWorkPollingGuidance(summary, now = Date.now()) {
  if (!summary || summary.generatingCount <= 0) return void 0;
  return {
    activeGeneratingWork: true,
    generatingCount: summary.generatingCount,
    doNotPollBefore: new Date(now + ACTIVE_WORK_POLLING_BACKOFF_MS).toISOString(),
    eventSurface: "pendingCoordinatorEvents",
    nextRecommendedAction: "Wait for pendingCoordinatorEvents/completion events or an explicit user status request. If no terminal evidence appears and the user asks for status, make one bounded status check, then wait again.",
    message: "Do not repeatedly poll mesh_status/mesh_view_queue/mesh_read_chat while delegated work is generating; terminal ledger or completion evidence will be surfaced through pendingCoordinatorEvents when available."
  };
}
function summarizeTaskMessage(message) {
  const taskSummary = message.replace(/\s+/g, " ").trim();
  const taskTitle = taskSummary.length > 96 ? `${taskSummary.slice(0, 93)}...` : taskSummary;
  return { taskTitle: taskTitle || "(untitled task)", taskSummary };
}
function buildDirectTaskPayload(message, via, opts) {
  const descriptor = summarizeTaskMessage(message);
  return {
    source: "direct",
    via,
    taskId: opts.taskId,
    message,
    taskTitle: descriptor.taskTitle,
    taskSummary: descriptor.taskSummary,
    ...opts.taskMode ? { taskMode: opts.taskMode } : {},
    ...opts.providerType ? { providerType: opts.providerType } : {},
    ...opts.targetSessionId ? { targetSessionId: opts.targetSessionId } : {},
    ...opts.dispatchedToIdleSession !== void 0 ? { dispatchedToIdleSession: opts.dispatchedToIdleSession } : {},
    ...opts.coordinatorSessionId ? { coordinatorSessionId: opts.coordinatorSessionId } : {},
    ...opts.coordinatorDaemonId ? { coordinatorDaemonId: opts.coordinatorDaemonId } : {},
    // Uniform routing rationale (mirrors the queue-claim task_dispatched shape) so both
    // paths render identically in mesh_task_history / the dashboard. The legacy top-level
    // `source`/`via`/`providerType` fields above are preserved verbatim for existing
    // consumers (mesh-active-work / mesh-events-stale key on payload.source === 'direct').
    routingDecision: {
      source: "direct",
      via,
      ...opts.selectedNodeId ? { selectedNodeId: opts.selectedNodeId } : {},
      ...opts.providerType ? { resolvedProviderType: opts.providerType } : {},
      ...opts.resolvedModel ? { resolvedModel: opts.resolvedModel } : {},
      ...opts.resolvedThinkingLevel ? { resolvedThinkingLevel: opts.resolvedThinkingLevel } : {}
    }
  };
}
function findNode(mesh, nodeId) {
  const node = mesh.nodes.find((n) => (0, import_daemon_core3.meshNodeIdMatches)(n, nodeId));
  if (!node) throw new Error(`Node '${nodeId}' is not a member of mesh '${mesh.name}'`);
  return node;
}
var DUPLICATE_DISPATCH_WINDOW_MS = 6e4;
async function refreshMeshFromDaemon(ctx) {
  try {
    const result = await ctx.transport.command("get_mesh", { meshId: ctx.mesh.id });
    if (!result?.success || !Array.isArray(result.mesh?.nodes)) return;
    const refreshedNodes = result.mesh.nodes.filter((n) => n?.id).map((n) => n);
    ctx.mesh.nodes.splice(0, ctx.mesh.nodes.length, ...refreshedNodes);
    ctx.mesh.updatedAt = result.mesh.updatedAt ?? ctx.mesh.updatedAt;
  } catch {
  }
}
async function syncCoordinatorDaemonMeshCache(ctx) {
  if (!(ctx.transport instanceof IpcTransport)) return;
  try {
    await ctx.transport.command("get_mesh", {
      meshId: ctx.mesh.id,
      inlineMesh: ctx.mesh
    });
  } catch {
  }
}
async function findNodeWithRefresh(ctx, nodeId) {
  const hit = ctx.mesh.nodes.find((n) => (0, import_daemon_core3.meshNodeIdMatches)(n, nodeId));
  if (hit && !hit.isLocalWorktree) return hit;
  await refreshMeshFromDaemon(ctx);
  const refreshed = ctx.mesh.nodes.find((n) => (0, import_daemon_core3.meshNodeIdMatches)(n, nodeId));
  if (!refreshed) throw new Error(`Node '${nodeId}' is not a member of mesh '${ctx.mesh.name}'`);
  return refreshed;
}
async function findOptionalNodeWithRefresh(ctx, nodeId) {
  const hit = ctx.mesh.nodes.find((n) => (0, import_daemon_core3.meshNodeIdMatches)(n, nodeId));
  if (hit && !hit.isLocalWorktree) return hit;
  await refreshMeshFromDaemon(ctx);
  return ctx.mesh.nodes.find((n) => (0, import_daemon_core3.meshNodeIdMatches)(n, nodeId)) ?? null;
}
function hasRecentDuplicateDispatch(ctx, args) {
  const now = Date.now();
  const normalizedMessage = args.message.trim();
  for (const task of (0, import_daemon_core3.getQueue)(ctx.mesh.id)) {
    const timestamp = new Date(task.updatedAt || task.createdAt).getTime();
    if (!Number.isFinite(timestamp) || now - timestamp > DUPLICATE_DISPATCH_WINDOW_MS) continue;
    if (task.targetNodeId && task.targetNodeId !== args.node_id) continue;
    if (task.assignedNodeId && task.assignedNodeId !== args.node_id) continue;
    if (args.session_id && task.targetSessionId !== args.session_id && task.assignedSessionId !== args.session_id) continue;
    if (task.message?.trim() === normalizedMessage) {
      return { duplicate: true, entry: task, source: "queue" };
    }
  }
  const entries = (0, import_daemon_core3.readLedgerEntries)(ctx.mesh.id, { tail: 200 });
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const timestamp = new Date(entry.timestamp).getTime();
    if (Number.isFinite(timestamp) && now - timestamp > DUPLICATE_DISPATCH_WINDOW_MS) break;
    if (entry.kind !== "task_dispatched") continue;
    if (entry.nodeId !== args.node_id) continue;
    if (args.session_id && entry.sessionId !== args.session_id) continue;
    if (typeof entry.payload?.message !== "string") continue;
    if (entry.payload.message.trim() === normalizedMessage) {
      return { duplicate: true, entry, source: "ledger" };
    }
  }
  return { duplicate: false };
}
function buildMissingNodeReadChatRecovery(ctx, args) {
  const entries = (0, import_daemon_core3.readLedgerEntries)(ctx.mesh.id, { tail: 300 });
  const relatedEntries = entries.filter((entry) => entry.nodeId === args.node_id || entry.sessionId === args.session_id);
  const completedEntries = relatedEntries.filter((entry) => entry.kind === "task_completed");
  const lastDispatch = [...relatedEntries].reverse().find((entry) => entry.kind === "task_dispatched");
  const lastTerminal = [...relatedEntries].reverse().find((entry) => entry.kind === "task_completed" || entry.kind === "task_failed" || entry.kind === "task_stalled");
  const lastRemoved = [...relatedEntries].reverse().find((entry) => entry.kind === "node_removed");
  const lastLaunch = [...relatedEntries].reverse().find((entry) => entry.kind === "session_launched");
  const providerSessionId = args.provider_session_id || readString(lastTerminal?.payload?.providerSessionId) || readString(lastLaunch?.payload?.providerSessionId) || readString(lastDispatch?.payload?.providerSessionId);
  const finalSummary = readString(lastTerminal?.payload?.finalSummary) || readString(lastTerminal?.payload?.compactSummary) || readString(lastTerminal?.payload?.summary);
  const ledger = {
    taskCompletedFound: completedEntries.length > 0,
    nodeRemovedFound: !!lastRemoved,
    providerType: lastTerminal?.providerType || lastLaunch?.providerType || lastDispatch?.providerType,
    providerSessionId,
    nodeRemovedAt: lastRemoved?.timestamp,
    sessionCleanupMode: readString(lastRemoved?.payload?.sessionCleanupMode),
    readDebugLocator: readString(lastTerminal?.payload?.readDebugLocator) || readString(lastTerminal?.payload?.debugBundlePath)
  };
  if (finalSummary) {
    if (args.compact === true) {
      return {
        ...compactChatPayload({
          success: true,
          status: "idle",
          providerSessionId,
          summary: finalSummary,
          messages: [{ role: "assistant", content: finalSummary, isHistorical: true }]
        }, {
          nodeId: args.node_id,
          sessionId: args.session_id,
          limit: args.tail ?? 10
        }),
        recoveredFromLedger: true,
        ledger
      };
    }
    return {
      success: true,
      compact: false,
      recoveredFromLedger: true,
      nodeId: args.node_id,
      sessionId: args.session_id,
      summary: finalSummary,
      ledger,
      messages: [{ role: "assistant", content: finalSummary, isHistorical: true }]
    };
  }
  return {
    success: false,
    recoverable: true,
    code: "mesh_removed_node_transcript_unavailable",
    error: `Node '${args.node_id}' is not a current member of mesh '${ctx.mesh.name}'.`,
    nodeId: args.node_id,
    sessionId: args.session_id,
    providerSessionId,
    reason: "node_not_in_current_mesh_snapshot",
    ledger,
    completedSessionSeenInLedger: ledger.taskCompletedFound,
    lastDispatch: lastDispatch ? {
      timestamp: lastDispatch.timestamp,
      sessionId: lastDispatch.sessionId,
      providerType: lastDispatch.providerType,
      taskId: typeof lastDispatch.payload?.taskId === "string" ? lastDispatch.payload.taskId : void 0,
      messagePreview: typeof lastDispatch.payload?.message === "string" ? lastDispatch.payload.message.slice(0, 500) : void 0
    } : null,
    lastTerminalEvent: lastTerminal ? {
      kind: lastTerminal.kind,
      timestamp: lastTerminal.timestamp,
      sessionId: lastTerminal.sessionId,
      providerType: lastTerminal.providerType,
      taskId: typeof lastTerminal.payload?.taskId === "string" ? lastTerminal.payload.taskId : void 0,
      payload: lastTerminal.payload
    } : null,
    nextSteps: [
      providerSessionId ? `Retry mesh_read_chat with provider_session_id='${providerSessionId}' on a current live node for the same daemon if one exists.` : "If the node UI shows a provider transcript id, retry mesh_read_chat/mesh_read_debug with provider_session_id.",
      "Use mesh_read_debug with the provider_session_id or daemon-side debug bundle locator if available.",
      "Check mesh_task_history for task_completed and node_removed entries before redispatching; do not resend solely because transcript recovery failed.",
      "If this node was removed with stop_and_delete, the runtime transcript may be gone; rely on the ledger summary/locator or ask the operator for the saved UI output."
    ],
    recoveryHints: [
      "The worktree/node may have been removed or the mesh snapshot may be stale after task completion.",
      "If you have a provider_session_id, retry mesh_read_chat with that value while targeting a live node for the same daemon if available.",
      "Use mesh_read_debug with provider_session_id, or inspect the daemon/session-host history locator if the transcript has already been archived.",
      "Avoid redispatching the same task solely because read_chat could not recover the transcript; check task_history and git status first."
    ]
  };
}
function isDirectDispatchLedgerEntry(entry) {
  if (entry?.kind !== "task_dispatched") return false;
  const payload = entry.payload || {};
  const via = readString(payload.via);
  return payload.source === "direct" || via === "p2p_direct" || via === "local_direct" || via === "mesh_send_task";
}
function readMessageTimestampIso(message) {
  for (const value of [message?.timestamp, message?.createdAt, message?.created_at, message?.updatedAt, message?.time]) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const ms = value > 1e10 ? value : value * 1e3;
      return new Date(ms).toISOString();
    }
    if (typeof value === "string" && value.trim()) {
      const ms = new Date(value.trim()).getTime();
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }
  return void 0;
}
function readFinalAssistantTranscriptEvidence(payload) {
  const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
  let turnEnd;
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const message = rawMessages[i];
    if (!isCoordinatorVisibleMessage(message)) continue;
    const role = String(message?.role ?? "").toLowerCase();
    turnEnd = (role === "assistant" || role === "agent") && messageContent(message).trim() ? message : void 0;
    break;
  }
  if (!turnEnd) return { finalSummary: void 0, transcriptMessageAt: void 0 };
  return {
    finalSummary: messageContent(turnEnd).trim(),
    transcriptMessageAt: readMessageTimestampIso(turnEnd)
  };
}
function findNodeSession(nodes, nodeId, sessionId) {
  if (!nodeId || !sessionId) return {};
  const node = nodes.find((candidate) => (0, import_daemon_core3.meshNodeIdMatches)(candidate, nodeId));
  if (!node) return {};
  const sessions = Array.isArray(node.sessions) ? node.sessions : [];
  const session = sessions.find((candidate) => readSessionRecordId(candidate) === sessionId);
  return { node, session };
}
function buildDirectDispatchReconciliationCandidates(directDispatches, ledgerEntries) {
  const candidates = [];
  const seenTaskIds = /* @__PURE__ */ new Set();
  for (const dispatch of directDispatches || []) {
    const taskId = readString(dispatch?.taskId);
    if (!taskId || seenTaskIds.has(taskId)) continue;
    seenTaskIds.add(taskId);
    candidates.push(dispatch);
  }
  for (const entry of ledgerEntries || []) {
    if (!isDirectDispatchLedgerEntry(entry)) continue;
    const taskId = readString(entry.payload?.taskId);
    if (!taskId || seenTaskIds.has(taskId)) continue;
    seenTaskIds.add(taskId);
    candidates.push({
      taskId,
      nodeId: entry.nodeId,
      sessionId: entry.sessionId,
      providerType: entry.providerType || readString(entry.payload?.providerType),
      message: readString(entry.payload?.message),
      dispatchedAt: entry.timestamp,
      via: readString(entry.payload?.via)
    });
  }
  return candidates;
}
async function reconcileDirectDispatchesFromTranscriptEvidence(ctx, liveNodes, directDispatches, ledgerEntries) {
  let attempted = 0;
  let reconciled = 0;
  let skipped = 0;
  const candidates = buildDirectDispatchReconciliationCandidates(directDispatches, ledgerEntries);
  for (const dispatch of candidates) {
    const taskId = readString(dispatch?.taskId);
    const nodeId = readString(dispatch?.nodeId);
    const sessionId = readString(dispatch?.sessionId);
    if (!taskId || !nodeId || !sessionId) {
      skipped += 1;
      continue;
    }
    const { session } = findNodeSession(liveNodes, nodeId, sessionId);
    if (!session || !isIdleSessionRecord(session)) {
      skipped += 1;
      continue;
    }
    const node = await findOptionalNodeWithRefresh(ctx, nodeId).catch(() => null);
    if (!node) {
      skipped += 1;
      continue;
    }
    const providerType = readString(dispatch?.providerType) || resolveSessionProviderType(session);
    const providerSessionId = readString(session?.providerSessionId) || readString(session?.activeChat?.providerSessionId) || readString(session?.settings?.providerSessionId) || resolveMeshSessionProviderMetadata(ctx, nodeId, sessionId)?.providerSessionId;
    attempted += 1;
    try {
      const readResult = await commandForNode(ctx, node, "read_chat", {
        sessionId,
        targetSessionId: sessionId,
        workspace: node.workspace,
        ...providerType ? { agentType: providerType, providerType } : {},
        ...providerSessionId ? { providerSessionId } : {},
        tailLimit: 10
      });
      const payload = unwrapCommandPayload(readResult);
      if (payload?.success === false) continue;
      if ((0, import_daemon_core3.hasTrailingToolActivityAfterFinalAssistant)(Array.isArray(payload?.messages) ? payload.messages : [])) continue;
      const evidence = readFinalAssistantTranscriptEvidence(payload);
      if (!evidence.finalSummary) continue;
      const result = (0, import_daemon_core3.reconcileDirectDispatchCompletionFromTranscript)({
        meshId: ctx.mesh.id,
        nodeId,
        sessionId,
        providerType,
        providerSessionId: readString(payload?.providerSessionId) || providerSessionId,
        taskId,
        finalSummary: evidence.finalSummary,
        transcriptMessageAt: evidence.transcriptMessageAt,
        targetCoordinatorDaemonId: ctx.localDaemonId,
        source: "mcp_mesh_status_transcript_reconciliation"
      });
      if (result.reconciled) reconciled += 1;
    } catch {
      skipped += 1;
    }
  }
  return { attempted, reconciled, skipped };
}
async function triggerMeshQueueAndReport(ctx) {
  try {
    const raw = await ctx.transport.command("trigger_mesh_queue", { meshId: ctx.mesh.id });
    const payload = unwrapCommandPayload(raw);
    const trigger = payload?.trigger && typeof payload.trigger === "object" ? payload.trigger : payload;
    return trigger && typeof trigger === "object" ? trigger : { success: true };
  } catch (e) {
    return {
      success: false,
      error: e?.message || String(e)
    };
  }
}
function buildQueueTriggerGuidance(queueTrigger) {
  if (!queueTrigger || queueTrigger.claimed === true) return void 0;
  if (queueTrigger.success === false) {
    return {
      queueClaimed: false,
      queueDispatchState: "trigger_failed",
      nextAction: "Do not assume the queued task is running. Check mesh_view_queue and daemon connectivity before redispatching."
    };
  }
  if (queueTrigger.autoLaunchPending === true) {
    return {
      queueClaimed: false,
      queueDispatchState: "pending_waiting_for_autolaunch",
      nextAction: "A worker session was just auto-launched for this task and is booting; it will claim the task shortly. Wait for it to claim \u2014 do NOT launch another session. Use mesh_view_queue to confirm the assignment lands."
    };
  }
  if (queueTrigger.noIdleMeshSessionAvailable === true) {
    return {
      queueClaimed: false,
      queueDispatchState: "pending_no_idle_mesh_session",
      nextAction: "The task is queued but not running. Launch a managed worker with mesh_launch_session, or wait for a delegated session to become ready and trigger the queue again."
    };
  }
  return {
    queueClaimed: false,
    queueDispatchState: "pending_or_waiting_for_ready",
    nextAction: "The task is queued but this trigger did not claim it. Use mesh_view_queue for the current active-work source of truth before retrying."
  };
}
function isMeshOwnedDelegateSession(session, meshId, nodeId) {
  const settings = session?.settings;
  const sessionMeshId = typeof settings?.meshNodeFor === "string" ? settings.meshNodeFor.trim() : "";
  const sessionNodeId = typeof settings?.meshNodeId === "string" ? settings.meshNodeId.trim() : "";
  if (sessionMeshId) {
    if (sessionMeshId !== meshId) return false;
    return !sessionNodeId || sessionNodeId === nodeId;
  }
  const coordinatorOwned = settings?.launchedByCoordinator === true || Boolean(readString(settings?.meshCoordinatorDaemonId));
  if (!coordinatorOwned) return false;
  const lastNodeId = readString(settings?.meshLastNodeId);
  if (lastNodeId) return lastNodeId === nodeId;
  return true;
}
function hasRemoteRelayMetadata(session) {
  return Boolean(
    readString(session?.settings?.meshCoordinatorDaemonId) || readString(session?.meta?.meshCoordinatorDaemonId) || readString(session?.metadata?.meshCoordinatorDaemonId) || readString(session?.meshCoordinatorDaemonId)
  );
}
function classifyRemoteDelegateRelaySafety(session, meshId, nodeId, coordinatorDaemonId) {
  if (!isMeshOwnedDelegateSession(session, meshId, nodeId)) return "unsafe_alias";
  if (hasRemoteRelayMetadata(session)) return "safe";
  return coordinatorDaemonId ? "self_heal" : "missing_anchor";
}
function chooseDispatchableSession(sessions, providerType, meshId, nodeId, coordinatorDaemonId) {
  const live = sessions.filter((session) => !isTerminalSessionRecord(session));
  const matchingProvider = (session) => !providerType || session?.providerType === providerType || session?.cliType === providerType;
  const meshSessions = live.filter((session) => {
    const safety = classifyRemoteDelegateRelaySafety(session, meshId, nodeId, coordinatorDaemonId);
    return safety === "safe" || safety === "self_heal";
  });
  return meshSessions.find((session) => isIdleSessionRecord(session) && matchingProvider(session)) || void 0;
}
function buildRelayUnsafeRemoteSessionFailure(ctx, node, sessionId, providerType) {
  return {
    success: false,
    recoverable: true,
    code: "mesh_delegate_session_missing_relay_metadata",
    reason: "mesh_delegate_session_missing_relay_metadata",
    transport: "mesh_transport",
    retryRecommended: true,
    meshId: ctx.mesh.id,
    nodeId: node.id,
    daemonId: node.daemonId,
    workspace: node.workspace,
    sessionId,
    unsafeTranscriptAlias: true,
    ...providerType ? { resolvedProviderType: providerType } : {},
    error: `Remote session '${sessionId}' is not relay-safe for mesh '${ctx.mesh.id}': missing meshNodeFor/meshCoordinatorDaemonId metadata, so completion events would not reach the coordinator ledger. This session may be the coordinator itself or an unrelated session (unsafe_transcript_alias risk).`,
    nextAction: `Launch a fresh relay-safe session with mesh_launch_session(node_id: '${node.id}'${providerType ? `, type: '${providerType}'` : ""}) or dispatch without session_id so Repo Mesh can choose a valid delegate session.`,
    noFallbackReason: "Blindly reusing a remote session without mesh relay metadata would silently drop task_completed / generating_completed events."
  };
}
function buildMissingCoordinatorDaemonIdFailure(ctx, node, providerType) {
  return {
    success: false,
    recoverable: true,
    code: "mesh_coordinator_daemon_unknown",
    reason: "mesh_coordinator_daemon_unknown",
    transport: "mesh_transport",
    retryRecommended: true,
    meshId: ctx.mesh.id,
    nodeId: node.id,
    daemonId: node.daemonId,
    workspace: node.workspace,
    ...providerType ? { resolvedProviderType: providerType } : {},
    error: `Cannot launch a remote mesh delegate for node '${node.id}': coordinator daemon identity is unavailable, so the worker would be unable to relay completion events back to the coordinator.`,
    nextAction: "Retry after the coordinator daemon identity is available (for example from an attached daemon-backed MCP session) so meshCoordinatorDaemonId can be stamped on the worker session.",
    noFallbackReason: "Launching without meshCoordinatorDaemonId would create a worker session that can finish work but cannot emit task_completed / generating_completed back to the coordinator."
  };
}
function findNestedPayload(value, predicate) {
  const seen = /* @__PURE__ */ new Set();
  const stack = [{ payload: value, depth: 0 }];
  while (stack.length) {
    const { payload, depth } = stack.pop();
    if (predicate(payload)) return payload;
    if (!payload || typeof payload !== "object" || seen.has(payload) || depth >= 8) continue;
    seen.add(payload);
    for (const key of ["payload", "result"]) {
      if (key in payload) stack.push({ payload: payload[key], depth: depth + 1 });
    }
  }
  return value;
}
function extractCloneNodePayload(value) {
  return findNestedPayload(value, (payload) => Boolean(payload?.node?.id));
}
function extractGitStatus(value) {
  const payload = unwrapCommandPayload(value);
  return payload?.status ?? value?.status ?? payload;
}
function extractGitDiff(value) {
  const payload = unwrapCommandPayload(value);
  return payload?.diffSummary ?? payload?.diff ?? value?.diffSummary ?? value?.diff ?? payload;
}
function extractSubmodules(value, ignorePaths) {
  const payload = unwrapCommandPayload(value);
  const subs = payload?.status?.submodules ?? payload?.submodules ?? value?.status?.submodules ?? value?.submodules;
  if (!Array.isArray(subs)) return void 0;
  if (ignorePaths.length === 0) return subs;
  const ignoreSet = new Set(ignorePaths);
  return subs.filter((s) => s?.path && !ignoreSet.has(s.path));
}
function assignFullGitSnapshot(entry, status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return;
  entry.git = status;
}
var COMPACT_DETAILED_NODES_BYTE_BUDGET = 9e3;
var COMPACT_NODES_TOTAL_BYTE_BUDGET = 11500;
var COMPACT_MISSIONS_BYTE_BUDGET = 6e3;
function extractLaunchPayload(value) {
  return findNestedPayload(value, (payload) => Boolean(payload?.sessionId || payload?.id || payload?.runtimeSessionId));
}
function classifyMeshLaunchFailure(error) {
  const message = error instanceof Error ? error.message : String(error || "launch failed");
  const lower = message.toLowerCase();
  const p2pClassification = (0, import_daemon_core3.classifyP2pRelayFailure)(error, { command: "launch_cli" });
  if (p2pClassification.recoverable) {
    return p2pClassification;
  }
  if (lower.includes("cannot connect to daemon ipc") || lower.includes("daemon ipc command")) {
    return {
      code: "local_ipc_unavailable",
      reason: "local_daemon_ipc_unavailable",
      transport: "local_ipc",
      recoverable: true,
      retryRecommended: true,
      nextAction: "Check the local daemon IPC connection, then retry mesh_launch_session once after the daemon is reachable."
    };
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      code: "mesh_transport_timeout",
      reason: "mesh_transport_timeout",
      transport: "mesh_transport",
      recoverable: true,
      retryRecommended: true,
      nextAction: "Check mesh transport health, then do one bounded retry before requeueing or relaunching the task."
    };
  }
  return {
    code: "mesh_launch_failed",
    reason: "provider_launch_failed",
    transport: "mesh_transport",
    recoverable: false,
    retryRecommended: false,
    nextAction: "Inspect the provider launch error and fix the underlying provider/configuration issue before retrying."
  };
}
function buildWorktreeCleanupHint(node) {
  if (!node.isLocalWorktree) return void 0;
  return {
    tool: "mesh_remove_node",
    args: { node_id: node.id, session_cleanup_mode: "preserve" },
    hint: `If the worktree is no longer needed, remove the orphan worktree node with mesh_remove_node(node_id: "${node.id}").`
  };
}
function buildRecoverableLaunchFailure(ctx, node, providerType, error) {
  const message = error instanceof Error ? error.message : String(error || "launch failed");
  const classified = classifyMeshLaunchFailure(error);
  const cleanup = buildWorktreeCleanupHint(node);
  return {
    success: false,
    recoverable: classified.recoverable,
    code: classified.code,
    reason: classified.reason,
    transport: classified.transport,
    retryRecommended: classified.retryRecommended,
    nextAction: classified.nextAction,
    ...classified.noFallbackReason ? { noFallbackReason: classified.noFallbackReason } : {},
    error: message,
    meshId: ctx.mesh.id,
    nodeId: node.id,
    daemonId: node.daemonId,
    workspace: node.workspace,
    isLocalWorktree: node.isLocalWorktree === true,
    worktreeBranch: node.worktreeBranch,
    clonedFromNodeId: node.clonedFromNodeId,
    ...providerType ? { resolvedProviderType: providerType } : {},
    retryHint: `Retry mesh_launch_session(node_id: "${node.id}"${providerType ? `, type: "${providerType}"` : ""}) after daemon mesh transport/P2P is healthy.`,
    ...cleanup ? { cleanup } : {},
    nextStepHints: [
      `Retry mesh_launch_session(node_id: "${node.id}"${providerType ? `, type: "${providerType}"` : ""}) after checking daemon/P2P health.`,
      ...cleanup ? [`Cleanup orphan worktree node with mesh_remove_node(node_id: "${node.id}") if retry is not desired.`] : [],
      "Run mesh_status to see the degraded reason and recovery hints before redispatching work."
    ]
  };
}
function recordRecoverableLaunchFailure(ctx, node, providerType, error) {
  const failure = buildRecoverableLaunchFailure(ctx, node, providerType, error);
  try {
    (0, import_daemon_core3.appendLedgerEntry)(ctx.mesh.id, {
      kind: "recovery_attempted",
      nodeId: node.id,
      providerType,
      payload: {
        event: "session_launch_failed",
        ...failure
      }
    });
  } catch {
  }
  return failure;
}
function getLatestActiveLaunchFailure(meshId, nodeId) {
  const entries = (0, import_daemon_core3.readLedgerEntries)(meshId, { tail: 200 });
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.nodeId !== nodeId) continue;
    if (entry.kind === "session_launched" || entry.kind === "node_removed") return null;
    if (entry.kind === "recovery_attempted" && entry.payload?.event === "session_launch_failed") {
      return { timestamp: entry.timestamp, ...entry.payload };
    }
  }
  return null;
}
function buildCoordinatorP2pRelayFailure(error, context) {
  const payload = (0, import_daemon_core3.buildP2pRelayFailurePayload)(error, {
    command: context.command,
    targetDaemonId: context.targetDaemonId
  });
  return {
    ...payload,
    ...context.nodeId ? { nodeId: context.nodeId } : {},
    ...context.sessionId ? { sessionId: context.sessionId } : {},
    retryHint: payload.retryRecommended ? payload.nextAction : "Do not retry as a P2P transport recovery; inspect the command/provider error first."
  };
}
async function ipcDispatchToRemoteAgent(ctx, node, args) {
  const transport = ctx.transport;
  const daemonId = node.daemonId;
  const dispatchCoordinatorDaemonId = readString(args.meshContext?.coordinatorDaemonId) || "";
  let sessionId = args.session_id?.trim() || "";
  const providerPriorityList = Array.isArray(node.policy?.providerPriority) ? node.policy.providerPriority : [];
  let resolvedProviderType = args.providerType?.trim() || providerPriorityList[0] || "";
  if (sessionId && args.verifiedSession) {
    const explicitSession = args.verifiedSession;
    const relaySafety = classifyRemoteDelegateRelaySafety(explicitSession, ctx.mesh.id, node.id, dispatchCoordinatorDaemonId);
    if (relaySafety === "unsafe_alias") {
      return buildRelayUnsafeRemoteSessionFailure(
        ctx,
        node,
        sessionId,
        resolvedProviderType || resolveSessionProviderType(explicitSession) || void 0
      );
    }
    if (relaySafety === "missing_anchor") {
      return buildMissingCoordinatorDaemonIdFailure(
        ctx,
        node,
        resolvedProviderType || resolveSessionProviderType(explicitSession) || void 0
      );
    }
    if (!resolvedProviderType) {
      resolvedProviderType = resolveSessionProviderType(explicitSession);
    }
  } else if (!sessionId || args.session_id) {
    try {
      const relayResult = await transport.meshCommand(daemonId, "get_status_metadata", {});
      const sessions = extractStatusMetadataSessions(relayResult);
      if (sessionId) {
        const explicitSession = sessions.find((session) => readSessionRecordId(session) === sessionId);
        if (!explicitSession) {
          return {
            success: false,
            recoverable: true,
            code: "mesh_target_session_not_found",
            reason: "mesh_target_session_not_found",
            transport: "mesh_transport",
            retryRecommended: true,
            meshId: ctx.mesh.id,
            nodeId: node.id,
            daemonId,
            workspace: node.workspace,
            sessionId,
            ...resolvedProviderType ? { resolvedProviderType } : {},
            error: `Remote session '${sessionId}' is not present in the live status for node '${node.id}'.`,
            nextAction: `Launch a fresh session with mesh_launch_session(node_id: '${node.id}'${resolvedProviderType ? `, type: '${resolvedProviderType}'` : ""}) or retry without session_id so Repo Mesh can target a live delegate session.`
          };
        }
        const relaySafety = classifyRemoteDelegateRelaySafety(explicitSession, ctx.mesh.id, node.id, dispatchCoordinatorDaemonId);
        if (relaySafety === "unsafe_alias") {
          return buildRelayUnsafeRemoteSessionFailure(
            ctx,
            node,
            sessionId,
            resolvedProviderType || resolveSessionProviderType(explicitSession) || void 0
          );
        }
        if (relaySafety === "missing_anchor") {
          return buildMissingCoordinatorDaemonIdFailure(
            ctx,
            node,
            resolvedProviderType || resolveSessionProviderType(explicitSession) || void 0
          );
        }
        if (!resolvedProviderType) {
          resolvedProviderType = resolveSessionProviderType(explicitSession);
        }
      } else {
        const targetSession = chooseDispatchableSession(sessions, resolvedProviderType, ctx.mesh.id, node.id, dispatchCoordinatorDaemonId);
        if (targetSession?.id || targetSession?.sessionId) {
          sessionId = targetSession.id || targetSession.sessionId;
          if (!resolvedProviderType) {
            resolvedProviderType = resolveSessionProviderType(targetSession);
          }
        }
      }
    } catch (e) {
      if (sessionId) {
        return {
          ...buildCoordinatorP2pRelayFailure(e, {
            command: "get_status_metadata",
            targetDaemonId: daemonId,
            nodeId: node.id,
            sessionId
          }),
          success: false,
          error: `Cannot verify remote session '${sessionId}' before dispatch: ${e?.message || String(e)}`
        };
      }
    }
  }
  if (!resolvedProviderType) {
    return { success: false, error: `Cannot dispatch to remote node '${node.id}': providerType unknown. Set providerPriority on the node policy or call mesh_launch_session first.` };
  }
  try {
    const dispatchResult = await transport.meshCommand(daemonId, "agent_command", {
      ...sessionId ? { targetSessionId: sessionId } : {},
      agentType: resolvedProviderType,
      cliType: resolvedProviderType,
      action: "send_chat",
      message: args.message,
      // WTCLAIM (B): carry the node workspace so a sessionless dispatch can be
      // scoped to THIS node's session on the worker (findAdapter dir match /
      // findMeshNodeAdapter). Without it, a worker hosting both a base node and a
      // cloned worktree node (same daemonId) would fall through to a provider-only
      // fuzzy match and could land worktree work on the base session.
      ...node.workspace ? { dir: node.workspace } : {},
      ...args.meshContext ? { meshContext: args.meshContext } : {}
    });
    const dispatchPayload = unwrapCommandPayload(dispatchResult);
    if (dispatchPayload?.success === false || dispatchResult?.success === false) {
      const source = dispatchPayload?.success === false ? dispatchPayload : dispatchResult;
      const errorMessage = dispatchPayload?.error || dispatchResult?.error || "agent_command rejected the task";
      return {
        ...buildCoordinatorP2pRelayFailure(source?.error || errorMessage, {
          command: "agent_command",
          targetDaemonId: daemonId,
          nodeId: node.id,
          sessionId
        }),
        ...source && typeof source === "object" ? source : {},
        success: false,
        error: `P2P dispatch failed: ${errorMessage}`
      };
    }
    return { success: true, dispatched: true, sessionId: sessionId || "", providerType: resolvedProviderType };
  } catch (e) {
    const errorMessage = e?.message || String(e);
    return {
      ...buildCoordinatorP2pRelayFailure(e, {
        command: "agent_command",
        targetDaemonId: daemonId,
        nodeId: node.id,
        sessionId
      }),
      error: `P2P dispatch failed: ${errorMessage}`
    };
  }
}
function meshSessionCacheKey(nodeId, runtimeSessionId) {
  return `${nodeId}:${runtimeSessionId}`;
}
function rememberMeshSessionProviderMetadata(nodeId, runtimeSessionId, metadata) {
  const keyNodeId = readString(nodeId);
  const keySessionId = readString(runtimeSessionId);
  if (!keyNodeId || !keySessionId) return;
  const providerType = readString(metadata.providerType);
  const providerSessionId = readString(metadata.providerSessionId);
  if (!providerType && !providerSessionId) return;
  const existing = getSessionMetadata(meshSessionCacheKey(keyNodeId, keySessionId)) || { providerType: "" };
  meshSessionProviderMetadata.set(meshSessionCacheKey(keyNodeId, keySessionId), {
    providerType: providerType || existing.providerType,
    providerSessionId: providerSessionId || existing.providerSessionId,
    expiresAt: Date.now() + SESSION_PROVIDER_METADATA_TTL_MS
  });
}
function rememberMeshSessionProviderMetadataFromEvent(event) {
  const metadataEvent = event?.metadataEvent && typeof event.metadataEvent === "object" ? event.metadataEvent : event && typeof event === "object" ? event : {};
  const nodeId = readString(event?.nodeId) || readString(metadataEvent.nodeId) || readString(metadataEvent.meshNodeId);
  const sessionId = readString(metadataEvent.targetSessionId) || readString(metadataEvent.sessionId) || readString(metadataEvent.instanceId) || readString(event?.sessionId);
  rememberMeshSessionProviderMetadata(nodeId, sessionId, {
    providerType: readString(metadataEvent.providerType) || readString(event?.providerType) || "",
    providerSessionId: readString(metadataEvent.providerSessionId) || readString(event?.providerSessionId)
  });
}
function resolveMeshSessionProviderMetadataFromLedger(ctx, nodeId, runtimeSessionId) {
  const entries = (0, import_daemon_core3.readLedgerEntries)(ctx.mesh.id, { tail: 50 });
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const payload = entry.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload) ? entry.payload : {};
    const entryNodeId = readString(entry.nodeId) || readString(payload.nodeId) || readString(payload.meshNodeId);
    if (entryNodeId && entryNodeId !== nodeId) continue;
    const entrySessionId = readString(entry.sessionId) || readString(payload.targetSessionId) || readString(payload.sessionId) || readString(payload.instanceId);
    if (entrySessionId !== runtimeSessionId) continue;
    const providerType = readString(entry.providerType) || readString(payload.providerType);
    const completionDiagnostic = payload.completionDiagnostic && typeof payload.completionDiagnostic === "object" && !Array.isArray(payload.completionDiagnostic) ? payload.completionDiagnostic : {};
    const metadataEvent = payload.metadataEvent && typeof payload.metadataEvent === "object" && !Array.isArray(payload.metadataEvent) ? payload.metadataEvent : {};
    const providerSessionId = readString(payload.providerSessionId) || readString(completionDiagnostic.providerSessionId) || readString(metadataEvent.providerSessionId);
    if (providerType || providerSessionId) {
      return { providerType: providerType || "", providerSessionId };
    }
  }
  return void 0;
}
function resolveMeshSessionProviderMetadata(ctx, nodeId, runtimeSessionId) {
  const cached = getSessionMetadata(meshSessionCacheKey(nodeId, runtimeSessionId));
  if (cached?.providerType || cached?.providerSessionId) return cached;
  const fromLedger = resolveMeshSessionProviderMetadataFromLedger(ctx, nodeId, runtimeSessionId);
  if (fromLedger) rememberMeshSessionProviderMetadata(nodeId, runtimeSessionId, fromLedger);
  return fromLedger;
}
function countUncommittedChanges(status) {
  if (typeof status?.uncommittedChanges === "number") return status.uncommittedChanges;
  const keys = ["staged", "modified", "untracked", "deleted", "renamed"];
  const counted = keys.reduce((sum, key) => sum + (Number.isFinite(Number(status?.[key])) ? Number(status[key]) : 0), 0);
  const conflicts = Array.isArray(status?.conflictFiles) ? status.conflictFiles.length : status?.hasConflicts ? 1 : 0;
  return counted + conflicts;
}
function isGitStatusDirty(status) {
  if (typeof status?.isDirty === "boolean") return status.isDirty;
  if (typeof status?.dirty === "boolean") return status.dirty;
  if (Array.isArray(status?.submodules) && status.submodules.some((submodule) => submodule?.dirty || submodule?.outOfSync || submodule?.error)) return true;
  return countUncommittedChanges(status) > 0;
}
var ROUTING_SKIPPED_COMPACT_MAX = 5;
function compactRoutingDecision(routing) {
  const out = {};
  for (const [k, v] of Object.entries(routing)) {
    if (k === "skippedCandidates" && Array.isArray(v)) {
      const kept = v.slice(0, ROUTING_SKIPPED_COMPACT_MAX);
      out[k] = kept;
      if (v.length > kept.length) out.skippedCandidatesDropped = v.length - kept.length;
    } else {
      out[k] = v;
    }
  }
  return out;
}
function slimLedgerPayload(payload) {
  const slim = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "message" || k === "taskSummary") {
      slim[k] = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "\u2026" : v;
    } else if (k === "routingDecision" && v && typeof v === "object" && !Array.isArray(v)) {
      slim[k] = compactRoutingDecision(v);
    } else if (k === "evidence" || k === "workerResult" || k === "gitStatus" || k === "validationResults") {
    } else if (k === "finalSummary") {
      slim[k] = typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "\u2026" : v;
    } else if (LARGE_LEDGER_FIELD_KEYS.has(k)) {
      slim[k] = summarizeLargeLedgerField(k, v);
    } else {
      slim[k] = elideLargeNestedValue(k, v);
    }
  }
  return slim;
}
function readRelatedRepos(node) {
  const raw = Array.isArray(node.relatedRepos) ? node.relatedRepos : Array.isArray(node.policy?.relatedRepos) ? node.policy.relatedRepos : [];
  return raw.map((entry) => ({
    label: typeof entry?.label === "string" ? entry.label.trim() : "",
    workspace: typeof entry?.workspace === "string" ? entry.workspace.trim() : ""
  })).filter((entry) => Boolean(entry.label && entry.workspace));
}
function summarizeRelatedRepoStatus(repo, status) {
  const dirty = isGitStatusDirty(status);
  return {
    label: repo.label,
    workspace: repo.workspace,
    isGitRepo: status?.isGitRepo === true,
    branch: status?.branch ?? null,
    upstream: status?.upstream ?? null,
    upstreamStatus: typeof status?.upstreamStatus === "string" ? status.upstreamStatus : status?.upstream ? "unchecked" : "no_upstream",
    upstreamFetchedAt: Number.isFinite(Number(status?.upstreamFetchedAt)) ? Number(status.upstreamFetchedAt) : null,
    upstreamFetchError: typeof status?.upstreamFetchError === "string" ? status.upstreamFetchError : null,
    ahead: Number.isFinite(Number(status?.ahead)) ? Number(status.ahead) : 0,
    behind: Number.isFinite(Number(status?.behind)) ? Number(status.behind) : 0,
    dirty,
    uncommittedChanges: countUncommittedChanges(status),
    head: status?.headCommit ?? null,
    lastCommitSummary: status?.headMessage ?? null,
    ...status?.reason ? { reason: status.reason } : {},
    ...status?.error ? { error: status.error } : {}
  };
}
async function collectRelatedRepoStatuses(ctx, node) {
  const relatedRepos = readRelatedRepos(node);
  if (!relatedRepos.length) return [];
  const results = [];
  for (const repo of relatedRepos) {
    try {
      const statusResult = await commandForNode(ctx, node, "git_status", { workspace: repo.workspace, refreshUpstream: true }, { statusProbe: true });
      const status = extractGitStatus(statusResult);
      results.push(summarizeRelatedRepoStatus(repo, status));
    } catch (e) {
      results.push({
        label: repo.label,
        workspace: repo.workspace,
        error: e?.message || "related repo status failed"
      });
    }
  }
  return results;
}
function readProviderPriority(policy) {
  const raw = policy?.providerPriority;
  return Array.isArray(raw) ? raw.map((type) => typeof type === "string" ? type.trim() : "").filter(Boolean) : [];
}
function readNodeSupportedProviders(policy) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  const push = (type) => {
    const trimmed = typeof type === "string" ? type.trim() : "";
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  for (const slot of normalizeNodeCapabilitySlots(policy?.slots)) push(slot.provider);
  for (const type of readProviderPriority(policy)) push(type);
  return out;
}
function buildNodeCapabilityExposure(node) {
  const providers = readNodeSupportedProviders(node.policy);
  const capabilityTags = (0, import_daemon_core3.buildMeshNodeCapabilityTags)(node);
  const exposure = { capabilityTags };
  if (providers.length) {
    const byProvider = {};
    for (const provider of providers) {
      byProvider[provider] = (0, import_daemon_core3.buildMeshNodeCapabilityTags)(node, provider);
    }
    exposure.capabilityTagsByProvider = byProvider;
  }
  const capabilities = Array.isArray(node.capabilities) ? node.capabilities.filter((tag) => typeof tag === "string" && !!tag.trim()) : [];
  if (capabilities.length) exposure.capabilities = capabilities;
  return exposure;
}
function readSpawnedSessionVisibility(policy) {
  return policy?.spawnedSessionVisibility === "hidden" ? "hidden" : "visible";
}
function missingProviderPriorityMessage(nodeId) {
  return `Node '${nodeId}' has no providerPriority policy; pass type explicitly or configure node.policy.providerPriority`;
}
function getNodeLaunchReadiness(node) {
  const bootstrap = node.worktreeBootstrap;
  if (node.isLocalWorktree && bootstrap?.status === "failed" && bootstrap?.required !== false) {
    return {
      providerPriority: readProviderPriority(node.policy),
      launchReady: false,
      launchBlockedReason: "worktree_bootstrap_failed",
      launchBlockedMessage: typeof bootstrap.error === "string" && bootstrap.error.trim() ? bootstrap.error.trim() : "Required worktree bootstrap failed; resolve it before launching an agent into this node.",
      worktreeBootstrap: bootstrap
    };
  }
  const providerPriority = readProviderPriority(node.policy);
  if (providerPriority.length) {
    return {
      providerPriority,
      launchReady: true
    };
  }
  return {
    providerPriority,
    launchReady: false,
    launchBlockedReason: "missing_provider_priority",
    launchBlockedMessage: missingProviderPriorityMessage(node.id)
  };
}
function getWorktreeBootstrapLaunchBlock(node, meshPolicy) {
  if (!node.isLocalWorktree) return void 0;
  const bootstrap = node.worktreeBootstrap;
  const requireReady = !!(meshPolicy && typeof meshPolicy === "object" && meshPolicy.requireBootstrapBeforeLaunch === true);
  if (requireReady && bootstrap?.status !== "ready") {
    return {
      success: false,
      code: "bootstrap_not_ready",
      error: `Node '${node.id}' bootstrap state is '${bootstrap?.status ?? "unknown"}' and mesh policy requireBootstrapBeforeLaunch is enabled.`,
      nodeId: node.id,
      worktreeBootstrap: bootstrap ?? null,
      recoveryHint: "Run the worktree bootstrap (clone runOnClone or a refine with bootstrap inherit) until the node reports ready, or disable requireBootstrapBeforeLaunch."
    };
  }
  if (bootstrap?.status !== "failed" || bootstrap?.required === false) return void 0;
  return {
    success: false,
    code: "worktree_bootstrap_failed",
    error: typeof bootstrap.error === "string" && bootstrap.error.trim() ? bootstrap.error.trim() : `Node '${node.id}' has a failed required worktree bootstrap.`,
    nodeId: node.id,
    worktreeBootstrap: bootstrap,
    recoveryHint: "Fix the configured worktree bootstrap command or remove/recreate the worktree node before launching an agent."
  };
}
async function collectLiveStatusSessions(ctx, node) {
  try {
    const statusResult = await commandForNode(ctx, node, "get_status_metadata", {});
    return extractStatusMetadataSessions(statusResult);
  } catch {
    return [];
  }
}
async function collectLiveStatusProbe(ctx, node) {
  try {
    const statusResult = await commandForNode(ctx, node, "get_status_metadata", {}, { statusProbe: true });
    return {
      sessions: extractStatusMetadataSessions(statusResult),
      daemonBuild: extractDaemonBuildInfo(statusResult)
    };
  } catch {
    return { sessions: [] };
  }
}
function extractDaemonBuildInfo(value) {
  const payload = unwrapCommandPayload(value);
  const build = payload?.daemonBuild && typeof payload.daemonBuild === "object" ? payload.daemonBuild : value?.daemonBuild && typeof value.daemonBuild === "object" ? value.daemonBuild : void 0;
  if (!build) return void 0;
  const commit = readString(build.commit);
  if (!commit) return void 0;
  return {
    commit,
    commitShort: readString(build.commitShort) || commit.slice(0, 7),
    version: readString(build.version) || "unknown",
    ...readString(build.builtAt) ? { builtAt: readString(build.builtAt) } : {}
  };
}
async function collectMeshViewQueueNodesWithLiveSessions(ctx) {
  const nodes = await Promise.all(ctx.mesh.nodes.map(async (node) => {
    const liveSessions = await collectLiveStatusSessions(ctx, node);
    return liveSessions.length > 0 ? { ...node, sessions: liveSessions } : node;
  }));
  return nodes;
}
function buildBranchConvergence(mesh, node, status, dirty, uncommittedChanges) {
  const defaultBranch = readString(mesh.defaultBranch) ?? "main";
  const branch = readString(status?.branch) ?? readString(node.worktreeBranch) ?? null;
  const ahead = readNumeric(status?.ahead);
  const behind = readNumeric(status?.behind);
  const upstream = readString(status?.upstream) ?? null;
  const upstreamStatus = readString(status?.upstreamStatus) ?? (upstream ? "unchecked" : "no_upstream");
  const hasConflicts = status?.hasConflicts === true || Array.isArray(status?.conflictFiles) && status.conflictFiles.length > 0;
  const base = {
    defaultBranch,
    branch,
    upstream,
    upstreamStatus,
    ahead,
    behind,
    isWorktree: node.isLocalWorktree === true,
    isDefaultBranch: branch === defaultBranch
  };
  if (status?.isGitRepo !== true) {
    return {
      ...base,
      status: "blocked_review",
      needsConvergence: true,
      reason: "git_status_unavailable",
      nextStep: `Resolve git status for node '${node.id}' before marking the task complete.`
    };
  }
  if (!branch) {
    return {
      ...base,
      status: "blocked_review",
      needsConvergence: true,
      reason: "branch_unknown",
      nextStep: `Inspect node '${node.id}' git branch before deciding whether it is merged to ${defaultBranch}.`
    };
  }
  if (hasConflicts || dirty || uncommittedChanges > 0) {
    return {
      ...base,
      status: "not_mergeable",
      needsConvergence: true,
      reason: hasConflicts ? "conflicts_present" : "dirty_workspace",
      nextStep: `Commit, checkpoint, or resolve node '${node.id}' before any main convergence step.`
    };
  }
  if (branch === defaultBranch) {
    if (upstream && upstreamStatus !== "fresh") {
      return {
        ...base,
        status: "blocked_review",
        needsConvergence: true,
        reason: "default_branch_upstream_unverified",
        nextStep: `Refresh ${defaultBranch}'s upstream refs or resolve the fetch failure before declaring convergence complete for node '${node.id}'.`
      };
    }
    if (ahead > 0 || behind > 0) {
      return {
        ...base,
        status: "blocked_review",
        needsConvergence: true,
        reason: "default_branch_not_even_with_upstream",
        nextStep: `Bring ${defaultBranch} even with its upstream before declaring convergence complete.`
      };
    }
    return {
      ...base,
      status: "merged_to_main",
      needsConvergence: false,
      reason: "clean_default_branch",
      nextStep: null
    };
  }
  if (node.isLocalWorktree) {
    return {
      ...base,
      status: "cleanup_candidate",
      needsConvergence: true,
      reason: "clean_non_default_worktree_branch",
      nextStep: `Run mesh_refine_node(node_id: "${node.id}") or explicitly classify this worktree as blocked_review/not_mergeable before ending the task.`
    };
  }
  if (upstream && upstreamStatus !== "fresh") {
    return {
      ...base,
      status: "blocked_review",
      needsConvergence: true,
      reason: "feature_branch_upstream_unverified",
      nextStep: `Refresh branch '${branch}' upstream refs or resolve the fetch failure before deciding whether it is ready to merge into ${defaultBranch}.`
    };
  }
  if (!upstream || ahead > 0 || behind > 0) {
    return {
      ...base,
      status: "blocked_review",
      needsConvergence: true,
      reason: !upstream ? "feature_branch_missing_upstream" : "feature_branch_not_even_with_upstream",
      nextStep: `Push or reconcile branch '${branch}', then merge it into ${defaultBranch} or mark it not_mergeable with a reason.`
    };
  }
  return {
    ...base,
    status: "pushed_feature_branch_needs_merge",
    needsConvergence: true,
    reason: "clean_non_default_branch",
    nextStep: `Review and merge branch '${branch}' into ${defaultBranch}; do not report the task as fully complete while it remains off main.`
  };
}
var COMPACT_MAX_CONVERGENCE_FOLLOWUPS = 12;
function summarizeBranchConvergence(nodes, compact = false) {
  const allFollowUps = nodes.filter((node) => node?.branchConvergence?.needsConvergence === true).map((node) => ({
    nodeId: node.nodeId,
    // workspace is a long absolute path redundant with nodeId — drop it in
    // compact mode to keep this summary bounded.
    ...compact ? {} : { workspace: node.workspace },
    branch: node.branchConvergence.branch,
    status: node.branchConvergence.status,
    reason: node.branchConvergence.reason,
    // The per-node nextStep is long prose that repeats node ids/branch names.
    // In compact mode drop it (the status+reason carry the actionable signal;
    // verbose still surfaces the full nextStep) so this summary stays bounded
    // as node count grows.
    ...compact ? {} : { nextStep: node.branchConvergence.nextStep }
  }));
  const byStatus = {};
  for (const f of allFollowUps) {
    const s = typeof f.status === "string" ? f.status : "unknown";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  const followUps = compact ? allFollowUps.slice(0, COMPACT_MAX_CONVERGENCE_FOLLOWUPS) : allFollowUps;
  const omitted = allFollowUps.length - followUps.length;
  return {
    needsFollowUp: allFollowUps.length > 0,
    unresolvedCount: allFollowUps.length,
    byStatus,
    requiredFinalStates: ["merged_to_main", "pushed_feature_branch_needs_merge", "blocked_review", "cleanup_candidate", "not_mergeable"],
    followUps,
    ...omitted > 0 ? { followUpsOmitted: omitted, followUpsHint: "Per-node followUp rows are capped in compact mode; counts above are complete. Use verbose=true for the full list." } : {}
  };
}
async function commandForNode(ctx, node, command, args = {}, opts) {
  const isLocalNode = isLocalControlPlaneNode(ctx, node);
  if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
    const relayedArgs = opts?.statusProbe ? withStatusProbeMarker(args) : args;
    return ctx.transport.meshCommand(node.daemonId, command, relayedArgs);
  }
  return ctx.transport.command(command, args);
}
function normalizePendingMeshCoordinatorEvents(value) {
  const payload = unwrapCommandPayload(value);
  const events = Array.isArray(payload?.events) ? payload.events : Array.isArray(value?.events) ? value.events : [];
  return events.filter((event) => event && typeof event === "object");
}
function buildMeshForwardPayloadFromPendingEvent(event) {
  const metadataEvent = event?.metadataEvent && typeof event.metadataEvent === "object" ? event.metadataEvent : {};
  return {
    event: readString(event?.event),
    meshId: readString(event?.meshId),
    nodeId: readString(event?.nodeId) || readString(metadataEvent.meshNodeId),
    workspace: readString(event?.workspace) || readString(metadataEvent.workspace),
    targetSessionId: readString(metadataEvent.targetSessionId) || readString(metadataEvent.sessionId) || readString(metadataEvent.instanceId),
    providerType: readString(metadataEvent.providerType),
    providerSessionId: readString(metadataEvent.providerSessionId),
    finalSummary: readString(metadataEvent.finalSummary) || readString(metadataEvent.summary),
    jobId: readString(metadataEvent.jobId),
    interactionId: readString(metadataEvent.interactionId),
    status: readString(metadataEvent.status),
    targetDaemonId: readString(metadataEvent.targetDaemonId),
    startedAt: readString(metadataEvent.startedAt),
    completedAt: readString(metadataEvent.completedAt),
    retryOfJobId: readString(metadataEvent.retryOfJobId),
    ...metadataEvent.result && typeof metadataEvent.result === "object" && !Array.isArray(metadataEvent.result) ? { result: metadataEvent.result } : {},
    ...metadataEvent.intentional === true ? { intentional: true } : {},
    ...metadataEvent.intentionalStop === true ? { intentionalStop: true } : {},
    ...metadataEvent.operatorCleanup === true ? { operatorCleanup: true } : {},
    ...readString(metadataEvent.reason) ? { reason: readString(metadataEvent.reason) } : {},
    ...readString(metadataEvent.stopReason) ? { stopReason: readString(metadataEvent.stopReason) } : {},
    ...readString(metadataEvent.cleanupReason) ? { cleanupReason: readString(metadataEvent.cleanupReason) } : {},
    ...readString(metadataEvent.source) ? { source: readString(metadataEvent.source) } : {},
    // T4 (B3b): carry the v2 envelope across the P2P relay so a remote worker's
    // completion pulled by an MCP/LLM coordinator re-forwards with its ORIGINAL
    // eventId (idempotency) and unicast routing intact, matching the reconcile-loop
    // relay path (buildForwardPayloadFromPending). Spread LAST so the authoritative
    // envelope always wins. Empty for a v1 event (version-skew safe).
    ...(0, import_daemon_core3.serializeV2EnvelopeToWire)(event)
  };
}
async function drainCoordinatorPendingEvents(ctx, opts) {
  const requestedNodeIds = opts?.nodeIds?.length ? new Set(opts.nodeIds) : null;
  const matchesCurrentMesh = (event) => readString(event?.meshId) === ctx.mesh.id;
  if (ctx.transport instanceof IpcTransport) {
    const transport = ctx.transport;
    const surfacedEvents = [];
    const coordinatorDaemonId = readString(ctx.localDaemonId);
    const pendingEventArgs = {
      meshId: ctx.mesh.id,
      ...coordinatorDaemonId ? { coordinatorDaemonId } : {}
    };
    const localPendingEventArgs = { ...pendingEventArgs, selfCoordinatorInboxRead: true };
    const drainLocalToSurface = async () => {
      const raw = await transport.command("get_pending_mesh_events", localPendingEventArgs);
      const payloadRaw = unwrapCommandPayload(raw);
      const counters = payloadRaw?.meshProtocolV2Counters ?? raw?.meshProtocolV2Counters;
      if (counters && typeof counters === "object") {
        ctx.lastMeshProtocolV2Counters = counters;
      }
      const hasLiveCliCoordinator = payloadRaw?.hasLiveCliCoordinator === true || raw?.hasLiveCliCoordinator === true;
      const surfacedForSelfCoordinator = payloadRaw?.surfacedForSelfCoordinator === true || raw?.surfacedForSelfCoordinator === true;
      const localEvents = normalizePendingMeshCoordinatorEvents(raw).filter(matchesCurrentMesh);
      for (const event of localEvents) {
        const payload = buildMeshForwardPayloadFromPendingEvent(event);
        if (!payload.event || !payload.meshId) continue;
        if (!hasLiveCliCoordinator || surfacedForSelfCoordinator) {
          rememberMeshSessionProviderMetadataFromEvent({ ...event, metadataEvent: payload });
          surfacedEvents.push(event);
          continue;
        }
        let injected = false;
        try {
          await transport.command("mesh_forward_event", payload);
          injected = true;
        } catch {
        }
        rememberMeshSessionProviderMetadataFromEvent({ ...event, metadataEvent: payload });
        if (!injected) surfacedEvents.push(event);
      }
    };
    try {
      await drainLocalToSurface();
    } catch {
    }
    for (const node of ctx.mesh.nodes) {
      if (!node.daemonId || isLocalControlPlaneNode(ctx, node)) continue;
      if (requestedNodeIds && !requestedNodeIds.has(node.id)) continue;
      try {
        const remoteEvents = normalizePendingMeshCoordinatorEvents(
          await transport.meshCommand(node.daemonId, "get_pending_mesh_events", pendingEventArgs)
        ).filter(matchesCurrentMesh);
        if (remoteEvents.length === 0) continue;
        for (const event of remoteEvents) {
          const payload = buildMeshForwardPayloadFromPendingEvent(event);
          if (!payload.event || !payload.meshId) continue;
          await transport.command("mesh_forward_event", payload);
          rememberMeshSessionProviderMetadataFromEvent({ ...event, metadataEvent: payload });
        }
      } catch {
      }
    }
    try {
      await drainLocalToSurface();
    } catch {
    }
    return surfacedEvents;
  }
  const drainerIdentity = (0, import_daemon_core3.coordinatorIdentityFromEmitFields)({
    daemonId: ctx.localDaemonId,
    sessionId: ctx.coordinatorSessionId
  });
  const events = (0, import_daemon_core3.drainPendingMeshCoordinatorEvents)(
    ctx.mesh.id,
    ctx.localDaemonId,
    drainerIdentity ? { drainerIdentity } : void 0
  ).filter(matchesCurrentMesh);
  events.forEach(rememberMeshSessionProviderMetadataFromEvent);
  return events;
}
function isP2pTransportUnavailableError(error) {
  return (0, import_daemon_core3.isP2pRelayTransportFailure)(error);
}
function buildRemoveNodeArgs(ctx, nodeId, sessionCleanupMode, force) {
  return {
    meshId: ctx.mesh.id,
    nodeId,
    ...sessionCleanupMode ? { sessionCleanupMode } : {},
    ...force === true ? { force: true } : {},
    inlineMesh: ctx.mesh
  };
}
function classifyReadChatTransportCause(error) {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (/not acknowledged|delivery failure|channel never opened|connect timed out|not connected|datachannel|disconnected|\bclosed\b|offline|no route|failed to initiate p2p|p2p mesh is not available|connect queue full/.test(message)) {
    return "not_connected";
  }
  return "saturated";
}
function resolveCachedMeshSessionPreviewFromLedger(ctx, nodeId, sessionId) {
  const entries = (0, import_daemon_core3.readLedgerEntries)(ctx.mesh.id, { tail: 200 });
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const payload = entry.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload) ? entry.payload : {};
    const entryNodeId = readString(entry.nodeId) || readString(payload.nodeId) || readString(payload.meshNodeId);
    if (entryNodeId && entryNodeId !== nodeId) continue;
    const entrySessionId = readString(entry.sessionId) || readString(payload.targetSessionId) || readString(payload.sessionId) || readString(payload.instanceId);
    if (entrySessionId !== sessionId) continue;
    const metadataEvent = payload.metadataEvent && typeof payload.metadataEvent === "object" && !Array.isArray(payload.metadataEvent) ? payload.metadataEvent : payload;
    const preview = (0, import_daemon_core3.resolveMeshSurfacedSessionPreview)(metadataEvent);
    if (preview) {
      return { ...preview, ledgerKind: entry.kind, timestamp: entry.timestamp };
    }
  }
  return void 0;
}
function buildMeshReadChatCacheFallback(ctx, args, node, error) {
  const classification = (0, import_daemon_core3.classifyP2pRelayFailure)(error, { command: "read_chat", targetDaemonId: node.daemonId });
  const cause = classifyReadChatTransportCause(error);
  const errorMessage = error instanceof Error ? error.message : String(error ?? "");
  const causeNote = cause === "not_connected" ? "the worker daemon is not currently connected over P2P (no live channel)" : "the worker daemon is connected but saturated \u2014 it acknowledged the request but did not return the transcript within the deadline";
  const cached = resolveCachedMeshSessionPreviewFromLedger(ctx, args.node_id, args.session_id);
  if (cached) {
    return JSON.stringify({
      success: true,
      source: "coordinator_cache_fallback",
      fallback: true,
      nodeId: args.node_id,
      sessionId: args.session_id,
      transport: "p2p",
      transportFailure: {
        code: classification.code,
        reason: classification.reason,
        cause,
        error: errorMessage
      },
      advisory: `Live transcript unavailable (${causeNote}). Showing the cached coordinator-side summary surfaced from the worker's last completion/status event \u2014 a stale point-in-time summary, NOT the live transcript. The full transcript requires a live P2P read_chat once the peer is reachable.`,
      fullTranscriptRequiresP2p: true,
      summary: cached.preview,
      messages: [{
        role: cached.role,
        content: cached.preview,
        cached: true,
        ...cached.receivedAt ? { receivedAt: cached.receivedAt } : {}
      }],
      cachedPreview: {
        role: cached.role,
        ledgerKind: cached.ledgerKind,
        ledgerTimestamp: cached.timestamp,
        ...cached.receivedAt ? { receivedAt: cached.receivedAt } : {}
      }
    }, null, 2);
  }
  const failure = buildCoordinatorP2pRelayFailure(error, {
    command: "read_chat",
    targetDaemonId: node.daemonId,
    nodeId: args.node_id,
    sessionId: args.session_id
  });
  return JSON.stringify({
    ...failure,
    cause,
    cachedSummaryAvailable: false,
    fullTranscriptRequiresP2p: true,
    advisory: `Live transcript unavailable (${causeNote}) and no cached coordinator-side summary exists for this session yet (no completion/status event has been surfaced). The full transcript requires a live P2P read_chat once the peer is reachable.`
  }, null, 2);
}
function resolveRefineConfigNode(ctx, nodeId) {
  if (nodeId) return findNode(ctx.mesh, nodeId);
  const node = ctx.mesh.nodes.find((entry) => !!entry.workspace);
  if (!node) throw new Error("No mesh node with a workspace is available");
  return node;
}

// src/tools/mesh-tools-status.ts
var MESH_PROTOCOL_VERSION_V2_WIRE = "2.0";
function summarizePendingEventProtocolMetrics(pendingEvents) {
  if (!Array.isArray(pendingEvents) || pendingEvents.length === 0) return null;
  let v2 = 0;
  const scopes = {};
  for (const event of pendingEvents) {
    const protocolVersion = typeof event?.protocolVersion === "string" ? event.protocolVersion : "";
    if (protocolVersion === MESH_PROTOCOL_VERSION_V2_WIRE) {
      v2 += 1;
      const scope = typeof event?.scope === "string" && event.scope ? event.scope : "unspecified";
      scopes[scope] = (scopes[scope] ?? 0) + 1;
    }
  }
  const total = pendingEvents.length;
  return {
    total,
    v2,
    v1: total - v2,
    v2Ratio: total > 0 ? Math.round(v2 / total * 100) / 100 : 0,
    scopes
  };
}
async function meshStatus(ctx, args = {}) {
  const rateResult = (0, import_daemon_core4.recordMeshToolCall)({ meshId: ctx.mesh.id, tool: "mesh_status" });
  const compact = args.verbose === true ? false : args.compact ?? true;
  await refreshMeshFromDaemon(ctx);
  const { mesh, transport } = ctx;
  let ledgerSummary = (0, import_daemon_core4.getLedgerSummary)(mesh.id);
  const schedulingRuntime = (0, import_daemon_core4.buildMeshSchedulingRuntime)(mesh, (0, import_daemon_core4.getQueue)(mesh.id));
  const schedulingByNode = new Map(schedulingRuntime.nodes.map((n) => [n.nodeId, n]));
  const results = await Promise.all(mesh.nodes.map(async (node) => {
    const entry = {
      nodeId: node.id,
      workspace: node.workspace,
      machine: buildNodeMachineIdentity(ctx, node),
      daemonId: readNodeDaemonId(node),
      machineId: readNodeMachineId(node),
      ...getNodeLaunchReadiness(node),
      ...buildNodeCapabilityExposure(node)
    };
    const nodeScheduling = schedulingByNode.get(node.id);
    if (nodeScheduling) {
      const { nodeId: _omit, ...rest } = nodeScheduling;
      entry.scheduling = compact ? { load: rest.load, capReached: rest.capReached } : rest;
    }
    let liveTruthProbed = false;
    try {
      const autoDiscover = node.policy?.autoDiscoverSubmodules !== false;
      const statusResult = await commandForNode(ctx, node, "git_status", {
        workspace: node.workspace,
        refreshUpstream: true,
        includeSubmodules: autoDiscover,
        submoduleIgnorePaths: node.policy?.submoduleIgnorePaths || void 0
      }, { statusProbe: true });
      liveTruthProbed = true;
      const status = extractGitStatus(statusResult);
      const uncommittedChanges = countUncommittedChanges(status);
      const dirty = isGitStatusDirty(status);
      entry.health = status?.isGitRepo ? dirty ? "dirty" : "online" : "degraded";
      assignFullGitSnapshot(entry, status);
      entry.branch = status?.branch;
      entry.isDirty = dirty;
      entry.uncommittedChanges = uncommittedChanges;
      entry.branchConvergence = buildBranchConvergence(mesh, node, status, dirty, uncommittedChanges);
      if (status?.daemonBuildBehind && typeof status.daemonBuildBehind === "object") {
        entry.staleDaemonBuild = status.daemonBuildBehind;
      }
      const submodules = extractSubmodules(statusResult, node.policy?.submoduleIgnorePaths || []);
      if (submodules && submodules.some((s) => s?.outOfSync)) {
        entry.submoduleWarning = "One or more submodules are out of sync with the parent repo. Run `git submodule update` or check deployment readiness.";
        entry.outOfSyncSubmodules = submodules.filter((s) => s?.outOfSync).map((s) => s.path);
      }
    } catch (e) {
      const failure = buildCoordinatorP2pRelayFailure(e, {
        command: "git_status",
        targetDaemonId: node.daemonId,
        nodeId: node.id
      });
      entry.health = "degraded";
      entry.error = failure.error;
      entry.degradedReason = failure.recoverable ? "p2p_relay_failure" : "git_status_unavailable";
      Object.assign(entry, {
        code: failure.code,
        transport: failure.transport,
        recoverable: failure.recoverable,
        retryRecommended: failure.retryRecommended,
        nextAction: failure.nextAction,
        noFallbackReason: failure.noFallbackReason
      });
    }
    entry.dataFreshness = (0, import_daemon_core4.buildMeshNodeProbeFreshness)({
      git: entry.git,
      liveTruthProbed,
      isSelfNode: entry.machine?.sameMachine === true,
      daemonId: readNodeDaemonId(node),
      node
    });
    const recoveryContext = (0, import_daemon_core4.getSessionRecoveryContext)(mesh.id, { nodeId: node.id });
    if (recoveryContext.consecutiveNodeFailures > 0) {
      entry.recoveryHints = {
        consecutiveFailures: recoveryContext.consecutiveNodeFailures,
        lastTaskMessage: typeof recoveryContext.lastTaskMessage === "string" ? recoveryContext.lastTaskMessage.slice(0, 100) + (recoveryContext.lastTaskMessage.length > 100 ? "\u2026" : "") : recoveryContext.lastTaskMessage,
        advice: recoveryContext.advice,
        retryRecommended: recoveryContext.retryRecommended
      };
    }
    const activeLaunchFailure = getLatestActiveLaunchFailure(mesh.id, node.id);
    if (activeLaunchFailure && node.isLocalWorktree) {
      entry.health = "degraded";
      entry.degradedReason = "worktree_launch_failed";
      entry.launchReady = false;
      entry.launchBlockedReason = activeLaunchFailure.code || "mesh_launch_failed";
      entry.launchBlockedMessage = activeLaunchFailure.error || "Previous worktree session launch failed";
      entry.lastLaunchFailure = activeLaunchFailure;
    }
    const nextStepHints = [];
    if (entry.degradedReason === "worktree_launch_failed") {
      nextStepHints.push(`Retry mesh_launch_session(node_id: "${node.id}") after daemon mesh transport/P2P is healthy.`);
      nextStepHints.push(`If retry is not desired, cleanup the orphan worktree node with mesh_remove_node(node_id: "${node.id}").`);
    } else if (entry.health === "online" && node.isLocalWorktree) {
      nextStepHints.push(`Merge worktree to base via mesh_refine_node(node_id: "${node.id}")`);
    } else if (entry.health === "dirty") {
      nextStepHints.push(`Commit changes via mesh_checkpoint(node_id: "${node.id}", message: "...")`);
    } else if (entry.health === "degraded" && entry.error?.includes("git")) {
      nextStepHints.push("Initialize git repository or check workspace path.");
    }
    if (entry.branchConvergence?.needsConvergence === true && entry.branchConvergence.nextStep) {
      nextStepHints.push(String(entry.branchConvergence.nextStep));
    }
    if (recoveryContext.consecutiveNodeFailures > 0) {
      if (recoveryContext.retryRecommended) {
        nextStepHints.push(`Retry task on this node or launch a fresh session.`);
      } else {
        nextStepHints.push(`Consider reassigning work to a different node.`);
      }
    }
    if (nextStepHints.length > 0) {
      entry.nextStepHints = nextStepHints;
    }
    const relatedRepos = await collectRelatedRepoStatuses(ctx, node);
    if (relatedRepos.length) entry.relatedRepos = relatedRepos;
    const statusProbe = await collectLiveStatusProbe(ctx, node);
    const liveSessions = statusProbe.sessions;
    if (statusProbe.daemonBuild) entry.daemonBuild = statusProbe.daemonBuild;
    if (liveSessions.length > 0) {
      entry.sessions = liveSessions.map((s) => {
        const coordinatorMeshId = typeof s.coordinator?.meshId === "string" ? s.coordinator.meshId : void 0;
        const isSelfCoordinator = coordinatorMeshId === mesh.id;
        return {
          id: s.instanceId ?? s.id ?? s.sessionId,
          status: s.status ?? s.lifecycle ?? s.state,
          providerType: s.providerType ?? s.cliType ?? s.type,
          ...s.activeChat?.status ? { chatStatus: s.activeChat.status } : {},
          // Stage 6: attempt identity + causal stage from the unified turn
          // projection (present on mesh-owned sessions only), so mesh_status
          // reports the SAME attemptId/stage as read_chat and the dashboard.
          ...s.turn?.attemptId ? { attemptId: s.turn.attemptId } : {},
          ...s.turn?.stage ? { turnStage: s.turn.stage } : {},
          ...isSelfCoordinator ? { isSelfCoordinator: true, role: "coordinator" } : {},
          // [T2] Carry the worker-computed last-message preview through the slim so
          // the coordinator's inbox can show the worker's latest ASSISTANT reply
          // without re-deriving it from a live in-process instance it doesn't host.
          // The worker's get_status_metadata snapshot already computes these
          // (status/snapshot.ts) from its real transcript; dropping them here forced
          // the coordinator down a derive path that fails for genuinely remote
          // workers, leaving the mobile inbox stuck on the dispatched user task.
          ...typeof s.lastMessagePreview === "string" && s.lastMessagePreview ? { lastMessagePreview: s.lastMessagePreview } : {},
          ...typeof s.lastMessageRole === "string" && s.lastMessageRole ? { lastMessageRole: s.lastMessageRole } : {},
          ...typeof s.lastMessageAt === "number" && Number.isFinite(s.lastMessageAt) ? { lastMessageAt: s.lastMessageAt } : {},
          // RESTORE-STICK: carry the worker's AUTHORITATIVE dashboard hide/mute
          // state (already resolved by the worker's status/builders honoring any
          // per-session user override) plus the raw userHidden/userMuted overrides.
          // The coordinator's cloud snapshot append (daemon-cloud
          // appendMeshOwnedSessionsToSnapshot) otherwise re-derives hide/mute purely
          // from mesh policy and clobbers a user's manual restore/un-mute every
          // snapshot — the un-hide flickered visible then re-hid. Dropping these
          // here is exactly what starved the coordinator of the worker's real state.
          ...typeof s.surfaceHidden === "boolean" ? { surfaceHidden: s.surfaceHidden } : {},
          ...typeof s.muted === "boolean" ? { muted: s.muted } : {},
          ...typeof s.settings?.userHidden === "boolean" ? { userHidden: s.settings.userHidden } : {},
          ...typeof s.settings?.userMuted === "boolean" ? { userMuted: s.settings.userMuted } : {}
        };
      }).filter((s) => s.id);
    }
    return entry;
  }));
  let ledgerEntries = (0, import_daemon_core4.readLedgerEntries)(mesh.id, { tail: 200 });
  let directDispatches = (0, import_daemon_core4.getActiveDirectDispatches)(mesh.id);
  const directReconciliation = await reconcileDirectDispatchesFromTranscriptEvidence(ctx, results, directDispatches, ledgerEntries);
  if (directReconciliation.reconciled > 0) {
    ledgerEntries = (0, import_daemon_core4.readLedgerEntries)(mesh.id, { tail: 200 });
    directDispatches = (0, import_daemon_core4.getActiveDirectDispatches)(mesh.id);
    ledgerSummary = (0, import_daemon_core4.getLedgerSummary)(mesh.id);
  }
  const activeWorkEvidence = (0, import_daemon_core4.buildMeshActiveWork)({
    meshId: mesh.id,
    queue: (0, import_daemon_core4.getQueue)(mesh.id),
    ledgerEntries,
    directDispatches,
    nodes: results
  });
  const pollingGuidance = buildActiveWorkPollingGuidance(activeWorkEvidence.summary);
  const staleDirectWorkSummary = (0, import_daemon_core4.buildCompactStaleDirectWorkSummary)(activeWorkEvidence.staleDirectWork, {
    note: activeWorkEvidence.staleDirectWorkNote,
    detailHint: "Full stale direct entries are omitted from mesh_status by default. Call mesh_status with includeStaleDirectWorkDetails=true or inspect mesh_task_history for ledger detail."
  });
  const activeWorkForResponse = compact ? compactActiveWorkRecords(activeWorkEvidence.activeWork) : { records: activeWorkEvidence.activeWork, omitted: 0 };
  const coordinatorSessions = [];
  for (const nodeEntry of results) {
    const sessions = Array.isArray(nodeEntry.sessions) ? nodeEntry.sessions : [];
    for (const s of sessions) {
      if (s?.isSelfCoordinator === true && s.id) {
        coordinatorSessions.push({
          nodeId: nodeEntry.nodeId,
          sessionId: s.id,
          providerType: s.providerType,
          status: s.status
        });
      }
    }
  }
  const includeSessions = args.includeSessions === true;
  const daemonSessions = {};
  if (compact) {
    const seenDaemons = /* @__PURE__ */ new Set();
    for (const entry of results) {
      const daemonId = typeof entry?.daemonId === "string" && entry.daemonId ? entry.daemonId : "";
      const sessions = Array.isArray(entry?.sessions) ? entry.sessions : [];
      if (daemonId && sessions.length > 0 && !seenDaemons.has(daemonId)) {
        seenDaemons.add(daemonId);
        daemonSessions[daemonId] = includeSessions ? sessions : summarizeNodeSessions(sessions);
      }
    }
  }
  const daemonBuilds = {};
  for (const entry of results) {
    const daemonId = typeof entry?.daemonId === "string" && entry.daemonId ? entry.daemonId : "";
    if (daemonId && entry?.daemonBuild && !(daemonId in daemonBuilds)) {
      daemonBuilds[daemonId] = entry.daemonBuild;
    }
  }
  const staleDaemonBuilds = [];
  const seenStale = /* @__PURE__ */ new Set();
  for (const entry of results) {
    const behind = entry?.staleDaemonBuild;
    if (!behind || typeof behind !== "object") continue;
    const daemonId = typeof entry?.daemonId === "string" ? entry.daemonId : "";
    const key = `${daemonId}::${behind.scope ?? ""}::${behind.buildCommit ?? ""}::${behind.head ?? ""}`;
    if (seenStale.has(key)) continue;
    seenStale.add(key);
    const isDaemonAffecting = behind.isDaemonAffecting !== false;
    staleDaemonBuilds.push({
      daemonId,
      nodeId: entry.nodeId,
      scope: behind.scope,
      liveBuildCommit: behind.buildCommit,
      liveBuildCommitShort: behind.buildCommitShort,
      head: behind.head,
      isDaemonAffecting,
      ...Array.isArray(behind.affectedPackages) && behind.affectedPackages.length > 0 ? { affectedPackages: behind.affectedPackages } : {},
      // The full ~300-char warning prose is identical for every entry and is
      // already emitted ONCE at the top level as `staleDaemonBuildWarning`.
      // Keep it per-entry only in verbose to avoid N× duplication in compact.
      ...compact ? {} : { warning: behind.warning }
    });
  }
  const daemonAffectingStaleBuilds = staleDaemonBuilds.filter((b) => b.isDaemonAffecting !== false);
  const webOnlyStaleBuilds = staleDaemonBuilds.filter((b) => b.isDaemonAffecting === false);
  const providerVersionsByProvider = {};
  for (const entry of results) {
    const versions = entry?.providerVersions;
    if (!versions || typeof versions !== "object") continue;
    const nodeId = typeof entry?.nodeId === "string" ? entry.nodeId : "";
    for (const [providerId, rawVersion] of Object.entries(versions)) {
      const version = typeof rawVersion === "string" ? rawVersion.trim() : "";
      if (!providerId || !version) continue;
      const byVersion = providerVersionsByProvider[providerId] ??= {};
      (byVersion[version] ??= []).push(nodeId);
    }
  }
  const providerVersionSkew = [];
  for (const [providerId, byVersion] of Object.entries(providerVersionsByProvider)) {
    const distinctVersions = Object.keys(byVersion);
    if (distinctVersions.length <= 1) continue;
    providerVersionSkew.push({
      provider: providerId,
      versions: distinctVersions.map((version) => ({
        version,
        nodeIds: byVersion[version].filter(Boolean)
      }))
    });
  }
  let stubbedNodeCount = 0;
  let foldedNodesSummary;
  const nodesForResponse = compact ? (() => {
    const compacted = results.map((entry) => {
      const next = compactMeshStatusNode(entry);
      if (!next || typeof next !== "object") return next;
      if (Array.isArray(next.sessions)) {
        next.sessionSummary = summarizeNodeSessions(next.sessions);
        if (!includeSessions) delete next.sessions;
      }
      if (next.daemonBuild !== void 0) delete next.daemonBuild;
      return next;
    });
    const noteworthy = compacted.filter((n) => n && typeof n === "object" && isNoteworthyCompactNode(n));
    const ranked = [...noteworthy].sort((a, b) => compactNodeSeverity(b) - compactNodeSeverity(a));
    const detailedIds = /* @__PURE__ */ new Set();
    let detailSpent = 0;
    for (const n of ranked) {
      const cost = JSON.stringify(n).length + 1;
      if (detailedIds.size === 0 || detailSpent + cost <= COMPACT_DETAILED_NODES_BYTE_BUDGET) {
        detailedIds.add(String(n.nodeId));
        detailSpent += cost;
      }
    }
    const stubOrder = [...compacted].filter((n) => n && typeof n === "object").sort((a, b) => compactNodeSeverity(b) - compactNodeSeverity(a));
    const keptIds = new Set(detailedIds);
    let totalSpent = detailSpent;
    for (const n of stubOrder) {
      const id = String(n.nodeId);
      if (keptIds.has(id)) continue;
      const stubCost = JSON.stringify(minimalCompactNode(n)).length + 1;
      if (totalSpent + stubCost <= COMPACT_NODES_TOTAL_BYTE_BUDGET) {
        keptIds.add(id);
        totalSpent += stubCost;
      }
    }
    const fullyFolded = [];
    const out = compacted.map((n) => {
      if (!n || typeof n !== "object") return n;
      const id = String(n.nodeId);
      if (detailedIds.has(id)) return n;
      if (keptIds.has(id)) {
        stubbedNodeCount += 1;
        return minimalCompactNode(n);
      }
      fullyFolded.push(n);
      return null;
    }).filter((n) => n !== null);
    if (fullyFolded.length > 0) {
      const byBranchConvergence = {};
      const byHealth = {};
      const nodeIds = [];
      for (const n of fullyFolded) {
        const bc = typeof n?.branchConvergence?.status === "string" ? n.branchConvergence.status : "unknown";
        byBranchConvergence[bc] = (byBranchConvergence[bc] ?? 0) + 1;
        const h = typeof n?.health === "string" ? n.health : "unknown";
        byHealth[h] = (byHealth[h] ?? 0) + 1;
        if (n?.nodeId) nodeIds.push(String(n.nodeId));
      }
      foldedNodesSummary = {
        count: fullyFolded.length,
        note: "Node-array byte budget reached: these nodes are listed by id only. Query a specific node_id or use verbose=true for their detail.",
        byHealth,
        byBranchConvergence,
        nodeIds
      };
    }
    return out;
  })() : results;
  const response = {
    meshId: mesh.id,
    meshName: mesh.name,
    repoIdentity: mesh.repoIdentity,
    policy: mesh.policy,
    // Mesh-level scheduling rollup (strategy + global cap consumption). Per-node
    // detail (load/priority/provider caps/claim-block reasons) lives on each
    // nodes[].scheduling; the node array is dropped here to avoid duplicating it.
    scheduling: {
      strategy: schedulingRuntime.strategy,
      maxParallelTasks: schedulingRuntime.maxParallelTasks,
      maxReadonlyParallelTasks: schedulingRuntime.maxReadonlyParallelTasks,
      activeWriteAssigned: schedulingRuntime.activeWriteAssigned,
      activeReadonlyAssigned: schedulingRuntime.activeReadonlyAssigned,
      globalWriteCapReached: schedulingRuntime.globalWriteCapReached,
      globalReadonlyCapReached: schedulingRuntime.globalReadonlyCapReached
    },
    payloadMode: compact ? "compact" : "full",
    refreshedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sourceOfTruth: {
      membership: "coordinator_daemon_live_mesh",
      currentStatus: "live_git_and_session_probes",
      activeWork: "mesh_queue_file_and_local_ledger",
      historicalEvidenceOnly: ["recoveryHints", "ledgerSummary"]
    },
    nodes: nodesForResponse,
    ...compact && stubbedNodeCount > 0 ? {
      stubbedNodesNote: `${stubbedNodeCount} node(s) in the array above are reduced to a minimal stub (marked folded:true) in compact mode \u2014 healthy/clean nodes plus any beyond the detail byte-budget. They remain addressable by node_id; use verbose=true for their full detail.`
    } : {},
    ...compact && foldedNodesSummary ? { foldedNodes: foldedNodesSummary } : {},
    ...compact && Object.keys(daemonSessions).length > 0 ? { daemonSessions } : {},
    ...Object.keys(daemonBuilds).length > 0 ? { daemonBuilds } : {},
    ...staleDaemonBuilds.length > 0 ? { staleDaemonBuilds } : {},
    ...daemonAffectingStaleBuilds.length > 0 ? {
      staleDaemonBuildWarning: "One or more live daemons were built from a commit behind the workspace HEAD with daemon-runtime package changes. Merged refinery/mesh-tool fixes are NOT live on those daemons until they are rebuilt/redeployed and restarted \u2014 a local daemon-core dist rebuild does not update a cloud daemon. Do not assume a just-merged fix is active."
    } : {},
    ...webOnlyStaleBuilds.length > 0 ? {
      webOnlyStaleBuildNote: 'One or more live daemons are behind workspace HEAD, but only web packages changed in that range. The daemon does NOT need a rebuild/restart \u2014 redeploy the web app to reflect those changes. This is informational, not a "fix not live" condition.'
    } : {},
    // T7: provider CLI/ACP version skew across nodes (observational only).
    ...providerVersionSkew.length > 0 ? {
      providerVersionSkew,
      providerVersionSkewWarning: "One or more provider CLIs/ACP agents are running different versions across mesh nodes (see providerVersionSkew). This is informational, not a dispatch blocker \u2014 but a task that assumes a uniform toolchain (e.g. a version-specific flag or output format) may behave differently per node. Consider aligning versions or pinning the task to a node with the expected version."
    } : {},
    activeWork: activeWorkForResponse.records,
    ...compact && activeWorkForResponse.omitted > 0 ? { activeWorkRowsOmitted: activeWorkForResponse.omitted } : {},
    ...compact ? { activeWorkHint: `Compact activeWork rows carry a short taskTitle + dispatch scalars only; full task prompt/summary text is omitted \u2014 use mesh_task_history or mesh_status verbose=true. First ${COMPACT_MAX_ACTIVE_WORK_ROWS} rows serialized.` } : {},
    staleDirectWorkSummary,
    ...args.includeStaleDirectWorkDetails === true ? { staleDirectWork: activeWorkEvidence.staleDirectWork } : {},
    // terminalDirectWork is historical (completed/failed direct dispatches) — opt-in only.
    ...args.includeTerminalDirectWork === true ? { terminalDirectWork: activeWorkEvidence.terminalDirectWork } : {},
    activeWorkSummary: activeWorkEvidence.summary,
    ...pollingGuidance ? { pollingGuidance } : {},
    ...rateResult.rateLimitExceeded ? { pollingRateAdvisory: { type: "rate_limit_exceeded", tool: "mesh_status", callsInWindow: rateResult.callsInWindow, message: rateResult.advisory } } : {},
    branchConvergenceSummary: summarizeBranchConvergence(results, compact),
    ...coordinatorSessions.length > 0 ? {
      coordinatorSessions,
      selfIdentification: {
        meshId: mesh.id,
        coordinatorSessions,
        note: "Sessions listed here are coordinator sessions for this mesh. The calling coordinator IS one of these sessions \u2014 do not treat its own generating CLI session as a foreign delegated task. Per-session marker: sessions[].isSelfCoordinator === true."
      }
    } : {}
  };
  try {
    response.ledgerSummary = ledgerSummary;
  } catch {
  }
  try {
    if (compact) {
      const { live, historyFold } = (0, import_daemon_core4.getMeshStatusMissionsCompact)(mesh.id);
      const ranked = [...live].sort((a, b) => String(b.tasks?.lastActivityAt ?? "").localeCompare(String(a.tasks?.lastActivityAt ?? "")));
      const kept = [];
      const overflow = [];
      let spent = 0;
      for (const m of ranked) {
        const cost = JSON.stringify(m).length + 1;
        if (kept.length === 0 || spent + cost <= COMPACT_MISSIONS_BYTE_BUDGET) {
          kept.push(m);
          spent += cost;
        } else {
          overflow.push(m);
        }
      }
      if (kept.length > 0) response.missions = kept;
      if (overflow.length > 0) {
        const byStatus = {};
        for (const m of overflow) byStatus[String(m.status)] = (byStatus[String(m.status)] ?? 0) + 1;
        response.foldedMissions = {
          count: overflow.length,
          note: "Live-mission byte budget reached: these active/paused missions are listed by id only. Use mesh_mission_list or mesh_status verbose=true for their detail.",
          byStatus,
          missionIds: overflow.map((m) => String(m.id))
        };
      }
      if (historyFold) response.missionsHistory = historyFold;
    } else {
      const missions = (0, import_daemon_core4.getMeshStatusMissionSummaries)(mesh.id, { verbose: true });
      if (missions.length > 0) {
        response.missions = missions.map((mission) => {
          try {
            return { ...mission, stats: (0, import_daemon_core4.computeMeshMissionStats)(mesh.id, mission.id) };
          } catch {
            return mission;
          }
        });
      }
    }
  } catch {
  }
  try {
    const pendingEvents = await drainCoordinatorPendingEvents(ctx);
    const asyncRefineJobs = (0, import_daemon_core4.buildMeshAsyncRefineJobs)({
      meshId: mesh.id,
      ledgerEntries,
      pendingEvents
    });
    if (asyncRefineJobs.length > 0) {
      if (compact) {
        const summary = (0, import_daemon_core4.summarizeMeshAsyncRefineJobs)(asyncRefineJobs);
        if (summary.activeJobs.length > 0) response.asyncRefineJobs = summary.activeJobs;
        response.asyncRefineJobsSummary = {
          total: summary.total,
          byStatus: summary.byStatus,
          ...summary.staleTerminal > 0 ? { staleTerminal: summary.staleTerminal } : {}
        };
      } else {
        response.asyncRefineJobs = asyncRefineJobs;
      }
    }
    const magiActivity = (0, import_daemon_core4.buildMeshMagiActivity)({ meshId: mesh.id, ledgerEntries });
    if (magiActivity.length > 0) {
      const fold = (0, import_daemon_core4.summarizeMeshMagiActivity)(magiActivity);
      if (compact) {
        if (fold.groups.length > 0) response.magiActivity = fold.groups;
        response.magiActivitySummary = {
          total: fold.total,
          byStatus: fold.byStatus,
          ...fold.staleSynthesized > 0 ? { staleSynthesized: fold.staleSynthesized } : {}
        };
      } else {
        response.magiActivity = magiActivity;
      }
    }
    if (pendingEvents.length > 0) {
      response.pendingCoordinatorEvents = pendingEvents;
    }
    const protocolMetrics = summarizePendingEventProtocolMetrics(pendingEvents);
    if (protocolMetrics) {
      response.meshProtocolMetrics = protocolMetrics;
    }
    if (ctx.lastMeshProtocolV2Counters) {
      response.meshProtocolV2Counters = ctx.lastMeshProtocolV2Counters;
    }
  } catch {
  }
  return JSON.stringify(response, null, 2);
}
async function meshListNodes(ctx) {
  await refreshMeshFromDaemon(ctx);
  const { mesh } = ctx;
  return JSON.stringify({
    meshId: mesh.id,
    meshName: mesh.name,
    nodes: mesh.nodes.map((n) => ({
      nodeId: n.id,
      workspace: n.workspace,
      repoRoot: n.repoRoot,
      daemonId: readNodeDaemonId(n),
      machineId: readNodeMachineId(n),
      machine: buildNodeMachineIdentity(ctx, n),
      isLocalWorktree: n.isLocalWorktree,
      policy: n.policy,
      relatedRepos: readRelatedRepos(n),
      ...getNodeLaunchReadiness(n),
      ...buildNodeCapabilityExposure(n),
      userOverrides: n.userOverrides
    }))
  }, null, 2);
}

// src/tools/mesh-tools-queue.ts
function normalizeDedupMessage(message) {
  return (message || "").trim().replace(/\s+/g, " ").toLowerCase();
}
function findInFlightDuplicate(ctx, message, targetNodeId) {
  const fingerprint = normalizeDedupMessage(message);
  if (!fingerprint) return null;
  for (const task of (0, import_daemon_core4.getQueue)(ctx.mesh.id)) {
    if (task.status !== "pending" && task.status !== "assigned") continue;
    if (normalizeDedupMessage(task.message) !== fingerprint) continue;
    if (targetNodeId) {
      const existingTarget = task.targetNodeId || task.assignedNodeId;
      if (!existingTarget || !(0, import_daemon_core4.meshNodeIdMatches)({ id: existingTarget }, targetNodeId)) continue;
    }
    return { id: task.id, status: task.status, assignedNodeId: task.assignedNodeId, targetNodeId: task.targetNodeId };
  }
  return null;
}
async function meshEnqueueTask(ctx, args) {
  const message = readString(args.message);
  if (!message) {
    return JSON.stringify({
      success: false,
      code: "invalid_message",
      error: "mesh_enqueue_task requires a non-empty string `message`."
    });
  }
  const taskMode = readString(args.task_mode) || readString(args.taskMode);
  const readonly = args.readonly === true || args.read_only === true;
  const requiredTags = (0, import_daemon_core4.normalizeMeshCapabilityTags)(Array.isArray(args.requiredTags) ? args.requiredTags : args.required_tags);
  const dependsOn = Array.isArray(args.dependsOn) ? args.dependsOn : Array.isArray(args.depends_on) ? args.depends_on : void 0;
  const missionId = readString(args.missionId) || readString(args.mission_id) || void 0;
  const priority = (0, import_daemon_core4.normalizeMeshTaskPriority)(readString(args.priority)) || void 0;
  const model = readString(args.model) || void 0;
  const thinkingLevel = readString(args.thinkingLevel) || void 0;
  const difficulty = readString(args.difficulty) || void 0;
  const notBeforeRaw = args.notBefore !== void 0 ? args.notBefore : args.not_before;
  const notBefore = (0, import_daemon_core4.resolveNotBefore)(notBeforeRaw);
  const maxRetriesRaw = typeof args.maxRetries === "number" ? args.maxRetries : typeof args.max_retries === "number" ? args.max_retries : void 0;
  const maxRetries = typeof maxRetriesRaw === "number" && Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0 ? Math.floor(maxRetriesRaw) : void 0;
  const allowDuplicate = args.allowDuplicate === true || args.allow_duplicate === true;
  const blockDuplicate = args.blockDuplicate === true || args.block_duplicate === true;
  const explicitTargetRaw = readString(args.targetNodeId) || readString(args.target_node_id) || readString(args.targetNode) || readString(args.target_node) || void 0;
  const preferWorktree = args.preferWorktree === true || args.prefer_worktree === true;
  let targetNodeId;
  if (explicitTargetRaw) {
    const matched = ctx.mesh.nodes.find((n) => (0, import_daemon_core4.meshNodeIdMatches)(n, explicitTargetRaw));
    if (!matched) {
      return JSON.stringify({
        success: false,
        code: "target_node_not_found",
        error: `target node '${explicitTargetRaw}' is not a member of this mesh \u2014 refusing to enqueue an unpinned task (it could be claimed by any node, including a different machine). Use mesh_list_nodes to get a valid node id.`,
        targetNodeId: explicitTargetRaw,
        availableNodeIds: ctx.mesh.nodes.map((n) => n.id).filter(Boolean)
      });
    }
    targetNodeId = readString(matched.id) || explicitTargetRaw;
  } else if (preferWorktree) {
    targetNodeId = resolvePreferredWorktreeNodeId(ctx) || void 0;
  }
  const duplicateSuspect = allowDuplicate ? null : findInFlightDuplicate(ctx, message, targetNodeId);
  if (duplicateSuspect && blockDuplicate) {
    return JSON.stringify({
      success: false,
      code: "duplicate_suspect",
      error: `an in-flight task with the same message${targetNodeId ? " and target node" : ""} already exists (task '${duplicateSuspect.id}', status '${duplicateSuspect.status}'). Refusing because block_duplicate=true. Cancel it, wait for it, or re-enqueue with allow_duplicate=true.`,
      duplicateOf: { taskId: duplicateSuspect.id, status: duplicateSuspect.status, assignedNodeId: duplicateSuspect.assignedNodeId, targetNodeId: duplicateSuspect.targetNodeId }
    });
  }
  try {
    const task = (0, import_daemon_core4.enqueueTask)(ctx.mesh.id, message, {
      taskMode,
      ...readonly ? { readonly: true } : {},
      requiredTags,
      dependsOn,
      missionId,
      targetNodeId,
      ...priority ? { priority } : {},
      ...model ? { model } : {},
      ...thinkingLevel ? { thinkingLevel } : {},
      ...difficulty ? { difficulty } : {},
      ...notBefore ? { notBefore } : {},
      ...maxRetries !== void 0 ? { maxRetries } : {},
      ...ctx.coordinatorSessionId ? { sourceCoordinatorSessionId: ctx.coordinatorSessionId } : {}
    });
    const duplicateWarning = duplicateSuspect ? { duplicateSuspect: { taskId: duplicateSuspect.id, status: duplicateSuspect.status, assignedNodeId: duplicateSuspect.assignedNodeId, targetNodeId: duplicateSuspect.targetNodeId }, duplicateSuspectHint: "An in-flight task with the same message+target already exists. This new task was enqueued anyway (warn-only). Cancel one via mesh_queue_cancel if it is an accidental re-enqueue, or pass allow_duplicate=true to silence this, or block_duplicate=true to refuse next time." } : {};
    const enqueueEcho = {
      ...task.priority ? { priority: task.priority } : {},
      ...task.notBefore ? { notBefore: task.notBefore } : {},
      ...task.maxRetries !== void 0 ? { maxRetries: task.maxRetries } : {}
    };
    if (!(ctx.transport instanceof IpcTransport)) {
      const queueTrigger = await triggerMeshQueueAndReport(ctx);
      return JSON.stringify({
        success: true,
        source: "queue",
        taskId: task.id,
        status: task.status,
        taskMode: task.taskMode,
        requiredTags: task.requiredTags,
        ...enqueueEcho,
        ...targetNodeId ? { targetNodeId } : {},
        ...preferWorktree && !explicitTargetRaw && !targetNodeId ? { preferWorktreeNoOp: true } : {},
        ...duplicateWarning,
        queueTrigger,
        ...buildQueueTriggerGuidance(queueTrigger)
      });
    }
    {
      const queueTrigger = await triggerMeshQueueAndReport(ctx);
      const dependencyStatusById = new Map(
        (0, import_daemon_core4.getQueue)(ctx.mesh.id).map((t) => [t.id, t.status])
      );
      const eagerPushDeferred = !(0, import_daemon_core4.taskDependenciesSatisfied)(task, dependencyStatusById);
      const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
      const dispatchPromises = [];
      const eagerPushTargets = eagerPushDeferred ? [] : ctx.mesh.nodes;
      for (const node of eagerPushTargets) {
        const isLocalNode = isLocalControlPlaneNode(ctx, node);
        if (isLocalNode || !node.daemonId) continue;
        if (targetNodeId && node.id !== targetNodeId) continue;
        if (!(0, import_daemon_core4.nodeSatisfiesRequiredTags)(requiredTags, (0, import_daemon_core4.buildMeshNodeCapabilityTags)(node))) continue;
        dispatchPromises.push(
          ipcDispatchToRemoteAgent(ctx, node, {
            message,
            meshContext: {
              meshId: ctx.mesh.id,
              nodeId: node.id,
              taskId: task.id,
              ...coordinatorDaemonId ? { coordinatorDaemonId } : {}
            }
          }).then((result) => {
            if (result.success) {
              try {
                const providerType = result.providerType;
                const descriptor = summarizeTaskMessage(message);
                (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
                  kind: "task_dispatched",
                  nodeId: node.id,
                  sessionId: result.sessionId,
                  providerType,
                  payload: {
                    source: "queue",
                    via: "p2p_direct",
                    taskId: task.id,
                    message,
                    taskTitle: descriptor.taskTitle,
                    taskSummary: descriptor.taskSummary,
                    ...task.taskMode ? { taskMode: task.taskMode } : {},
                    ...providerType ? { providerType } : {},
                    targetSessionId: result.sessionId
                  }
                });
              } catch {
              }
            }
          }).catch((err) => {
            try {
              (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
                kind: "p2p_dispatch_failed",
                nodeId: node.id,
                payload: {
                  source: "queue",
                  via: "p2p_direct",
                  taskId: task.id,
                  error: err?.message || String(err),
                  dispatchFailedAt: (/* @__PURE__ */ new Date()).toISOString()
                }
              });
            } catch {
            }
          })
        );
      }
      Promise.all(dispatchPromises).catch(() => {
      });
      return JSON.stringify({
        success: true,
        source: "queue",
        taskId: task.id,
        status: task.status,
        taskMode: task.taskMode,
        requiredTags: task.requiredTags,
        ...enqueueEcho,
        ...targetNodeId ? { targetNodeId } : {},
        ...preferWorktree && !explicitTargetRaw && !targetNodeId ? { preferWorktreeNoOp: true } : {},
        ...eagerPushDeferred ? { eagerPushDeferred: true, eagerPushDeferredReason: "dependencies_unsatisfied" } : {},
        ...duplicateWarning,
        queueTrigger,
        ...buildQueueTriggerGuidance(queueTrigger)
      });
    }
  } catch (e) {
    const message2 = e?.message || String(e);
    if (message2.includes("live_debug_readonly_guardrail_violation")) {
      return JSON.stringify({ success: false, code: "live_debug_readonly_guardrail_violation", taskMode, error: message2 });
    }
    if (message2.includes("dependency_cycle_detected")) {
      return JSON.stringify({ success: false, code: "dependency_cycle_detected", dependsOn, error: message2 });
    }
    return JSON.stringify({ success: false, error: message2 });
  }
}
async function meshViewQueue(ctx, args) {
  const rateResult = (0, import_daemon_core4.recordMeshToolCall)({ meshId: ctx.mesh.id, tool: "mesh_view_queue" });
  const compact = args.verbose === true ? false : args.compact ?? true;
  try {
    await refreshMeshFromDaemon(ctx);
    const statusFilter = sanitizeQueueStatusFilter(args.status);
    const view = normalizeQueueViewMode(args.view);
    const rawQueue = (0, import_daemon_core4.getQueue)(ctx.mesh.id);
    const statusById = new Map(rawQueue.map((task) => [task.id, task.status]));
    const withDependencies = rawQueue.map((task) => {
      if (!Array.isArray(task.dependsOn) || task.dependsOn.length === 0) return task;
      const depState = (0, import_daemon_core4.describeTaskDependencyState)(task, statusById);
      return { ...task, ...depState };
    });
    const fullQueue = prioritizeActiveQueueRows(annotateQueueStaleness(withDependencies, ctx.mesh));
    const queue = filterQueueForView(fullQueue, view, statusFilter);
    const summary = buildQueueStatusSummary(fullQueue);
    const visibleSummary = buildQueueStatusSummary(queue);
    const maintenance = buildQueueMaintenanceReport(fullQueue);
    const liveNodes = await collectMeshViewQueueNodesWithLiveSessions(ctx);
    let ledgerEntries = (0, import_daemon_core4.readLedgerEntries)(ctx.mesh.id, { tail: 200 });
    let directDispatches = (0, import_daemon_core4.getActiveDirectDispatches)(ctx.mesh.id);
    const directReconciliation = await reconcileDirectDispatchesFromTranscriptEvidence(ctx, liveNodes, directDispatches, ledgerEntries);
    if (directReconciliation.reconciled > 0) {
      ledgerEntries = (0, import_daemon_core4.readLedgerEntries)(ctx.mesh.id, { tail: 200 });
      directDispatches = (0, import_daemon_core4.getActiveDirectDispatches)(ctx.mesh.id);
    }
    (0, import_daemon_core4.markStaleDirectDispatches)(ctx.mesh.id);
    directDispatches = (0, import_daemon_core4.getActiveDirectDispatches)(ctx.mesh.id);
    const activeWorkEvidence = (0, import_daemon_core4.buildMeshActiveWork)({
      meshId: ctx.mesh.id,
      queue: fullQueue,
      ledgerEntries,
      // Always pass MeshRuntimeStore records (may be empty). buildMeshActiveWork uses them for local
      // dispatches and falls through to ledger scan for remote P2P dispatches not in MeshRuntimeStore.
      directDispatches,
      nodes: liveNodes
    });
    const recentDispatchFailures = ledgerEntries.filter((e) => e.kind === "p2p_dispatch_failed").slice(-20).map((e) => ({
      nodeId: e.nodeId,
      taskId: e.payload?.taskId,
      error: e.payload?.error,
      via: e.payload?.via,
      failedAt: e.payload?.dispatchFailedAt || e.timestamp
    }));
    const staleAssignedTasks = maintenance.staleAssignedTasks || [];
    const requestedHistoricalRows = queue.some((task) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || "")));
    const pollingGuidance = buildActiveWorkPollingGuidance(activeWorkEvidence.summary);
    const activeOnlyQueue = queue.filter((task) => !HISTORICAL_QUEUE_STATUSES.has(String(task?.status || "")));
    const compactQueueResult = compact ? compactQueueRows(activeOnlyQueue) : { rows: activeOnlyQueue, omitted: 0 };
    const visibleQueue = compact ? compactQueueResult.rows : queue;
    const wantActiveQueueArray = view === "active" || statusFilter?.some((status) => ACTIVE_QUEUE_STATUSES.has(status));
    const wantHistoricalQueueArray = !compact && (view === "historical" || requestedHistoricalRows);
    const activeWorkResult = compact ? compactActiveWorkRecords(activeWorkEvidence.activeWork) : { records: activeWorkEvidence.activeWork, omitted: 0 };
    const staleDirectWorkSummary = (0, import_daemon_core4.buildCompactStaleDirectWorkSummary)(activeWorkEvidence.staleDirectWork, {
      note: activeWorkEvidence.staleDirectWorkNote,
      detailHint: "Full stale direct entries are omitted from mesh_view_queue in compact mode. Call mesh_view_queue with verbose=true, or inspect mesh_task_history for ledger detail."
    });
    const maintenanceForResponse = compact ? buildCompactQueueMaintenanceReport(maintenance) : maintenance;
    return JSON.stringify({
      success: true,
      payloadMode: compact ? "compact" : "full",
      sourceOfTruth: {
        kind: "mesh_work_queue_file",
        activeStatuses: ["pending", "assigned"],
        historicalStatuses: ["completed", "failed", "cancelled"],
        notes: "pending/assigned are active work; completed/failed/cancelled are historical ledger records and never stale assignments."
      },
      filter: {
        view,
        statuses: statusFilter,
        filtered: Boolean(statusFilter?.length) || view !== "all"
      },
      queue: visibleQueue,
      ...compact ? { historicalRowsOmitted: true, historicalRowsHint: "Completed/failed/cancelled rows are omitted in compact mode; see historicalCounts. Call mesh_view_queue with verbose=true (or view=historical, compact=false) for full rows." } : {},
      ...compact && compactQueueResult.omitted > 0 ? {
        activeRowsOmitted: compactQueueResult.omitted,
        activeRowsHint: `Showing the first ${COMPACT_MAX_ACTIVE_QUEUE_ROWS} active rows (per-row messages truncated). ${compactQueueResult.omitted} more active row(s) omitted \u2014 see activeCount/activeCounts for the complete total or use verbose=true.`
      } : {},
      activeWork: activeWorkResult.records,
      ...compact && activeWorkResult.omitted > 0 ? {
        activeWorkOmitted: activeWorkResult.omitted,
        activeWorkHint: `Showing the first ${COMPACT_MAX_ACTIVE_WORK_ROWS} active-work records (messages truncated). ${activeWorkResult.omitted} more omitted \u2014 see activeWorkSummary for complete counts or use verbose=true.`
      } : {},
      staleDirectWorkSummary,
      ...compact ? {} : { staleDirectWork: activeWorkEvidence.staleDirectWork },
      activeWorkSummary: activeWorkEvidence.summary,
      ...pollingGuidance ? { pollingGuidance } : {},
      ...rateResult.rateLimitExceeded ? { pollingRateAdvisory: { type: "rate_limit_exceeded", tool: "mesh_view_queue", callsInWindow: rateResult.callsInWindow, message: rateResult.advisory } } : {},
      summary,
      visibleSummary,
      activeCounts: summary.activeCounts,
      historicalCounts: summary.historicalCounts,
      visibleActiveCounts: visibleSummary.activeCounts,
      visibleHistoricalCounts: visibleSummary.historicalCounts,
      activeCount: summary.activeCount,
      historicalCount: summary.historicalCount,
      visibleActiveCount: visibleSummary.activeCount,
      visibleHistoricalCount: visibleSummary.historicalCount,
      staleAssignedTasks: compact ? staleAssignedTasks.slice(0, 10).map(compactQueueRow) : staleAssignedTasks,
      staleAssignedCount: maintenance.staleAssignedCount,
      queueMaintenance: maintenanceForResponse,
      cleanupDryRun: maintenanceForResponse,
      ...recentDispatchFailures.length > 0 ? {
        recentDispatchFailures,
        dispatchFailureCount: recentDispatchFailures.length,
        dispatchFailureNote: "Remote P2P dispatch attempts that failed. Affected tasks remain pending and may require mesh_queue_requeue if no idle session picks them up."
      } : {},
      ...wantActiveQueueArray && !compact ? {
        activeQueue: queue.filter((task) => ACTIVE_QUEUE_STATUSES.has(String(task?.status || "")))
      } : {},
      // In compact mode the `queue` field already holds exactly the slimmed+
      // capped active rows, so the separate activeQueue array would be a verbatim
      // duplicate (it doubled the payload). Point callers at `queue` instead.
      ...wantActiveQueueArray && compact ? { activeQueueHint: "In compact mode the active rows are in `queue` (already filtered to pending/assigned). Use verbose=true for the separate full activeQueue array." } : {},
      ...wantHistoricalQueueArray ? {
        historicalQueue: queue.filter((task) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || "")))
      } : {},
      // Back-compat alias for callers already reading the first hardening payload.
      staleAssignments: compact ? staleAssignedTasks.slice(0, 10).map(compactQueueRow) : staleAssignedTasks
    }, null, 2);
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}
async function meshQueueCancel(ctx, args) {
  try {
    const taskId = (args.task_id || args.taskId || "").trim();
    if (!taskId) return JSON.stringify({ success: false, error: "task_id required" });
    const preCancel = (0, import_daemon_core4.getQueue)(ctx.mesh.id).find((t) => t?.id === taskId);
    const wasAssigned = preCancel?.status === "assigned";
    const assignedSessionId = readString(preCancel?.assignedSessionId) || void 0;
    const assignedNodeId = readString(preCancel?.assignedNodeId) || void 0;
    const assignedProviderType = readString(preCancel?.assignedProviderType) || void 0;
    const task = (0, import_daemon_core4.cancelTask)(ctx.mesh.id, taskId, { reason: args.reason });
    if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
    ctx.transport.command("trigger_mesh_queue", { meshId: ctx.mesh.id }).catch(() => {
    });
    let workerStop = { attempted: false };
    if (wasAssigned && assignedSessionId && assignedSessionId !== ctx.coordinatorSessionId && assignedProviderType) {
      workerStop = { attempted: true, sessionId: assignedSessionId, nodeId: assignedNodeId };
      try {
        const stopResult = await ctx.transport.command("agent_command", {
          targetSessionId: assignedSessionId,
          cliType: assignedProviderType,
          agentType: assignedProviderType,
          action: "stop",
          ...assignedNodeId ? { meshContext: { meshId: ctx.mesh.id, nodeId: assignedNodeId, taskId } } : {}
        });
        const stopped = stopResult?.stopped === true || stopResult?.success === true;
        workerStop.stopped = stopped;
        if (!stopped) {
          workerStop.reason = readString(stopResult?.error) || "worker stop not confirmed";
        }
      } catch (e) {
        workerStop.stopped = false;
        workerStop.reason = e?.message || String(e);
      }
    } else if (wasAssigned && assignedSessionId === ctx.coordinatorSessionId) {
      workerStop = { attempted: false, reason: "assigned_session_is_coordinator_self \u2014 stop suppressed" };
    }
    return JSON.stringify({ success: true, task, workerStop }, null, 2);
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}
async function meshQueueRequeue(ctx, args) {
  try {
    const taskId = (args.task_id || args.taskId || "").trim();
    if (!taskId) return JSON.stringify({ success: false, error: "task_id required" });
    const targetNodeId = (args.target_node_id || args.targetNodeId || "").trim() || void 0;
    const targetSessionId = (args.target_session_id || args.targetSessionId || "").trim() || void 0;
    const keepTargetSession = args.keep_target_session === true || args.keepTargetSession === true;
    const clearTargetNode = args.clear_target_node === true || args.clearTargetNode === true;
    const clearTargetSession = targetSessionId ? false : !keepTargetSession;
    const force = args.force === true;
    if (ctx.transport instanceof IpcTransport) {
      const raw = await ctx.transport.command("requeue_mesh_queue_task", {
        meshId: ctx.mesh.id,
        taskId,
        reason: args.reason,
        ...targetNodeId ? { targetNodeId } : {},
        ...targetSessionId ? { targetSessionId } : {},
        clearTargetNode,
        clearTargetSession,
        force
      });
      const result = unwrapCommandPayload(raw) || {};
      if (result.success === false) {
        return JSON.stringify(result, null, 2);
      }
      const task2 = result.task;
      if (!task2) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
      if (task2.status === "failed" && task2.cancelReason?.startsWith("max_retries_exceeded")) {
        return JSON.stringify({
          success: false,
          code: "max_retries_exceeded",
          error: task2.cancelReason,
          task: task2,
          hint: "Use force=true to bypass the retry cap for explicit operator recovery."
        }, null, 2);
      }
      const triggerPreferredNodeId2 = targetNodeId || task2.targetNodeId || void 0;
      ctx.transport.command("trigger_mesh_queue", {
        meshId: ctx.mesh.id,
        ...triggerPreferredNodeId2 ? { preferredNodeId: triggerPreferredNodeId2 } : {}
      }).catch(() => {
      });
      return JSON.stringify({ success: true, task: task2 }, null, 2);
    }
    const task = (0, import_daemon_core4.requeueTask)(ctx.mesh.id, taskId, {
      reason: args.reason,
      targetNodeId,
      targetSessionId,
      clearTargetNode,
      clearTargetSession,
      force
    });
    if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
    if (task.status === "failed" && task.cancelReason?.startsWith("max_retries_exceeded")) {
      return JSON.stringify({
        success: false,
        code: "max_retries_exceeded",
        error: task.cancelReason,
        task,
        hint: "Use force=true to bypass the retry cap for explicit operator recovery."
      }, null, 2);
    }
    const triggerPreferredNodeId = targetNodeId || task.targetNodeId || void 0;
    ctx.transport.command("trigger_mesh_queue", {
      meshId: ctx.mesh.id,
      ...triggerPreferredNodeId ? { preferredNodeId: triggerPreferredNodeId } : {}
    }).catch(() => {
    });
    return JSON.stringify({ success: true, task }, null, 2);
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

// src/tools/mesh-tools-mission.ts
async function meshTaskHistory(ctx, args) {
  const { mesh } = ctx;
  const compact = args.verbose === true ? false : args.compact ?? true;
  const pendingEvents = await drainCoordinatorPendingEvents(ctx);
  const requestedTail = typeof args.tail === "number" && args.tail > 0 ? Math.floor(args.tail) : 20;
  const compactCap = requestedTail > 50 ? 20 : 30;
  const tail = compact ? Math.min(requestedTail, compactCap) : Math.min(requestedTail, 200);
  const kind = typeof args.kind === "string" && args.kind.trim() ? [args.kind.trim()] : void 0;
  const rawEntries = (0, import_daemon_core4.readLedgerEntries)(mesh.id, { tail, kind });
  const entries = compact ? rawEntries.map((e) => ({
    ...e,
    payload: e.payload ? slimLedgerPayload(e.payload) : e.payload
  })) : rawEntries;
  const summary = (0, import_daemon_core4.getLedgerSummary)(mesh.id);
  let taskStats;
  try {
    const taskIds = [...new Set(rawEntries.map((e) => typeof e.payload?.taskId === "string" ? e.payload.taskId : "").filter(Boolean))];
    if (taskIds.length > 0) {
      const stats = (0, import_daemon_core4.computeMeshTaskStats)(mesh.id, { taskIds });
      if (stats.length > 0) taskStats = stats;
    }
  } catch {
  }
  return JSON.stringify({
    meshId: mesh.id,
    payloadMode: compact ? "compact" : "full",
    entries,
    summary,
    ...taskStats ? { taskStats } : {},
    ...pendingEvents.length > 0 ? { pendingCoordinatorEvents: pendingEvents } : {}
  }, null, 2);
}
async function meshLedgerQuery(ctx, args) {
  const { mesh } = ctx;
  const pendingEvents = await drainCoordinatorPendingEvents(ctx);
  const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.split(",").map((k) => k.trim()).filter(Boolean) : void 0;
  const since = typeof args.since === "string" && args.since.trim() ? args.since.trim() : typeof args.since === "number" ? String(args.since) : void 0;
  const node = typeof args.node === "string" && args.node.trim() ? args.node.trim() : void 0;
  const requestedTail = typeof args.tail === "number" && args.tail > 0 ? Math.floor(args.tail) : 50;
  const tail = Math.min(requestedTail, 500);
  const entries = (0, import_daemon_core4.readLedgerEntries)(mesh.id, { tail, kind, since, node });
  const summary = (0, import_daemon_core4.getLedgerSummary)(mesh.id);
  return JSON.stringify({
    meshId: mesh.id,
    query: {
      ...kind ? { kind } : {},
      ...since ? { since } : {},
      ...node ? { node } : {},
      tail
    },
    count: entries.length,
    entries,
    summary,
    ...pendingEvents.length > 0 ? { pendingCoordinatorEvents: pendingEvents } : {}
  }, null, 2);
}
async function meshRecordNote(ctx, args) {
  const { mesh } = ctx;
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) {
    return JSON.stringify({ success: false, error: "text required" }, null, 2);
  }
  const category = args.category === "provider_quirk" || args.category === "pattern_to_avoid" || args.category === "recovery_lesson" ? args.category : void 0;
  const createdAt = (/* @__PURE__ */ new Date()).toISOString();
  const pinned = args.pinned === true ? true : void 0;
  let expiresAt;
  if (typeof args.expiresAt === "string" && !Number.isNaN(new Date(args.expiresAt).getTime())) {
    expiresAt = new Date(args.expiresAt).toISOString();
  } else if (typeof args.ttl_days === "number" && Number.isFinite(args.ttl_days) && args.ttl_days > 0) {
    expiresAt = new Date(new Date(createdAt).getTime() + args.ttl_days * 24 * 60 * 60 * 1e3).toISOString();
  }
  const supersedes = typeof args.supersedes === "string" && args.supersedes.trim() ? args.supersedes.trim() : void 0;
  const subjectKey = typeof args.subject_key === "string" && args.subject_key.trim() ? args.subject_key.trim() : void 0;
  const sourceCoordinator = ctx.coordinatorSessionId || ctx.localDaemonId || ctx.coordinatorHostname || void 0;
  const entry = (0, import_daemon_core4.appendLedgerEntry)(mesh.id, {
    kind: "coordinator_operating_note",
    ...sourceCoordinator ? { sessionId: sourceCoordinator } : {},
    payload: {
      text,
      ...category ? { category } : {},
      createdAt,
      ...sourceCoordinator ? { sourceCoordinator } : {},
      ...pinned ? { pinned } : {},
      ...expiresAt ? { expiresAt } : {},
      ...supersedes ? { supersedes } : {},
      ...subjectKey ? { subjectKey } : {}
    }
  });
  return JSON.stringify({
    success: true,
    meshId: mesh.id,
    noteId: entry.id,
    recorded: {
      text,
      category: category ?? null,
      createdAt,
      pinned: pinned ?? false,
      expiresAt: expiresAt ?? null,
      supersedes: supersedes ?? null,
      subjectKey: subjectKey ?? null
    },
    note: 'Recorded to the mesh ledger. Future coordinators on this mesh will see it under "## Operating Notes" at launch.'
  }, null, 2);
}
async function meshForgetNote(ctx, args) {
  const { mesh } = ctx;
  const noteId = readString(args.note_id) || readString(args.noteId) || void 0;
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!noteId && !text) {
    return JSON.stringify({ success: false, error: "note_id or text required" }, null, 2);
  }
  try {
    const { tombstone, matched } = (0, import_daemon_core4.tombstoneOperatingNote)(mesh.id, {
      ...noteId ? { noteId } : {},
      ...text ? { text } : {},
      ...typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason.trim() } : {}
    });
    return JSON.stringify({
      success: true,
      meshId: mesh.id,
      tombstoneId: tombstone.id,
      forgot: { noteId: noteId ?? null, text: text || null, matched },
      note: matched > 0 ? `Retracted ${matched} operating note(s). Future coordinators on this mesh will no longer see them at launch. History is preserved (append-only tombstone).` : "No live operating note matched \u2014 recorded a tombstone anyway so any matching note appended later is also suppressed."
    }, null, 2);
  } catch (e) {
    return JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2);
  }
}
async function meshReconcileLedger(ctx, args) {
  await refreshMeshFromDaemon(ctx);
  const requestedNodeIds = Array.isArray(args.node_ids) ? new Set(args.node_ids.map((id) => typeof id === "string" ? id.trim() : "").filter(Boolean)) : null;
  const nodes = ctx.mesh.nodes.filter((node) => !requestedNodeIds || requestedNodeIds.has(node.id));
  const replicas = [];
  const shouldImport = args.import_entries !== false;
  const queryArgs = {
    meshId: ctx.mesh.id,
    ...typeof args.limit === "number" ? { limit: args.limit } : {},
    ...typeof args.after_id === "string" && args.after_id.trim() ? { afterId: args.after_id.trim() } : {},
    ...typeof args.since === "string" && args.since.trim() ? { since: args.since.trim() } : {}
  };
  const reconcileNode = async (node) => {
    try {
      if (isLocalControlPlaneNode(ctx, node) || !node.daemonId) {
        const slice2 = (0, import_daemon_core4.readLedgerSliceFromStore)(ctx.mesh.id, queryArgs);
        return (0, import_daemon_core4.buildMeshLedgerReplicaEvidence)({
          nodeId: node.id,
          daemonId: node.daemonId,
          transport: "local",
          slice: slice2,
          status: "local"
        });
      }
      const result = await commandForNode(ctx, node, "get_mesh_ledger_slice", queryArgs, { statusProbe: true });
      const payload = unwrapCommandPayload(result);
      if (payload?.success === false) {
        throw new Error(payload.error || "remote get_mesh_ledger_slice failed");
      }
      const slice = payload?.slice ?? payload;
      if (slice?.protocol !== "adhdev.mesh.ledger.slice.v1" || !Array.isArray(slice.entries)) {
        throw new Error("remote daemon returned an invalid ledger slice payload");
      }
      const importResult = shouldImport ? (0, import_daemon_core4.appendRemoteLedgerEntries)(ctx.mesh.id, slice.entries) : { accepted: 0, skippedDuplicate: 0, rejectedInvalid: 0, entries: [] };
      if (shouldImport && importResult.accepted > 0) {
        (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
          kind: "ledger_replicated",
          nodeId: node.id,
          payload: {
            protocol: "adhdev.mesh.ledger.slice.v1",
            imported: importResult.accepted,
            skippedDuplicate: importResult.skippedDuplicate,
            rejectedInvalid: importResult.rejectedInvalid,
            nextAfterId: slice.cursor?.nextAfterId ?? null,
            via: "p2p_datachannel"
          }
        });
      }
      return (0, import_daemon_core4.buildMeshLedgerReplicaEvidence)({
        nodeId: node.id,
        daemonId: node.daemonId,
        transport: "p2p_datachannel",
        slice,
        importResult
      });
    } catch (e) {
      return (0, import_daemon_core4.buildMeshLedgerReplicaEvidence)({
        nodeId: node.id,
        daemonId: node.daemonId,
        transport: node.daemonId ? "p2p_datachannel" : "local",
        status: "failed",
        error: e?.message ?? String(e)
      });
    }
  };
  const settled = await Promise.allSettled(nodes.map(reconcileNode));
  settled.forEach((outcome, idx) => {
    if (outcome.status === "fulfilled") {
      replicas.push(outcome.value);
    } else {
      const node = nodes[idx];
      replicas.push((0, import_daemon_core4.buildMeshLedgerReplicaEvidence)({
        nodeId: node.id,
        daemonId: node.daemonId,
        transport: node.daemonId ? "p2p_datachannel" : "local",
        status: "failed",
        error: outcome.reason?.message ?? String(outcome.reason)
      }));
    }
  });
  const evidence = (0, import_daemon_core4.buildMeshLedgerReconciliationEvidence)(ctx.mesh.id, replicas);
  (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
    kind: "ledger_reconciled",
    payload: {
      protocol: evidence.protocol,
      sourceOfTruth: evidence.sourceOfTruth,
      totals: evidence.totals,
      convergence: evidence.convergence
    }
  });
  return JSON.stringify({ success: true, evidence }, null, 2);
}
async function meshRequeueHeldEvents(ctx, args) {
  const { mesh } = ctx;
  const raw = args.filter && typeof args.filter === "object" ? args.filter : void 0;
  const filter = raw ? {
    ...readString(raw.task_id) || readString(raw.taskId) ? { taskId: readString(raw.task_id) || readString(raw.taskId) } : {},
    ...readString(raw.node_id) || readString(raw.nodeId) ? { nodeId: readString(raw.node_id) || readString(raw.nodeId) } : {},
    ...readString(raw.event) ? { event: readString(raw.event) } : {},
    ...readString(raw.reason) ? { reason: readString(raw.reason) } : {},
    ...readString(raw.since) ? { since: readString(raw.since) } : {}
  } : void 0;
  const result = (0, import_daemon_core4.requeueHeldMeshCoordinatorEvents)(mesh.id, filter && Object.keys(filter).length > 0 ? filter : void 0);
  const note = result.matched === 0 ? "No recoverable held events matched. Nothing to requeue." : `${result.requeued} held event(s) restored to the pending queue` + (result.dedupSuppressed > 0 ? ` (${result.dedupSuppressed} collapsed onto still-live duplicates)` : "") + (result.alreadyRequeued > 0 ? `; ${result.alreadyRequeued} already recovered by a prior pass` : "") + (result.unrecoverable > 0 ? `; ${result.unrecoverable} had no restorable original event` : "") + ". A coordinator will drain them on its next poll.";
  return JSON.stringify({ success: true, ...result, note }, null, 2);
}
async function meshMissionUpsert(ctx, args) {
  const bulkIds = normalizeMissionIdList(args.mission_ids ?? args.missionIds);
  if (bulkIds.length > 0) {
    return meshMissionUpsertBulk(ctx, bulkIds, readString(args.status));
  }
  try {
    const title = readString(args.title);
    if (!title) {
      return JSON.stringify({
        success: false,
        code: "mission_title_required",
        error: "mission_title_required: single-mission upsert needs a non-empty title. For a bulk status transition pass mission_ids (array) + status instead."
      });
    }
    const mission = (0, import_daemon_core4.upsertMeshMission)(ctx.mesh.id, {
      id: readString(args.mission_id) || readString(args.missionId) || void 0,
      title,
      goal: typeof args.goal === "string" ? args.goal : void 0,
      status: readString(args.status) || void 0
    });
    return JSON.stringify({
      success: true,
      mission,
      nextAction: "Attach tasks with mesh_enqueue_task mission_id and depends_on. mesh_status shows live task aggregates for this mission."
    });
  } catch (e) {
    const message = e?.message || String(e);
    const code = message.includes("mission_title_required") ? "mission_title_required" : message.includes("invalid_mission_status") ? "invalid_mission_status" : void 0;
    return JSON.stringify({ success: false, ...code ? { code } : {}, error: message });
  }
}
function normalizeMissionIdList(value) {
  if (!Array.isArray(value)) return [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of value) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (id) seen.add(id);
  }
  return [...seen];
}
async function meshMissionUpsertBulk(ctx, missionIds, status) {
  if (!status) {
    return JSON.stringify({
      success: false,
      code: "bulk_status_required",
      error: "bulk mission upsert (mission_ids) requires a status to apply to every listed mission."
    });
  }
  const results = missionIds.map((id) => {
    try {
      const existing = (0, import_daemon_core4.getMeshMission)(ctx.mesh.id, id);
      if (!existing) return { id, ok: false, error: "mission_not_found" };
      const updated = (0, import_daemon_core4.upsertMeshMission)(ctx.mesh.id, {
        id,
        title: existing.title,
        status
      });
      return { id, ok: true, status: updated.status };
    } catch (e) {
      const message = e?.message || String(e);
      const code = message.includes("invalid_mission_status") ? "invalid_mission_status" : void 0;
      return { id, ok: false, error: message, ...code ? { code } : {} };
    }
  });
  const applied = results.filter((r) => r.ok).length;
  const failed = results.length - applied;
  return JSON.stringify({
    success: failed === 0,
    mode: "bulk",
    requestedStatus: status,
    applied,
    failed,
    results,
    nextAction: failed === 0 ? `Applied status '${status}' to ${applied} mission(s).` : `${applied} applied, ${failed} failed \u2014 see results[] for per-mission errors.`
  });
}
async function meshMissionList(ctx, args = {}) {
  try {
    const rawStatuses = Array.isArray(args.status) ? args.status : typeof args.status === "string" && args.status.trim() ? [args.status] : [];
    const invalid = rawStatuses.filter((s) => !import_daemon_core4.MESH_MISSION_STATUSES.includes(s));
    if (invalid.length > 0) {
      return JSON.stringify({
        success: false,
        code: "invalid_mission_status",
        error: `invalid status filter: ${invalid.join(", ")} (valid: ${import_daemon_core4.MESH_MISSION_STATUSES.join(", ")})`
      });
    }
    const statuses = rawStatuses.length > 0 ? rawStatuses : void 0;
    const includeMagi = (args.include_magi ?? args.includeMagi) === true;
    const verbose = args.verbose === true;
    const withStats = verbose || (args.include_stats ?? args.includeStats) === true;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : void 0;
    const result = (0, import_daemon_core4.listMeshMissionsForTool)(ctx.mesh.id, {
      statuses,
      verbose,
      includeMagi,
      withStats,
      limit
    });
    return JSON.stringify({
      success: true,
      count: result.missions.length,
      matched: result.matched,
      ...result.truncated ? { truncated: true, overflowIds: result.overflowIds } : {},
      ...statuses ? { statusFilter: statuses } : {},
      ...includeMagi ? { includeMagi: true } : { magiCompletedHidden: true },
      ...withStats ? {} : { statsHidden: true },
      missions: result.missions,
      ...result.historyFold ? { historyFold: result.historyFold } : {}
    }, null, 2);
  } catch (e) {
    return JSON.stringify({ success: false, error: e?.message || String(e) });
  }
}
async function meshReviewInbox(ctx, args = {}) {
  await refreshMeshFromDaemon(ctx);
  const meshId = (args.mesh_id ?? ctx.mesh.id).trim();
  const result = await commandForNode(ctx, ctx.mesh.nodes[0], "get_mesh_review_inbox", {
    meshId,
    inlineMesh: ctx.mesh
  }, { statusProbe: true });
  return JSON.stringify(result, null, 2);
}

// src/tools/mesh-tools-magi.ts
var import_daemon_core5 = require("@adhdev/daemon-core");
var MAGI_MAX_REPLICAS = 12;
var MAGI_MIN_TARGETS = 2;
var MAGI_CLUSTER_JACCARD = 0.4;
var MAGI_DEFAULT_WAIT_MS = 18e4;
var MAGI_MAX_WAIT_MS = 6e5;
var MAGI_POLL_INTERVAL_MS = 5e3;
var VALID_TASK_KINDS = ["claim_audit", "rca", "design", "freeform"];
var DEFAULT_TASK_KIND = "claim_audit";
function normalizeMagiTaskKind(raw) {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return VALID_TASK_KINDS.includes(s) ? s : DEFAULT_TASK_KIND;
}
var VALID_STANCES = /* @__PURE__ */ new Set(["support", "oppose", "uncertain"]);
function coerceClaim(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw;
  const claim = typeof r.claim === "string" ? r.claim.trim() : "";
  if (!claim) return null;
  const stance = typeof r.stance === "string" && VALID_STANCES.has(r.stance) ? r.stance : "uncertain";
  const evidence = Array.isArray(r.evidence) ? r.evidence.map((e) => typeof e === "string" ? e.trim() : "").filter(Boolean) : [];
  const confidence = typeof r.confidence === "number" && Number.isFinite(r.confidence) ? Math.min(1, Math.max(0, r.confidence)) : 0.5;
  return { claim, stance, evidence, confidence };
}
function coerceResponse(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw;
  if (!Array.isArray(r.claims)) return null;
  const claims = r.claims.map(coerceClaim).filter((c) => c !== null);
  const top_findings = Array.isArray(r.top_findings) ? r.top_findings.map((f) => typeof f === "string" ? f.trim() : "").filter(Boolean) : [];
  const open_questions = Array.isArray(r.open_questions) ? r.open_questions.map((q) => typeof q === "string" ? q.trim() : "").filter(Boolean) : [];
  if (claims.length === 0 && top_findings.length === 0) return null;
  return { claims, top_findings, open_questions };
}
function extractJsonObjectCandidates(text) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return candidates.sort((a, b) => b.length - a.length);
}
function parseMagiResponse(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const direct = (() => {
    try {
      return coerceResponse(JSON.parse(text));
    } catch {
      return null;
    }
  })();
  if (direct) return direct;
  for (const candidate of extractJsonObjectCandidates(text)) {
    if (!candidate.includes('"claims"') && !candidate.includes('"top_findings"')) continue;
    try {
      const parsed = coerceResponse(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
    }
  }
  return null;
}
function asStringArray(raw) {
  return Array.isArray(raw) ? raw.map((e) => typeof e === "string" ? e.trim() : "").filter(Boolean) : [];
}
function asConfidence(raw) {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
}
function asTrimmedString(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}
function coerceRcaResponse(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw;
  const rootCause = asTrimmedString(r.rootCause);
  const mechanism = asTrimmedString(r.mechanism);
  const failsAt = asTrimmedString(r.failsAt);
  const fixDirection = asTrimmedString(r.fixDirection);
  const evidence = asStringArray(r.evidence);
  const confidence = asConfidence(r.confidence);
  if (!rootCause && !mechanism && !failsAt && !fixDirection && evidence.length === 0) return null;
  const payload = { rootCause, failsAt, mechanism, evidence, fixDirection, confidence };
  if (!rootCause || !mechanism) return { payload, failReason: "missing_required_fields" };
  if (evidence.length === 0) return { payload, failReason: "empty_evidence" };
  return { payload };
}
function coerceDesignResponse(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw;
  const recommendation = asTrimmedString(r.recommendation);
  const rationale = asTrimmedString(r.rationale);
  const alternatives = asStringArray(r.alternatives);
  const tradeoffs = asStringArray(r.tradeoffs);
  const risks = asStringArray(r.risks);
  const evidence = asStringArray(r.evidence);
  const confidence = asConfidence(r.confidence);
  if (!recommendation && !rationale && alternatives.length === 0 && tradeoffs.length === 0 && risks.length === 0 && evidence.length === 0) return null;
  const payload = { recommendation, rationale, alternatives, tradeoffs, risks, evidence, confidence };
  if (!recommendation || !rationale) return { payload, failReason: "missing_required_fields" };
  if (evidence.length === 0) return { payload, failReason: "empty_evidence" };
  return { payload };
}
function rcaToCommonSchema(p) {
  return {
    claims: [{ claim: p.rootCause, stance: "support", evidence: p.evidence, confidence: p.confidence }],
    top_findings: [
      ...p.failsAt ? [`fails at: ${p.failsAt}`] : [],
      ...p.mechanism ? [`mechanism: ${p.mechanism}`] : [],
      ...p.fixDirection ? [`fix direction: ${p.fixDirection}`] : []
    ],
    open_questions: []
  };
}
function designToCommonSchema(p) {
  return {
    claims: [{ claim: p.recommendation, stance: "support", evidence: p.evidence, confidence: p.confidence }],
    top_findings: [
      ...p.rationale ? [`rationale: ${p.rationale}`] : [],
      ...p.alternatives.map((a) => `alternative: ${a}`),
      ...p.tradeoffs.map((t) => `tradeoff: ${t}`)
    ],
    open_questions: p.risks.map((r) => `risk: ${r}`)
  };
}
function firstJsonCandidate(text, coerce) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    const direct = coerce(JSON.parse(text));
    if (direct) return direct;
  } catch {
  }
  for (const candidate of extractJsonObjectCandidates(text)) {
    try {
      const parsed = coerce(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
    }
  }
  return null;
}
function parseMagiResponseForKind(text, kind) {
  if (kind === "freeform") {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) return { ok: false, failReason: "no_parseable_output" };
    const payload = { text: trimmed };
    return { ok: true, response: { claims: [], top_findings: [trimmed], open_questions: [] }, payload };
  }
  if (kind === "claim_audit") {
    const parsed = parseMagiResponse(text);
    if (!parsed) return { ok: false, failReason: "no_parseable_output" };
    const hasEvidence = parsed.claims.some((c) => c.evidence.length > 0) || parsed.top_findings.length > 0;
    if (!hasEvidence && parsed.claims.length > 0) return { ok: false, payload: parsed, failReason: "empty_evidence" };
    return { ok: true, response: parsed, payload: parsed };
  }
  if (kind === "rca") {
    const result2 = firstJsonCandidate(text, coerceRcaResponse);
    if (!result2) return { ok: false, failReason: "no_parseable_output" };
    if (result2.failReason) return { ok: false, payload: result2.payload, failReason: result2.failReason };
    return { ok: true, response: rcaToCommonSchema(result2.payload), payload: result2.payload };
  }
  const result = firstJsonCandidate(text, coerceDesignResponse);
  if (!result) return { ok: false, failReason: "no_parseable_output" };
  if (result.failReason) return { ok: false, payload: result.payload, failReason: result.failReason };
  return { ok: true, response: designToCommonSchema(result.payload), payload: result.payload };
}
function parseFirstMagiCandidateForKind(payload, kind, opts = {}) {
  const rawCandidates = collectMagiCandidateTexts(payload);
  let compactCandidates = [];
  try {
    compactCandidates = collectMagiCandidateTexts(
      compactChatPayload(payload, { sessionId: opts.sessionId ?? null })
    );
  } catch {
  }
  const seen = /* @__PURE__ */ new Set();
  let lastFail = { ok: false, failReason: "no_parseable_output" };
  for (const candidate of [...rawCandidates, ...compactCandidates]) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const result = parseMagiResponseForKind(candidate, kind);
    if (result.ok) return result;
    if (result.failReason !== "no_parseable_output") lastFail = result;
  }
  return lastFail;
}
var CLAIM_STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "to",
  "of",
  "in",
  "on",
  "at",
  "and",
  "or",
  "for",
  "this",
  "that",
  "it",
  "its",
  "as",
  "by",
  "with"
]);
function claimTokenSet(claim) {
  const tokens = claim.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !CLAIM_STOPWORDS.has(t));
  return new Set(tokens);
}
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
function isSpecificEvidence(ev) {
  return /[\w/.\\-]+:\d+/.test(ev) || /[\w-]+\.[a-z]{1,5}\b/i.test(ev) || /https?:\/\//i.test(ev);
}
function canonicalizeSpecificEvidence(ev) {
  const lower = ev.toLowerCase().replace(/\s+/g, " ").trim();
  const urlMatch = lower.match(/https?:\/\/([^\s)\]>"']+)/i);
  if (urlMatch) {
    const stripped = urlMatch[1].replace(/[#?].*$/, "").replace(/\/+$/, "");
    return `url:${stripped}`;
  }
  const fileLine = lower.match(/([\w./\\-]+):(\d+)/);
  if (fileLine) {
    const pathPart = fileLine[1].replace(/\\/g, "/");
    const basename = pathPart.split("/").filter(Boolean).pop() || pathPart;
    return `${basename}:${fileLine[2]}`;
  }
  return lower;
}
function normalizeEvidence(ev) {
  return isSpecificEvidence(ev) ? canonicalizeSpecificEvidence(ev) : ev.toLowerCase().replace(/\s+/g, " ").trim();
}
function magiReadIndicatesApprovalWedge(payload) {
  const p = payload;
  if (!p || typeof p !== "object") return false;
  const status = String(p.status ?? "");
  if (status === "waiting_approval" || status === "waiting_choice") return true;
  return !!p.activeModal;
}
function rankNeedsVerification(c) {
  switch (c.category) {
    case "contested":
      return 0;
    case "dissent":
      return 1;
    case "source_coupled":
      return 2;
    case "singleton":
      return 3;
    default:
      return 4;
  }
}
function synthesizeMagiResponses(responses, opts = {}) {
  const answered = responses.filter((r) => r.source.ok && r.response);
  const requireEvidence = opts.requireIndependentEvidence !== false;
  const clusters = [];
  for (const { source, response } of answered) {
    for (const claim of response.claims) {
      const tokens = claimTokenSet(claim.claim);
      const specific = new Set(claim.evidence.filter(isSpecificEvidence).map(normalizeEvidence));
      let best = null;
      let bestScore = 0;
      for (const cluster of clusters) {
        const evidenceMerge = [...specific].some((e) => cluster.specificEvidence.has(e));
        const score = evidenceMerge ? 1 : jaccard(tokens, cluster.tokens);
        if (score > bestScore) {
          bestScore = score;
          best = cluster;
        }
      }
      const member = {
        taskId: source.taskId,
        nodeId: source.nodeId,
        provider: source.provider,
        claim: claim.claim,
        stance: claim.stance,
        evidence: claim.evidence,
        confidence: claim.confidence
      };
      if (best && bestScore >= MAGI_CLUSTER_JACCARD) {
        best.members.push(member);
        for (const t of tokens) best.tokens.add(t);
        for (const e of specific) best.specificEvidence.add(e);
      } else {
        clusters.push({ members: [member], tokens: new Set(tokens), specificEvidence: new Set(specific) });
      }
    }
  }
  const built = clusters.map((cluster) => {
    const stance = { support: 0, oppose: 0, uncertain: 0 };
    for (const m of cluster.members) stance[m.stance]++;
    const distinctProviders2 = new Set(cluster.members.map((m) => m.provider).filter(Boolean)).size;
    const distinctNodes2 = new Set(cluster.members.map((m) => m.nodeId).filter(Boolean)).size;
    const distinctEvidence = new Set(cluster.members.flatMap((m) => m.evidence.map(normalizeEvidence)).filter(Boolean)).size;
    const distinctAgents = new Set(cluster.members.map((m) => m.taskId)).size;
    const maxConfidence = cluster.members.reduce((mx, m) => Math.max(mx, m.confidence), 0);
    const independenceScore = Math.max(distinctProviders2, 1) * Math.max(distinctNodes2, 1);
    const highIndependence = distinctProviders2 >= 2 && distinctNodes2 >= 2;
    const representative = cluster.members.map((m) => m.claim).sort((a, b) => b.length - a.length)[0];
    const reasons = [];
    let category;
    const hasSupport = stance.support > 0;
    const hasOppose = stance.oppose > 0;
    if (distinctAgents <= 1) {
      category = "singleton";
      reasons.push("raised by exactly one agent \u2014 cannot be cross-checked");
    } else if (hasSupport && hasOppose) {
      if (stance.support > stance.oppose) {
        category = "dissent";
        reasons.push(`minority opposition (${stance.oppose} oppose vs ${stance.support} support)`);
      } else {
        category = "contested";
        reasons.push(`stances split (${stance.support} support / ${stance.oppose} oppose / ${stance.uncertain} uncertain)`);
      }
    } else if (highIndependence) {
      category = "agreed";
    } else {
      category = "source_coupled";
      reasons.push(`apparent agreement but low independence (${distinctProviders2} provider(s) \xD7 ${distinctNodes2} machine(s))`);
    }
    let needsVerification2 = category === "contested" || category === "dissent" || category === "singleton" || category === "source_coupled";
    if (requireEvidence && distinctEvidence === 0 && maxConfidence >= 0.5 && category === "agreed") {
      needsVerification2 = true;
      reasons.push("no independent file:line/source evidence for a high-confidence claim");
    }
    return {
      claim: representative,
      category,
      members: cluster.members,
      stance,
      distinctProviders: distinctProviders2,
      distinctNodes: distinctNodes2,
      distinctEvidence,
      independenceScore,
      needsVerification: needsVerification2,
      reasons
    };
  });
  const needsVerification = built.filter((c) => c.needsVerification).sort((a, b) => rankNeedsVerification(a) - rankNeedsVerification(b) || a.independenceScore - b.independenceScore);
  const agreed = built.filter((c) => c.category === "agreed" && !c.needsVerification);
  const distinctProviders = new Set(answered.map((r) => r.source.provider).filter(Boolean)).size;
  const distinctNodes = new Set(answered.map((r) => r.source.nodeId).filter(Boolean)).size;
  const replicasExpected = opts.replicasExpected ?? responses.length;
  const replicasAnswered = answered.length;
  let independenceBanner = null;
  if (replicasAnswered >= 1 && (distinctProviders < 2 || distinctNodes < 2)) {
    const replicasMissing = Math.max(0, replicasExpected - replicasAnswered);
    const lossDominated = replicasMissing > 0 && replicasMissing >= replicasAnswered;
    if (lossDominated) {
      independenceBanner = `independence not achieved \u2014 only ${replicasAnswered} of ${replicasExpected} replica(s) answered (${replicasMissing} missing/dropped), collapsing the answering set to ${distinctProviders} provider(s) and ${distinctNodes} machine(s). This is a replica-loss/collection failure, not a low-diversity panel \u2014 inspect the dropped replicas (stale/unparseable/no-session) before re-reading the diversity spans. Agreements are routed to needs_verification.`;
    } else {
      independenceBanner = `independence not achieved \u2014 the answering replicas span ${distinctProviders} provider(s) and ${distinctNodes} machine(s); their agreements are source-coupled and routed to needs_verification.`;
    }
  }
  const openQuestions = [...new Set(answered.flatMap((r) => r.response.open_questions))];
  const gitSkew = computeMagiGitSkew(answered);
  return {
    replicasExpected,
    replicasAnswered,
    replicasMissing: Math.max(0, replicasExpected - replicasAnswered),
    distinctProviders,
    distinctNodes,
    independenceBanner,
    clusters: built,
    needsVerification,
    agreed,
    openQuestions,
    replicas: responses.map((r) => r.source),
    gitSkew
  };
}
function computeMagiGitSkew(answered) {
  const branches = /* @__PURE__ */ new Set();
  let divergentReplicas = 0;
  for (const { source } of answered) {
    const git = source.git;
    if (!git) continue;
    const branch = typeof git.branch === "string" && git.branch.trim() ? git.branch.trim() : void 0;
    if (branch) branches.add(branch);
    if ((git.ahead ?? 0) > 0 || (git.behind ?? 0) > 0) divergentReplicas++;
  }
  const branchList = [...branches].sort();
  const skewed = branchList.length > 1 || divergentReplicas > 0;
  return {
    skewed,
    distinctBranches: branchList.length,
    branches: branchList,
    divergentReplicas,
    ...skewed ? {
      note: branchList.length > 1 ? `replicas span ${branchList.length} branches (${branchList.join(", ")}) \u2014 evidence compares different code; treat agreement with caution.` : `${divergentReplicas} replica(s) diverge from upstream (ahead/behind) \u2014 not all replicas are on identical code.`
    } : {}
  };
}
function replicaCountFor(slot, defaultN, globalN) {
  const n = slot.n ?? defaultN ?? globalN ?? 1;
  return Math.max(1, Math.floor(n));
}
function nodeHeadCommit(node) {
  const h = node?.git?.headCommit;
  return typeof h === "string" && h.trim() ? h.trim() : void 0;
}
function nodeSubmoduleKey(node) {
  const subs = node?.git?.submodules;
  if (!Array.isArray(subs) || subs.length === 0) return void 0;
  const parts = subs.map((s) => {
    const path = typeof s?.path === "string" ? s.path.trim() : "";
    const commit = typeof s?.commit === "string" ? s.commit.trim() : "";
    return path && commit ? `${path}@${commit}` : void 0;
  }).filter((p) => !!p).sort((a, b) => a.localeCompare(b));
  return parts.length > 0 ? parts.join(",") : void 0;
}
function candidateMatchesReferenceBase(candidateHead, candidateSubKey, referenceCommit, referenceSubKey) {
  if (candidateHead !== referenceCommit) return false;
  if (referenceSubKey !== void 0 && candidateSubKey !== void 0) {
    return candidateSubKey === referenceSubKey;
  }
  return true;
}
function nodeGitDrift(node) {
  const git = node?.git;
  const behind = git && typeof git.behind === "number" && Number.isFinite(git.behind) ? Math.max(0, git.behind) : 0;
  const ahead = git && typeof git.ahead === "number" && Number.isFinite(git.ahead) ? Math.max(0, git.ahead) : 0;
  return { behind, ahead };
}
function nodeHasGitDrift(node) {
  const { behind, ahead } = nodeGitDrift(node);
  return behind > 0 || ahead > 0;
}
function buildMagiFanoutPlan(slots, nodes, opts = {}) {
  const cap = Math.max(1, Math.floor(opts.maxReplicas ?? MAGI_MAX_REPLICAS));
  const slotList = Array.isArray(slots) ? slots : [];
  const defaultN = opts.defaultN;
  const referenceCommit = typeof opts.referenceCommit === "string" && opts.referenceCommit.trim() ? opts.referenceCommit.trim() : void 0;
  const referenceSubmoduleKey = typeof opts.referenceSubmoduleKey === "string" && opts.referenceSubmoduleKey.trim() ? opts.referenceSubmoduleKey.trim() : void 0;
  const includeStale = opts.includeStale === true;
  const replicas = [];
  const unavailableSlots = [];
  const unhealthySlots = [];
  const slotResolutions = [];
  const targetKeys = /* @__PURE__ */ new Set();
  const providerSet = /* @__PURE__ */ new Set();
  const nodeTargetSet = /* @__PURE__ */ new Set();
  let totalRequested = 0;
  slotList.forEach((slot, slotIndex) => {
    const provider = slot.provider;
    const model = typeof slot.model === "string" && slot.model.trim() ? slot.model.trim() : void 0;
    const capabilityTags = (0, import_daemon_core4.normalizeMeshCapabilityTags)(slot.capabilityTags);
    const requiredTags = (0, import_daemon_core4.normalizeMeshCapabilityTags)([`provider=${provider}`, ...capabilityTags]);
    const count = replicaCountFor(slot, defaultN, opts.n);
    let targetNodeId;
    let candidateNodes = [];
    if (slot.nodeId) {
      const node = nodes.find((n) => (0, import_daemon_core4.meshNodeIdMatches)(n, slot.nodeId));
      if (node) {
        targetNodeId = node.id;
        candidateNodes = [node];
      }
    } else {
      candidateNodes = nodes.filter((n) => (0, import_daemon_core4.nodeSatisfiesRequiredTags)(requiredTags, (0, import_daemon_core4.buildMeshNodeCapabilityTags)(n)));
    }
    const available = candidateNodes.length > 0;
    if (!available) {
      unavailableSlots.push({
        slotIndex,
        provider,
        nodeId: slot.nodeId,
        capabilityTags,
        reason: slot.nodeId ? `pinned node '${slot.nodeId}' is not a member of this mesh` : `no mesh node satisfies required tags [${requiredTags.join(", ")}]`
      });
      slotResolutions.push({ slotIndex, provider, nodeId: slot.nodeId, capabilityTags, available: false, gitStale: false, unhealthy: false, excluded: true, reason: "unavailable" });
      return;
    }
    const launchableCandidates = candidateNodes.filter((n) => (0, import_daemon_core4.isMeshNodeHealthLaunchable)(n));
    if (launchableCandidates.length === 0) {
      const health = (0, import_daemon_core4.resolveEffectiveMeshNodeHealth)(candidateNodes[0]);
      unhealthySlots.push({
        slotIndex,
        provider,
        nodeId: targetNodeId ?? slot.nodeId,
        capabilityTags,
        health,
        reason: slot.nodeId ? `pinned node '${slot.nodeId}' health is '${health}' (not launch-ready)` : `no launch-ready node satisfies required tags [${requiredTags.join(", ")}] \u2014 all candidates are '${health}'`
      });
      slotResolutions.push({
        slotIndex,
        provider,
        nodeId: targetNodeId ?? slot.nodeId,
        capabilityTags,
        available: true,
        gitStale: false,
        unhealthy: true,
        health,
        excluded: true,
        reason: `node_unhealthy: ${health}`
      });
      return;
    }
    if (slot.nodeId && launchableCandidates[0]) targetNodeId = launchableCandidates[0].id;
    candidateNodes = launchableCandidates;
    let headCommit;
    let gitStale = false;
    if (referenceCommit) {
      const freshCandidate = candidateNodes.find((n) => {
        const h = nodeHeadCommit(n);
        if (!h) return true;
        return candidateMatchesReferenceBase(h, nodeSubmoduleKey(n), referenceCommit, referenceSubmoduleKey);
      });
      if (freshCandidate) {
        headCommit = nodeHeadCommit(freshCandidate);
        if (slot.nodeId) targetNodeId = freshCandidate.id;
        gitStale = false;
      } else {
        headCommit = nodeHeadCommit(candidateNodes[0]);
        gitStale = true;
      }
    } else {
      const freshCandidate = candidateNodes.find((n) => !nodeHasGitDrift(n));
      if (freshCandidate && candidateNodes.some(nodeHasGitDrift)) {
        headCommit = nodeHeadCommit(freshCandidate);
        if (slot.nodeId) targetNodeId = freshCandidate.id;
        gitStale = false;
      } else if (!freshCandidate && candidateNodes.some(nodeHasGitDrift)) {
        headCommit = nodeHeadCommit(candidateNodes[0]);
        gitStale = true;
      } else {
        headCommit = nodeHeadCommit(candidateNodes.find((n) => nodeHeadCommit(n)) ?? candidateNodes[0]);
      }
    }
    const resolution = {
      slotIndex,
      provider,
      nodeId: targetNodeId ?? slot.nodeId,
      capabilityTags,
      available: true,
      ...headCommit ? { headCommit } : {},
      gitStale,
      // Candidate pool was already narrowed to launch-ready nodes above, so an
      // included slot is health-launchable by construction.
      unhealthy: false,
      health: (0, import_daemon_core4.resolveEffectiveMeshNodeHealth)(candidateNodes[0]),
      excluded: false
    };
    if (gitStale && !includeStale) {
      resolution.excluded = true;
      if (referenceCommit) {
        resolution.reason = headCommit && headCommit === referenceCommit ? `git-stale: node HEAD ${headCommit} matches reference but submodule gitlink(s) differ from reference base` : `git-stale: node HEAD ${headCommit ?? "(unknown)"} differs from reference ${referenceCommit}`;
      } else {
        resolution.reason = `git-stale: node reports drift from its upstream (behind/ahead) and no coordinator reference commit is known`;
      }
      slotResolutions.push(resolution);
      return;
    }
    totalRequested += count;
    const targetKey = targetNodeId ? `node:${targetNodeId}` : `tags:${[...requiredTags].sort().join(",")}`;
    targetKeys.add(`${targetKey}|${provider}`);
    providerSet.add(provider);
    nodeTargetSet.add(targetKey);
    slotResolutions.push(resolution);
    for (let i = 0; i < count; i++) {
      replicas.push({ slotIndex, provider, targetNodeId, capabilityTags, requiredTags, ...model ? { model } : {} });
    }
  });
  const droppedReplicas = Math.max(0, replicas.length - cap);
  const capped = droppedReplicas > 0 ? replicas.slice(0, cap) : replicas;
  const distinctProviders = providerSet.size;
  const distinctNodeTargets = nodeTargetSet.size;
  const staleSlots = slotResolutions.filter((m) => m.gitStale && m.excluded);
  const includedStaleSlots = slotResolutions.filter((m) => m.gitStale && !m.excluded);
  return {
    replicas: capped,
    totalRequested,
    totalAfterCap: capped.length,
    droppedReplicas,
    distinctTargets: targetKeys.size,
    distinctProviders,
    distinctNodeTargets,
    enoughTargets: targetKeys.size >= MAGI_MIN_TARGETS,
    coupled: distinctProviders < 2 || distinctNodeTargets < 2,
    unavailableSlots,
    unhealthySlots,
    ...referenceCommit ? { referenceCommit } : {},
    slotResolutions,
    staleSlots,
    includedStaleSlots
  };
}
function resolveMagiReferenceCommit(ctx) {
  const node = resolveCoordinatorNode(ctx);
  return nodeHeadCommit(node);
}
function resolveMagiReferenceSubmoduleKey(ctx) {
  const node = resolveCoordinatorNode(ctx);
  return nodeSubmoduleKey(node);
}
var MAGI_CLAIM_AUDIT_CONTRACT = `When done, respond with ONLY a single JSON object (no prose, no code fence) matching this exact schema:
{
  "claims": [ { "claim": "string", "stance": "support | oppose | uncertain", "evidence": ["file:line or external source"], "confidence": 0.0 } ],
  "top_findings": ["string"],
  "open_questions": ["string"]
}
Each claim MUST carry concrete evidence (file:line or a cited source) \u2014 unevidenced claims are flagged for re-verification. "stance" is your stance toward the claim being true. Do not invent agreement; report uncertainty honestly.`;
var MAGI_RCA_CONTRACT = `When done, respond with ONLY a single JSON object (no prose, no code fence) matching this exact schema:
{
  "rootCause": "string \u2014 the single underlying root cause",
  "failsAt": "file:line \u2014 the precise location the failure manifests",
  "mechanism": "string \u2014 how the root cause produces the observed symptom",
  "evidence": ["file:line or external source"],
  "fixDirection": "string \u2014 the direction a fix should take (do NOT write the fix)",
  "confidence": 0.0
}
"rootCause" and "mechanism" are REQUIRED. "evidence" MUST be non-empty (concrete file:line or cited source) \u2014 an empty evidence array is rejected and re-requested. Report uncertainty honestly.`;
var MAGI_DESIGN_CONTRACT = `When done, respond with ONLY a single JSON object (no prose, no code fence) matching this exact schema:
{
  "recommendation": "string \u2014 the recommended approach",
  "rationale": "string \u2014 why this approach",
  "alternatives": ["string \u2014 approaches considered and not chosen"],
  "tradeoffs": ["string"],
  "risks": ["string"],
  "evidence": ["file:line or external source backing the recommendation"],
  "confidence": 0.0
}
"recommendation" and "rationale" are REQUIRED. "evidence" MUST be non-empty \u2014 an empty evidence array is rejected and re-requested. Report uncertainty honestly.`;
var MAGI_FREEFORM_CONTRACT = `Answer the question in natural language. No JSON schema is required for this task \u2014 write your analysis directly. (Note: a freeform answer is cross-verified only weakly, because it is unstructured.)`;
function magiOutputContractFor(kind) {
  switch (kind) {
    case "rca":
      return MAGI_RCA_CONTRACT;
    case "design":
      return MAGI_DESIGN_CONTRACT;
    case "freeform":
      return MAGI_FREEFORM_CONTRACT;
    case "claim_audit":
    default:
      return MAGI_CLAIM_AUDIT_CONTRACT;
  }
}
function detectQuestionOutputSchemaConflict(question) {
  const q = typeof question === "string" ? question : "";
  if (!q.trim()) return null;
  const lower = q.toLowerCase();
  const signals = [
    "respond with only",
    "respond with a single json",
    "single json object",
    "output format",
    "output schema",
    "reply with only",
    '"claims"',
    '"top_findings"',
    "matching this exact schema"
  ];
  const hit = signals.find((s) => lower.includes(s));
  if (!hit) return null;
  return `The question text appears to embed an output-format schema (matched "${hit}"). MAGI already injects exactly one output contract for the selected task_kind, so a second schema in the question collides with it and replicas may fuse the two into unparseable output. Move any output-format instructions OUT of the question \u2014 describe only WHAT to investigate.`;
}
function buildMagiTaskPrompt(args) {
  const kind = args.taskKind ?? DEFAULT_TASK_KIND;
  const parts = [];
  parts.push("You are one independent member of a multi-agent cross-verification quorum (MAGI). Several other agents on different machines/providers are answering the SAME question independently; your job is a rigorous, READ-ONLY investigation. Do NOT write, edit, commit, or push anything.");
  parts.push(`Task kind: ${kind}.`);
  if (args.mode) parts.push(`Investigation mode: ${args.mode}.`);
  parts.push(`
## Question
${args.question.trim()}`);
  if (args.target && args.target.trim()) parts.push(`
## Target to investigate
${args.target.trim()}`);
  if (Array.isArray(args.artifacts) && args.artifacts.length > 0) {
    parts.push(`
## Artifacts
${args.artifacts.map((a) => String(a)).join("\n\n---\n\n")}`);
  }
  parts.push(`
## Output
${magiOutputContractFor(kind)}`);
  return parts.join("\n");
}
function collectMagiCandidateTexts(payload) {
  if (!payload || typeof payload !== "object") return [];
  const p = payload;
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (value) => {
    const text = typeof value === "string" ? value : "";
    const trimmed = text.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(text);
  };
  const messages = Array.isArray(p.messages) ? p.messages : Array.isArray(p.chat) ? p.chat : Array.isArray(p.transcript) ? p.transcript : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.role || msg.from || "").toLowerCase();
    if (role && role !== "assistant" && role !== "agent" && role !== "model") continue;
    const content = msg.content ?? msg.text ?? msg.message;
    if (typeof content === "string") push(content);
    else if (Array.isArray(content)) {
      const joined = content.map((part) => typeof part === "string" ? part : part && typeof part === "object" && typeof part.text === "string" ? part.text : "").join("");
      push(joined);
    }
    push(msg.summary);
    push(msg.summaryMetadata?.summary);
  }
  push(p.summary);
  push(p.finalSummary);
  push(p.lastMessagePreview);
  push(p.text);
  return out;
}
function replicaCompletionIsWeak(meshId, taskId) {
  try {
    const entries = (0, import_daemon_core4.readLedgerEntries)(meshId, { kind: ["task_completed"], tail: 200 });
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      const payload = entry?.payload && typeof entry.payload === "object" ? entry.payload : void 0;
      const entryTaskId = readString(payload?.taskId) || readString(entry?.taskId);
      if (!entryTaskId || entryTaskId !== taskId) continue;
      if ((0, import_daemon_core4.isWeakCompletionEvidence)(payload)) return true;
      const diag = payload?.completionDiagnostic;
      if (diag && typeof diag === "object" && !Array.isArray(diag) && readString(diag.reason) === "short_generating_suppressed") {
        return true;
      }
      return false;
    }
  } catch {
  }
  return false;
}
async function meshMagiKindPanelSet(ctx, args) {
  const kind = readString(args.task_kind) || readString(args.kind);
  if (!kind) return JSON.stringify({ success: false, error: "task_kind required" });
  const write = args.write === true;
  try {
    const current = (0, import_daemon_core4.getMagiKindPanel)(kind) ?? [];
    if (!write) {
      const preview = (0, import_daemon_core4.normalizeMagiSlots)(args.slots);
      return JSON.stringify({
        success: true,
        dryRun: true,
        taskKind: kind,
        scope: "machine_local",
        replacement: true,
        currentSlots: current,
        slots: preview,
        note: "Dry-run only \u2014 no file written. This is a WHOLESALE replacement of the kind's slot list (machine-local ~/.adhdev/meshes.json); the currentSlots would be fully replaced. Re-run with write=true after explicit user approval."
      }, null, 2);
    }
    const slots = (0, import_daemon_core4.setMagiKindPanel)(kind, args.slots);
    return JSON.stringify({
      success: true,
      written: true,
      taskKind: kind,
      scope: "machine_local",
      replacement: true,
      previousSlots: current,
      slots,
      nextAction: "Verify with mesh_magi_kind_panel_list, then mesh_magi_review({ task_kind }) resolves this binding."
    }, null, 2);
  } catch (e) {
    const message = e?.message || String(e);
    const code = message.includes("invalid_magi_kind_panel") ? "invalid_magi_kind_panel" : void 0;
    return JSON.stringify({ success: false, ...code ? { code } : {}, error: message });
  }
}
async function meshMagiKindPanelList(ctx, args = {}) {
  const only = readString(args.task_kind) || readString(args.kind);
  const all = (0, import_daemon_core4.listMagiKindPanels)();
  if (only) {
    const slots = (0, import_daemon_core4.getMagiKindPanel)(only);
    if (slots === void 0) {
      return JSON.stringify({
        success: false,
        code: "magi_kind_not_configured",
        error: `task_kind '${only}' has no configured kind-panel binding`,
        configuredKinds: Object.keys(all)
      }, null, 2);
    }
    return JSON.stringify({ success: true, scope: "machine_local", taskKind: only, slots }, null, 2);
  }
  return JSON.stringify({ success: true, scope: "machine_local", kindPanels: all, configuredKinds: Object.keys(all) }, null, 2);
}
async function meshMagiReview(ctx, args) {
  const question = readString(args.question);
  if (!question) return JSON.stringify({ success: false, error: "question required" });
  const explicitTaskKind = args.task_kind ?? args.taskKind;
  if (typeof explicitTaskKind !== "string" || !VALID_TASK_KINDS.includes(explicitTaskKind.trim().toLowerCase())) {
    return JSON.stringify({
      success: false,
      code: "task_kind_required",
      error: "task_kind is required and selects both the output schema and the configured kind-panel slots. Pass one of: claim_audit / rca / design / freeform.",
      validTaskKinds: VALID_TASK_KINDS,
      hint: "Configure the kind-panel slots for this task_kind in mesh settings (magiKindPanels) or via mesh_magi_kind_panel_set, then call mesh_magi_review({ question, task_kind })."
    }, null, 2);
  }
  const questionSchemaWarning = detectQuestionOutputSchemaConflict(question);
  await refreshMeshFromDaemon(ctx);
  const referenceCommit = resolveMagiReferenceCommit(ctx);
  const referenceSubmoduleKey = resolveMagiReferenceSubmoduleKey(ctx);
  const taskKind = normalizeMagiTaskKind(explicitTaskKind);
  const panelName = `(kind:${taskKind})`;
  const slots = (0, import_daemon_core4.getMagiKindPanel)(taskKind);
  if (!slots || slots.length === 0) {
    return JSON.stringify({
      success: false,
      code: "magi_kind_not_configured",
      error: `No panel slots are configured for this task_kind in mesh settings. Add at least one (machine + provider + model) slot in settings \u2014 task_kind '${taskKind}' has no configured kind-panel.`,
      taskKind,
      configuredKinds: Object.keys((0, import_daemon_core4.listMagiKindPanels)()),
      hint: "Configure this kind in mesh settings (MagiKindPanelEditor), or set it with mesh_magi_kind_panel_set, then retry."
    }, null, 2);
  }
  let planSlots;
  try {
    planSlots = (0, import_daemon_core4.normalizeMagiSlots)(slots);
  } catch (e) {
    return JSON.stringify({
      success: false,
      code: "invalid_magi_kind_panel",
      error: `configured kind-panel for '${taskKind}' is invalid: ${e?.message || String(e)}`,
      taskKind,
      hint: "Re-save the kind-panel slots in mesh settings \u2014 each slot needs a provider; nodeId / model are optional."
    }, null, 2);
  }
  const includeStale = (args.include_stale ?? args.includeStale) === true;
  const plan = buildMagiFanoutPlan(planSlots, ctx.mesh.nodes, { n: args.n, referenceCommit, referenceSubmoduleKey, includeStale });
  if (!plan.enoughTargets) {
    const droppedByStale = plan.staleSlots.length > 0;
    const droppedByHealth = plan.unhealthySlots.length > 0;
    const code = droppedByHealth ? "magi_insufficient_targets_after_health_exclusion" : droppedByStale ? "magi_insufficient_targets_after_stale_exclusion" : "magi_insufficient_targets";
    const error = droppedByHealth ? `Kind-panel '${panelName}' resolves to only ${plan.distinctTargets} independent (node, provider) target(s) AFTER excluding ${plan.unhealthySlots.length} unhealthy slot(s) (${plan.unhealthySlots.map((s) => `${s.nodeId ?? `[${s.provider}]`}=${s.health}`).join(", ")}); MAGI requires \u2265${MAGI_MIN_TARGETS} and never silently degrades to N=1. A degraded node would leave its replica parked in 'pending' forever, so it is excluded rather than dispatched.` : droppedByStale ? `Kind-panel '${panelName}' resolves to only ${plan.distinctTargets} independent (node, provider) target(s) AFTER excluding ${plan.staleSlots.length} git-stale slot(s) (HEAD differs from reference ${referenceCommit ?? "(unknown)"}); MAGI requires \u2265${MAGI_MIN_TARGETS} and never silently degrades to N=1.` : `Kind-panel '${panelName}' resolves to ${plan.distinctTargets} available (node, provider) target(s); MAGI requires \u2265${MAGI_MIN_TARGETS} and never silently degrades to N=1.`;
    const hint = droppedByHealth ? "Bring the degraded node(s) back online (check P2P/git health via mesh_status), or configure additional healthy (machine + provider) slots for this kind-panel, then retry." : droppedByStale ? "Bring the stale node(s) to the reference commit, or pass include_stale=true to mesh_magi_review to fan out to them anyway (results will be git-skewed)." : "Fix the kind-panel slots with mesh_magi_kind_panel_set (or in mesh settings), and use mesh_status to confirm nodes/providers are online.";
    return JSON.stringify({
      success: false,
      code,
      error,
      ...referenceCommit ? { referenceCommit } : {},
      unavailableSlots: plan.unavailableSlots,
      ...droppedByHealth ? { unhealthySlots: plan.unhealthySlots } : {},
      ...droppedByStale ? { staleSlots: plan.staleSlots } : {},
      hint
    }, null, 2);
  }
  const mode = readString(args.mode);
  const requireIndependentEvidence = (args.require_independent_evidence ?? args.requireIndependentEvidence) !== false;
  const wait = args.wait !== false;
  const waitTimeoutMs = Math.min(MAGI_MAX_WAIT_MS, Math.max(MAGI_POLL_INTERVAL_MS, Number(args.wait_timeout_ms ?? args.waitTimeoutMs) || MAGI_DEFAULT_WAIT_MS));
  const consensusGroupId = `magi_${(0, import_node_crypto.randomUUID)().replace(/-/g, "")}`;
  const titleQ = question.length > 80 ? `${question.slice(0, 77)}...` : question;
  const mission = (0, import_daemon_core4.upsertMeshMission)(ctx.mesh.id, {
    title: `MAGI: ${titleQ}`,
    goal: `Cross-verify (read-only) across panel '${panelName}': ${question}${args.target ? `
Target: ${args.target}` : ""}`,
    // Tag provenance so the completed inline mission is bounded out of the default
    // mesh_mission_list (these accumulate one-per-run and auto-close on collection).
    source: "magi"
  });
  const prompt = buildMagiTaskPrompt({ question, target: args.target, artifacts: args.artifacts, mode: mode || void 0, taskKind });
  const replicaRecords = [];
  for (const replica of plan.replicas) {
    try {
      const task = (0, import_daemon_core4.enqueueTask)(ctx.mesh.id, prompt, {
        readonly: true,
        taskMode: "live_debug_readonly",
        requiredTags: replica.requiredTags,
        missionId: mission.id,
        consensusGroupId,
        ...replica.targetNodeId ? { targetNodeId: replica.targetNodeId } : {},
        ...replica.model ? { model: replica.model } : {},
        ...ctx.coordinatorSessionId ? { sourceCoordinatorSessionId: ctx.coordinatorSessionId } : {}
      });
      replicaRecords.push({ taskId: task.id, provider: replica.provider, targetNodeId: replica.targetNodeId, requiredTags: replica.requiredTags });
    } catch (e) {
      try {
        (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
          kind: "magi_replica_enqueue_failed",
          payload: { consensusGroupId, missionId: mission.id, provider: replica.provider, error: e?.message || String(e) }
        });
      } catch {
      }
    }
  }
  if (replicaRecords.length < MAGI_MIN_TARGETS) {
    return JSON.stringify({ success: false, code: "magi_enqueue_failed", error: "fewer than 2 replicas enqueued successfully", consensusGroupId, missionId: mission.id });
  }
  persistMagiDispatched(ctx, {
    consensusGroupId,
    missionId: mission.id,
    panel: panelName,
    question,
    replicaCount: replicaRecords.length,
    taskKind
  });
  const queueTrigger = await triggerMeshQueueAndReport(ctx);
  const baseResult = {
    success: true,
    consensusGroupId,
    missionId: mission.id,
    panel: panelName,
    taskKind,
    ...questionSchemaWarning ? { questionSchemaWarning } : {},
    question,
    replicaCount: replicaRecords.length,
    replicas: replicaRecords.map((r) => ({ taskId: r.taskId, provider: r.provider, targetNodeId: r.targetNodeId })),
    independence: {
      distinctProviders: plan.distinctProviders,
      distinctMachines: plan.distinctNodeTargets,
      coupled: plan.coupled,
      ...plan.coupled ? { banner: "Panel collapsed to a single provider or machine \u2014 agreements will be flagged source-coupled." } : {}
    },
    ...plan.referenceCommit ? { referenceCommit: plan.referenceCommit } : {},
    // Surface health-gate exclusions even when quorum still held: these replicas were
    // NEVER dispatched (their node is degraded/offline and would park in `pending`
    // forever), so the coordinator/collect must know not to wait on them.
    ...plan.unhealthySlots.length > 0 ? {
      excludedSlots: plan.unhealthySlots,
      healthExcludedWarning: `${plan.unhealthySlots.length} slot(s) were excluded from this fan-out because their node health is not launch-ready (${plan.unhealthySlots.map((s) => `${s.nodeId ?? `[${s.provider}]`}=${s.health}`).join(", ")}) \u2014 those replicas were NOT dispatched. Bring the node(s) online (mesh_status) to include them.`
    } : {},
    // Surface git-stale handling: which slots were excluded (default), or included
    // despite being stale (include_stale=true) — the latter makes results git-skewed.
    ...plan.staleSlots.length > 0 ? {
      gitStaleExcluded: plan.staleSlots,
      gitStaleWarning: `${plan.staleSlots.length} git-stale slot(s) (HEAD \u2260 reference ${plan.referenceCommit ?? "(unknown)"}) were excluded from this fan-out; pass include_stale=true to include them.`
    } : {},
    ...plan.includedStaleSlots.length > 0 ? {
      gitStaleIncluded: plan.includedStaleSlots,
      gitStaleWarning: `include_stale=true: ${plan.includedStaleSlots.length} git-stale slot(s) (HEAD \u2260 reference ${plan.referenceCommit ?? "(unknown)"}) were INCLUDED \u2014 their evidence compares different code, so synthesis will be git-skewed.`
    } : {},
    ...plan.droppedReplicas > 0 ? {
      cappedReplicas: plan.droppedReplicas,
      cappedNote: `Total replicas requested (${plan.totalRequested}) exceeded the guard cap (${MAGI_MAX_REPLICAS}); ${plan.droppedReplicas} dropped (logged, not silent).`
    } : {},
    costNote: `MAGI dispatched ${replicaRecords.length} read-only sessions \u2014 token spend scales with the replica count.`,
    queueTrigger
  };
  if (!wait) {
    return JSON.stringify({
      ...baseResult,
      waited: false,
      pollWith: { tool: "mesh_magi_collect", args: { consensus_group_id: consensusGroupId } },
      nextAction: `Replicas are running. Drive off mission completion / pendingCoordinatorEvents rather than polling chat, then collect + synthesize once with mesh_magi_collect({ consensus_group_id: '${consensusGroupId}' }).`
    }, null, 2);
  }
  const collected = await collectMagiResponses(ctx, {
    replicaTaskIds: replicaRecords.map((r) => r.taskId),
    timeoutMs: waitTimeoutMs,
    taskKind
  });
  const synthesis = synthesizeMagiResponses(collected.responses, {
    replicasExpected: replicaRecords.length,
    requireIndependentEvidence
  });
  const synthesisNoRaw = stripRawAnswers(synthesis);
  const freeformBanner = taskKind === "freeform" ? "task_kind=freeform: answers are unstructured natural language; cross-verification is WEAK (no claim clustering / independence scoring). Treat the collected answers as parallel opinions, not a verified consensus." : null;
  persistMagiSynthesis(ctx, {
    consensusGroupId,
    missionId: mission.id,
    panel: panelName,
    question,
    staleReplicas: collected.staleCount,
    synthesis: synthesisNoRaw
  });
  closeMagiMissionIfTerminal(ctx, mission.id, collected.terminal);
  const cleanupMode = resolveMagiAutoCleanupMode(ctx, args.auto_cleanup ?? args.autoCleanup);
  const cleanupReplicaTasks = findMagiReplicaTasks((0, import_daemon_core4.getQueue)(ctx.mesh.id), consensusGroupId);
  const cleanup = await cleanupMagiAutoLaunchedSessions(ctx, {
    replicaTasks: cleanupReplicaTasks,
    terminal: collected.terminal,
    mode: cleanupMode
  });
  return JSON.stringify({
    ...baseResult,
    waited: true,
    ...cleanup ? { sessionCleanup: { mode: cleanupMode, cleanedSessionCount: cleanup.cleanedSessionCount, perNode: cleanup.perNode } } : {},
    collection: {
      terminal: collected.terminal,
      timedOut: collected.timedOut,
      answered: synthesis.replicasAnswered,
      missing: synthesis.replicasMissing,
      staleReplicas: collected.staleCount,
      ...collected.staleCount > 0 ? { staleNote: `${collected.staleCount} replica(s) were detected STALE \u2014 assigned to a node/session no longer present in the live mesh; collection stopped early rather than waiting out the timeout.` } : {},
      ...collected.retriedCount > 0 ? { retriedReplicas: collected.retriedCount, retryNote: `${collected.retriedCount} replica(s) failed the ${taskKind} schema and were sent one delta re-request for a corrected single-JSON answer.` } : {},
      ...synthesis.replicasMissing > 0 ? { missingNote: `Partial synthesis \u2014 ${synthesis.replicasMissing} of ${replicaRecords.length} replicas did not return a parseable response (timed out / failed / unparseable / schema-invalid / stale).` } : {}
    },
    ...freeformBanner ? { freeformBanner } : {},
    synthesis: synthesisNoRaw
  }, null, 2);
}
async function meshMagiCollect(ctx, args) {
  const consensusGroupId = readString(args.consensus_group_id) || readString(args.consensusGroupId);
  if (!consensusGroupId) return JSON.stringify({ success: false, error: "consensus_group_id required" });
  await refreshMeshFromDaemon(ctx);
  const explicitKind = args.task_kind ?? args.taskKind;
  const taskKind = explicitKind !== void 0 ? normalizeMagiTaskKind(explicitKind) : recoverMagiTaskKind(ctx, consensusGroupId);
  const replicaTasks = findMagiReplicaTasks((0, import_daemon_core4.getQueue)(ctx.mesh.id), consensusGroupId);
  if (replicaTasks.length === 0) {
    return JSON.stringify({
      success: false,
      code: "magi_group_not_found",
      error: `No MAGI replicas found for consensus group '${consensusGroupId}'. It may have been pruned, or the id is wrong.`,
      consensusGroupId
    });
  }
  const requireIndependentEvidence = (args.require_independent_evidence ?? args.requireIndependentEvidence) !== false;
  const wait = args.wait === true;
  const timeoutMs = wait ? Math.min(MAGI_MAX_WAIT_MS, Math.max(MAGI_POLL_INTERVAL_MS, Number(args.wait_timeout_ms ?? args.waitTimeoutMs) || MAGI_DEFAULT_WAIT_MS)) : 0;
  const replicaTaskIds = replicaTasks.map((t) => readString(t.id)).filter(Boolean);
  const collected = await collectMagiResponses(ctx, { replicaTaskIds, timeoutMs, taskKind });
  const synthesis = synthesizeMagiResponses(collected.responses, {
    replicasExpected: replicaTaskIds.length,
    requireIndependentEvidence
  });
  const verbose = args.verbose === true;
  const synthesisNoRaw = stripRawAnswers(synthesis);
  const returnedSynthesis = verbose ? synthesis : synthesisNoRaw;
  const freeformBanner = taskKind === "freeform" ? "task_kind=freeform: answers are unstructured natural language; cross-verification is WEAK (no claim clustering / independence scoring). Treat the collected answers as parallel opinions, not a verified consensus." : null;
  const replicaMissionId = readString(replicaTasks[0]?.missionId);
  persistMagiSynthesis(ctx, {
    consensusGroupId,
    missionId: replicaMissionId,
    staleReplicas: collected.staleCount,
    synthesis: synthesisNoRaw
  });
  closeMagiMissionIfTerminal(ctx, replicaMissionId, collected.terminal);
  const cleanupMode = resolveMagiAutoCleanupMode(ctx, args.auto_cleanup ?? args.autoCleanup);
  const cleanup = await cleanupMagiAutoLaunchedSessions(ctx, {
    replicaTasks,
    terminal: collected.terminal,
    mode: cleanupMode
  });
  return JSON.stringify({
    success: true,
    consensusGroupId,
    taskKind,
    replicaCount: replicaTaskIds.length,
    waited: wait,
    ...cleanup ? { sessionCleanup: { mode: cleanupMode, cleanedSessionCount: cleanup.cleanedSessionCount, perNode: cleanup.perNode } } : {},
    collection: {
      terminal: collected.terminal,
      timedOut: collected.timedOut,
      answered: synthesis.replicasAnswered,
      missing: synthesis.replicasMissing,
      staleReplicas: collected.staleCount,
      ...collected.staleCount > 0 ? { staleNote: `${collected.staleCount} replica(s) were detected STALE \u2014 assigned to a node/session no longer present in the live mesh.` } : {},
      ...collected.retriedCount > 0 ? { retriedReplicas: collected.retriedCount, retryNote: `${collected.retriedCount} replica(s) failed the ${taskKind} schema and were sent one delta re-request for a corrected single-JSON answer.` } : {},
      ...!collected.terminal ? { pendingNote: "Not all replicas are terminal yet \u2014 this is a partial snapshot. Re-collect once mission/pendingCoordinatorEvents report more completions." } : {}
    },
    ...freeformBanner ? { freeformBanner } : {},
    ...verbose ? { rawAnswersIncluded: true } : {},
    synthesis: returnedSynthesis
  }, null, 2);
}
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var MAGI_TERMINAL_STATUSES = /* @__PURE__ */ new Set(["completed", "failed", "cancelled"]);
function findMagiReplicaTasks(queue, consensusGroupId) {
  const groupId = typeof consensusGroupId === "string" ? consensusGroupId.trim() : "";
  if (!groupId) return [];
  return (Array.isArray(queue) ? queue : []).filter((t) => readString(t?.consensusGroupId) === groupId);
}
function computeMagiCleanupTargets(replicaTasks) {
  const byNode = /* @__PURE__ */ new Map();
  for (const task of Array.isArray(replicaTasks) ? replicaTasks : []) {
    const replicaTaskId = readString(task?.id);
    if (!replicaTaskId) continue;
    const nodeId = readString(task?.assignedNodeId) || readString(task?.autoLaunch?.nodeId) || readString(task?.targetNodeId);
    if (!nodeId) continue;
    const candidateSessionIds = [];
    if (readString(task?.autoLaunch?.status) === "completed") {
      const al = readString(task?.autoLaunch?.sessionId);
      if (al) candidateSessionIds.push(al);
    }
    const assigned = readString(task?.assignedSessionId);
    if (assigned) candidateSessionIds.push(assigned);
    if (candidateSessionIds.length === 0) continue;
    let entry = byNode.get(nodeId);
    if (!entry) {
      entry = { sessionIds: /* @__PURE__ */ new Set(), requireAutoLaunchedForTaskIds: {} };
      byNode.set(nodeId, entry);
    }
    for (const sid of candidateSessionIds) {
      entry.sessionIds.add(sid);
      if (!(sid in entry.requireAutoLaunchedForTaskIds)) {
        entry.requireAutoLaunchedForTaskIds[sid] = replicaTaskId;
      }
    }
  }
  const out = /* @__PURE__ */ new Map();
  for (const [nodeId, entry] of byNode) {
    out.set(nodeId, {
      sessionIds: Array.from(entry.sessionIds),
      requireAutoLaunchedForTaskIds: entry.requireAutoLaunchedForTaskIds
    });
  }
  return out;
}
function resolveMagiAutoCleanupMode(ctx, perCallOverride) {
  if (perCallOverride === true) return "stop_and_delete";
  if (perCallOverride === false) return "preserve";
  return (0, import_daemon_core5.resolveMagiSessionCleanupMode)(ctx.mesh?.policy?.magiSessionCleanup);
}
async function cleanupMagiAutoLaunchedSessions(ctx, args) {
  if (args.mode === "preserve") return null;
  if (!args.terminal) return null;
  const targets = computeMagiCleanupTargets(args.replicaTasks);
  if (targets.size === 0) return null;
  let cleanedSessionCount = 0;
  const perNode = [];
  const cleanupNode = async (nodeId, group) => {
    try {
      const node = await findOptionalNodeWithRefresh(ctx, nodeId);
      if (!node) {
        return { cleaned: 0, entry: { nodeId, skipped: "node_not_in_live_mesh", sessionIds: group.sessionIds } };
      }
      const result = await commandForNode(ctx, node, "cleanup_mesh_sessions", {
        meshId: ctx.mesh.id,
        nodeId,
        mode: "stop_and_delete",
        sessionIds: group.sessionIds,
        source: "magi_session_cleanup",
        requireAutoLaunchedForTaskIds: group.requireAutoLaunchedForTaskIds,
        inlineMesh: ctx.mesh
      }, { statusProbe: true });
      const payload = unwrapCommandPayload(result);
      const deleted = Array.isArray(payload?.deletedSessionIds) ? payload.deletedSessionIds.length : 0;
      const stopped = Array.isArray(payload?.stoppedSessionIds) ? payload.stoppedSessionIds.length : 0;
      return {
        cleaned: deleted + stopped,
        entry: {
          nodeId,
          requested: group.sessionIds.length,
          deleted,
          ...stopped ? { stopped } : {},
          ...Array.isArray(payload?.skippedMarkerMismatchSessionIds) && payload.skippedMarkerMismatchSessionIds.length ? { skippedMarkerMismatch: payload.skippedMarkerMismatchSessionIds } : {},
          ...payload?.deleteUnsupported ? { deleteUnsupported: true } : {}
        }
      };
    } catch (e) {
      return { cleaned: 0, entry: { nodeId, error: e?.message || String(e), sessionIds: group.sessionIds } };
    }
  };
  const cleanupTargets = Array.from(targets).filter(([, group]) => group.sessionIds.length > 0);
  const settled = await Promise.allSettled(
    cleanupTargets.map(([nodeId, group]) => cleanupNode(nodeId, group))
  );
  settled.forEach((outcome, idx) => {
    if (outcome.status === "fulfilled") {
      cleanedSessionCount += outcome.value.cleaned;
      perNode.push(outcome.value.entry);
    } else {
      const [nodeId, group] = cleanupTargets[idx];
      perNode.push({ nodeId, error: outcome.reason?.message ?? String(outcome.reason), sessionIds: group.sessionIds });
    }
  });
  return { cleanedSessionCount, perNode };
}
function sessionSharedWithAnotherReplica(task, allTasks) {
  const sid = readString(task?.assignedSessionId);
  if (!sid) return false;
  const nodeId = readString(task?.assignedNodeId);
  return (Array.isArray(allTasks) ? allTasks : []).some((other) => other?.id !== task?.id && readString(other?.assignedSessionId) === sid && (!nodeId || !readString(other?.assignedNodeId) || readString(other?.assignedNodeId) === nodeId));
}
function classifyStaleReplicas(annotatedTasks, terminal = MAGI_TERMINAL_STATUSES) {
  const staleTaskIds = /* @__PURE__ */ new Set();
  const staleReasons = {};
  for (const t of Array.isArray(annotatedTasks) ? annotatedTasks : []) {
    if (terminal.has(String(t?.status))) continue;
    if (t?.staleAssigned === true) {
      const id = readString(t.id);
      if (!id) continue;
      staleTaskIds.add(id);
      staleReasons[id] = readString(t.staleReason) || "assigned node/session is not present in the live mesh";
    }
  }
  return { staleTaskIds, staleReasons };
}
function persistMagiDispatched(ctx, args) {
  try {
    (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
      kind: "magi_dispatched",
      payload: {
        source: "magi",
        consensusGroupId: args.consensusGroupId,
        ...args.missionId ? { missionId: args.missionId } : {},
        ...args.panel ? { panel: args.panel } : {},
        ...args.question ? { question: args.question.slice(0, 300) } : {},
        replicaCount: args.replicaCount,
        // MAGI-REDESIGN: persist the task_kind so a later mesh_magi_collect
        // (which rediscovers replicas from the queue, not the original call)
        // re-derives the right schema parser for this group.
        ...args.taskKind ? { taskKind: args.taskKind } : {}
      }
    });
  } catch {
  }
}
function recoverMagiTaskKind(ctx, consensusGroupId) {
  try {
    const entries = (0, import_daemon_core4.readLedgerEntries)(ctx.mesh.id, { kind: ["magi_dispatched"], tail: 200 });
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const payload = entries[i]?.payload;
      if (!payload || typeof payload !== "object") continue;
      if (readString(payload.consensusGroupId) !== consensusGroupId) continue;
      return normalizeMagiTaskKind(payload.taskKind);
    }
  } catch {
  }
  return DEFAULT_TASK_KIND;
}
function stripRawAnswers(synthesis) {
  if (!Array.isArray(synthesis.replicas) || synthesis.replicas.length === 0) return synthesis;
  return {
    ...synthesis,
    replicas: synthesis.replicas.map((r) => {
      if (r.rawAnswer === void 0 && r.rawAnswerTruncated === void 0) return r;
      const { rawAnswer: _omitRaw, rawAnswerTruncated: _omitTrunc, ...rest } = r;
      return rest;
    })
  };
}
function persistMagiSynthesis(ctx, args) {
  try {
    (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
      kind: "magi_synthesis",
      payload: {
        source: "magi",
        consensusGroupId: args.consensusGroupId,
        ...args.missionId ? { missionId: args.missionId } : {},
        ...args.panel ? { panel: args.panel } : {},
        ...args.question ? { question: args.question.slice(0, 300) } : {},
        ...typeof args.staleReplicas === "number" ? { staleReplicas: args.staleReplicas } : {},
        synthesis: args.synthesis
      }
    });
  } catch {
  }
}
function closeMagiMissionIfTerminal(ctx, missionId, terminal) {
  if (!terminal) return;
  const id = readString(missionId);
  if (!id) return;
  try {
    const mission = (0, import_daemon_core4.getMeshMission)(ctx.mesh.id, id);
    if (!mission || mission.status !== "active") return;
    (0, import_daemon_core4.upsertMeshMission)(ctx.mesh.id, {
      id,
      title: mission.title,
      // Preserve goal: upsert defaults goal to the existing value when omitted.
      status: "completed"
    });
  } catch {
  }
}
function extractNodeGitRef(node) {
  const git = node?.git;
  if (!git || typeof git !== "object") return void 0;
  const ref = {};
  if (typeof git.branch === "string" || git.branch === null) ref.branch = git.branch;
  const headCommit = nodeHeadCommit(node);
  if (headCommit) ref.headCommit = headCommit;
  if (typeof git.ahead === "number" && Number.isFinite(git.ahead)) ref.ahead = git.ahead;
  if (typeof git.behind === "number" && Number.isFinite(git.behind)) ref.behind = git.behind;
  if (typeof git.dirty === "boolean") ref.dirty = git.dirty;
  return Object.keys(ref).length > 0 ? ref : void 0;
}
async function collectMagiResponses(ctx, args) {
  const ids = new Set(args.replicaTaskIds);
  const deadline = Date.now() + args.timeoutMs;
  const TERMINAL = MAGI_TERMINAL_STATUSES;
  const kind = args.taskKind ?? DEFAULT_TASK_KIND;
  const emptyResponse = () => ({ claims: [], top_findings: [], open_questions: [] });
  const retried = /* @__PURE__ */ new Set();
  const finalized = /* @__PURE__ */ new Map();
  const provisional = /* @__PURE__ */ new Map();
  const captureRawAnswer = (source, payload) => {
    try {
      const candidates = collectMagiCandidateTexts(payload);
      const raw = candidates.find((c) => c.trim().length > 0);
      if (!raw) return;
      if (raw.length > import_daemon_core4.MAGI_RAW_ANSWER_CAP) {
        source.rawAnswer = raw.slice(0, import_daemon_core4.MAGI_RAW_ANSWER_CAP);
        source.rawAnswerTruncated = true;
      } else {
        source.rawAnswer = raw;
      }
    } catch {
    }
  };
  const buildSource = (task) => {
    const sourceNodeId = task.assignedNodeId || task.targetNodeId || void 0;
    const gitRef = extractNodeGitRef(sourceNodeId ? ctx.mesh.nodes.find((n) => (0, import_daemon_core4.meshNodeIdMatches)(n, sourceNodeId)) : void 0);
    return {
      taskId: task.id,
      nodeId: sourceNodeId,
      provider: task.assignedProviderType || void 0,
      ok: false,
      ...gitRef ? { git: gitRef } : {}
    };
  };
  const sendKindRetry = async (task, failReason) => {
    const node = ctx.mesh.nodes.find((n) => (0, import_daemon_core4.meshNodeIdMatches)(n, task.assignedNodeId));
    if (!node || !task.assignedSessionId) return false;
    const why = failReason === "empty_evidence" ? "your previous answer had an empty evidence array" : failReason === "missing_required_fields" ? "your previous answer was missing required fields" : "your previous answer did not parse as the required JSON";
    const message = `Your previous MAGI answer could not be accepted (${why}). Respond NOW with ONLY a single JSON object (no prose, no code fence) matching EXACTLY this schema, with non-empty evidence:

${magiOutputContractFor(kind)}`;
    try {
      const coordinatorDaemonId = ctx.localDaemonId;
      await commandForNode(ctx, node, "agent_command", {
        targetSessionId: task.assignedSessionId,
        providerType: task.assignedProviderType,
        cliType: task.assignedProviderType,
        agentType: task.assignedProviderType,
        action: "send_chat",
        message,
        meshContext: {
          meshId: ctx.mesh.id,
          nodeId: task.assignedNodeId,
          taskId: task.id,
          ...coordinatorDaemonId ? { coordinatorDaemonId } : {},
          ...ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}
        }
      });
      try {
        (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
          kind: "magi_replica_retry",
          payload: { taskId: task.id, kind, failReason }
        });
      } catch {
      }
      return true;
    } catch {
      return false;
    }
  };
  const nudgeWedgedReplica = async (task) => {
    const node = ctx.mesh.nodes.find((n) => (0, import_daemon_core4.meshNodeIdMatches)(n, task.assignedNodeId));
    if (!node || !task.assignedSessionId) return;
    try {
      const read = await commandForNode(ctx, node, "read_chat", {
        sessionId: task.assignedSessionId,
        targetSessionId: task.assignedSessionId,
        workspace: node.workspace,
        tailLimit: 1
      });
      const payload = unwrapCommandPayload(read);
      if (!magiReadIndicatesApprovalWedge(payload)) return;
      const status = String(payload?.status ?? "");
      await commandForNode(ctx, node, "resolve_action", {
        sessionId: task.assignedSessionId,
        targetSessionId: task.assignedSessionId,
        workspace: node.workspace,
        providerType: task.assignedProviderType,
        agentType: task.assignedProviderType,
        cliType: task.assignedProviderType,
        action: "approve"
      });
      try {
        (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
          kind: "magi_replica_auto_approved",
          payload: { taskId: task.id, nodeId: task.assignedNodeId, status }
        });
      } catch {
      }
    } catch {
    }
  };
  const tryResolveReplica = async (task, staleTaskIds2, staleReasons2, force, liveTasks) => {
    const taskId = task.id;
    const source = buildSource(task);
    if (task.status !== "completed" || !task.assignedNodeId || !task.assignedSessionId) {
      if (staleTaskIds2.has(taskId)) {
        source.stale = true;
        source.error = `stale: ${staleReasons2[taskId]}`;
        finalized.set(taskId, { source, response: emptyResponse() });
        return true;
      }
      if (TERMINAL.has(String(task.status))) {
        source.error = task.status === "completed" ? "no_session_to_read" : `replica_${task.status || "incomplete"}`;
        finalized.set(taskId, { source, response: emptyResponse() });
        return true;
      }
      if (task.assignedNodeId && task.assignedSessionId && !force) {
        await nudgeWedgedReplica(task);
      }
      if (force) {
        source.error = `replica_${task.status || "incomplete"}`;
        finalized.set(taskId, { source, response: emptyResponse() });
        return true;
      }
      return false;
    }
    if (sessionSharedWithAnotherReplica(task, liveTasks)) {
      if (force) {
        source.error = "cross_wired_shared_session";
        finalized.set(taskId, { source, response: emptyResponse() });
        return true;
      }
      return false;
    }
    let kindResult;
    try {
      const node = ctx.mesh.nodes.find((n) => (0, import_daemon_core4.meshNodeIdMatches)(n, task.assignedNodeId));
      if (!node) throw new Error("assigned node not in mesh");
      const result = await commandForNode(ctx, node, "read_chat", {
        sessionId: task.assignedSessionId,
        targetSessionId: task.assignedSessionId,
        workspace: node.workspace,
        tailLimit: 6,
        // FIX#1: scope the read to the CURRENT turn so a provider that supports it returns
        // only this turn's bubbles (coverage:'current-turn' / _turnKey), instead of the
        // whole-session tail whose newest kind-valid JSON could belong to an earlier turn.
        coverage: "current-turn"
      });
      const payload = unwrapCommandPayload(result);
      captureRawAnswer(source, payload);
      kindResult = parseFirstMagiCandidateForKind(payload, kind, {
        sessionId: task.assignedSessionId
      });
    } catch (e) {
      if (force) {
        source.error = `read_failed: ${e?.message || String(e)}`;
        finalized.set(taskId, { source, response: emptyResponse() });
        return true;
      }
      return false;
    }
    if (kindResult.ok && kindResult.response) {
      const weak = replicaCompletionIsWeak(ctx.mesh.id, taskId);
      if (weak && !force) {
        provisional.set(taskId, { source: { ...source, ok: true }, response: kindResult.response });
        return false;
      }
      finalized.set(taskId, { source: { ...source, ok: true }, response: kindResult.response });
      return true;
    }
    const isSchemaFailure = kindResult.failReason === "missing_required_fields" || kindResult.failReason === "empty_evidence";
    if (isSchemaFailure && !retried.has(taskId) && !force) {
      retried.add(taskId);
      const sent = await sendKindRetry(task, kindResult.failReason);
      if (sent) return false;
    }
    if (force) {
      const prov = provisional.get(taskId);
      if (prov) {
        finalized.set(taskId, prov);
        return true;
      }
      source.error = isSchemaFailure ? `schema_invalid: ${kindResult.failReason}` : "unparseable_output";
      finalized.set(taskId, { source, response: emptyResponse() });
      return true;
    }
    return false;
  };
  for (; ; ) {
    const tasks = annotateQueueStaleness((0, import_daemon_core4.getQueue)(ctx.mesh.id).filter((t) => ids.has(t.id)), ctx.mesh);
    const allPresent = tasks.length === ids.size;
    const { staleTaskIds: staleTaskIds2, staleReasons: staleReasons2 } = classifyStaleReplicas(tasks, TERMINAL);
    const pastDeadline = Date.now() >= deadline;
    for (const task of tasks) {
      if (finalized.has(task.id)) continue;
      await tryResolveReplica(task, staleTaskIds2, staleReasons2, pastDeadline, tasks);
    }
    if (allPresent && finalized.size >= ids.size) break;
    if (pastDeadline) break;
    const outstanding = tasks.filter((t) => !finalized.has(t.id));
    if (allPresent && outstanding.length > 0 && outstanding.every((t) => staleTaskIds2.has(t.id))) break;
    await sleep(Math.min(MAGI_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  const finalTasks = annotateQueueStaleness((0, import_daemon_core4.getQueue)(ctx.mesh.id).filter((t) => ids.has(t.id)), ctx.mesh);
  const { staleTaskIds, staleReasons } = classifyStaleReplicas(finalTasks, TERMINAL);
  const presentIds = new Set(finalTasks.map((t) => t.id));
  for (const task of finalTasks) {
    if (!finalized.has(task.id)) await tryResolveReplica(task, staleTaskIds, staleReasons, true, finalTasks);
  }
  for (const id of ids) {
    if (finalized.has(id)) continue;
    if (!presentIds.has(id)) {
      finalized.set(id, { source: { taskId: id, ok: false, error: "replica_missing" }, response: emptyResponse() });
    }
  }
  const responses = args.replicaTaskIds.map((id) => finalized.get(id)).filter((r) => !!r);
  const terminal = presentIds.size === ids.size && finalTasks.every((t) => TERMINAL.has(String(t.status)));
  const staleCount = responses.filter((r) => r.source.stale === true).length;
  return { responses, terminal, timedOut: !terminal, staleCount, retriedCount: retried.size };
}

// src/tools/mesh-tools-slots.ts
function readNodeSlots(node) {
  return normalizeNodeCapabilitySlots(node?.policy?.slots);
}
async function meshNodeSlotsList(ctx, args = {}) {
  const nodeId = String(args.node_id || args.nodeId || "").trim();
  if (!nodeId) return JSON.stringify({ success: false, error: "node_id required" });
  try {
    const node = await findNodeWithRefresh(ctx, nodeId);
    return JSON.stringify({
      success: true,
      nodeId: node.id,
      slots: readNodeSlots(node)
    }, null, 2);
  } catch (e) {
    return JSON.stringify({ success: false, error: e?.message || String(e) });
  }
}
async function meshNodeSlotsSet(ctx, args) {
  const nodeId = String(args.node_id || args.nodeId || "").trim();
  if (!nodeId) return JSON.stringify({ success: false, error: "node_id required" });
  const write = args.write === true;
  try {
    const node = await findNodeWithRefresh(ctx, nodeId);
    const current = readNodeSlots(node);
    const proposed = normalizeNodeCapabilitySlots(args.slots);
    if (!write) {
      return JSON.stringify({
        success: true,
        dryRun: true,
        nodeId: node.id,
        replacement: true,
        ...typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason.trim() } : {},
        currentSlots: current,
        proposedSlots: proposed,
        note: "Dry-run only \u2014 nothing written. This is a WHOLESALE replacement of the node's capability slots (policy.slots): currentSlots would be fully replaced by proposedSlots. Present this diff to the user and re-run with write=true ONLY after explicit approval."
      }, null, 2);
    }
    const raw = await commandForNode(ctx, node, "update_mesh_node", {
      meshId: ctx.mesh.id,
      nodeId: node.id,
      policy: { slots: proposed },
      inlineMesh: ctx.mesh
    });
    const result = unwrapCommandPayload(raw);
    if (result?.success === false) {
      return JSON.stringify({ success: false, error: result.error || "update_mesh_node failed" });
    }
    const idx = ctx.mesh.nodes.findIndex((n) => n.id === node.id);
    if (idx >= 0) {
      const target = ctx.mesh.nodes[idx];
      target.policy = {
        ...target.policy && typeof target.policy === "object" && !Array.isArray(target.policy) ? target.policy : {},
        slots: proposed
      };
      ctx.mesh.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      await syncCoordinatorDaemonMeshCache(ctx);
    }
    return JSON.stringify({
      success: true,
      written: true,
      nodeId: node.id,
      replacement: true,
      previousSlots: current,
      slots: proposed,
      nextAction: "Verify with mesh_node_slots_list. Slot-fitness routing picks these up on the next queue drain."
    }, null, 2);
  } catch (e) {
    return JSON.stringify({ success: false, error: e?.message || String(e) });
  }
}

// src/tools/mesh-tools-session.ts
function computeIdleDispatchAckRisk(sessionWasIdle, dispatchPreRecorded, sessionId) {
  if (!sessionWasIdle || dispatchPreRecorded) return {};
  return {
    dispatchAcknowledgementRisk: true,
    dispatchAcknowledgementRiskReason: "idle_dispatch_prerecord_failed",
    dispatchAcknowledgementNote: `Session '${sessionId}' was idle at dispatch time and the dispatch row could not be pre-recorded, so its completion may be deduplicated as a prior turn and lost. Use mesh_status to verify; if the session remains idle or the completion never lands, launch a fresh session and retry.`
  };
}
async function meshPruneStaleDirect(ctx, args = {}) {
  await refreshMeshFromDaemon(ctx);
  const execute = args.execute === true && args.dry_run !== true;
  const includeTerminal = args.include_terminal === true;
  const liveNodes = await collectMeshViewQueueNodesWithLiveSessions(ctx);
  const ledgerEntries = (0, import_daemon_core4.readLedgerEntries)(ctx.mesh.id, { tail: 500 });
  const directDispatches = (0, import_daemon_core4.getActiveDirectDispatches)(ctx.mesh.id);
  const result = (0, import_daemon_core4.pruneStaleDirectDispatches)({
    meshId: ctx.mesh.id,
    queue: (0, import_daemon_core4.getQueue)(ctx.mesh.id),
    ledgerEntries,
    directDispatches,
    nodes: liveNodes,
    execute,
    includeTerminal,
    source: "mesh_prune_stale_direct"
  });
  const { prunable, prunedCount, preservedUnacknowledged, preservedLedgerOnly, preservedNotOrphan } = result;
  const summarize = (records) => records.map((r) => ({
    taskId: r.taskId,
    nodeId: r.nodeId,
    sessionId: r.sessionId,
    status: r.status,
    terminal: r.terminal === true,
    staleReason: r.staleReason,
    taskTitle: r.taskTitle,
    createdAt: r.createdAt
  }));
  return JSON.stringify({
    success: true,
    mode: result.mode,
    meshId: ctx.mesh.id,
    includeTerminal,
    candidateCount: result.candidateCount,
    prunableCount: prunable.length,
    prunedCount,
    prunable: summarize(prunable),
    preserved: {
      unacknowledgedCount: preservedUnacknowledged.length,
      ledgerOnlyCount: preservedLedgerOnly.length,
      notOrphanCount: preservedNotOrphan.length,
      unacknowledged: summarize(preservedUnacknowledged),
      ledgerOnly: summarize(preservedLedgerOnly),
      notOrphan: summarize(preservedNotOrphan)
    },
    note: execute ? `Pruned ${prunedCount} orphaned direct dispatch record(s) from the active staleDirect surface. The append-only mesh ledger audit history is preserved; a direct_dispatch_pruned entry records this prune.` : "Dry run \u2014 nothing was deleted. Re-run with execute=true to prune the listed orphaned records. Fresh unacknowledged dispatch failures (node/session still live) and ledger-only audit entries are always preserved."
  }, null, 2);
}
async function meshSendTask(ctx, args) {
  const message = readString(args.message);
  if (!message) {
    return JSON.stringify({
      success: false,
      code: "invalid_message",
      error: "mesh_send_task requires a non-empty string `message`."
    });
  }
  const requestedTaskMode = readString(args.task_mode) || readString(args.taskMode);
  const readonly = args.readonly === true || args.read_only === true;
  const missionId = readString(args.missionId) || readString(args.mission_id) || void 0;
  const modeValidation = (0, import_daemon_core4.validateMeshTaskModeRequest)(requestedTaskMode, message, readonly);
  if (!modeValidation.valid) {
    return JSON.stringify({
      success: false,
      code: "live_debug_readonly_guardrail_violation",
      taskMode: modeValidation.taskMode || requestedTaskMode,
      violations: modeValidation.violations,
      allowedOperations: modeValidation.allowedOperations,
      error: `live_debug_readonly_guardrail_violation: forbidden operations (${modeValidation.violations.join(", ")})`
    });
  }
  const taskMode = modeValidation.taskMode;
  const node = await findNodeWithRefresh(ctx, args.node_id);
  if (node.policy?.readOnly) {
    return JSON.stringify({ error: `Node '${args.node_id}' is read-only` });
  }
  if (taskMode === "convergence" && node.isLocalWorktree === true) {
    return JSON.stringify({
      success: false,
      recoverable: true,
      code: "mesh_convergence_target_is_worktree",
      reason: "mesh_convergence_target_is_worktree",
      nodeId: args.node_id,
      sessionId: args.session_id,
      taskMode,
      error: `Node '${args.node_id}' is a worktree clone; a convergence task is base-only (it merges/pushes onto base). Dispatching it to a worktree session risks a multi-worktree push/deploy race.`,
      nextAction: `Dispatch the convergence task to the base node for this mesh, or run the deterministic fast-forward convergence path (mesh_fast_forward_node / mesh_refine_node) instead of mesh_send_task.`
    });
  }
  let explicitTargetSession;
  if (args.session_id && isWorkerTaskMode(taskMode, readonly)) {
    try {
      const statusResult = await commandForNode(ctx, node, "get_status_metadata", {});
      const sessions = extractStatusMetadataSessions(statusResult);
      explicitTargetSession = sessions.find((session) => readSessionRecordId(session) === args.session_id);
      if (explicitTargetSession && isMeshCoordinatorSessionRecord(explicitTargetSession)) {
        return JSON.stringify({
          success: false,
          recoverable: true,
          code: "mesh_target_session_is_coordinator",
          reason: "mesh_target_session_is_coordinator",
          nodeId: args.node_id,
          sessionId: args.session_id,
          taskMode: taskMode || "unspecified",
          error: `Session '${args.session_id}' is a Repo Mesh coordinator session, not a visible worker session. Launch or use a visible worker session before dispatching this task.`,
          nextAction: `Call mesh_launch_session for node '${args.node_id}' and then retry mesh_send_task with that worker session_id, or use mesh_enqueue_task for queue-based worker assignment.`
        });
      }
      if (explicitTargetSession && isUnmanagedSessionRecord(explicitTargetSession)) {
        return JSON.stringify({
          success: false,
          recoverable: true,
          code: "mesh_target_session_unmanaged",
          reason: "mesh_target_session_unmanaged",
          nodeId: args.node_id,
          sessionId: args.session_id,
          taskMode: taskMode || "unspecified",
          unsafeTranscriptAlias: true,
          error: `Session '${args.session_id}' on node '${args.node_id}' has no Repo Mesh delegation metadata (missing meshNodeFor/meshCoordinatorFor/launchedByCoordinator). It may be the coordinator's own session or an unrelated session \u2014 dispatching risks self-send and orphaned completion events that never reach the coordinator ledger.`,
          nextAction: `Call mesh_launch_session for node '${args.node_id}' to start a fresh managed worker session, then retry mesh_send_task with the returned session_id. Alternatively use mesh_enqueue_task for queue-based assignment without specifying session_id.`
        });
      }
    } catch {
      explicitTargetSession = void 0;
    }
  }
  const duplicate = hasRecentDuplicateDispatch(ctx, args);
  if (duplicate.duplicate) {
    return JSON.stringify({
      success: true,
      duplicate: true,
      dispatched: false,
      warning: "Duplicate mesh_send_task suppressed: the same node/session/message was dispatched recently.",
      nodeId: args.node_id,
      sessionId: args.session_id,
      source: duplicate.source,
      previousDispatch: duplicate.entry ? {
        id: duplicate.entry.id,
        timestamp: duplicate.entry.timestamp || duplicate.entry.updatedAt || duplicate.entry.createdAt,
        nodeId: duplicate.entry.nodeId || duplicate.entry.targetNodeId || duplicate.entry.assignedNodeId,
        sessionId: duplicate.entry.sessionId || duplicate.entry.targetSessionId || duplicate.entry.assignedSessionId
      } : void 0
    });
  }
  try {
    const isLocalNode = isLocalControlPlaneNode(ctx, node);
    if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
      const cached = getSessionMetadata(meshSessionCacheKey(args.node_id, args.session_id || ""));
      const taskId = (0, import_node_crypto.randomUUID)();
      const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
      const result2 = await ipcDispatchToRemoteAgent(ctx, node, {
        session_id: args.session_id,
        message,
        providerType: cached?.providerType,
        verifiedSession: explicitTargetSession,
        meshContext: {
          meshId: ctx.mesh.id,
          nodeId: args.node_id,
          taskId,
          ...coordinatorDaemonId ? { coordinatorDaemonId } : {},
          // (3) Stamp the originating coordinator session so the worker's completion
          // routes back to THIS coordinator session (multi-coordinator). Survives the
          // P2P dispatch to the remote worker, which echoes it on its completion event.
          ...ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}
        }
      });
      if (result2.success) {
        const resultSessionId = result2.sessionId && result2.providerType && result2.sessionId === result2.providerType ? "" : result2.sessionId;
        const dispatchedSessionId = args.session_id || resultSessionId;
        const dispatchedAt = (/* @__PURE__ */ new Date()).toISOString();
        try {
          const providerType = result2.providerType || cached?.providerType;
          (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
            kind: "task_dispatched",
            nodeId: args.node_id,
            sessionId: dispatchedSessionId,
            providerType,
            payload: buildDirectTaskPayload(message, "p2p_direct", {
              taskId,
              taskMode,
              providerType,
              targetSessionId: dispatchedSessionId,
              ...args.node_id ? { selectedNodeId: args.node_id } : {},
              ...ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {},
              // COORD-EVENT-MISROUTE: persist the dispatching coordinator daemon anchor
              // (same value stamped into meshContext above) so a transcript-reconcile
              // synth recovers it instead of the worker's own self-daemon.
              ...coordinatorDaemonId ? { coordinatorDaemonId } : {}
            })
          });
          (0, import_daemon_core4.insertDirectDispatch)(ctx.mesh.id, {
            taskId,
            nodeId: args.node_id,
            sessionId: dispatchedSessionId,
            providerType: providerType || void 0,
            message,
            taskMode: taskMode || void 0,
            via: "p2p_direct",
            dispatchedAt
          });
          if (missionId) {
            (0, import_daemon_core4.recordDirectDispatchTask)(ctx.mesh.id, message, {
              id: taskId,
              missionId,
              assignedNodeId: args.node_id,
              assignedSessionId: dispatchedSessionId,
              taskMode,
              ...readonly ? { readonly: true } : {},
              dispatchedAt
            });
          }
        } catch {
        }
      }
      const returnedSessionId = result2.sessionId && result2.providerType && result2.sessionId === result2.providerType ? "" : result2.sessionId;
      return JSON.stringify({
        ...result2,
        nodeId: args.node_id,
        sessionId: result2.success ? args.session_id || returnedSessionId : args.session_id,
        ...result2.success ? { source: "direct", taskId } : {},
        taskMode,
        ...result2.success && result2.providerType ? { providerType: result2.providerType } : {},
        dispatched: result2.success === true
      });
    }
    if (args.session_id) {
      const cached = getSessionMetadata(meshSessionCacheKey(args.node_id, args.session_id));
      let resolvedProviderType = cached?.providerType || "";
      if (!resolvedProviderType) {
        let explicitSession = explicitTargetSession;
        if (!explicitSession) {
          const statusResult = await commandForNode(ctx, node, "get_status_metadata", {});
          const sessions = extractStatusMetadataSessions(statusResult);
          explicitSession = sessions.find((session) => readSessionRecordId(session) === args.session_id);
        }
        if (!explicitSession) {
          return JSON.stringify({
            success: false,
            recoverable: true,
            code: "mesh_target_session_not_found",
            reason: "mesh_target_session_not_found",
            transport: "local_ipc",
            retryRecommended: true,
            nodeId: args.node_id,
            sessionId: args.session_id,
            error: `Local session '${args.session_id}' is not present in live status for node '${args.node_id}'.`,
            nextAction: `Launch a fresh session with mesh_launch_session(node_id: '${args.node_id}') or retry without session_id so Repo Mesh can target a live delegate session.`
          });
        }
        if (isMeshCoordinatorSessionRecord(explicitSession)) {
          return JSON.stringify({
            success: false,
            recoverable: true,
            code: "mesh_target_session_is_coordinator",
            reason: "mesh_target_session_is_coordinator",
            nodeId: args.node_id,
            sessionId: args.session_id,
            taskMode: taskMode || "unspecified",
            error: `Session '${args.session_id}' is a Repo Mesh coordinator session, not a visible worker session. Launch or use a visible worker session before dispatching this task.`,
            nextAction: `Call mesh_launch_session for node '${args.node_id}' and then retry mesh_send_task with that worker session_id, or use mesh_enqueue_task for queue-based worker assignment.`
          });
        }
        if (isUnmanagedSessionRecord(explicitSession)) {
          return JSON.stringify({
            success: false,
            recoverable: true,
            code: "mesh_target_session_unmanaged",
            reason: "mesh_target_session_unmanaged",
            nodeId: args.node_id,
            sessionId: args.session_id,
            taskMode: taskMode || "unspecified",
            unsafeTranscriptAlias: true,
            unsafeDelegateTarget: true,
            error: `Session '${args.session_id}' on node '${args.node_id}' has no Repo Mesh delegation metadata (missing meshNodeFor/meshCoordinatorFor/launchedByCoordinator). It may be the coordinator's own session or an unrelated session \u2014 dispatching risks self-send and orphaned completion events that never reach the coordinator ledger.`,
            nextAction: `Call mesh_launch_session for node '${args.node_id}' to start a fresh managed worker session, then retry mesh_send_task with the returned session_id. Alternatively use mesh_enqueue_task for queue-based assignment without specifying session_id.`
          });
        }
        resolvedProviderType = resolveSessionProviderType(explicitSession);
        if (resolvedProviderType) {
          meshSessionProviderMetadata.set(meshSessionCacheKey(args.node_id, args.session_id), {
            providerType: resolvedProviderType,
            providerSessionId: readString(explicitSession?.providerSessionId) || void 0,
            expiresAt: Date.now() + SESSION_PROVIDER_METADATA_TTL_MS
          });
        }
      }
      if (!resolvedProviderType) {
        return JSON.stringify({
          success: false,
          recoverable: true,
          code: "mesh_target_session_provider_unknown",
          reason: "mesh_target_session_provider_unknown",
          transport: "local_ipc",
          retryRecommended: false,
          nodeId: args.node_id,
          sessionId: args.session_id,
          error: `Local session '${args.session_id}' is live but does not expose providerType/cliType, so agent_command cannot be routed safely.`,
          nextAction: `Relaunch the target session on node '${args.node_id}' or retry without session_id so Repo Mesh can pick a session with provider metadata.`
        });
      }
      if (explicitTargetSession && !isIdleSessionRecord(explicitTargetSession) && !isTerminalSessionRecord(explicitTargetSession)) {
        const sessionStatus = typeof explicitTargetSession?.status === "string" ? explicitTargetSession.status : "unknown";
        const { resolveDeliveryDecision } = await import("@adhdev/daemon-core");
        const policyResult = resolveDeliveryDecision(sessionStatus, { kind: "task" });
        if (policyResult.decision === "queued") {
          const queuedTask = (0, import_daemon_core4.enqueueTask)(ctx.mesh.id, message, {
            targetNodeId: args.node_id,
            targetSessionId: args.session_id,
            taskMode,
            ...readonly ? { readonly: true } : {},
            ...missionId ? { missionId } : {},
            ...ctx.coordinatorSessionId ? { sourceCoordinatorSessionId: ctx.coordinatorSessionId } : {}
          });
          return JSON.stringify({
            success: true,
            dispatched: false,
            decision: "queued_delivery",
            taskId: queuedTask.id,
            reason: policyResult.reason,
            nodeId: args.node_id,
            sessionId: args.session_id,
            sessionStatus,
            taskMode: taskMode || void 0,
            message: policyResult.message,
            nextAction: `Task '${queuedTask.id}' is queued and pinned to session '${args.session_id}' \u2014 it auto-delivers the moment the session goes idle. Use mesh_status or mesh_task_history to track it; no manual resend needed.`
          });
        }
      }
      const sessionWasIdle = explicitTargetSession ? isIdleSessionRecord(explicitTargetSession) : false;
      const taskId = (0, import_node_crypto.randomUUID)();
      const dispatchedAt = (/* @__PURE__ */ new Date()).toISOString();
      const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
      try {
        (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
          kind: "task_dispatched",
          nodeId: args.node_id,
          sessionId: args.session_id,
          providerType: resolvedProviderType,
          payload: buildDirectTaskPayload(message, "local_direct", {
            taskId,
            taskMode,
            providerType: resolvedProviderType,
            targetSessionId: args.session_id,
            dispatchedToIdleSession: sessionWasIdle,
            ...args.node_id ? { selectedNodeId: args.node_id } : {},
            ...ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {},
            // COORD-EVENT-MISROUTE: persist the dispatching coordinator daemon anchor so a
            // transcript-reconcile synth recovers it from the ledger rather than stamping
            // the reconcile-runner's own self-daemon.
            ...coordinatorDaemonId ? { coordinatorDaemonId } : {}
          })
        });
      } catch {
      }
      (0, import_daemon_core4.insertDirectDispatch)(ctx.mesh.id, {
        taskId,
        nodeId: args.node_id,
        sessionId: args.session_id,
        providerType: resolvedProviderType || void 0,
        message,
        taskMode: taskMode || void 0,
        via: "local_direct",
        dispatchedToIdleSession: sessionWasIdle,
        dispatchedAt
      });
      let dispatchPreRecorded = false;
      try {
        dispatchPreRecorded = (0, import_daemon_core4.getActiveDirectDispatches)(ctx.mesh.id).some((d) => d.taskId === taskId);
      } catch {
      }
      const dispatchResult = await commandForNode(ctx, node, "agent_command", {
        targetSessionId: args.session_id,
        agentType: resolvedProviderType,
        cliType: resolvedProviderType,
        providerType: resolvedProviderType,
        action: "send_chat",
        message,
        meshContext: {
          meshId: ctx.mesh.id,
          nodeId: args.node_id,
          taskId,
          ...coordinatorDaemonId ? { coordinatorDaemonId } : {},
          // (3) Originating coordinator session anchor — see the remote-dispatch path above.
          ...ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}
        }
      });
      const dispatchPayload = unwrapCommandPayload(dispatchResult);
      if (dispatchPayload?.success === false || dispatchResult?.success === false) {
        try {
          (0, import_daemon_core4.deleteDirectDispatchesByTaskId)(ctx.mesh.id, [taskId]);
        } catch {
        }
        dispatchPreRecorded = false;
        const source = dispatchPayload?.success === false ? dispatchPayload : dispatchResult;
        return JSON.stringify({
          ...source && typeof source === "object" ? source : {},
          success: false,
          nodeId: args.node_id,
          sessionId: args.session_id,
          error: dispatchPayload?.error || dispatchResult?.error || "agent_command rejected the task"
        });
      }
      if (missionId) {
        try {
          (0, import_daemon_core4.recordDirectDispatchTask)(ctx.mesh.id, message, {
            id: taskId,
            missionId,
            assignedNodeId: args.node_id,
            assignedSessionId: args.session_id,
            taskMode,
            ...readonly ? { readonly: true } : {},
            dispatchedAt
          });
        } catch {
        }
      }
      let deliveryId;
      try {
        const { createSessionDelivery: createDelivery } = await import("@adhdev/daemon-core");
        const delivery = createDelivery({
          meshId: ctx.mesh.id,
          nodeId: args.node_id,
          sessionId: args.session_id,
          providerType: resolvedProviderType || void 0,
          taskId,
          kind: "task",
          message,
          status: sessionWasIdle ? "delivered" : "delivering"
        });
        deliveryId = delivery.id;
      } catch {
      }
      return JSON.stringify({
        success: true,
        dispatched: true,
        decision: "immediate",
        source: "direct",
        taskId,
        deliveryId,
        taskMode,
        providerType: resolvedProviderType,
        nodeId: args.node_id,
        sessionId: args.session_id,
        // DISPATCH-ACK-RISK-STALE: only warn on a GENUINE residual loss risk — an idle
        // session whose dispatch row did NOT survive pre-record. A successfully
        // pre-recorded idle dispatch (the NOTIF-DROP / CANON-A path) is not at risk.
        ...computeIdleDispatchAckRisk(sessionWasIdle, dispatchPreRecorded, args.session_id)
      });
    }
    const task = (0, import_daemon_core4.enqueueTask)(ctx.mesh.id, message, {
      targetNodeId: args.node_id,
      targetSessionId: args.session_id,
      taskMode,
      ...readonly ? { readonly: true } : {},
      ...missionId ? { missionId } : {},
      ...ctx.coordinatorSessionId ? { sourceCoordinatorSessionId: ctx.coordinatorSessionId } : {}
    });
    const queueTrigger = await triggerMeshQueueAndReport(ctx);
    const pendingEvents = (0, import_daemon_core4.drainPendingMeshCoordinatorEvents)(ctx.mesh.id, ctx.localDaemonId);
    const result = {
      success: true,
      source: "queue",
      nodeId: args.node_id,
      taskId: task.id,
      status: task.status,
      taskMode: task.taskMode,
      queueTrigger,
      ...buildQueueTriggerGuidance(queueTrigger)
    };
    if (pendingEvents.length > 0) {
      result.pendingCoordinatorEvents = pendingEvents;
    }
    return JSON.stringify(result);
  } catch (e) {
    const failure = buildCoordinatorP2pRelayFailure(e, {
      command: "mesh_send_task",
      targetDaemonId: node.daemonId,
      nodeId: args.node_id,
      sessionId: args.session_id
    });
    return JSON.stringify(failure);
  }
}
async function meshReadChat(ctx, args) {
  const node = await findOptionalNodeWithRefresh(ctx, args.node_id);
  if (!node) {
    return JSON.stringify(buildMissingNodeReadChatRecovery(ctx, args), null, 2);
  }
  await drainCoordinatorPendingEvents(ctx, { nodeIds: [args.node_id] });
  const cached = resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
  const providerSessionId = typeof args.provider_session_id === "string" && args.provider_session_id.trim() ? args.provider_session_id.trim() : cached?.providerSessionId;
  const isLocalNode = isLocalControlPlaneNode(ctx, node);
  let result;
  try {
    result = await commandForNode(ctx, node, "read_chat", {
      sessionId: args.session_id,
      targetSessionId: args.session_id,
      workspace: node.workspace,
      ...cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {},
      ...providerSessionId ? { providerSessionId } : {},
      tailLimit: args.tail ?? 10
    });
  } catch (e) {
    if (isLocalNode || !(0, import_daemon_core4.isP2pRelayTransportFailure)(e)) throw e;
    return buildMeshReadChatCacheFallback(ctx, args, node, e);
  }
  const payload = annotateRapidReadChatAdvisory(unwrapCommandPayload(result), {
    key: `mesh:${args.node_id}:${args.session_id}`,
    toolName: "mesh_read_chat",
    completionCallbackExpected: true
  });
  const useCompact = args.compact !== false;
  if (useCompact) {
    const compactPayload = compactChatPayload(payload, {
      nodeId: args.node_id,
      sessionId: args.session_id,
      limit: args.tail ?? 10,
      // Carry the daemon's Stage 6 turn projection (attemptId/turnStage/
      // authority/terminal outcome) so the slim response stays at parity
      // with daemon read_chat and mesh_status. Non-content scalars only.
      preserveTurn: true
    });
    return JSON.stringify(
      payload.pollingAdvisory ? { ...compactPayload, pollingAdvisory: payload.pollingAdvisory } : compactPayload,
      null,
      2
    );
  }
  return JSON.stringify(payload, null, 2);
}
async function meshReadDebug(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  const cached = resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
  const providerSessionId = typeof args.provider_session_id === "string" && args.provider_session_id.trim() ? args.provider_session_id.trim() : cached?.providerSessionId;
  const delivery = args.delivery === "inline" ? void 0 : "daemon_file";
  const result = await commandForNode(ctx, node, "get_chat_debug_bundle", {
    sessionId: args.session_id,
    targetSessionId: args.session_id,
    workspace: node.workspace,
    ...cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {},
    ...providerSessionId ? { providerSessionId } : {},
    tailLimit: args.tail ?? 40,
    ...delivery ? { delivery } : {}
  });
  const payload = unwrapCommandPayload(result);
  return JSON.stringify(payload, null, 2);
}
async function meshReadTerminal(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  const liveSessions = await collectLiveStatusSessions(ctx, node);
  const record = liveSessions.find((s) => readSessionRecordId(s) === args.session_id);
  if (record && !isMeshOwnedDelegateSession(record, ctx.mesh.id, args.node_id)) {
    return JSON.stringify({
      success: false,
      error: "session is not a mesh-owned delegate of this mesh/node \u2014 mesh_read_terminal is scoped to sessions this coordinator spawned",
      nodeId: args.node_id,
      sessionId: args.session_id
    }, null, 2);
  }
  const cached = resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
  const result = await commandForNode(ctx, node, "read_terminal", {
    sessionId: args.session_id,
    targetSessionId: args.session_id,
    workspace: node.workspace,
    ...cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {},
    ...typeof args.max_bytes === "number" && Number.isFinite(args.max_bytes) ? { maxBytes: args.max_bytes } : {}
  });
  const payload = unwrapCommandPayload(result);
  return JSON.stringify(payload, null, 2);
}
var MESH_SEND_KEYS_DESTRUCTIVE = /* @__PURE__ */ new Set(["CTRL_C", "ESC"]);
async function meshSendKeys(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  const items = Array.isArray(args.sequence) ? args.sequence : [];
  if (items.length === 0) {
    return JSON.stringify({ success: false, error: "sequence (non-empty array of {text}|{key}) required" }, null, 2);
  }
  const liveSessions = await collectLiveStatusSessions(ctx, node);
  const record = liveSessions.find((s) => readSessionRecordId(s) === args.session_id);
  if (record && !isMeshOwnedDelegateSession(record, ctx.mesh.id, args.node_id)) {
    return JSON.stringify({
      success: false,
      error: "session is not a mesh-owned delegate of this mesh/node \u2014 mesh_send_keys is scoped to sessions this coordinator spawned",
      nodeId: args.node_id,
      sessionId: args.session_id
    }, null, 2);
  }
  const requestedKeys = items.map((it) => it && typeof it.key === "string" ? it.key : "").filter(Boolean);
  const hasDestructive = requestedKeys.some((k) => MESH_SEND_KEYS_DESTRUCTIVE.has(k));
  const auditKeys = requestedKeys.slice(0, 64);
  const recordAudit = (result2, extra = {}) => {
    try {
      (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
        kind: "key_injection",
        nodeId: args.node_id,
        sessionId: args.session_id,
        payload: {
          keys: auditKeys,
          // key ENUMS only — never the literal text body
          hasDestructive,
          confirmDestructive: args.confirm_destructive === true,
          result: result2,
          ...extra
        }
      });
    } catch {
    }
  };
  if (hasDestructive) {
    const policyAllows = (0, import_daemon_core4.resolveAllowSendKeysDestructive)(ctx.mesh.policy, node.policy);
    if (args.confirm_destructive !== true || !policyAllows) {
      recordAudit("refused", { refused: "destructive_gate", policyAllows });
      return JSON.stringify({
        success: false,
        error: "destructive key (CTRL_C/ESC) requires BOTH confirm_destructive=true AND mesh policy allowSendKeysDestructive=true",
        refused: "destructive_gate",
        confirmDestructive: args.confirm_destructive === true,
        policyAllowsDestructive: policyAllows
      }, null, 2);
    }
  }
  const cached = resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
  const result = await commandForNode(ctx, node, "send_keys", {
    sessionId: args.session_id,
    targetSessionId: args.session_id,
    workspace: node.workspace,
    ...cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {},
    sequence: items,
    confirm_destructive: args.confirm_destructive === true,
    allow_modal_override: args.allow_modal_override === true
  });
  const payload = unwrapCommandPayload(result);
  if (payload?.success === true) {
    recordAudit("injected", { submits: payload.submits === true });
  } else {
    recordAudit("refused", { refused: readString(payload?.refused) || "error" });
  }
  return JSON.stringify(payload, null, 2);
}
async function meshLaunchSession(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  const bootstrapBlock = getWorktreeBootstrapLaunchBlock(node, ctx.mesh.policy);
  if (bootstrapBlock) return JSON.stringify(bootstrapBlock, null, 2);
  {
    const requestedType = typeof args.type === "string" && args.type.trim() ? args.type.trim() : "";
    let resolvedProviderType = requestedType;
    if (requestedType) {
      const slotProviders = normalizeNodeCapabilitySlots(node.policy?.slots).map((s) => s.provider);
      if (slotProviders.length && !slotProviders.includes(requestedType)) {
        return JSON.stringify({
          success: false,
          code: "mesh_provider_type_unsupported",
          error: `Node '${args.node_id}' does not support provider '${requestedType}'. Its capability slots (policy.slots) declare: ${slotProviders.join(", ")}. Configure a slot for '${requestedType}' via mesh_node_slots_set, or launch with one of the supported types.`,
          nodeId: args.node_id,
          requestedType,
          supportedProviders: slotProviders
        }, null, 2);
      }
    }
    if (!resolvedProviderType) {
      const providerPriority = readProviderPriority(node.policy);
      if (!providerPriority.length) {
        return JSON.stringify({ success: false, error: missingProviderPriorityMessage(args.node_id) });
      }
      const failed = [];
      let unreachableError = null;
      for (const providerType of providerPriority) {
        let detectedPayload;
        try {
          const detectedResult = await commandForNode(ctx, node, "detect_provider", { providerType }, { statusProbe: true });
          detectedPayload = unwrapCommandPayload(detectedResult);
        } catch (e) {
          unreachableError = e?.message || String(e);
          break;
        }
        if (detectedPayload?.success && detectedPayload?.detected) {
          resolvedProviderType = providerType;
          break;
        }
        failed.push(`${providerType}: ${detectedPayload?.error || "not detected"}`);
      }
      if (!resolvedProviderType) {
        if (unreachableError) {
          return JSON.stringify({ success: false, error: `Node '${args.node_id}' is unreachable \u2014 cannot detect a provider (${unreachableError}). The node's daemon may be offline; retry once it reconnects.` });
        }
        return JSON.stringify({ success: false, error: `No usable provider detected for node '${args.node_id}' from providerPriority: ${failed.join("; ")}` });
      }
    }
    const coordinatorNode = resolveCoordinatorNode(ctx);
    const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
    const spawnedSessionVisibility = readSpawnedSessionVisibility(ctx.mesh.policy);
    const delegatedWorkerAutoApprove = (0, import_daemon_core4.resolveDelegatedWorkerAutoApprove)(ctx.mesh.policy, node.policy);
    let requestedAutoApproveMode;
    const delegatedWorkerDangerousModeAllow = (0, import_daemon_core4.resolveDelegatedWorkerDangerousModeAllow)(ctx.mesh.policy, node.policy);
    if (delegatedWorkerAutoApprove !== false) {
      try {
        const ws = typeof node.workspace === "string" && node.workspace.trim() ? node.workspace.trim() : "";
        if (ws) {
          const repo = (0, import_daemon_core4.loadRepoMeshJsonConfig)(ws);
          const repoMode = repo.sourceType === "repo_file" ? repo.config?.providerDefaults?.autoApproveModes?.[resolvedProviderType] : void 0;
          if (typeof repoMode === "string" && repoMode.trim()) requestedAutoApproveMode = repoMode.trim();
        }
      } catch {
      }
    }
    const isLocalNode = isLocalControlPlaneNode(ctx, node);
    if (node.daemonId && !isLocalNode && !coordinatorDaemonId) {
      return JSON.stringify(buildMissingCoordinatorDaemonIdFailure(ctx, node, resolvedProviderType), null, 2);
    }
    if (args.force !== true) {
      try {
        const statusResult = await commandForNode(ctx, node, "get_status_metadata", {});
        const sessions = extractStatusMetadataSessions(statusResult);
        const existing = sessions.find((session) => {
          if (isTerminalSessionRecord(session)) return false;
          if (!isMeshOwnedDelegateSession(session, ctx.mesh.id, args.node_id)) return false;
          if (resolvedProviderType) {
            const sessionProviderType = resolveSessionProviderType(session);
            if (sessionProviderType && sessionProviderType !== resolvedProviderType) return false;
          }
          return true;
        });
        if (existing) {
          const existingSessionId = readSessionRecordId(existing);
          if (existingSessionId) {
            const existingProviderType = resolveSessionProviderType(existing) || resolvedProviderType || void 0;
            const existingStatus = typeof existing?.status === "string" ? existing.status : "unknown";
            return JSON.stringify({
              success: true,
              duplicate: true,
              launched: false,
              reused: true,
              sessionId: existingSessionId,
              nodeId: args.node_id,
              ...existingProviderType ? { resolvedProviderType: existingProviderType, providerType: existingProviderType } : {},
              sessionStatus: existingStatus,
              idle: isIdleSessionRecord(existing),
              reason: "mesh_launch_session_duplicate_guard",
              warning: `Node '${args.node_id}' already has a live mesh-owned worker session ('${existingSessionId}', status '${existingStatus}'). Returning it instead of launching an empty duplicate (likely an enqueue auto-launch already spawned it).`,
              nextAction: `Use session '${existingSessionId}' for mesh_send_task/mesh_read_chat. If you intentionally need a second concurrent session on this node, retry mesh_launch_session with force=true.`
            }, null, 2);
          }
        }
      } catch {
      }
    }
    let result;
    try {
      result = await commandForNode(ctx, node, "launch_cli", {
        cliType: resolvedProviderType,
        dir: node.workspace,
        settings: {
          // Worker launch envelope (A5): structured metadata so worker sessions
          // know their role and can route completion events back correctly.
          role: "worker",
          meshNodeFor: ctx.mesh.id,
          meshNodeId: args.node_id,
          spawnedSessionVisibility,
          // Delegated worker auto-approval (see resolveDelegatedWorkerAutoApprove).
          // Lands in settingsOverride and beats the global per-provider autoApprove.
          // When a repo-requested mode ID is present AND auto-approve is enabled,
          // stamp the mode ID (validated daemon-side) alongside the boolean; the
          // adapter's resolveProviderAutoApproveMode prefers the mode and fails
          // closed on an unknown ID. delegatedWorkerDangerousModeAllow rides along
          // so the adapter can honor/deny a dangerous requested mode.
          autoApprove: delegatedWorkerAutoApprove,
          ...requestedAutoApproveMode ? { autoApproveMode: requestedAutoApproveMode } : {},
          delegatedWorkerDangerousModeAllow,
          ...coordinatorDaemonId ? { meshCoordinatorDaemonId: coordinatorDaemonId } : {},
          // (3) Stamp the originating coordinator SESSION at launch too, so a worker
          // launched via mesh_launch_session routes its completions back to the exact
          // coordinator session (multi-coordinator). Absent → daemon-level fallback.
          ...ctx.coordinatorSessionId ? { meshCoordinatorSessionId: ctx.coordinatorSessionId } : {},
          ...coordinatorNode?.id ? { meshCoordinatorNodeId: coordinatorNode.id } : {},
          launchedByCoordinator: true
        }
      });
    } catch (e) {
      return JSON.stringify(recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, e), null, 2);
    }
    const launchPayload = extractLaunchPayload(result);
    if (launchPayload?.success === false || result?.success === false) {
      const launchError = new Error(launchPayload?.error || result?.error || "launch_cli rejected the session launch");
      return JSON.stringify(recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, launchError), null, 2);
    }
    const runtimeSessionId = typeof launchPayload?.sessionId === "string" ? launchPayload.sessionId : typeof launchPayload?.id === "string" ? launchPayload.id : typeof launchPayload?.runtimeSessionId === "string" ? launchPayload.runtimeSessionId : "";
    const providerSessionId = typeof launchPayload?.providerSessionId === "string" && launchPayload.providerSessionId.trim() ? launchPayload.providerSessionId.trim() : void 0;
    if (runtimeSessionId) {
      meshSessionProviderMetadata.set(meshSessionCacheKey(args.node_id, runtimeSessionId), {
        providerType: resolvedProviderType,
        ...providerSessionId ? { providerSessionId } : {},
        expiresAt: Date.now() + SESSION_PROVIDER_METADATA_TTL_MS
      });
    }
    try {
      (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
        kind: "session_launched",
        nodeId: args.node_id,
        sessionId: runtimeSessionId || void 0,
        providerType: resolvedProviderType,
        payload: { providerSessionId }
      });
    } catch {
    }
    const queueTrigger = await triggerMeshQueueAndReport(ctx);
    return JSON.stringify({
      ...launchPayload,
      resolvedProviderType,
      ...providerSessionId ? { providerSessionId } : {},
      queueTrigger,
      ...buildQueueTriggerGuidance(queueTrigger)
    }, null, 2);
  }
}
async function meshApprove(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  const cached = getSessionMetadata(meshSessionCacheKey(args.node_id, args.session_id));
  const providerSessionId = cached?.providerSessionId;
  const result = await commandForNode(ctx, node, "resolve_action", {
    sessionId: args.session_id,
    targetSessionId: args.session_id,
    workspace: node.workspace,
    ...cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {},
    ...providerSessionId ? { providerSessionId } : {},
    action: args.action === "reject" ? "reject" : "approve"
  });
  return JSON.stringify(result, null, 2);
}
async function meshAnswerQuestion(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  if (!args.promptId || typeof args.promptId !== "string") {
    return JSON.stringify({ success: false, error: "promptId is required (from the agent:waiting_choice event)." }, null, 2);
  }
  if (!Array.isArray(args.answers)) {
    return JSON.stringify({ success: false, error: "answers must be an array (one entry per question)." }, null, 2);
  }
  const result = await commandForNode(ctx, node, "interactive_prompt_response", {
    targetSessionId: args.session_id,
    sessionId: args.session_id,
    workspace: node.workspace,
    response: {
      promptId: args.promptId,
      answers: args.answers
    }
  });
  return JSON.stringify(result, null, 2);
}
async function meshListPendingApprovals(ctx, _args = {}) {
  (0, import_daemon_core4.recordMeshToolCall)({ meshId: ctx.mesh.id, tool: "mesh_list_pending_approvals" });
  await refreshMeshFromDaemon(ctx);
  const liveNodes = await collectMeshViewQueueNodesWithLiveSessions(ctx);
  let ledgerEntries = (0, import_daemon_core4.readLedgerEntries)(ctx.mesh.id, { tail: 200 });
  let directDispatches = (0, import_daemon_core4.getActiveDirectDispatches)(ctx.mesh.id);
  const directReconciliation = await reconcileDirectDispatchesFromTranscriptEvidence(ctx, liveNodes, directDispatches, ledgerEntries);
  if (directReconciliation.reconciled > 0) {
    ledgerEntries = (0, import_daemon_core4.readLedgerEntries)(ctx.mesh.id, { tail: 200 });
    directDispatches = (0, import_daemon_core4.getActiveDirectDispatches)(ctx.mesh.id);
  }
  (0, import_daemon_core4.markStaleDirectDispatches)(ctx.mesh.id);
  directDispatches = (0, import_daemon_core4.getActiveDirectDispatches)(ctx.mesh.id);
  const activeWorkEvidence = (0, import_daemon_core4.buildMeshActiveWork)({
    meshId: ctx.mesh.id,
    queue: (0, import_daemon_core4.getQueue)(ctx.mesh.id),
    ledgerEntries,
    directDispatches,
    nodes: liveNodes
  });
  const approvals = (0, import_daemon_core4.collectPendingApprovals)(activeWorkEvidence.activeWork);
  return JSON.stringify({
    count: approvals.length,
    approvals,
    ...approvals.length === 0 ? { note: "No sessions are currently awaiting an approval decision." } : { nextStep: 'Resolve each with mesh_approve(node_id, session_id, action: "approve" | "reject").' }
  }, null, 2);
}
async function meshCleanupSessions(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  const result = await commandForNode(ctx, node, "cleanup_mesh_sessions", {
    meshId: ctx.mesh.id,
    nodeId: args.node_id,
    mode: args.mode,
    sessionIds: args.session_ids,
    dryRun: args.dry_run === true,
    inlineMesh: ctx.mesh
  });
  return JSON.stringify(result, null, 2);
}

// src/tools/mesh-tools-git.ts
async function meshGitStatus(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  const autoDiscoverSubmodules = node.policy?.autoDiscoverSubmodules !== false;
  const submoduleIgnorePaths = node.policy?.submoduleIgnorePaths || [];
  try {
    const statusResult = await commandForNode(ctx, node, "git_status", {
      workspace: node.workspace,
      refreshUpstream: true,
      includeSubmodules: autoDiscoverSubmodules,
      submoduleIgnorePaths: submoduleIgnorePaths.length > 0 ? submoduleIgnorePaths : void 0
    });
    const diffResult = await commandForNode(ctx, node, "git_diff_summary", {
      workspace: node.workspace
    });
    return JSON.stringify({
      nodeId: args.node_id,
      workspace: node.workspace,
      status: extractGitStatus(statusResult),
      diff: extractGitDiff(diffResult),
      submodules: autoDiscoverSubmodules ? extractSubmodules(statusResult, submoduleIgnorePaths) : void 0,
      relatedRepos: await collectRelatedRepoStatuses(ctx, node)
    }, null, 2);
  } catch (e) {
    const failure = buildCoordinatorP2pRelayFailure(e, {
      command: "git_status",
      targetDaemonId: node.daemonId,
      nodeId: args.node_id
    });
    return JSON.stringify({
      ...failure,
      workspace: node.workspace
    }, null, 2);
  }
}
async function meshReadNodeLogs(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  try {
    const result = await commandForNode(ctx, node, "get_mesh_node_logs", {
      meshId: ctx.mesh.id,
      nodeId: args.node_id,
      ...typeof args.grep === "string" && args.grep.trim() ? { grep: args.grep.trim() } : {},
      ...Number.isFinite(args.since_ms) ? { sinceMs: args.since_ms } : {},
      ...Number.isFinite(args.tail_bytes) ? { tailBytes: args.tail_bytes } : {},
      ...typeof args.date === "string" && args.date.trim() ? { date: args.date.trim() } : {}
    });
    const payload = unwrapCommandPayload(result);
    return JSON.stringify(payload, null, 2);
  } catch (e) {
    const failure = buildCoordinatorP2pRelayFailure(e, {
      command: "get_mesh_node_logs",
      targetDaemonId: node.daemonId,
      nodeId: args.node_id
    });
    return JSON.stringify(failure, null, 2);
  }
}
async function meshFastForwardNode(ctx, args) {
  await refreshMeshFromDaemon(ctx);
  const node = await findNodeWithRefresh(ctx, args.node_id);
  const submoduleIgnorePaths = node.policy?.submoduleIgnorePaths || [];
  if (node.policy?.readOnly) {
    return JSON.stringify({
      success: false,
      code: "node_read_only",
      nodeId: args.node_id,
      workspace: node.workspace,
      allowed: false,
      willRun: false,
      executed: false,
      blockingReasons: ["node_read_only"]
    }, null, 2);
  }
  try {
    const dryRun = args.dry_run === true || args.execute !== true;
    const result = await commandForNode(ctx, node, "fast_forward_mesh_node", {
      meshId: ctx.mesh.id,
      nodeId: node.id,
      workspace: node.workspace,
      mode: args.mode === "push" ? "push" : "merge",
      branch: typeof args.branch === "string" ? args.branch : void 0,
      execute: args.execute === true && args.dry_run !== true,
      dryRun,
      updateSubmodules: args.update_submodules === true,
      pushSubmodules: args.push_submodules === true,
      submoduleIgnorePaths: submoduleIgnorePaths.length > 0 ? submoduleIgnorePaths : void 0
    });
    return JSON.stringify(unwrapCommandPayload(result), null, 2);
  } catch (e) {
    const failure = buildCoordinatorP2pRelayFailure(e, {
      command: "fast_forward_mesh_node",
      targetDaemonId: node.daemonId,
      nodeId: args.node_id
    });
    return JSON.stringify({
      ...failure,
      workspace: node.workspace,
      allowed: false,
      willRun: false,
      executed: false,
      blockingReasons: [failure.code || "mesh_fast_forward_unavailable"]
    }, null, 2);
  }
}
async function meshRestartDaemon(ctx, args) {
  await refreshMeshFromDaemon(ctx);
  const node = await findNodeWithRefresh(ctx, args.node_id);
  try {
    const result = await commandForNode(ctx, node, "restart_daemon_node", {
      meshId: ctx.mesh.id,
      nodeId: node.id,
      inlineMesh: ctx.mesh,
      ...args.channel ? { channel: args.channel } : {},
      ...args.mode ? { mode: args.mode } : {},
      ...args.force === true ? { force: true } : {},
      ...args.self_only === true ? { selfOnly: true } : {},
      ...args.when_idle === true ? { whenIdle: true } : {},
      ...args.cancel_when_idle === true ? { cancelWhenIdle: true } : {},
      ...typeof args.timeout_ms === "number" ? { timeoutMs: args.timeout_ms } : {},
      ...args.kill_session_host === true ? { killSessionHost: true } : {}
    });
    return JSON.stringify(unwrapCommandPayload(result), null, 2);
  } catch (e) {
    const failure = buildCoordinatorP2pRelayFailure(e, {
      command: "restart_daemon_node",
      targetDaemonId: node.daemonId,
      nodeId: args.node_id
    });
    return JSON.stringify(failure, null, 2);
  }
}
async function meshCheckpoint(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  if (node.policy?.readOnly) {
    return JSON.stringify({ error: `Node '${args.node_id}' is read-only \u2014 cannot checkpoint` });
  }
  const result = await commandForNode(ctx, node, "git_checkpoint", {
    workspace: node.workspace,
    message: args.message,
    includeUntracked: true
  });
  try {
    (0, import_daemon_core4.appendLedgerEntry)(ctx.mesh.id, {
      kind: "checkpoint_created",
      nodeId: args.node_id,
      payload: {
        message: args.message,
        commit: result?.checkpoint?.commit,
        outcome: result?.checkpoint?.status || (result?.checkpoint?.noop ? "skipped" : void 0),
        noop: result?.checkpoint?.noop === true,
        reason: result?.checkpoint?.reason
      }
    });
  } catch {
  }
  return JSON.stringify(result, null, 2);
}
async function meshCloneNode(ctx, args) {
  const sourceNode = await findNodeWithRefresh(ctx, args.source_node_id);
  const planned = unwrapCommandPayload(await commandForNode(ctx, sourceNode, "plan_mesh_onboarding", {
    workspace: sourceNode.workspace,
    meshId: ctx.mesh.id,
    inlineMesh: ctx.mesh,
    operation: "clone_worktree",
    branch: args.branch
  }));
  if (!planned?.success) {
    return JSON.stringify({
      success: false,
      dry_run: true,
      code: planned?.code || "onboarding_blocked",
      error: planned?.error || "Worktree clone preflight failed",
      action: planned?.action,
      raw: planned
    }, null, 2);
  }
  const result = await commandForNode(ctx, sourceNode, "clone_mesh_node", {
    meshId: ctx.mesh.id,
    sourceNodeId: args.source_node_id,
    branch: args.branch,
    baseBranch: args.base_branch,
    inlineMesh: ctx.mesh
  });
  const clonePayload = extractCloneNodePayload(result);
  if (clonePayload?.success && clonePayload.node?.id) {
    const existingIndex = ctx.mesh.nodes.findIndex((n) => n.id === clonePayload.node.id);
    if (existingIndex >= 0) ctx.mesh.nodes[existingIndex] = clonePayload.node;
    else ctx.mesh.nodes.push(clonePayload.node);
    ctx.mesh.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    await syncCoordinatorDaemonMeshCache(ctx);
  }
  return JSON.stringify(result, null, 2);
}
async function meshRemoveNode(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  const removeArgs = buildRemoveNodeArgs(ctx, args.node_id, args.session_cleanup_mode, args.force === true);
  let result;
  let transportFallback;
  try {
    result = await commandForNode(ctx, node, "remove_mesh_node", removeArgs);
  } catch (e) {
    if (ctx.transport instanceof IpcTransport && node.isLocalWorktree && isP2pTransportUnavailableError(e)) {
      result = await ctx.transport.command("remove_mesh_node", removeArgs);
      transportFallback = {
        from: "p2p_mesh_relay",
        to: "local_control_plane",
        reason: e?.message || String(e)
      };
    } else {
      return JSON.stringify({
        success: false,
        code: isP2pTransportUnavailableError(e) ? "p2p_unavailable" : "mesh_remove_node_failed",
        error: e?.message || String(e),
        recoveryHint: isP2pTransportUnavailableError(e) ? "If this is an ADHDev-managed local worktree, retry from a coordinator connected to the daemon that owns the worktree; dashboard command/data-plane traffic still requires P2P." : "Inspect mesh_status and retry after resolving the reported failure."
      }, null, 2);
    }
  }
  if (result?.success && result.removed !== false) {
    const idx = ctx.mesh.nodes.findIndex((n) => n.id === args.node_id);
    if (idx >= 0) {
      ctx.mesh.nodes.splice(idx, 1);
      ctx.mesh.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    }
  }
  return JSON.stringify({ ...result || {}, ...transportFallback ? { transportFallback } : {} }, null, 2);
}
async function meshCleanupWorktreeNodes(ctx, args) {
  const dryRun = args?.dry_run !== false;
  const wireArgs = {
    meshId: ctx.mesh.id,
    dryRun,
    ...args?.node_id ? { nodeId: args.node_id } : {}
  };
  let result;
  try {
    if (args?.node_id) {
      const node = await findNodeWithRefresh(ctx, args.node_id);
      result = await commandForNode(ctx, node, "cleanup_worktree_nodes", wireArgs);
    } else {
      result = await ctx.transport.command("cleanup_worktree_nodes", wireArgs);
    }
  } catch (e) {
    return JSON.stringify({
      success: false,
      code: isP2pTransportUnavailableError(e) ? "p2p_unavailable" : "mesh_cleanup_worktree_nodes_failed",
      error: e?.message || String(e),
      recoveryHint: "Inspect mesh_status and retry after resolving the reported failure; per-node reasons are never hidden in a successful plan."
    }, null, 2);
  }
  if (!dryRun && result?.success && Array.isArray(result.entries)) {
    let changed = false;
    for (const entry of result.entries) {
      if (entry?.execution?.success && entry.execution.removed) {
        const idx = ctx.mesh.nodes.findIndex((n) => n.id === entry.nodeId);
        if (idx >= 0) {
          ctx.mesh.nodes.splice(idx, 1);
          changed = true;
        }
      }
    }
    if (changed) ctx.mesh.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  return JSON.stringify(result ?? { success: false, error: "no response from daemon" }, null, 2);
}

// src/tools/mesh-tools-crud.ts
async function meshPlanOnboarding(transport, args, defaultMeshId) {
  const workspace = typeof args?.workspace === "string" ? args.workspace.trim() : "";
  if (!workspace) {
    return JSON.stringify({
      success: false,
      dryRun: true,
      code: "workspace_required",
      error: "workspace required",
      action: "Pass an absolute path on the daemon that owns the checkout."
    }, null, 2);
  }
  const meshId = typeof args?.mesh_id === "string" && args.mesh_id.trim() ? args.mesh_id.trim() : typeof defaultMeshId === "string" ? defaultMeshId.trim() : "";
  const result = await transport.command("plan_mesh_onboarding", {
    workspace,
    ...meshId ? { meshId } : {},
    ...args?.operation ? { operation: args.operation } : {},
    ...typeof args?.branch === "string" && args.branch.trim() ? { branch: args.branch.trim() } : {}
  });
  return JSON.stringify(unwrapCommandPayload(result), null, 2);
}
async function meshCreate(transport, args) {
  const name = typeof args?.name === "string" ? args.name.trim() : "";
  if (!name) {
    return JSON.stringify({ success: false, error: "name required" }, null, 2);
  }
  let repoRemoteUrl = typeof args?.repo_remote_url === "string" ? args.repo_remote_url.trim() : "";
  let repoIdentity = typeof args?.repo_identity === "string" ? args.repo_identity.trim() : "";
  let defaultBranch = typeof args?.default_branch === "string" ? args.default_branch.trim() : "";
  let discovery;
  if (!repoRemoteUrl && !repoIdentity) {
    const workspace = typeof args?.workspace === "string" && args.workspace.trim() ? args.workspace.trim() : void 0;
    const planned = unwrapCommandPayload(await transport.command("plan_mesh_onboarding", {
      ...workspace ? { workspace } : {},
      operation: "auto"
    }));
    if (!planned?.success) {
      return JSON.stringify({
        success: false,
        dry_run: true,
        code: planned?.code || "onboarding_blocked",
        error: planned?.error || "Could not infer repository identity from the workspace.",
        action: planned?.action,
        raw: planned
      }, null, 2);
    }
    if (planned?.plan?.kind !== "create_mesh_and_onboard") {
      return JSON.stringify({
        success: false,
        dry_run: true,
        code: "compatible_mesh_exists",
        error: planned?.plan?.summary || "A compatible mesh already exists.",
        action: "Use mesh_add_node with the compatible mesh instead of creating a duplicate mesh.",
        raw: planned
      }, null, 2);
    }
    discovery = planned.discovery;
    repoRemoteUrl = discovery?.origin?.urls?.[0] || discovery?.upstream?.urls?.[0] || "";
    repoIdentity = discovery?.repoIdentity || "";
    defaultBranch ||= discovery?.defaultBranch || "";
  }
  const createResult = await transport.command("create_mesh", {
    name,
    ...repoRemoteUrl ? { repoRemoteUrl } : {},
    ...repoIdentity ? { repoIdentity } : {},
    ...defaultBranch ? { defaultBranch } : {}
  });
  const createPayload = unwrapCommandPayload(createResult);
  const mesh = createPayload?.mesh;
  if (!createPayload?.success || !mesh?.id) {
    return JSON.stringify({
      success: false,
      error: createPayload?.error || "create_mesh failed",
      raw: createPayload ?? createResult
    }, null, 2);
  }
  const out = {
    success: true,
    mesh_id: mesh.id,
    name: mesh.name,
    repo_identity: mesh.repoIdentity,
    default_branch: mesh.defaultBranch,
    node_count: Array.isArray(mesh.nodes) ? mesh.nodes.length : 0,
    next_step: `Add the base node with mesh_add_node (mesh_id: "${mesh.id}", workspace: <repo path>), then start mesh mode with: adhdev mcp --repo-mesh ${mesh.id}`
  };
  if (args?.add_current === true) {
    const workspace = typeof args?.workspace === "string" && args.workspace.trim() ? args.workspace.trim() : "";
    const addResult = await transport.command("add_mesh_node", {
      meshId: mesh.id,
      ...workspace || discovery?.repoRoot ? { workspace: discovery?.repoRoot || workspace } : {},
      ...discovery?.repoRoot ? { repoRoot: discovery.repoRoot } : {},
      ...discovery?.isLinkedWorktree === true ? { isLocalWorktree: true } : {},
      inlineMesh: mesh
    });
    const addPayload = unwrapCommandPayload(addResult);
    if (addPayload?.success && addPayload?.node?.id) {
      out.node_id = addPayload.node.id;
      out.node_workspace = addPayload.node.workspace;
    } else {
      out.add_current_error = addPayload?.error || "add_mesh_node failed (mesh was still created)";
    }
  }
  return JSON.stringify(out, null, 2);
}
async function meshAddNode(transport, args, defaultMeshId) {
  const meshId = typeof args?.mesh_id === "string" && args.mesh_id.trim() ? args.mesh_id.trim() : typeof defaultMeshId === "string" ? defaultMeshId.trim() : "";
  const workspace = typeof args?.workspace === "string" ? args.workspace.trim() : "";
  if (!meshId) {
    return JSON.stringify({ success: false, error: "mesh_id required (create one first with mesh_create)." }, null, 2);
  }
  if (!workspace) {
    return JSON.stringify({ success: false, error: "workspace required (absolute path to the repo checkout on the target daemon)." }, null, 2);
  }
  const providerPriority = Array.isArray(args?.provider_priority) ? args.provider_priority.map((v) => typeof v === "string" ? v.trim() : "").filter(Boolean) : typeof args?.provider_priority === "string" ? args.provider_priority.split(",").map((v) => v.trim()).filter(Boolean) : [];
  const planResult = await transport.command("plan_mesh_onboarding", {
    meshId,
    workspace,
    operation: "add_existing",
    ...args?.inline_mesh ? { inlineMesh: args.inline_mesh } : {}
  });
  const planPayload = unwrapCommandPayload(planResult);
  if (!planPayload?.success) {
    return JSON.stringify({
      success: false,
      dry_run: true,
      code: planPayload?.code || "onboarding_blocked",
      error: planPayload?.error || "Repo Mesh onboarding preflight failed",
      action: planPayload?.action,
      raw: planPayload ?? planResult
    }, null, 2);
  }
  const discoveredWorkspace = typeof planPayload?.discovery?.repoRoot === "string" ? planPayload.discovery.repoRoot : workspace;
  const addResult = await transport.command("add_mesh_node", {
    meshId,
    workspace: discoveredWorkspace,
    repoRoot: discoveredWorkspace,
    ...args?.read_only === true ? { readOnly: true } : {},
    ...providerPriority.length ? { providerPriority } : {},
    ...args?.is_worktree === true || planPayload?.discovery?.isLinkedWorktree === true ? { isLocalWorktree: true } : {},
    ...args?.inline_mesh ? { inlineMesh: args.inline_mesh } : {}
  });
  const addPayload = unwrapCommandPayload(addResult);
  if (!addPayload?.success || !addPayload?.node?.id) {
    return JSON.stringify({
      success: false,
      error: addPayload?.error || "add_mesh_node failed",
      code: addPayload?.code,
      raw: addPayload ?? addResult
    }, null, 2);
  }
  return JSON.stringify({
    success: true,
    mesh_id: meshId,
    node_id: addPayload.node.id,
    workspace: addPayload.node.workspace,
    read_only: addPayload.node.policy?.readOnly === true,
    provider_priority: addPayload.node.policy?.providerPriority,
    next_step: `Node registered. Launch an agent on it with mesh_launch_session (node_id: "${addPayload.node.id}") or delegate work with mesh_send_task / mesh_enqueue_task.`
  }, null, 2);
}

// src/tools/mesh-tools-refine.ts
async function meshRefineConfigSchema(ctx) {
  const node = resolveRefineConfigNode(ctx);
  const result = await commandForNode(ctx, node, "get_mesh_refine_config_schema", {});
  return JSON.stringify(result, null, 2);
}
async function meshValidateRefineConfig(ctx, args) {
  const node = resolveRefineConfigNode(ctx, args.node_id);
  const result = await commandForNode(ctx, node, "validate_mesh_refine_config", {
    workspace: node.workspace,
    inlineMesh: ctx.mesh,
    ...args.config ? { config: args.config } : {}
  });
  return JSON.stringify(result, null, 2);
}
async function meshSuggestRefineConfig(ctx, args) {
  const node = resolveRefineConfigNode(ctx, args.node_id);
  const result = await commandForNode(ctx, node, "suggest_mesh_refine_config", {
    workspace: node.workspace,
    inlineMesh: ctx.mesh
  });
  return JSON.stringify(result, null, 2);
}
async function meshRefineConfig(ctx, args = {}) {
  switch (args.mode) {
    case "schema":
      return meshRefineConfigSchema(ctx);
    case "validate":
      return meshValidateRefineConfig(ctx, args);
    case "suggest":
      return meshSuggestRefineConfig(ctx, args);
    default:
      throw new Error(
        `mesh_refine_config: invalid or missing 'mode' (${JSON.stringify(args.mode)}). Expected one of: 'schema' | 'validate' | 'suggest'.`
      );
  }
}
async function meshChangeImpactConfigSchema(ctx) {
  const node = resolveRefineConfigNode(ctx);
  const result = await commandForNode(ctx, node, "get_mesh_change_impact_config_schema", {});
  return JSON.stringify(result, null, 2);
}
async function meshValidateChangeImpactConfig(ctx, args) {
  const node = resolveRefineConfigNode(ctx, args.node_id);
  const result = await commandForNode(ctx, node, "validate_mesh_change_impact_config", {
    workspace: node.workspace,
    ...args.config ? { config: args.config } : {}
  });
  return JSON.stringify(result, null, 2);
}
async function meshSuggestChangeImpactConfig(ctx, args) {
  const node = resolveRefineConfigNode(ctx, args.node_id);
  const result = await commandForNode(ctx, node, "suggest_mesh_change_impact_config", {
    workspace: node.workspace
  });
  return JSON.stringify(result, null, 2);
}
async function meshChangeImpactConfig(ctx, args = {}) {
  switch (args.mode) {
    case "schema":
      return meshChangeImpactConfigSchema(ctx);
    case "validate":
      return meshValidateChangeImpactConfig(ctx, args);
    case "suggest":
      return meshSuggestChangeImpactConfig(ctx, args);
    default:
      throw new Error(
        `mesh_change_impact_config: invalid or missing 'mode' (${JSON.stringify(args.mode)}). Expected one of: 'schema' | 'validate' | 'suggest'.`
      );
  }
}
async function meshInit(ctx, args) {
  const node = resolveRefineConfigNode(ctx, args.node_id);
  const result = await commandForNode(ctx, node, "mesh_init", {
    workspace: node.workspace,
    inlineMesh: ctx.mesh,
    ...args.write !== void 0 ? { write: args.write } : {},
    ...args.overwrite !== void 0 ? { overwrite: args.overwrite } : {}
  });
  return JSON.stringify(result, null, 2);
}
async function meshReinit(ctx, args) {
  const node = resolveRefineConfigNode(ctx, args.node_id);
  const overwrite = args.overwrite !== false;
  const result = await commandForNode(ctx, node, "mesh_init", {
    workspace: node.workspace,
    inlineMesh: ctx.mesh,
    ...args.write !== void 0 ? { write: args.write } : {},
    overwrite
  });
  const annotated = result && typeof result === "object" ? {
    ...result,
    mode: "reinit",
    reinitContract: "Overwrite replaces existing config wholesale. Present the per-section current-vs-suggested diff (see currentConfig) and get EXPLICIT per-section user approval before re-invoking with write=true. Never silently drop operator hand-edits."
  } : result;
  return JSON.stringify(annotated, null, 2);
}
async function meshWriteMeshJsonConfig(ctx, args = {}) {
  const node = resolveRefineConfigNode(ctx, args.node_id);
  const result = await commandForNode(ctx, node, "write_mesh_json_config", {
    meshId: ctx.mesh.id,
    workspace: typeof args.workspace === "string" && args.workspace.trim() ? args.workspace.trim() : node.workspace,
    ...args.write !== void 0 ? { write: args.write } : {},
    ...args.overwrite !== void 0 ? { overwrite: args.overwrite } : {}
  });
  return JSON.stringify(result, null, 2);
}
async function meshRefinePlan(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  const result = await commandForNode(ctx, node, "plan_mesh_refine_node", {
    meshId: ctx.mesh.id,
    nodeId: args.node_id,
    inlineMesh: ctx.mesh
  });
  return JSON.stringify(result, null, 2);
}
async function meshRefineNode(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  const result = await commandForNode(ctx, node, "refine_mesh_node", {
    meshId: ctx.mesh.id,
    nodeId: args.node_id,
    ...args.execute !== void 0 ? { execute: args.execute } : {},
    ...args.dry_run !== void 0 ? { dryRun: args.dry_run } : {},
    inlineMesh: ctx.mesh
  });
  if (result?.success && result.async !== true && result.removeResult?.removed !== false) {
    const idx = ctx.mesh.nodes.findIndex((n) => n.id === args.node_id);
    if (idx >= 0) {
      ctx.mesh.nodes.splice(idx, 1);
      ctx.mesh.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    }
  }
  return JSON.stringify(result, null, 2);
}
async function meshRefineBatch(ctx, args = {}) {
  await refreshMeshFromDaemon(ctx);
  const nodeIds = Array.isArray(args.node_ids) ? args.node_ids.filter((v) => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()) : void 0;
  const result = await ctx.transport.command("batch_refine_mesh_nodes", {
    meshId: ctx.mesh.id,
    ...nodeIds ? { nodeIds } : {},
    ...args.execute !== void 0 ? { execute: args.execute } : {},
    ...args.dry_run !== void 0 ? { dryRun: args.dry_run } : {},
    inlineMesh: ctx.mesh
  });
  const payload = unwrapCommandPayload(result) ?? result;
  if (payload?.batch && payload?.dryRun === false && payload?.async !== true && Array.isArray(payload?.results)) {
    for (const outcome of payload.results) {
      if (outcome?.convergence === "merged_to_main" || outcome?.convergence === "skipped_patch_equivalent") {
        const idx = ctx.mesh.nodes.findIndex((n) => n.id === outcome.nodeId);
        if (idx >= 0) ctx.mesh.nodes.splice(idx, 1);
      }
    }
    ctx.mesh.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  return JSON.stringify(result, null, 2);
}

// src/help.ts
var STANDARD_TOOLS = [
  "list_daemons",
  "list_sessions",
  "launch_session",
  "stop_session",
  "check_pending",
  "read_chat",
  "read_chat_debug",
  "send_chat",
  "approve",
  "git_status",
  "git_log",
  "git_diff",
  "git_checkpoint",
  "git_push",
  "screenshot"
];
function buildMcpHelpText() {
  const meshTools = ALL_MESH_TOOLS.map((tool) => tool.name);
  return `
ADHDev MCP Server

Usage:
  adhdev mcp                                    Local mode (requires standalone daemon)
  adhdev mcp --mode ipc --repo-mesh <mesh_id>   Cloud daemon IPC mesh mode
  adhdev-mcp --help                             Compatibility bin (same server, legacy package entrypoint)

Options:
  --mode <mode>           Transport: local or ipc
  --port <n>              Standalone or IPC daemon port (defaults: local 3847, ipc 19222)
  --password <pass>       Standalone daemon password (if set)
  --repo-mesh <mesh_id>   Enable mesh mode \u2014 exposes only mesh-scoped coordinator tools
  --help                  Show this help

Environment variables:
  ADHDEV_PASSWORD     Daemon password (local mode)
  ADHDEV_MESH_ID      Mesh ID (mesh mode)
  ADHDEV_MCP_TRANSPORT Transport: local or ipc

Standard tools:   ${STANDARD_TOOLS.join(", ")}
Mesh tools:       ${meshTools.join(", ")}
`.trim();
}

// src/server.ts
var import_server = require("@modelcontextprotocol/sdk/server/index.js");
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");
var import_node_os = __toESM(require("os"));
var import_types = require("@modelcontextprotocol/sdk/types.js");

// src/transports/local.ts
var DEFAULT_PORT = 3847;
var LocalTransport = class {
  baseUrl;
  authHeader;
  constructor(opts = {}) {
    this.baseUrl = `http://localhost:${opts.port ?? DEFAULT_PORT}`;
    this.authHeader = opts.password ? `Bearer ${opts.password}` : null;
  }
  headers() {
    const h = { "Content-Type": "application/json" };
    if (this.authHeader) h["Authorization"] = this.authHeader;
    return h;
  }
  async getStatus() {
    const res = await fetch(`${this.baseUrl}/api/v1/status`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
    return res.json();
  }
  async command(type, args = {}) {
    const res = await fetch(`${this.baseUrl}/api/v1/command`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ type, ...args })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Command ${type} failed: ${res.status} ${text}`);
    }
    return res.json();
  }
  async ping() {
    try {
      await this.getStatus();
      return true;
    } catch {
      return false;
    }
  }
};

// src/tools/list-sessions.ts
var FORMAT_PROP = {
  format: {
    type: "string",
    enum: ["text", "json"],
    description: "Output format: 'text' (default, human-readable) or 'json' (structured, for programmatic use)."
  }
};
var LIST_SESSIONS_TOOL = {
  name: "list_sessions",
  description: "List all connected agent sessions.",
  inputSchema: {
    type: "object",
    properties: {
      ...FORMAT_PROP
    },
    required: []
  }
};
async function listSessions(transport, args = {}) {
  const asJson = args.format === "json";
  const status = await transport.getStatus();
  const sessions = status?.sessions ?? [];
  if (asJson) {
    return JSON.stringify({
      sessions: sessions.map((s) => ({
        id: s.id,
        type: s.providerType ?? s.type ?? "unknown",
        label: s.label ?? null,
        status: s.status ?? s.agentStatus ?? null,
        workspace: s.workspace ?? null
      }))
    }, null, 2);
  }
  if (sessions.length === 0) return "No active sessions.";
  const lines = sessions.map((s) => {
    const parts = [`id: ${s.id}`, `type: ${s.providerType ?? s.type ?? "unknown"}`];
    if (s.label) parts.push(`label: ${s.label}`);
    if (s.status ?? s.agentStatus) parts.push(`status: ${s.status ?? s.agentStatus}`);
    if (s.workspace) parts.push(`workspace: ${s.workspace}`);
    return parts.join(", ");
  });
  return `Sessions (${sessions.length}):
${lines.join("\n")}`;
}

// src/tools/list-daemons.ts
var LIST_DAEMONS_TOOL = {
  name: "list_daemons",
  description: "List the connected daemon (machine running the ADHDev agent). Returns the daemon identity extracted from its status report.",
  inputSchema: {
    type: "object",
    properties: {
      ...FORMAT_PROP
    },
    required: []
  }
};
async function listDaemons(transport, args = {}) {
  const asJson = args.format === "json";
  const status = await transport.getStatus();
  const daemon = {
    id: status?.id ?? status?.instanceId ?? "standalone",
    hostname: status?.hostname ?? status?.machine?.hostname ?? "localhost",
    platform: status?.platform ?? status?.machine?.platform ?? "unknown",
    version: status?.version ?? null,
    sessions: (status?.sessions ?? []).length
  };
  if (asJson) return JSON.stringify({ daemons: [daemon] }, null, 2);
  return `Daemons (1):
  id: ${daemon.id}, hostname: ${daemon.hostname}, platform: ${daemon.platform}${daemon.version ? `, version: ${daemon.version}` : ""}, sessions: ${daemon.sessions}`;
}

// src/tools/read-chat.ts
var READ_CHAT_TOOL = {
  name: "read_chat",
  description: "Read the current chat conversation from an IDE agent session. Returns recent messages.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Target session ID (from list_sessions). Pass explicitly in local mode when more than one session exists; omitting requires an active target and may fail."
      },
      limit: {
        type: "number",
        description: "Max messages to return (default: 50)."
      },
      compact: {
        type: "boolean",
        description: "Opt-in compact mode: filters tool/terminal/system/internal/control/debug/status chatter and returns user-visible messages plus lightweight summary metadata."
      },
      ...FORMAT_PROP
    },
    required: []
  }
};
async function readChat(transport, args) {
  const limit = args.limit ?? 50;
  const result = await transport.command("read_chat", {
    ...args.session_id ? { targetSessionId: args.session_id } : {},
    tailLimit: limit
  });
  const annotated = annotateRapidReadChatAdvisory(result, {
    key: `local:${args.session_id ?? "__active__"}`,
    toolName: "read_chat",
    completionCallbackExpected: false
  });
  return formatChatResult(annotated, args.session_id, args.format, limit, args.compact);
}
function formatChatResult(result, sessionId, format, limit = 50, compact = false) {
  if (!result?.success && result?.error) {
    if (format === "json") return JSON.stringify({ error: result.error, messages: [] }, null, 2);
    return `Error: ${result.error}`;
  }
  const messages = result?.messages ?? result?.data?.messages ?? [];
  const source = { ...result, messages };
  const compactPayload = compact ? compactChatPayload(source, { sessionId: sessionId ?? null, limit, preserveTurn: true }) : null;
  const outputMessages = compact ? compactPayload.messages : messages;
  if (format === "json") {
    if (compact && compactPayload) {
      return JSON.stringify({
        session_id: sessionId ?? null,
        ...compactPayload,
        ...result?.pollingAdvisory ? { pollingAdvisory: result.pollingAdvisory } : {},
        messages: compactPayload.messages.map((m) => ({
          role: m.role,
          kind: m.kind ?? null,
          content: messageContent(m),
          timestamp: m.timestamp ?? null,
          // Preserve the dedup flag so consumers know the body lives in `summary`.
          ...m._sameAsSummary === true ? { _sameAsSummary: true } : {}
        }))
      }, null, 2);
    }
    return JSON.stringify({
      session_id: sessionId ?? null,
      ...result?.pollingAdvisory ? { pollingAdvisory: result.pollingAdvisory } : {},
      messages: outputMessages.slice(-limit).map((m) => ({
        role: m.role,
        kind: m.kind ?? null,
        content: messageContent(m),
        timestamp: m.timestamp ?? null
      }))
    }, null, 2);
  }
  if ((format === "text" || format === void 0) && compact && compactPayload) {
    const summaryText = typeof compactPayload.summary === "string" ? compactPayload.summary.trim() : "";
    const tail = outputMessages.slice(-limit);
    const lastIndex = tail.length - 1;
    const lines2 = tail.flatMap((m, idx) => {
      const role = m.role === "user" ? "User" : m.role === "assistant" ? "Agent" : m.role;
      const content = messageContent(m);
      if (idx === lastIndex && (role === "Agent" || m.role === "agent") && summaryText && content.trim() === summaryText) {
        return [];
      }
      const truncated = content.length > 500 ? `${content.slice(0, 500)}\u2026` : content;
      return [`[${role}] ${truncated}`];
    });
    if (compactPayload.summary) {
      const truncatedSummary = compactPayload.summary.length > 500 ? `${compactPayload.summary.slice(0, 500)}\u2026` : compactPayload.summary;
      lines2.push(`[Summary] ${truncatedSummary}`);
    }
    if (result?.pollingAdvisory) {
      lines2.push(`Advisory: ${result.pollingAdvisory.message}`);
    }
    return lines2.length > 0 ? lines2.join("\n\n") : "No messages in chat.";
  }
  if (outputMessages.length === 0) {
    return result?.pollingAdvisory ? `No messages in chat.

Advisory: ${result.pollingAdvisory.message}` : "No messages in chat.";
  }
  const lines = outputMessages.slice(-limit).map((m) => {
    const role = m.role === "user" ? "User" : m.role === "assistant" ? "Agent" : m.role;
    const content = messageContent(m);
    const truncated = content.length > 500 ? `${content.slice(0, 500)}\u2026` : content;
    return `[${role}] ${truncated}`;
  });
  if (result?.pollingAdvisory) {
    lines.push(`Advisory: ${result.pollingAdvisory.message}`);
  }
  return lines.join("\n\n");
}

// src/tools/read-chat-debug.ts
var READ_CHAT_DEBUG_TOOL = {
  name: "read_chat_debug",
  description: "Collect a daemon-side chat/parser debug bundle for an agent session without opening the browser UI. Prefer this when terminal/chat diverge or long CLI transcripts parse incorrectly. Defaults to daemon_file delivery and returns a saved bundle locator.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Target session ID (from list_sessions). Required for reliable routing."
      },
      agent_type: {
        type: "string",
        description: "Optional provider/agent type hint, e.g. hermes-cli, claude-cli, codex-cli."
      },
      limit: {
        type: "number",
        description: "Max read_chat tail messages embedded in the bundle (default: 40)."
      },
      delivery: {
        type: "string",
        enum: ["daemon_file", "inline"],
        description: "daemon_file saves the full sanitized bundle on the daemon and returns a locator; inline returns the sanitized bundle in the MCP response. Default: daemon_file."
      },
      ...FORMAT_PROP
    },
    required: ["session_id"]
  }
};
async function readChatDebug(transport, args) {
  const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
  if (!sessionId) throw new Error("session_id is required");
  const tailLimit = args.limit ?? 40;
  const delivery = args.delivery === "inline" ? "inline" : "daemon_file";
  const commandArgs = {
    targetSessionId: sessionId,
    tailLimit,
    ...args.agent_type ? { agentType: args.agent_type, providerType: args.agent_type } : {},
    ...delivery === "daemon_file" ? { delivery: "daemon_file" } : {}
  };
  const result = await transport.command("get_chat_debug_bundle", commandArgs);
  return formatChatDebugResult(result, { sessionId, delivery, format: args.format });
}
function formatChatDebugResult(result, options) {
  if (!result?.success && result?.error) {
    if (options.format === "json") return JSON.stringify({ success: false, error: result.error }, null, 2);
    return `Error: ${result.error}`;
  }
  if (options.format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (result?.delivery === "daemon_file") {
    const summary = result.summary && typeof result.summary === "object" ? result.summary : {};
    return [
      "ADHDev chat debug bundle saved on daemon.",
      `session_id: ${options.sessionId}`,
      `bundle_id: ${String(result.bundleId || "")}`,
      `saved_path: ${String(result.savedPath || "")}`,
      `size_bytes: ${String(result.sizeBytes || "")}`,
      `created_at: ${String(result.createdAt || "")}`,
      `read_chat_status: ${String(summary.readChatStatus || "")}`,
      `read_chat_total_messages: ${String(summary.readChatTotalMessages ?? "")}`,
      `cli_status: ${String(summary.cliStatus || "")}`,
      `cli_message_count: ${String(summary.cliMessageCount ?? "")}`
    ].join("\n");
  }
  if (typeof result?.text === "string") return result.text;
  if (result?.bundle) return JSON.stringify(result.bundle, null, 2);
  return JSON.stringify(result, null, 2);
}

// src/tools/spec-debug.ts
var SPEC_DEBUG_TOOL = {
  name: "spec_debug",
  description: "Get current spec state, sections, and state transition history for a spec-driven CLI session (claude-cli, antigravity-cli, etc.). Use to diagnose idle/busy detection issues, inspect section parsing, or verify idle_hold and busy_hold behavior.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Target session ID (from list_sessions)."
      },
      ...FORMAT_PROP
    },
    required: ["session_id"]
  }
};
async function specDebug(transport, args) {
  const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
  if (!sessionId) throw new Error("session_id is required");
  const result = await transport.command("get_spec_debug", { targetSessionId: sessionId });
  return formatSpecDebugResult(result, { sessionId, format: args.format });
}
function formatSpecDebugResult(result, options) {
  if (!result?.success) {
    const err = result?.error || "Unknown error";
    if (options.format === "json") return JSON.stringify({ success: false, error: err }, null, 2);
    return `Error: ${err}`;
  }
  if (options.format === "json") return JSON.stringify(result, null, 2);
  const snap = result.snapshot;
  if (!snap) {
    return [
      `session_id: ${options.sessionId}`,
      `provider_type: ${String(result.providerType || "")}`,
      "is_spec_provider: false",
      "No spec debug data available (not a spec-driven provider)."
    ].join("\n");
  }
  const lines = [];
  lines.push(`session_id: ${options.sessionId}`);
  lines.push(`provider_type: ${String(result.providerType || snap.cliType || "")}`);
  lines.push(`spec_id: ${String(snap.spec_id || "")}`);
  lines.push(`spec_path: ${String(snap.specPath || "")}`);
  lines.push(`current_state: ${snap.current_state ? `${snap.current_state.id} (${snap.current_state.label})` : "none"}`);
  lines.push(`idle_hold_pending: ${String(snap.idleHoldPending ?? false)}`);
  lines.push(`last_busy_at: ${snap.lastBusyAt ? new Date(snap.lastBusyAt).toISOString() : "never"}`);
  lines.push(`exited: ${String(snap.exited ?? false)}`);
  if (snap.current_modal) {
    lines.push(`current_modal: ${JSON.stringify(snap.current_modal)}`);
  }
  if (snap.sections && typeof snap.sections === "object") {
    lines.push("");
    lines.push("## Sections");
    for (const [id, text] of Object.entries(snap.sections)) {
      const raw = String(text ?? "");
      const lineCount = raw.length === 0 ? 0 : raw.split("\n").length;
      lines.push("");
      lines.push(`### section: ${id} (${lineCount} lines, ${raw.length} chars)`);
      lines.push("```");
      lines.push(raw);
      lines.push("```");
    }
  }
  const history = Array.isArray(snap.stateHistory) ? snap.stateHistory : [];
  if (history.length > 0) {
    lines.push("");
    lines.push("## State History (newest first)");
    const now = Date.now();
    for (const entry of [...history].reverse().slice(0, 20)) {
      const agoMs = now - entry.at;
      const ago = agoMs < 2e3 ? `${agoMs}ms ago` : `${(agoMs / 1e3).toFixed(1)}s ago`;
      const dur = entry.durationMs > 0 ? `  held ${entry.durationMs}ms` : "";
      const via = entry.via ? `  via ${entry.via}` : "";
      lines.push(`  ${String(entry.stateId).padEnd(18)} ${ago}${dur}${via}`);
      const rules = Array.isArray(entry.matchedRules) ? entry.matchedRules : [];
      for (const rule of rules) {
        lines.push(`      ${String(rule)}`);
      }
    }
  }
  const timeline = Array.isArray(snap.eventTimeline) ? snap.eventTimeline : [];
  if (timeline.length > 0) {
    lines.push("");
    lines.push("## Event Timeline (oldest first)");
    const now = Date.now();
    const arrow = {
      input: "\u2192 in ",
      output: "\u2190 out",
      resize: "\u21F2 size",
      cursor: "\u2316 cur",
      spawn: "\u23FB spawn",
      exit: "\u23F9 exit"
    };
    for (const ev of timeline.slice(-120)) {
      const agoMs = now - (ev.ts ?? now);
      const ago = agoMs < 2e3 ? `${agoMs}ms` : `${(agoMs / 1e3).toFixed(1)}s`;
      const tag = arrow[String(ev.kind)] ?? String(ev.kind);
      const bytes = typeof ev.bytes === "number" ? ` [${ev.bytes}b]` : "";
      lines.push(`  -${ago.padStart(6)}  ${tag}${bytes}  ${String(ev.content ?? "")}`);
    }
  }
  return lines.join("\n");
}

// src/tools/send-chat.ts
var SEND_CHAT_TOOL = {
  name: "send_chat",
  description: "Send a message to an IDE agent session.",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The message to send to the agent."
      },
      session_id: {
        type: "string",
        description: "Target session ID (from list_sessions). Omit to use the active session."
      }
    },
    required: ["message"]
  }
};
async function sendChat(transport, args) {
  if (!args.message?.trim()) throw new Error("message is required");
  const result = await transport.command("send_chat", {
    message: args.message,
    ...args.session_id ? { targetSessionId: args.session_id } : {}
  });
  if (result?.success === false) return `Error: ${result.error ?? "send_chat failed"}`;
  return "Message sent.";
}

// src/tools/approve.ts
var APPROVE_TOOL = {
  name: "approve",
  description: "Approve or reject a pending agent action (e.g. file write, command execution).",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["approve", "reject"],
        description: "Whether to approve or reject the pending action."
      },
      session_id: {
        type: "string",
        description: "Target session ID. Omit to use the active session."
      }
    },
    required: ["action"]
  }
};
async function approve(transport, args) {
  const action = args.action === "reject" ? "reject" : "approve";
  const result = await transport.command("resolve_action", {
    action,
    ...args.session_id ? { targetSessionId: args.session_id } : {}
  });
  if (result?.success === false) return `Error: ${result.error ?? "resolve_action failed"}`;
  return `Action ${action}d.`;
}

// src/tools/screenshot.ts
var SCREENSHOT_TOOL = {
  name: "screenshot",
  description: "Capture a screenshot of the current IDE window. Returns the image.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Target session ID. Omit to use the active session."
      }
    },
    required: []
  }
};
async function screenshot(transport, args) {
  const result = await transport.command("screenshot", {
    ...args.session_id ? { targetSessionId: args.session_id } : {}
  });
  if (result?.success === false) {
    return { type: "text", text: `Error: ${result.error ?? "screenshot failed"}` };
  }
  const b64 = result?.base64 ?? result?.screenshot ?? result?.result;
  if (!b64) {
    return { type: "text", text: "Screenshot captured but no image data returned." };
  }
  const mimeType = result?.format === "png" ? "image/png" : "image/webp";
  return { type: "image", data: b64, mimeType };
}

// src/tools/git-status.ts
var GIT_STATUS_TOOL = {
  name: "git_status",
  description: "Get git repository status for a workspace on the daemon machine.",
  inputSchema: {
    type: "object",
    properties: {
      workspace: {
        type: "string",
        description: "Absolute path to the workspace/repository directory."
      },
      include_diff: {
        type: "boolean",
        description: "Include changed file list (default: true)."
      },
      ...FORMAT_PROP
    },
    required: ["workspace"]
  }
};
async function gitStatus(transport, args) {
  let diffSummary;
  const statusResult = await transport.command("git_status", {
    workspace: args.workspace
  });
  const status = statusResult?.status ?? statusResult;
  if (args.include_diff !== false) {
    const diffResult = await transport.command("git_diff_summary", {
      workspace: args.workspace
    });
    diffSummary = diffResult?.diffSummary ?? diffResult;
  }
  if (status?.success === false || status?.reason) {
    const msg = status?.error ?? status?.reason ?? "unknown";
    if (args.format === "json") return JSON.stringify({ error: msg }, null, 2);
    return `Git error: ${msg}`;
  }
  if (!status?.isGitRepo) {
    if (args.format === "json") return JSON.stringify({ error: `Not a git repository: ${args.workspace}` }, null, 2);
    return `Not a git repository: ${args.workspace}`;
  }
  if (args.format === "json") {
    const files = diffSummary?.files?.map((f) => ({
      path: f.path,
      old_path: f.oldPath ?? null,
      status: f.status ?? "M",
      insertions: f.insertions ?? 0,
      deletions: f.deletions ?? 0
    })) ?? [];
    return JSON.stringify({
      branch: status.branch ?? null,
      head_commit: status.headCommit ?? null,
      head_message: status.headMessage ?? null,
      ahead: status.ahead ?? 0,
      behind: status.behind ?? 0,
      staged: status.staged ?? 0,
      modified: status.modified ?? 0,
      untracked: status.untracked ?? 0,
      deleted: status.deleted ?? 0,
      stash_count: status.stashCount ?? 0,
      has_conflicts: status.hasConflicts ?? false,
      dirty: status.dirty ?? false,
      changed_files: files,
      total_insertions: diffSummary?.totalInsertions ?? 0,
      total_deletions: diffSummary?.totalDeletions ?? 0
    }, null, 2);
  }
  const lines = [];
  if (status.branch) lines.push(`Branch: ${status.branch}`);
  if (status.headCommit) {
    lines.push(`HEAD: ${status.headCommit.slice(0, 7)}${status.headMessage ? ` \u2014 ${status.headMessage.slice(0, 80)}` : ""}`);
  }
  if (status.ahead > 0) lines.push(`Ahead: ${status.ahead}`);
  if (status.behind > 0) lines.push(`Behind: ${status.behind}`);
  if (status.staged > 0) lines.push(`Staged: ${status.staged}`);
  if (status.modified > 0) lines.push(`Modified: ${status.modified}`);
  if (status.untracked > 0) lines.push(`Untracked: ${status.untracked}`);
  if (status.deleted > 0) lines.push(`Deleted: ${status.deleted}`);
  if (status.stashCount > 0) lines.push(`Stashes: ${status.stashCount}`);
  if (status.hasConflicts) lines.push("Conflicts: YES");
  if (!status.dirty) lines.push("Working tree: clean");
  if (diffSummary?.files?.length > 0) {
    lines.push("");
    lines.push(`Changed files (${diffSummary.files.length}):`);
    for (const f of diffSummary.files.slice(0, 20)) {
      lines.push(`  ${f.status ?? "M"} ${f.path}${f.oldPath ? ` (was ${f.oldPath})` : ""}${f.insertions || f.deletions ? ` +${f.insertions ?? 0}/-${f.deletions ?? 0}` : ""}`);
    }
    if (diffSummary.files.length > 20) lines.push(`  \u2026 and ${diffSummary.files.length - 20} more`);
    if (diffSummary.totalInsertions || diffSummary.totalDeletions) {
      lines.push(`Total: +${diffSummary.totalInsertions ?? 0}/-${diffSummary.totalDeletions ?? 0}`);
    }
  }
  return lines.join("\n");
}

// src/tools/git-log.ts
var GIT_LOG_TOOL = {
  name: "git_log",
  description: "Get commit history for a workspace. Shows hash, message, author, and date for recent commits. Use this to track what changes an agent has made, verify checkpoint commits, or understand project history.",
  inputSchema: {
    type: "object",
    properties: {
      workspace: {
        type: "string",
        description: "Absolute path to the workspace/repository directory."
      },
      limit: {
        type: "number",
        description: "Max commits to return (default: 20, max: 100)."
      },
      file: {
        type: "string",
        description: "Filter history to commits that touched this repo-relative file path (optional)."
      },
      since: {
        type: "string",
        description: "Only commits after this date (ISO 8601 or git date string, optional)."
      },
      until: {
        type: "string",
        description: "Only commits before this date (ISO 8601 or git date string, optional)."
      },
      ...FORMAT_PROP
    },
    required: ["workspace"]
  }
};
async function gitLog(transport, args) {
  const limit = Math.max(1, Math.min(100, args.limit ?? 20));
  let raw = await transport.command("git_log", {
    workspace: args.workspace,
    limit,
    ...args.file ? { path: args.file } : {},
    ...args.since ? { since: args.since } : {},
    ...args.until ? { until: args.until } : {}
  });
  raw = raw?.log ?? raw;
  if (raw?.success === false || raw?.reason) {
    const msg = raw?.error ?? raw?.reason ?? "unknown";
    if (args.format === "json") return JSON.stringify({ error: msg }, null, 2);
    return `Git log error: ${msg}`;
  }
  if (!raw?.isGitRepo) {
    const msg = `Not a git repository: ${args.workspace}`;
    if (args.format === "json") return JSON.stringify({ error: msg }, null, 2);
    return msg;
  }
  const entries = raw?.entries ?? [];
  if (args.format === "json") {
    return JSON.stringify({
      workspace: raw.workspace,
      branch: raw.branch ?? null,
      entries: entries.map((e) => ({
        commit: e.commit,
        short: e.commit?.slice(0, 7),
        message: e.message,
        author: e.authorName ?? null,
        author_email: e.authorEmail ?? null,
        authored_at: e.authoredAt ? new Date(e.authoredAt).toISOString() : null
      })),
      total: entries.length,
      truncated: raw.truncated ?? false
    }, null, 2);
  }
  if (entries.length === 0) return "No commits found.";
  const lines = entries.map((e) => {
    const hash = e.commit?.slice(0, 7) ?? "???????";
    const date = e.authoredAt ? new Date(e.authoredAt).toISOString().slice(0, 10) : "";
    const author = e.authorName ? ` (${e.authorName})` : "";
    return `${hash} ${date}${author} ${e.message}`;
  });
  const header = `Commits (${entries.length}${raw.truncated ? ", truncated" : ""}):`;
  return `${header}
${lines.join("\n")}`;
}

// src/tools/git-diff.ts
var GIT_DIFF_TOOL = {
  name: "git_diff",
  description: "Get the actual diff content for changed files in a workspace. Without a specific file, returns diffs for up to 5 changed files. Use this to review what an agent actually changed \u2014 file names alone (from git_status) are not enough for code review.",
  inputSchema: {
    type: "object",
    properties: {
      workspace: {
        type: "string",
        description: "Absolute path to the workspace/repository directory."
      },
      file: {
        type: "string",
        description: "Specific repo-relative file path to diff (optional \u2014 if omitted, returns top 5 changed files)."
      },
      max_lines: {
        type: "number",
        description: "Max diff lines per file before truncating (default: 300)."
      },
      staged: {
        type: "boolean",
        description: "Show staged changes instead of unstaged (default: false)."
      },
      ...FORMAT_PROP
    },
    required: ["workspace"]
  }
};
async function gitDiff(transport, args) {
  const maxLines = Math.max(10, Math.min(2e3, args.max_lines ?? 300));
  const staged = args.staged ?? false;
  return localGitDiff(transport, args.workspace, args.file, maxLines, staged, args.format);
}
async function localGitDiff(transport, workspace, file, maxLines, staged, format) {
  if (file) {
    const raw = await transport.command("git_diff_file", { workspace, path: file, staged });
    const d = raw?.diff ?? raw;
    if (d?.success === false || d?.reason) {
      const msg = d?.error ?? d?.reason ?? "unknown";
      if (format === "json") return JSON.stringify({ error: msg }, null, 2);
      return `Git diff error: ${msg}`;
    }
    const lines = (d?.diff ?? "").split("\n");
    const truncated = lines.length > maxLines;
    const result = {
      files: [{
        path: file,
        diff: truncated ? lines.slice(0, maxLines).join("\n") + "\n... (truncated)" : d?.diff ?? "",
        truncated,
        binary: d?.binary ?? false
      }],
      total_files: 1,
      shown_files: 1,
      truncated
    };
    return formatDiffResult(result, format);
  }
  const summaryRaw = await transport.command("git_diff_summary", { workspace, staged });
  const summary = summaryRaw?.diffSummary ?? summaryRaw;
  if (summary?.success === false || summary?.reason) {
    const msg = summary?.error ?? summary?.reason ?? "unknown";
    if (format === "json") return JSON.stringify({ error: msg }, null, 2);
    return `Git diff error: ${msg}`;
  }
  if (!summary?.isGitRepo) {
    const msg = `Not a git repository: ${workspace}`;
    if (format === "json") return JSON.stringify({ error: msg }, null, 2);
    return msg;
  }
  const files = summary?.files ?? [];
  if (files.length === 0) {
    if (format === "json") return JSON.stringify({ files: [], total_files: 0, shown_files: 0, truncated: false }, null, 2);
    return "No changed files.";
  }
  const topFiles = files.slice(0, 5);
  const fileDiffs = await Promise.all(
    topFiles.map(async (f) => {
      try {
        const raw = await transport.command("git_diff_file", { workspace, path: f.path, staged });
        const d = raw?.diff ?? raw;
        const lines = (d?.diff ?? "").split("\n");
        const trunc = lines.length > maxLines;
        return {
          path: f.path,
          old_path: f.oldPath ?? null,
          status: f.status ?? "M",
          diff: trunc ? lines.slice(0, maxLines).join("\n") + "\n... (truncated)" : d?.diff ?? "",
          truncated: trunc,
          binary: d?.binary ?? false
        };
      } catch {
        return { path: f.path, diff: "", truncated: false, binary: false, error: "fetch failed" };
      }
    })
  );
  return formatDiffResult({
    files: fileDiffs,
    total_files: files.length,
    shown_files: topFiles.length,
    truncated: files.length > 5
  }, format);
}
function formatDiffResult(result, format) {
  if (format === "json") return JSON.stringify(result, null, 2);
  const files = result?.files ?? [];
  if (files.length === 0) return "No changed files.";
  const parts = [];
  const totalShown = result?.shown_files ?? files.length;
  const totalAll = result?.total_files ?? files.length;
  if (totalAll > totalShown) {
    parts.push(`Showing ${totalShown} of ${totalAll} changed files:
`);
  }
  for (const f of files) {
    const header = `--- ${f.path}${f.old_path ? ` (was ${f.old_path})` : ""} ---`;
    if (f.error) {
      parts.push(`${header}
(error: ${f.error})
`);
    } else if (f.binary) {
      parts.push(`${header}
(binary file)
`);
    } else if (!f.diff) {
      parts.push(`${header}
(no diff)
`);
    } else {
      parts.push(`${header}
${f.diff}${f.truncated ? "" : "\n"}`);
    }
  }
  return parts.join("\n");
}

// src/tools/git-checkpoint.ts
var GIT_CHECKPOINT_TOOL = {
  name: "git_checkpoint",
  description: "Create a checkpoint commit in a workspace. Stages all tracked changes (or all files including untracked) and commits with a prefixed message. Use this to save progress before a risky operation, or to create a restore point the orchestrator can reference.",
  inputSchema: {
    type: "object",
    properties: {
      workspace: {
        type: "string",
        description: "Absolute path to the workspace/repository directory."
      },
      message: {
        type: "string",
        description: 'Checkpoint message (max 200 chars). Will be prefixed with "adhdev: checkpoint ".'
      },
      include_untracked: {
        type: "boolean",
        description: "Also stage and commit untracked files (default: false)."
      }
    },
    required: ["workspace", "message"]
  }
};
async function gitCheckpoint(transport, args) {
  const message = args.message?.trim();
  if (!message) return "Error: message is required";
  if (message.length > 200) return "Error: message must be 200 characters or fewer";
  let raw = await transport.command("git_checkpoint", {
    workspace: args.workspace,
    message,
    includeUntracked: args.include_untracked ?? false
  });
  raw = raw?.checkpoint ?? raw;
  if (raw?.success === false || raw?.reason) {
    const msg = raw?.error ?? raw?.reason ?? "unknown";
    if (msg.includes("Nothing to commit") || msg.includes("nothing to commit")) {
      return "Nothing to commit \u2014 working tree is clean.";
    }
    return `Git checkpoint error: ${msg}`;
  }
  const commit = raw?.commit?.slice(0, 7) ?? "???????";
  const fullMsg = raw?.message ?? `adhdev: checkpoint ${message}`;
  return `Checkpoint created: ${commit} \u2014 ${fullMsg}`;
}

// src/tools/git-push.ts
var GIT_PUSH_TOOL = {
  name: "git_push",
  description: "Push a branch to a remote repository on the daemon machine. If the branch has no upstream configured, sets it automatically. Key for parallel multi-machine workflows: after git_checkpoint, push each machine's branch to origin so changes are available for PR/review.",
  inputSchema: {
    type: "object",
    properties: {
      workspace: {
        type: "string",
        description: "Absolute path to the workspace/repository directory."
      },
      remote: {
        type: "string",
        description: 'Remote name (default: "origin").'
      },
      branch: {
        type: "string",
        description: "Branch to push (default: current branch)."
      }
    },
    required: ["workspace"]
  }
};
async function gitPush(transport, args) {
  let raw = await transport.command("git_push", {
    workspace: args.workspace,
    remote: args.remote ?? "origin",
    ...args.branch ? { branch: args.branch } : {}
  });
  raw = raw?.push ?? raw;
  if (raw?.success === false || raw?.reason) {
    const msg = raw?.error ?? raw?.reason ?? "unknown";
    return `Git push error: ${msg}`;
  }
  const branch = raw?.branch ?? args.branch ?? "(current)";
  const remote = raw?.remote ?? args.remote ?? "origin";
  const newBranch = raw?.newBranch ? " [new branch]" : "";
  const output = raw?.output ? `
${raw.output}` : "";
  return `Pushed ${branch} \u2192 ${remote}${newBranch}${output}`;
}

// src/tools/launch-session.ts
var LAUNCH_SESSION_TOOL = {
  name: "launch_session",
  description: "Launch a new agent session on the daemon. Supports CLI agents (e.g. kimi, hermes-cli, claude-cli, gemini-cli), ACP agents (e.g. claude-acp), and IDEs (e.g. cursor, vscode).",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "Provider type to launch. CLI examples: kimi, hermes-cli, claude-cli, gemini-cli. ACP examples: claude-acp. IDE examples: cursor, vscode. Manifest aliases (e.g. codex \u2192 codex-cli) resolve to the canonical provider type."
      },
      workspace: {
        type: "string",
        description: "Working directory for the session. Defaults to the daemon default workspace."
      },
      model: {
        type: "string",
        description: "Model override for ACP agents (e.g. claude-opus-4-7)."
      }
    },
    required: ["type"]
  }
};
function legacyHeuristicRoute(type) {
  const isCliOrAcp = type.includes("-cli") || type.includes("-acp") || type === "codex";
  return { route: isCliOrAcp ? "cli" : "ide", canonicalType: type };
}
async function resolveProviderRoute(transport, requestedType) {
  const type = requestedType.trim();
  if (!type) return { error: "type is required" };
  let catalog;
  try {
    catalog = await transport.command("list_provider_availability", {});
  } catch {
    catalog = null;
  }
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : null;
  if (!catalog || catalog.success === false || !providers) {
    return legacyHeuristicRoute(type);
  }
  const query = type.toLowerCase();
  const hit = providers.find((p) => {
    if (!p || typeof p.type !== "string") return false;
    if (p.type.toLowerCase() === query) return true;
    const aliases = Array.isArray(p.aliases) ? p.aliases : [];
    return aliases.some((alias) => typeof alias === "string" && alias.toLowerCase() === query);
  });
  if (!hit) {
    const known = providers.map((p) => p && typeof p.type === "string" ? p.type : null).filter(Boolean).sort();
    return {
      error: `Unknown provider type '${type}'. Known provider types: ${known.join(", ")}`
    };
  }
  const route = hit.category === "cli" || hit.category === "acp" ? "cli" : "ide";
  return { route, canonicalType: hit.type };
}
async function launchSession(transport, args) {
  const resolved = await resolveProviderRoute(transport, args.type);
  if ("error" in resolved) return `Error: ${resolved.error}`;
  const commandType = resolved.route === "cli" ? "launch_cli" : "launch_ide";
  const payload = resolved.route === "cli" ? { cliType: resolved.canonicalType, dir: args.workspace ?? "~", ...args.model ? { model: args.model } : {} } : { ideType: resolved.canonicalType, enableCdp: true };
  const result = await transport.command(commandType, payload);
  if (result?.success === false) return `Error: ${result.error ?? "launch failed"}`;
  const id = result?.id ?? result?.sessionId;
  return id ? `Session launched. id: ${id}, type: ${resolved.canonicalType}` : `Launched: ${JSON.stringify(result)}`;
}

// src/tools/stop-session.ts
var STOP_SESSION_TOOL = {
  name: "stop_session",
  description: "Stop a running agent session. For CLI agents (hermes-cli, claude-cli, etc.) this sends a graceful stop signal. Use list_sessions to find the session_id.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Session ID to stop (from list_sessions)."
      },
      type: {
        type: "string",
        description: "Provider type (e.g. hermes-cli, claude-cli). Auto-resolved from session_id if omitted."
      }
    },
    required: ["session_id"]
  }
};
async function stopSession(transport, args) {
  let resolvedType = args.type;
  if (!resolvedType) {
    const status = await transport.getStatus();
    const session = (status?.sessions ?? []).find((s) => s.id === args.session_id);
    resolvedType = session?.providerType ?? session?.type;
  }
  if (!resolvedType) {
    return `Error: could not resolve session type for ${args.session_id}. Pass type= explicitly.`;
  }
  const result = await transport.command("stop_cli", {
    targetSessionId: args.session_id,
    cliType: resolvedType
  });
  if (result?.success === false) return `Error: ${result.error ?? "stop failed"}`;
  return `Session ${args.session_id} stopped.`;
}

// src/tools/check-pending.ts
var CHECK_PENDING_TOOL = {
  name: "check_pending",
  description: "List all agent sessions currently waiting for user approval (tool-use confirmation). Returns session ID, daemon ID, workspace, and the approval prompt message when available. Use approve() with the session_id to approve or reject.",
  inputSchema: {
    type: "object",
    properties: {
      ...FORMAT_PROP
    },
    required: []
  }
};
async function checkPending(transport, args) {
  const status = await transport.getStatus();
  const sessions = status?.sessions ?? [];
  const pending = sessions.filter(
    (s) => s.status === "waiting_approval" || s.agentStatus === "waiting_approval"
  );
  if (args.format === "json") {
    return JSON.stringify({
      pending: pending.map((s) => ({
        session_id: s.id,
        workspace: s.workspace ?? null,
        type: s.providerType ?? null,
        modal_message: s.activeChat?.activeModal?.message ?? null,
        buttons: s.activeChat?.activeModal?.buttons ?? []
      }))
    }, null, 2);
  }
  if (pending.length === 0) return "No sessions waiting for approval.";
  const lines = pending.map((s) => {
    const modal = s.activeChat?.activeModal;
    const parts = [`session_id: ${s.id}`];
    if (s.workspace) parts.push(`workspace: ${s.workspace}`);
    if (s.providerType) parts.push(`type: ${s.providerType}`);
    if (modal?.message) parts.push(`prompt: ${modal.message}`);
    if (modal?.buttons?.length) parts.push(`buttons: ${modal.buttons.join(", ")}`);
    return parts.join("\n  ");
  });
  return `Pending approvals (${pending.length}):

${lines.join("\n\n")}`;
}

// src/server.ts
async function buildMeshModeCoordinatorPrompt(mesh) {
  try {
    const { buildCoordinatorSystemPrompt } = await import("@adhdev/daemon-core");
    return buildCoordinatorSystemPrompt({ mesh });
  } catch (e) {
    throw new Error(`Failed to build Repo Mesh coordinator prompt: ${e?.message ?? String(e)}`);
  }
}
async function startMcpServer(opts) {
  const transport = opts.mode === "ipc" ? new IpcTransport({ port: opts.port }) : new LocalTransport({ port: opts.port, password: opts.password });
  const alive = await transport.ping();
  if (!alive) {
    const hint = opts.mode === "local" ? `Make sure the standalone daemon is running (adhdev standalone or npx @adhdev/daemon-standalone).` : `Make sure the cloud daemon is running with local IPC enabled (adhdev daemon).`;
    process.stderr.write(`[adhdev-mcp] Cannot reach ${opts.mode} daemon. ${hint}
`);
    process.exit(1);
  }
  const isLocal = opts.mode === "local";
  if (opts.meshId) {
    let mesh;
    if (!mesh && process.env.ADHDEV_INLINE_MESH) {
      try {
        mesh = JSON.parse(process.env.ADHDEV_INLINE_MESH);
        process.stderr.write(`[adhdev-mcp] Loaded mesh config from ADHDEV_INLINE_MESH env
`);
      } catch (e) {
        process.stderr.write(`[adhdev-mcp] Failed to parse ADHDEV_INLINE_MESH: ${e.message}
`);
      }
    }
    if (!mesh) {
      try {
        const { getMesh } = await import("@adhdev/daemon-core");
        mesh = getMesh(opts.meshId);
      } catch (e) {
        process.stderr.write(`[adhdev-mcp] Local meshes.json lookup failed: ${e.message}
`);
      }
    }
    if (!mesh && (transport instanceof LocalTransport || transport instanceof IpcTransport)) {
      try {
        const result = await transport.command("get_mesh", { meshId: opts.meshId });
        if (result?.success && result.mesh) {
          mesh = result.mesh;
          process.stderr.write(`[adhdev-mcp] Loaded mesh config from daemon
`);
        }
      } catch (e) {
        process.stderr.write(`[adhdev-mcp] Daemon mesh query failed: ${e.message}
`);
      }
    }
    if (!mesh) {
      process.stderr.write(`[adhdev-mcp] Mesh '${opts.meshId}' not found in local config. Use 'adhdev mesh list' to see available meshes.
`);
      process.exit(1);
    }
    let localDaemonId;
    let localMachineId;
    let coordinatorHostname = import_node_os.default.hostname();
    if (transport instanceof LocalTransport || transport instanceof IpcTransport) {
      try {
        const { loadConfig } = await import("@adhdev/daemon-core");
        const cfg = loadConfig();
        if (cfg.machineId) localMachineId = cfg.machineId;
        else if (cfg.registeredMachineId) localMachineId = cfg.registeredMachineId;
      } catch {
      }
    }
    if (transport instanceof IpcTransport) {
      try {
        const statusResult = await transport.getStatus();
        const instanceId = typeof statusResult?.status?.instanceId === "string" ? statusResult.status.instanceId.trim() : "";
        const hostname = typeof statusResult?.status?.hostname === "string" ? statusResult.status.hostname.trim() : typeof statusResult?.status?.machine?.hostname === "string" ? statusResult.status.machine.hostname.trim() : "";
        if (instanceId) localDaemonId = instanceId;
        if (hostname) coordinatorHostname = hostname;
      } catch {
      }
    }
    const coordinatorSessionId = typeof process.env.ADHDEV_COORDINATOR_SESSION_ID === "string" && process.env.ADHDEV_COORDINATOR_SESSION_ID.trim() ? process.env.ADHDEV_COORDINATOR_SESSION_ID.trim() : void 0;
    const meshCtx = { mesh, transport, ...localDaemonId ? { localDaemonId } : {}, ...localMachineId ? { localMachineId } : {}, ...coordinatorHostname ? { coordinatorHostname } : {}, ...coordinatorSessionId ? { coordinatorSessionId } : {} };
    const coordinatorPrompt = await buildMeshModeCoordinatorPrompt(mesh);
    const server2 = new import_server.Server(
      { name: "adhdev-mcp-server", version: "1.0.27" },
      { capabilities: { tools: {}, resources: {} } }
    );
    const { ListResourcesRequestSchema, ReadResourceRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    server2.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{
        uri: "coordinator://system-prompt",
        name: "Coordinator System Prompt",
        description: `System prompt for mesh "${mesh.name}" coordinator`,
        mimeType: "text/plain"
      }]
    }));
    server2.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      if (req.params.uri === "coordinator://system-prompt") {
        return { contents: [{ uri: req.params.uri, mimeType: "text/plain", text: coordinatorPrompt }] };
      }
      throw new Error(`Unknown resource: ${req.params.uri}`);
    });
    server2.setRequestHandler(import_types.ListToolsRequestSchema, async () => ({ tools: ALL_MESH_TOOLS }));
    server2.setRequestHandler(import_types.CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      const a = args ?? {};
      try {
        let text;
        switch (name) {
          case "mesh_status":
            text = await meshStatus(meshCtx, a);
            break;
          case "mesh_list_nodes":
            text = await meshListNodes(meshCtx);
            break;
          case "mesh_enqueue_task":
            text = await meshEnqueueTask(meshCtx, a);
            break;
          case "mesh_view_queue":
            text = await meshViewQueue(meshCtx, a);
            break;
          case "mesh_queue_cancel":
            text = await meshQueueCancel(meshCtx, a);
            break;
          case "mesh_queue_requeue":
            text = await meshQueueRequeue(meshCtx, a);
            break;
          case "mesh_send_task":
            text = await meshSendTask(meshCtx, a);
            break;
          case "mesh_read_chat":
            text = await meshReadChat(meshCtx, a);
            break;
          case "mesh_read_debug":
            text = await meshReadDebug(meshCtx, a);
            break;
          case "mesh_read_terminal":
            text = await meshReadTerminal(meshCtx, a);
            break;
          case "mesh_send_keys":
            text = await meshSendKeys(meshCtx, a);
            break;
          case "mesh_launch_session":
            text = await meshLaunchSession(meshCtx, a);
            break;
          case "mesh_git_status":
            text = await meshGitStatus(meshCtx, a);
            break;
          case "mesh_read_node_logs":
            text = await meshReadNodeLogs(meshCtx, a);
            break;
          case "mesh_fast_forward_node":
            text = await meshFastForwardNode(meshCtx, a);
            break;
          case "mesh_restart_daemon":
            text = await meshRestartDaemon(meshCtx, a);
            break;
          case "mesh_checkpoint":
            text = await meshCheckpoint(meshCtx, a);
            break;
          case "mesh_approve":
            text = await meshApprove(meshCtx, a);
            break;
          case "mesh_answer_question":
            text = await meshAnswerQuestion(meshCtx, a);
            break;
          case "mesh_list_pending_approvals":
            text = await meshListPendingApprovals(meshCtx, a);
            break;
          case "mesh_plan_onboarding":
            text = await meshPlanOnboarding(meshCtx.transport, a, meshCtx.mesh.id);
            break;
          case "mesh_create":
            text = await meshCreate(meshCtx.transport, a);
            break;
          case "mesh_add_node":
            text = await meshAddNode(meshCtx.transport, { ...a, inline_mesh: meshCtx.mesh }, meshCtx.mesh.id);
            break;
          case "mesh_clone_node":
            text = await meshCloneNode(meshCtx, a);
            break;
          case "mesh_remove_node":
            text = await meshRemoveNode(meshCtx, a);
            break;
          case "mesh_cleanup_worktree_nodes":
            text = await meshCleanupWorktreeNodes(meshCtx, a);
            break;
          case "mesh_refine_node":
            text = await meshRefineNode(meshCtx, a);
            break;
          case "mesh_refine_batch":
            text = await meshRefineBatch(meshCtx, a);
            break;
          case "mesh_refine_config":
            text = await meshRefineConfig(meshCtx, a);
            break;
          // Hidden 1-release aliases (Part 8-4): the former standalone config tools are no
          // longer published in ALL_MESH_TOOLS but stay dispatchable, forwarding to the
          // unified mesh_refine_config handler with the corresponding mode so pre-consolidation
          // callers keep working.
          case "mesh_refine_config_schema":
            text = await meshRefineConfig(meshCtx, { ...a, mode: "schema" });
            break;
          case "mesh_validate_refine_config":
            text = await meshRefineConfig(meshCtx, { ...a, mode: "validate" });
            break;
          case "mesh_suggest_refine_config":
            text = await meshRefineConfig(meshCtx, { ...a, mode: "suggest" });
            break;
          case "mesh_change_impact_config":
            text = await meshChangeImpactConfig(meshCtx, a);
            break;
          // Hidden 1-release aliases (symmetric to Part 8-4): the former standalone change-impact
          // config tools are no longer published in ALL_MESH_TOOLS but stay dispatchable, forwarding
          // to the unified mesh_change_impact_config handler with the corresponding mode so
          // pre-consolidation callers keep working.
          case "mesh_change_impact_config_schema":
            text = await meshChangeImpactConfig(meshCtx, { ...a, mode: "schema" });
            break;
          case "mesh_validate_change_impact_config":
            text = await meshChangeImpactConfig(meshCtx, { ...a, mode: "validate" });
            break;
          case "mesh_suggest_change_impact_config":
            text = await meshChangeImpactConfig(meshCtx, { ...a, mode: "suggest" });
            break;
          case "mesh_init":
            text = await meshInit(meshCtx, a);
            break;
          case "mesh_reinit":
            text = await meshReinit(meshCtx, a);
            break;
          case "mesh_write_mesh_json_config":
            text = await meshWriteMeshJsonConfig(meshCtx, a);
            break;
          case "mesh_refine_plan":
            text = await meshRefinePlan(meshCtx, a);
            break;
          case "mesh_cleanup_sessions":
            text = await meshCleanupSessions(meshCtx, a);
            break;
          case "mesh_prune_stale_direct":
            text = await meshPruneStaleDirect(meshCtx, a);
            break;
          case "mesh_task_history":
            text = await meshTaskHistory(meshCtx, a);
            break;
          case "mesh_ledger_query":
            text = await meshLedgerQuery(meshCtx, a);
            break;
          case "mesh_record_note":
            text = await meshRecordNote(meshCtx, a);
            break;
          case "mesh_forget_note":
            text = await meshForgetNote(meshCtx, a);
            break;
          case "mesh_reconcile_ledger":
            text = await meshReconcileLedger(meshCtx, a);
            break;
          case "mesh_requeue_held_events":
            text = await meshRequeueHeldEvents(meshCtx, a);
            break;
          case "mesh_mission_upsert":
            text = await meshMissionUpsert(meshCtx, a);
            break;
          case "mesh_mission_list":
            text = await meshMissionList(meshCtx, a);
            break;
          case "mesh_review_inbox":
            text = await meshReviewInbox(meshCtx, a);
            break;
          case "mesh_magi_review":
            text = await meshMagiReview(meshCtx, a);
            break;
          case "mesh_magi_collect":
            text = await meshMagiCollect(meshCtx, a);
            break;
          case "mesh_magi_kind_panel_set":
            text = await meshMagiKindPanelSet(meshCtx, a);
            break;
          case "mesh_magi_kind_panel_list":
            text = await meshMagiKindPanelList(meshCtx, a);
            break;
          case "mesh_node_slots_set":
            text = await meshNodeSlotsSet(meshCtx, a);
            break;
          case "mesh_node_slots_list":
            text = await meshNodeSlotsList(meshCtx, a);
            break;
          default:
            return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
        }
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }], isError: true };
      }
    });
    const stdioTransport2 = new import_stdio.StdioServerTransport();
    await server2.connect(stdioTransport2);
    process.stderr.write(`[adhdev-mcp] Server running in ${opts.mode} mesh mode \u2014 mesh: ${mesh.name} (${mesh.repoIdentity})
`);
    return;
  }
  const allTools = [
    LIST_DAEMONS_TOOL,
    LIST_SESSIONS_TOOL,
    LAUNCH_SESSION_TOOL,
    STOP_SESSION_TOOL,
    CHECK_PENDING_TOOL,
    READ_CHAT_TOOL,
    READ_CHAT_DEBUG_TOOL,
    SPEC_DEBUG_TOOL,
    SEND_CHAT_TOOL,
    APPROVE_TOOL,
    GIT_STATUS_TOOL,
    GIT_LOG_TOOL,
    GIT_DIFF_TOOL,
    GIT_CHECKPOINT_TOOL,
    GIT_PUSH_TOOL,
    // Mesh bootstrap: create a mesh + register its first node from an MCP-only agent.
    // Exposed in standard mode precisely because this is the no-mesh-yet context —
    // mesh mode refuses to boot without an existing meshId (see the mesh-mode block above).
    MESH_PLAN_ONBOARDING_TOOL,
    MESH_CREATE_TOOL,
    MESH_ADD_NODE_TOOL,
    ...isLocal ? [SCREENSHOT_TOOL] : []
  ];
  const server = new import_server.Server(
    { name: "adhdev-mcp-server", version: "0.9.66" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(import_types.ListToolsRequestSchema, async () => ({ tools: allTools }));
  server.setRequestHandler(import_types.CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = args ?? {};
    try {
      switch (name) {
        case "list_daemons": {
          const text = await listDaemons(transport, { format: a.format });
          return { content: [{ type: "text", text }] };
        }
        case "list_sessions": {
          const text = await listSessions(transport, { format: a.format });
          return { content: [{ type: "text", text }] };
        }
        case "read_chat": {
          const text = await readChat(transport, a);
          return { content: [{ type: "text", text }] };
        }
        case "read_chat_debug": {
          const text = await readChatDebug(transport, a);
          return { content: [{ type: "text", text }] };
        }
        case "spec_debug": {
          const text = await specDebug(transport, a);
          return { content: [{ type: "text", text }] };
        }
        case "send_chat": {
          const text = await sendChat(transport, { message: a.message, session_id: a.session_id });
          return { content: [{ type: "text", text }] };
        }
        case "approve": {
          const action = a.action === "reject" ? "reject" : "approve";
          const text = await approve(transport, { action, session_id: a.session_id });
          return { content: [{ type: "text", text }] };
        }
        case "screenshot": {
          const result = await screenshot(transport, { session_id: a.session_id });
          if (result.type === "image") {
            return {
              content: [{ type: "image", data: result.data, mimeType: result.mimeType }]
            };
          }
          return { content: [{ type: "text", text: result.text }] };
        }
        case "git_status": {
          const text = await gitStatus(transport, { workspace: a.workspace, include_diff: a.include_diff, format: a.format });
          return { content: [{ type: "text", text }] };
        }
        case "git_log": {
          const text = await gitLog(transport, { workspace: a.workspace, limit: a.limit, file: a.file, since: a.since, until: a.until, format: a.format });
          return { content: [{ type: "text", text }] };
        }
        case "git_diff": {
          const text = await gitDiff(transport, { workspace: a.workspace, file: a.file, max_lines: a.max_lines, staged: a.staged, format: a.format });
          return { content: [{ type: "text", text }] };
        }
        case "git_checkpoint": {
          const text = await gitCheckpoint(transport, { workspace: a.workspace, message: a.message, include_untracked: a.include_untracked });
          return { content: [{ type: "text", text }] };
        }
        case "git_push": {
          const text = await gitPush(transport, { workspace: a.workspace, remote: a.remote, branch: a.branch });
          return { content: [{ type: "text", text }] };
        }
        case "launch_session": {
          const text = await launchSession(transport, {
            type: a.type,
            workspace: a.workspace,
            model: a.model
          });
          return { content: [{ type: "text", text }] };
        }
        case "stop_session": {
          const text = await stopSession(transport, {
            session_id: a.session_id,
            type: a.type
          });
          return { content: [{ type: "text", text }] };
        }
        case "check_pending": {
          const text = await checkPending(transport, { format: a.format });
          return { content: [{ type: "text", text }] };
        }
        case "mesh_create": {
          const text = await meshCreate(transport, a);
          return { content: [{ type: "text", text }] };
        }
        case "mesh_plan_onboarding": {
          const text = await meshPlanOnboarding(transport, a);
          return { content: [{ type: "text", text }] };
        }
        case "mesh_add_node": {
          const text = await meshAddNode(transport, a);
          return { content: [{ type: "text", text }] };
        }
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
        isError: true
      };
    }
  });
  const stdioTransport = new import_stdio.StdioServerTransport();
  await server.connect(stdioTransport);
  process.stderr.write(`[adhdev-mcp] Server running in ${opts.mode} mode.
`);
}

// src/index.ts
function parseArgs(argv, env = process.env) {
  const args = argv.slice(2);
  let port;
  let password;
  let meshId;
  let explicitMode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mode" && args[i + 1]) {
      const value = String(args[++i]).trim();
      if (value === "local" || value === "ipc") explicitMode = value;
    } else if (arg?.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length).trim();
      if (value === "local" || value === "ipc") explicitMode = value;
    } else if (arg === "--port" && args[i + 1]) {
      port = Number(args[++i]);
    } else if (arg?.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--password" && args[i + 1]) {
      password = args[++i];
    } else if ((arg === "--repo-mesh" || arg === "--mesh") && args[i + 1]) {
      meshId = args[++i];
    } else if (arg?.startsWith("--repo-mesh=")) {
      meshId = arg.slice("--repo-mesh=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!password && env.ADHDEV_PASSWORD) password = env.ADHDEV_PASSWORD;
  if (!meshId && env.ADHDEV_MESH_ID) meshId = env.ADHDEV_MESH_ID;
  if (!explicitMode && env.ADHDEV_MCP_TRANSPORT) {
    const value = env.ADHDEV_MCP_TRANSPORT.trim();
    if (value === "local" || value === "ipc") explicitMode = value;
  }
  const mode = explicitMode || (meshId && env.ADHDEV_INLINE_MESH ? "ipc" : "local");
  return { mode, port, password, meshId };
}
function printHelp() {
  console.error(buildMcpHelpText());
}
startMcpServer(parseArgs(process.argv)).catch((err) => {
  process.stderr.write(`[adhdev-mcp] Fatal: ${err?.message ?? err}
`);
  process.exit(1);
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseArgs
});
//# sourceMappingURL=index.js.map