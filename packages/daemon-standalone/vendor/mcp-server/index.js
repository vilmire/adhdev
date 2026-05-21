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
  async sendIpcCommand(type, args) {
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error("WebSocket is not available in this Node runtime; Node 20+ is required for daemon IPC mode");
    }
    return new Promise((resolve, reject) => {
      const requestId = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const ws = new WebSocketCtor(`ws://127.0.0.1:${this.port}${this.path}`);
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {
        }
        fn();
      };
      const timeoutMs = type === "mesh_relay_command" ? 6e4 : 15e3;
      const timeout = setTimeout(() => {
        finish(() => reject(new Error(`Daemon IPC command '${type}' timed out after ${Math.round(timeoutMs / 1e3)}s`)));
      }, timeoutMs);
      let commandSent = false;
      const send = () => {
        if (commandSent) return;
        commandSent = true;
        ws.send(JSON.stringify({
          type: "ext:command",
          payload: { command: type, args, requestId }
        }));
      };
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
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
      ws.addEventListener("message", (event) => {
        try {
          const raw = typeof event.data === "string" ? event.data : String(event.data);
          const msg = JSON.parse(raw);
          if (msg?.type === "daemon:welcome") {
            send();
            return;
          }
          if (msg?.type !== "ext:command_result") return;
          if (msg?.payload?.requestId !== requestId) return;
          const payload = msg.payload;
          if (payload?.success === false) {
            finish(() => reject(new Error(payload.error || `Daemon IPC command '${type}' failed`)));
            return;
          }
          finish(() => resolve(payload?.result ?? payload));
        } catch {
        }
      });
      ws.addEventListener("error", () => {
        finish(() => reject(new Error(`Cannot connect to daemon IPC at ws://127.0.0.1:${this.port}${this.path}`)));
      });
    });
  }
};

// src/transports/mode.ts
function isLocalTransport(transport) {
  return typeof transport.command === "function";
}

// src/tools/chat-compact.ts
function isAssistantLike(message) {
  const role = String(message?.role ?? "").toLowerCase();
  return role === "assistant" || role === "agent";
}
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
function buildCompactMessageTail(visibleMessages, opts) {
  const summary = typeof opts.summary === "string" ? opts.summary.trim() : "";
  const shouldOmitSummaryMessage = !!summary && !!opts.finalAssistant && isAssistantLike(opts.finalAssistant) && messageContent(opts.finalAssistant).trim() === summary;
  const sourceMessages = shouldOmitSummaryMessage ? visibleMessages.filter((message) => message !== opts.finalAssistant) : visibleMessages;
  return sourceMessages.slice(-opts.limit);
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
  const messages = buildCompactMessageTail(visible, { summary, finalAssistant, limit });
  return {
    success: payload?.success !== false,
    compact: true,
    ...opts.nodeId ? { nodeId: opts.nodeId } : {},
    ...opts.sessionId !== void 0 ? { sessionId: opts.sessionId } : {},
    status: payload?.status ?? null,
    providerSessionId: payload?.providerSessionId ?? null,
    totalMessages: rawMessages.length,
    visibleMessages: visible.length,
    filteredMessages: visible.length,
    omittedMessages: Math.max(0, rawMessages.length - visible.length),
    summary,
    ...payload?.changedFiles !== void 0 ? { changedFiles: payload.changedFiles } : {},
    ...payload?.testsRun !== void 0 ? { testsRun: payload.testsRun } : {},
    messages
  };
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

// src/tools/mesh-tools.ts
var import_daemon_core = require("@adhdev/daemon-core");
var meshSessionProviderMetadata = /* @__PURE__ */ new Map();
function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
var DUPLICATE_DISPATCH_WINDOW_MS = 6e4;
var STALE_ASSIGNED_QUEUE_MS = 30 * 6e4;
var OLD_HISTORICAL_QUEUE_RECORD_MS = 7 * 24 * 60 * 6e4;
var ACTIVE_QUEUE_STATUSES = /* @__PURE__ */ new Set(["pending", "assigned"]);
var HISTORICAL_QUEUE_STATUSES = /* @__PURE__ */ new Set(["completed", "failed", "cancelled"]);
async function refreshMeshFromDaemon(ctx) {
  if (!(ctx.transport instanceof IpcTransport)) return;
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
  const hit = ctx.mesh.nodes.find((n) => n.id === nodeId);
  if (hit && !hit.isLocalWorktree) return hit;
  await refreshMeshFromDaemon(ctx);
  const refreshed = ctx.mesh.nodes.find((n) => n.id === nodeId);
  if (!refreshed) throw new Error(`Node '${nodeId}' is not a member of mesh '${ctx.mesh.name}'`);
  return refreshed;
}
async function findOptionalNodeWithRefresh(ctx, nodeId) {
  const hit = ctx.mesh.nodes.find((n) => n.id === nodeId);
  if (hit && !hit.isLocalWorktree) return hit;
  await refreshMeshFromDaemon(ctx);
  return ctx.mesh.nodes.find((n) => n.id === nodeId) ?? null;
}
function hasRecentDuplicateDispatch(ctx, args) {
  const now = Date.now();
  const normalizedMessage = args.message.trim();
  for (const task of (0, import_daemon_core.getQueue)(ctx.mesh.id)) {
    const timestamp = new Date(task.updatedAt || task.createdAt).getTime();
    if (!Number.isFinite(timestamp) || now - timestamp > DUPLICATE_DISPATCH_WINDOW_MS) continue;
    if (task.targetNodeId && task.targetNodeId !== args.node_id) continue;
    if (task.assignedNodeId && task.assignedNodeId !== args.node_id) continue;
    if (args.session_id && task.targetSessionId !== args.session_id && task.assignedSessionId !== args.session_id) continue;
    if (task.message?.trim() === normalizedMessage) {
      return { duplicate: true, entry: task, source: "queue" };
    }
  }
  const entries = (0, import_daemon_core.readLedgerEntries)(ctx.mesh.id, { tail: 200 });
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
  const entries = (0, import_daemon_core.readLedgerEntries)(ctx.mesh.id, { tail: 300 });
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
  for (const task of queue) {
    const status = typeof task?.status === "string" ? task.status : void 0;
    if (status && Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    }
  }
  return {
    totalCount: queue.length,
    activeCount: counts.pending + counts.assigned,
    historicalCount: counts.completed + counts.failed + counts.cancelled,
    counts,
    activeCounts: {
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
function isMeshOwnedDelegateSession(session, meshId, nodeId) {
  const settings = session?.settings;
  const sessionMeshId = typeof settings?.meshNodeFor === "string" ? settings.meshNodeFor.trim() : "";
  const coordinatorDaemonId = typeof settings?.meshCoordinatorDaemonId === "string" ? settings.meshCoordinatorDaemonId.trim() : "";
  const sessionNodeId = typeof settings?.meshNodeId === "string" ? settings.meshNodeId.trim() : "";
  if (sessionMeshId !== meshId || !coordinatorDaemonId) return false;
  return !sessionNodeId || sessionNodeId === nodeId;
}
function chooseDispatchableSession(sessions, providerType, meshId, nodeId) {
  const live = sessions.filter((session) => !isTerminalSessionRecord(session));
  const matchingProvider = (session) => !providerType || session?.providerType === providerType || session?.cliType === providerType;
  const meshSessions = live.filter(
    (session) => isMeshOwnedDelegateSession(session, meshId, nodeId)
  );
  return meshSessions.find((session) => isIdleSessionRecord(session) && matchingProvider(session)) || meshSessions.find(matchingProvider) || void 0;
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
    ...providerType ? { resolvedProviderType: providerType } : {},
    error: `Remote session '${sessionId}' is not relay-safe for mesh '${ctx.mesh.id}': missing meshNodeFor/meshCoordinatorDaemonId metadata, so completion events would not reach the coordinator ledger.`,
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
function extractLaunchPayload(value) {
  return findNestedPayload(value, (payload) => Boolean(payload?.sessionId || payload?.id || payload?.runtimeSessionId));
}
function classifyMeshLaunchFailure(error) {
  const message = error instanceof Error ? error.message : String(error || "launch failed");
  const lower = message.toLowerCase();
  const p2pClassification = (0, import_daemon_core.classifyP2pRelayFailure)(error, { command: "launch_cli" });
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
    (0, import_daemon_core.appendLedgerEntry)(ctx.mesh.id, {
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
  const entries = (0, import_daemon_core.readLedgerEntries)(meshId, { tail: 200 });
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
  const payload = (0, import_daemon_core.buildP2pRelayFailurePayload)(error, {
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
  let sessionId = args.session_id?.trim() || "";
  const providerPriorityList = Array.isArray(node.policy?.providerPriority) ? node.policy.providerPriority : [];
  let resolvedProviderType = args.providerType?.trim() || providerPriorityList[0] || "";
  if (!sessionId || args.session_id) {
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
        if (!isMeshOwnedDelegateSession(explicitSession, ctx.mesh.id, node.id)) {
          return buildRelayUnsafeRemoteSessionFailure(
            ctx,
            node,
            sessionId,
            resolvedProviderType || resolveSessionProviderType(explicitSession) || void 0
          );
        }
        if (!resolvedProviderType) {
          resolvedProviderType = resolveSessionProviderType(explicitSession);
        }
      } else {
        const targetSession = chooseDispatchableSession(sessions, resolvedProviderType, ctx.mesh.id, node.id);
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
      message: args.message
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
    return { success: true, dispatched: true, sessionId: sessionId || resolvedProviderType };
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
    return ctx.mesh.nodes.find((n) => readNodeDaemonId(n) === ctx.localDaemonId);
  }
  return void 0;
}
function readNodeMachineId(node) {
  return readString(node.machineId) || readString(node.machine_id);
}
function readNodeDaemonId(node) {
  return readString(node.daemonId) || readString(node.daemon_id);
}
function isDirectLocalNode(ctx, node) {
  const machineId = readNodeMachineId(node);
  const daemonId = readNodeDaemonId(node);
  return Boolean(
    ctx.localMachineId && machineId === ctx.localMachineId || ctx.localDaemonId && daemonId === ctx.localDaemonId
  );
}
function findClonedFromNode(ctx, node) {
  const clonedFromNodeId = readString(node.clonedFromNodeId) || readString(node.cloned_from_node_id);
  if (!clonedFromNodeId) return void 0;
  return ctx.mesh.nodes.find((n) => n.id === clonedFromNodeId || n.nodeId === clonedFromNodeId || n.node_id === clonedFromNodeId);
}
function isLocalControlPlaneNode(ctx, node) {
  if (isDirectLocalNode(ctx, node)) return true;
  if (node.isLocalWorktree === true) {
    const sourceNode = findClonedFromNode(ctx, node);
    if (sourceNode && isDirectLocalNode(ctx, sourceNode)) return true;
  }
  return false;
}
function meshSessionCacheKey(nodeId, runtimeSessionId) {
  return `${nodeId}:${runtimeSessionId}`;
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
  return countUncommittedChanges(status) > 0;
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
      const statusResult = !isLocalTransport(ctx.transport) && node.daemonId ? await ctx.transport.gitStatus(node.daemonId, repo.workspace, false, true) : await commandForNode(ctx, node, "git_status", { workspace: repo.workspace, refreshUpstream: true });
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
function readSpawnedSessionVisibility(policy) {
  return policy?.spawnedSessionVisibility === "hidden" ? "hidden" : "visible";
}
function missingProviderPriorityMessage(nodeId) {
  return `Node '${nodeId}' has no providerPriority policy; pass type explicitly or configure node.policy.providerPriority`;
}
function getNodeLaunchReadiness(node) {
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
function readNumeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
function summarizeBranchConvergence(nodes) {
  const followUps = nodes.filter((node) => node?.branchConvergence?.needsConvergence === true).map((node) => ({
    nodeId: node.nodeId,
    workspace: node.workspace,
    branch: node.branchConvergence.branch,
    status: node.branchConvergence.status,
    reason: node.branchConvergence.reason,
    nextStep: node.branchConvergence.nextStep
  }));
  return {
    needsFollowUp: followUps.length > 0,
    unresolvedCount: followUps.length,
    requiredFinalStates: ["merged_to_main", "pushed_feature_branch_needs_merge", "blocked_review", "cleanup_candidate", "not_mergeable"],
    followUps
  };
}
async function commandForNode(ctx, node, command, args = {}) {
  const isLocalNode = isLocalControlPlaneNode(ctx, node);
  if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
    return ctx.transport.meshCommand(node.daemonId, command, args);
  }
  if (isLocalTransport(ctx.transport)) {
    return ctx.transport.command(command, args);
  }
  throw new Error(`Command '${command}' requires daemon IPC/local transport for node '${node.id}'`);
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
    ...metadataEvent.intentional === true ? { intentional: true } : {},
    ...metadataEvent.intentionalStop === true ? { intentionalStop: true } : {},
    ...metadataEvent.operatorCleanup === true ? { operatorCleanup: true } : {},
    ...readString(metadataEvent.reason) ? { reason: readString(metadataEvent.reason) } : {},
    ...readString(metadataEvent.stopReason) ? { stopReason: readString(metadataEvent.stopReason) } : {},
    ...readString(metadataEvent.cleanupReason) ? { cleanupReason: readString(metadataEvent.cleanupReason) } : {},
    ...readString(metadataEvent.source) ? { source: readString(metadataEvent.source) } : {}
  };
}
async function drainCoordinatorPendingEvents(ctx, opts) {
  const requestedNodeIds = opts?.nodeIds?.length ? new Set(opts.nodeIds) : null;
  const matchesCurrentMesh = (event) => readString(event?.meshId) === ctx.mesh.id;
  if (ctx.transport instanceof IpcTransport) {
    const surfacedEvents = [];
    try {
      surfacedEvents.push(
        ...normalizePendingMeshCoordinatorEvents(await ctx.transport.command("get_pending_mesh_events", { meshId: ctx.mesh.id })).filter(matchesCurrentMesh)
      );
    } catch {
    }
    for (const node of ctx.mesh.nodes) {
      if (!node.daemonId || isLocalControlPlaneNode(ctx, node)) continue;
      if (requestedNodeIds && !requestedNodeIds.has(node.id)) continue;
      try {
        const remoteEvents = normalizePendingMeshCoordinatorEvents(
          await ctx.transport.meshCommand(node.daemonId, "get_pending_mesh_events", { meshId: ctx.mesh.id })
        ).filter(matchesCurrentMesh);
        if (remoteEvents.length === 0) continue;
        for (const event of remoteEvents) {
          const payload = buildMeshForwardPayloadFromPendingEvent(event);
          if (!payload.event || !payload.meshId) continue;
          await ctx.transport.command("mesh_forward_event", payload);
        }
      } catch {
      }
    }
    try {
      surfacedEvents.push(
        ...normalizePendingMeshCoordinatorEvents(await ctx.transport.command("get_pending_mesh_events", { meshId: ctx.mesh.id })).filter(matchesCurrentMesh)
      );
    } catch {
    }
    return surfacedEvents;
  }
  if (isLocalTransport(ctx.transport)) {
    return (0, import_daemon_core.drainPendingMeshCoordinatorEvents)(ctx.mesh.id).filter(matchesCurrentMesh);
  }
  return [];
}
function isP2pTransportUnavailableError(error) {
  return (0, import_daemon_core.isP2pRelayTransportFailure)(error);
}
function buildRemoveNodeArgs(ctx, nodeId, sessionCleanupMode) {
  return {
    meshId: ctx.mesh.id,
    nodeId,
    ...sessionCleanupMode ? { sessionCleanupMode } : {},
    inlineMesh: ctx.mesh
  };
}
var MESH_STATUS_TOOL = {
  name: "mesh_status",
  description: "Get the current status of all nodes in the repo mesh \u2014 health, git state, active sessions, recovery hints, and recommended next steps. Use this to decide which node to send work to or how to recover from failures.",
  inputSchema: {
    type: "object",
    properties: {
      _gemini_compat: { type: "string", description: "Dummy property for Gemini compatibility. Ignore this." }
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
  description: "Add a new task to the mesh work queue. Idle nodes will automatically pull and execute tasks from this queue. Use this instead of mesh_send_task when you do not need to target a specific node.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "The task instruction for the agent." }
    },
    required: ["message"]
  }
};
var MESH_VIEW_QUEUE_TOOL = {
  name: "mesh_view_queue",
  description: "View the mesh work queue with source-of-truth active counts separated from historical completed/failed/cancelled records.",
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
      }
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
  description: "Return a mesh queue task to pending for retry. By default clears stale assigned owner and target session so another live session can claim it.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Queue task ID to requeue." },
      reason: { type: "string", description: "Optional operator-visible reason for requeueing." },
      target_node_id: { type: "string", description: "Optional replacement target node ID." },
      target_session_id: { type: "string", description: "Optional replacement target runtime session ID." },
      clear_target_node: { type: "boolean", description: "When true, remove any existing target node constraint." },
      keep_target_session: { type: "boolean", description: "When true, preserve an existing target session if target_session_id is not provided. Defaults false to avoid stale session targets." }
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
      message: { type: "string", description: "Natural-language task to send to the agent." }
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
var MESH_LAUNCH_SESSION_TOOL = {
  name: "mesh_launch_session",
  description: "Launch a new agent session on a mesh node. Returns the session ID for subsequent send_task/read_chat calls. If the user names a provider, preserve it exactly: Hermes = hermes-cli, Claude Code/Claude = claude-cli, Codex = codex-cli, Gemini = gemini-cli. If type is omitted, resolve strictly from the node policy providerPriority and provider detection; fail closed when no configured provider is usable. Do not default to claude-cli.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Target node ID." },
      type: { type: "string", description: "Optional provider type to launch. Use hermes-cli for Hermes, claude-cli for Claude Code, codex-cli for Codex, gemini-cli for Gemini. When omitted, node.policy.providerPriority is probed in order." }
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
var MESH_CLONE_NODE_TOOL = {
  name: "mesh_clone_node",
  description: "Create a new worktree-based node from an existing node for isolated parallel work. Creates a git worktree on a new branch so multiple tasks can run on separate branches simultaneously.",
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
  description: "Remove a node from the mesh. If the node is a worktree, also cleans up the git worktree and directory. Session cleanup is controlled by mesh policy sessionCleanupOnNodeRemove unless session_cleanup_mode overrides it for this call.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Node ID to remove." },
      session_cleanup_mode: {
        type: "string",
        enum: ["preserve", "stop", "delete_stopped", "stop_and_delete"],
        description: "Optional override for cleanup of delegated sessions attached to this node. preserve keeps history/processes; stop stops live runtimes only; delete_stopped removes completed transcripts only; stop_and_delete stops live runtimes and deletes records."
      }
    },
    required: ["node_id"]
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
  description: "Read the task ledger for this mesh \u2014 dispatched tasks, completions, failures, checkpoints, and node lifecycle events. Use to understand what has been done before deciding next steps, to detect repeated failures, and to inform recovery decisions.",
  inputSchema: {
    type: "object",
    properties: {
      tail: { type: "number", description: "Number of recent entries to return (default: 20)." },
      kind: { type: "string", description: "Filter by entry kind: task_dispatched, task_completed, task_failed, task_stalled, session_launched, checkpoint_created, node_cloned, node_removed." }
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
var MESH_REFINE_NODE_TOOL = {
  name: "mesh_refine_node",
  description: "The Refinery: Automatically validate and merge a completed worktree node back into its base branch. This tool automates the validation gate and merge queue step. It will merge the node's branch into its base branch and cleanly remove the worktree node and its sessions.",
  inputSchema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Node ID of the completed worktree node to refine and merge." }
    },
    required: ["node_id"]
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
  MESH_LAUNCH_SESSION_TOOL,
  MESH_GIT_STATUS_TOOL,
  MESH_CHECKPOINT_TOOL,
  MESH_APPROVE_TOOL,
  MESH_CLONE_NODE_TOOL,
  MESH_REMOVE_NODE_TOOL,
  MESH_REFINE_NODE_TOOL,
  MESH_CLEANUP_SESSIONS_TOOL,
  MESH_TASK_HISTORY_TOOL,
  MESH_RECONCILE_LEDGER_TOOL
];
async function meshStatus(ctx) {
  await refreshMeshFromDaemon(ctx);
  const { mesh, transport } = ctx;
  const results = [];
  const ledgerSummary = (0, import_daemon_core.getLedgerSummary)(mesh.id);
  for (const node of mesh.nodes) {
    const entry = {
      nodeId: node.id,
      workspace: node.workspace,
      ...getNodeLaunchReadiness(node)
    };
    try {
      if (!isLocalTransport(transport) && node.daemonId) {
        const result = await transport.gitStatus(node.daemonId, node.workspace, false, true);
        const status = extractGitStatus(result);
        const uncommittedChanges = countUncommittedChanges(status);
        const dirty = isGitStatusDirty(status);
        entry.health = status?.isGitRepo ? dirty ? "dirty" : "online" : "degraded";
        assignFullGitSnapshot(entry, status);
        entry.branch = status?.branch;
        entry.isDirty = dirty;
        entry.uncommittedChanges = uncommittedChanges;
        entry.branchConvergence = buildBranchConvergence(mesh, node, status, dirty, uncommittedChanges);
        const submodules = extractSubmodules(result, node.policy?.submoduleIgnorePaths || []);
        if (submodules && submodules.some((s) => s?.outOfSync)) {
          entry.submoduleWarning = "One or more submodules are out of sync with the parent repo. Run `git submodule update` or check deployment readiness.";
          entry.outOfSyncSubmodules = submodules.filter((s) => s?.outOfSync).map((s) => s.path);
        }
      } else if (isLocalTransport(transport)) {
        const autoDiscover = node.policy?.autoDiscoverSubmodules !== false;
        const statusResult = await commandForNode(ctx, node, "git_status", {
          workspace: node.workspace,
          refreshUpstream: true,
          includeSubmodules: autoDiscover,
          submoduleIgnorePaths: node.policy?.submoduleIgnorePaths || void 0
        });
        const status = extractGitStatus(statusResult);
        const uncommittedChanges = countUncommittedChanges(status);
        const dirty = isGitStatusDirty(status);
        entry.health = status?.isGitRepo ? dirty ? "dirty" : "online" : "degraded";
        assignFullGitSnapshot(entry, status);
        entry.branch = status?.branch;
        entry.isDirty = dirty;
        entry.uncommittedChanges = uncommittedChanges;
        entry.branchConvergence = buildBranchConvergence(mesh, node, status, dirty, uncommittedChanges);
        const submodules = extractSubmodules(statusResult, node.policy?.submoduleIgnorePaths || []);
        if (submodules && submodules.some((s) => s?.outOfSync)) {
          entry.submoduleWarning = "One or more submodules are out of sync with the parent repo. Run `git submodule update` or check deployment readiness.";
          entry.outOfSyncSubmodules = submodules.filter((s) => s?.outOfSync).map((s) => s.path);
        }
      } else {
        entry.health = "unknown";
        entry.note = "No daemonId available for cloud status probe";
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
    const recoveryContext = (0, import_daemon_core.getSessionRecoveryContext)(mesh.id, { nodeId: node.id });
    if (recoveryContext.consecutiveNodeFailures > 0) {
      entry.recoveryHints = {
        consecutiveFailures: recoveryContext.consecutiveNodeFailures,
        lastTaskMessage: recoveryContext.lastTaskMessage,
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
    results.push(entry);
  }
  const response = {
    meshId: mesh.id,
    meshName: mesh.name,
    repoIdentity: mesh.repoIdentity,
    policy: mesh.policy,
    refreshedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sourceOfTruth: {
      membership: "coordinator_daemon_live_mesh",
      currentStatus: "live_git_and_session_probes",
      historicalEvidenceOnly: ["recoveryHints", "ledgerSummary"]
    },
    nodes: results,
    branchConvergenceSummary: summarizeBranchConvergence(results)
  };
  try {
    response.ledgerSummary = ledgerSummary;
  } catch {
  }
  try {
    const pendingEvents = await drainCoordinatorPendingEvents(ctx);
    if (pendingEvents.length > 0) {
      response.pendingCoordinatorEvents = pendingEvents;
    }
  } catch {
  }
  return JSON.stringify(response, null, 2);
}
async function meshTaskHistory(ctx, args) {
  const { mesh } = ctx;
  await drainCoordinatorPendingEvents(ctx);
  const tail = typeof args.tail === "number" && args.tail > 0 ? args.tail : 20;
  const kind = typeof args.kind === "string" && args.kind.trim() ? [args.kind.trim()] : void 0;
  const entries = (0, import_daemon_core.readLedgerEntries)(mesh.id, { tail, kind });
  const summary = (0, import_daemon_core.getLedgerSummary)(mesh.id);
  return JSON.stringify({ meshId: mesh.id, entries, summary }, null, 2);
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
  for (const node of nodes) {
    try {
      if (isLocalControlPlaneNode(ctx, node) || !node.daemonId) {
        const slice2 = (0, import_daemon_core.readLedgerSlice)(ctx.mesh.id, queryArgs);
        replicas.push((0, import_daemon_core.buildMeshLedgerReplicaEvidence)({
          nodeId: node.id,
          daemonId: node.daemonId,
          transport: "local",
          slice: slice2,
          status: "local"
        }));
        continue;
      }
      const result = await commandForNode(ctx, node, "get_mesh_ledger_slice", queryArgs);
      const payload = unwrapCommandPayload(result);
      if (payload?.success === false) {
        throw new Error(payload.error || "remote get_mesh_ledger_slice failed");
      }
      const slice = payload?.slice ?? payload;
      if (slice?.protocol !== "adhdev.mesh.ledger.slice.v1" || !Array.isArray(slice.entries)) {
        throw new Error("remote daemon returned an invalid ledger slice payload");
      }
      const importResult = shouldImport ? (0, import_daemon_core.appendRemoteLedgerEntries)(ctx.mesh.id, slice.entries) : { accepted: 0, skippedDuplicate: 0, rejectedInvalid: 0, entries: [] };
      replicas.push((0, import_daemon_core.buildMeshLedgerReplicaEvidence)({
        nodeId: node.id,
        daemonId: node.daemonId,
        transport: "p2p_datachannel",
        slice,
        importResult
      }));
      if (shouldImport && importResult.accepted > 0) {
        (0, import_daemon_core.appendLedgerEntry)(ctx.mesh.id, {
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
    } catch (e) {
      replicas.push((0, import_daemon_core.buildMeshLedgerReplicaEvidence)({
        nodeId: node.id,
        daemonId: node.daemonId,
        transport: node.daemonId ? "p2p_datachannel" : "local",
        status: "failed",
        error: e?.message ?? String(e)
      }));
    }
  }
  const evidence = (0, import_daemon_core.buildMeshLedgerReconciliationEvidence)(ctx.mesh.id, replicas);
  (0, import_daemon_core.appendLedgerEntry)(ctx.mesh.id, {
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
      isLocalWorktree: n.isLocalWorktree,
      policy: n.policy,
      relatedRepos: readRelatedRepos(n),
      ...getNodeLaunchReadiness(n),
      userOverrides: n.userOverrides
    }))
  }, null, 2);
}
async function meshEnqueueTask(ctx, args) {
  try {
    const task = (0, import_daemon_core.enqueueTask)(ctx.mesh.id, args.message);
    if (isLocalTransport(ctx.transport) && !(ctx.transport instanceof IpcTransport)) {
      ctx.transport.command("trigger_mesh_queue", { meshId: ctx.mesh.id }).catch(() => {
      });
      return JSON.stringify({ success: true, taskId: task.id, status: task.status });
    }
    if (ctx.transport instanceof IpcTransport) {
      ctx.transport.command("trigger_mesh_queue", { meshId: ctx.mesh.id }).catch(() => {
      });
      const dispatchPromises = [];
      for (const node of ctx.mesh.nodes) {
        const isLocalNode = isLocalControlPlaneNode(ctx, node);
        if (isLocalNode || !node.daemonId) continue;
        dispatchPromises.push(
          ipcDispatchToRemoteAgent(ctx, node, { message: args.message }).then((result) => {
            if (result.success) {
              try {
                (0, import_daemon_core.appendLedgerEntry)(ctx.mesh.id, {
                  kind: "task_dispatched",
                  nodeId: node.id,
                  sessionId: result.sessionId,
                  payload: { message: args.message, via: "p2p_direct", taskId: task.id }
                });
              } catch {
              }
            }
          }).catch(() => {
          })
        );
      }
      Promise.all(dispatchPromises).catch(() => {
      });
      return JSON.stringify({ success: true, taskId: task.id, status: task.status });
    }
    return JSON.stringify({ success: true, taskId: task.id, status: task.status });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}
async function meshViewQueue(ctx, args) {
  try {
    const statusFilter = sanitizeQueueStatusFilter(args.status);
    const view = normalizeQueueViewMode(args.view);
    const fullQueue = annotateQueueStaleness((0, import_daemon_core.getQueue)(ctx.mesh.id), ctx.mesh);
    const queue = filterQueueForView(fullQueue, view, statusFilter);
    const summary = buildQueueStatusSummary(fullQueue);
    const visibleSummary = buildQueueStatusSummary(queue);
    const maintenance = buildQueueMaintenanceReport(fullQueue);
    const staleAssignedTasks = maintenance.staleAssignedTasks || [];
    const requestedHistoricalRows = queue.some((task) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || "")));
    return JSON.stringify({
      success: true,
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
      queue,
      visibleQueue: queue,
      visibleSummary,
      summary,
      activeCounts: summary.activeCounts,
      historicalCounts: summary.historicalCounts,
      activeCount: summary.activeCount,
      historicalCount: summary.historicalCount,
      visibleActiveCounts: visibleSummary.activeCounts,
      visibleHistoricalCounts: visibleSummary.historicalCounts,
      visibleActiveCount: visibleSummary.activeCount,
      visibleHistoricalCount: visibleSummary.historicalCount,
      staleAssignedTasks,
      staleAssignedCount: maintenance.staleAssignedCount,
      queueMaintenance: maintenance,
      cleanupDryRun: maintenance,
      ...view === "active" || statusFilter?.some((status) => ACTIVE_QUEUE_STATUSES.has(status)) ? {
        activeQueue: queue.filter((task) => ACTIVE_QUEUE_STATUSES.has(String(task?.status || "")))
      } : {},
      ...view === "historical" || requestedHistoricalRows ? {
        historicalQueue: queue.filter((task) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || "")))
      } : {},
      // Back-compat alias for callers already reading the first hardening payload.
      staleAssignments: staleAssignedTasks
    }, null, 2);
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}
async function meshQueueCancel(ctx, args) {
  try {
    const taskId = (args.task_id || args.taskId || "").trim();
    if (!taskId) return JSON.stringify({ success: false, error: "task_id required" });
    const task = (0, import_daemon_core.cancelTask)(ctx.mesh.id, taskId, { reason: args.reason });
    if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
    return JSON.stringify({ success: true, task }, null, 2);
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
    const task = (0, import_daemon_core.requeueTask)(ctx.mesh.id, taskId, {
      reason: args.reason,
      targetNodeId,
      targetSessionId,
      clearTargetNode: args.clear_target_node === true || args.clearTargetNode === true,
      clearTargetSession: targetSessionId ? false : !keepTargetSession
    });
    if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
    if (isLocalTransport(ctx.transport)) {
      ctx.transport.command("trigger_mesh_queue", { meshId: ctx.mesh.id }).catch(() => {
      });
    }
    return JSON.stringify({ success: true, task }, null, 2);
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}
async function meshSendTask(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  if (node.policy?.readOnly) {
    return JSON.stringify({ error: `Node '${args.node_id}' is read-only` });
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
    if (!isLocalTransport(ctx.transport) && node.daemonId) {
      const res = await ctx.transport.meshEnqueueTask(node.daemonId, {
        meshId: ctx.mesh.id,
        message: args.message,
        targetNodeId: args.node_id
      });
      return JSON.stringify(res);
    }
    const isLocalNode = isLocalControlPlaneNode(ctx, node);
    if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
      const cached = meshSessionProviderMetadata.get(meshSessionCacheKey(args.node_id, args.session_id || ""));
      const result2 = await ipcDispatchToRemoteAgent(ctx, node, {
        session_id: args.session_id,
        message: args.message,
        providerType: cached?.providerType
      });
      if (result2.success) {
        const dispatchedSessionId = args.session_id || result2.sessionId;
        try {
          (0, import_daemon_core.appendLedgerEntry)(ctx.mesh.id, {
            kind: "task_dispatched",
            nodeId: args.node_id,
            sessionId: dispatchedSessionId,
            payload: {
              message: args.message,
              via: "p2p_direct",
              ...dispatchedSessionId ? { targetSessionId: dispatchedSessionId } : {}
            }
          });
        } catch {
        }
      }
      return JSON.stringify({ ...result2, nodeId: args.node_id, dispatched: result2.success === true });
    }
    if (args.session_id && isLocalTransport(ctx.transport)) {
      const cached = meshSessionProviderMetadata.get(meshSessionCacheKey(args.node_id, args.session_id));
      let resolvedProviderType = cached?.providerType || "";
      if (!resolvedProviderType) {
        const statusResult = await commandForNode(ctx, node, "get_status_metadata", {});
        const sessions = extractStatusMetadataSessions(statusResult);
        const explicitSession = sessions.find((session) => readSessionRecordId(session) === args.session_id);
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
        resolvedProviderType = resolveSessionProviderType(explicitSession);
        if (resolvedProviderType) {
          meshSessionProviderMetadata.set(meshSessionCacheKey(args.node_id, args.session_id), {
            providerType: resolvedProviderType,
            providerSessionId: readString(explicitSession?.providerSessionId) || void 0
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
      const dispatchResult = await commandForNode(ctx, node, "agent_command", {
        targetSessionId: args.session_id,
        agentType: resolvedProviderType,
        cliType: resolvedProviderType,
        providerType: resolvedProviderType,
        action: "send_chat",
        message: args.message
      });
      const dispatchPayload = unwrapCommandPayload(dispatchResult);
      if (dispatchPayload?.success === false || dispatchResult?.success === false) {
        return JSON.stringify({
          success: false,
          nodeId: args.node_id,
          sessionId: args.session_id,
          error: dispatchPayload?.error || dispatchResult?.error || "agent_command rejected the task"
        });
      }
      try {
        (0, import_daemon_core.appendLedgerEntry)(ctx.mesh.id, {
          kind: "task_dispatched",
          nodeId: args.node_id,
          sessionId: args.session_id,
          providerType: resolvedProviderType,
          payload: { message: args.message, via: "local_direct" }
        });
      } catch {
      }
      return JSON.stringify({ success: true, dispatched: true, nodeId: args.node_id, sessionId: args.session_id });
    }
    const task = (0, import_daemon_core.enqueueTask)(ctx.mesh.id, args.message, {
      targetNodeId: args.node_id,
      targetSessionId: args.session_id
    });
    if (isLocalTransport(ctx.transport) || ctx.transport instanceof IpcTransport) {
      ctx.transport.command("trigger_mesh_queue", { meshId: ctx.mesh.id }).catch(() => {
      });
    }
    const pendingEvents = isLocalTransport(ctx.transport) ? (0, import_daemon_core.drainPendingMeshCoordinatorEvents)(ctx.mesh.id) : [];
    const result = { success: true, nodeId: args.node_id, taskId: task.id, status: task.status };
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
  if (ctx.transport instanceof IpcTransport || isLocalTransport(ctx.transport)) {
    await drainCoordinatorPendingEvents(ctx, { nodeIds: [args.node_id] });
  }
  if (isLocalTransport(ctx.transport)) {
    const cached = meshSessionProviderMetadata.get(meshSessionCacheKey(args.node_id, args.session_id));
    const providerSessionId = typeof args.provider_session_id === "string" && args.provider_session_id.trim() ? args.provider_session_id.trim() : cached?.providerSessionId;
    const result = await commandForNode(ctx, node, "read_chat", {
      sessionId: args.session_id,
      targetSessionId: args.session_id,
      workspace: node.workspace,
      ...cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {},
      ...providerSessionId ? { providerSessionId } : {},
      tailLimit: args.tail ?? 10
    });
    const payload = annotateRapidReadChatAdvisory(unwrapCommandPayload(result), {
      key: `mesh:${args.node_id}:${args.session_id}`,
      toolName: "mesh_read_chat",
      completionCallbackExpected: true
    });
    if (args.compact) {
      const compactPayload = compactChatPayload(payload, {
        nodeId: args.node_id,
        sessionId: args.session_id,
        limit: args.tail ?? 10
      });
      return JSON.stringify(
        payload.pollingAdvisory ? { ...compactPayload, pollingAdvisory: payload.pollingAdvisory } : compactPayload,
        null,
        2
      );
    }
    return JSON.stringify(payload, null, 2);
  } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
    try {
      const targetId = `${node.daemonId}:session:${args.session_id}`;
      const res = await ctx.transport.readChat(targetId, {
        limit: args.tail ?? 10,
        sessionId: args.session_id
      });
      return JSON.stringify(res, null, 2);
    } catch (e) {
      return JSON.stringify({ success: false, error: e.message });
    }
  } else {
    return JSON.stringify({ error: "Cloud mesh read_chat requires node daemonId" });
  }
}
async function meshReadDebug(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  if (isLocalTransport(ctx.transport)) {
    const cached = meshSessionProviderMetadata.get(meshSessionCacheKey(args.node_id, args.session_id));
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
  } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
    try {
      const targetId = `${node.daemonId}:session:${args.session_id}`;
      const res = await ctx.transport.getChatDebugBundle(targetId, {
        sessionId: args.session_id,
        tailLimit: args.tail ?? 40,
        delivery: args.delivery
      });
      return JSON.stringify(res, null, 2);
    } catch (e) {
      return JSON.stringify({ success: false, error: e.message });
    }
  }
  return JSON.stringify({ error: "Cloud mesh read_debug requires node daemonId" });
}
async function meshLaunchSession(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  if (isLocalTransport(ctx.transport)) {
    let resolvedProviderType = typeof args.type === "string" && args.type.trim() ? args.type : "";
    if (!resolvedProviderType) {
      const providerPriority = readProviderPriority(node.policy);
      if (!providerPriority.length) {
        return JSON.stringify({ success: false, error: missingProviderPriorityMessage(args.node_id) });
      }
      const failed = [];
      for (const providerType of providerPriority) {
        const detectedResult = await commandForNode(ctx, node, "detect_provider", { providerType });
        const detectedPayload = unwrapCommandPayload(detectedResult);
        if (detectedPayload?.success && detectedPayload?.detected) {
          resolvedProviderType = providerType;
          break;
        }
        failed.push(`${providerType}: ${detectedPayload?.error || "not detected"}`);
      }
      if (!resolvedProviderType) {
        return JSON.stringify({ success: false, error: `No usable provider detected for node '${args.node_id}' from providerPriority: ${failed.join("; ")}` });
      }
    }
    const coordinatorNode = resolveCoordinatorNode(ctx);
    const coordinatorDaemonId = coordinatorNode?.daemonId || ctx.localDaemonId;
    const spawnedSessionVisibility = readSpawnedSessionVisibility(ctx.mesh.policy);
    const isLocalNode = isLocalControlPlaneNode(ctx, node);
    if (node.daemonId && !isLocalNode && !coordinatorDaemonId) {
      return JSON.stringify(buildMissingCoordinatorDaemonIdFailure(ctx, node, resolvedProviderType), null, 2);
    }
    let result;
    try {
      result = await commandForNode(ctx, node, "launch_cli", {
        cliType: resolvedProviderType,
        dir: node.workspace,
        settings: {
          meshNodeFor: ctx.mesh.id,
          meshNodeId: args.node_id,
          spawnedSessionVisibility,
          ...coordinatorDaemonId ? { meshCoordinatorDaemonId: coordinatorDaemonId } : {},
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
        ...providerSessionId ? { providerSessionId } : {}
      });
    }
    try {
      (0, import_daemon_core.appendLedgerEntry)(ctx.mesh.id, {
        kind: "session_launched",
        nodeId: args.node_id,
        sessionId: runtimeSessionId || void 0,
        providerType: resolvedProviderType,
        payload: { providerSessionId }
      });
    } catch {
    }
    if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
      ctx.transport.meshCommand(node.daemonId, "trigger_mesh_queue", { meshId: ctx.mesh.id }).catch(() => {
      });
    } else if (isLocalTransport(ctx.transport)) {
      ctx.transport.command("trigger_mesh_queue", { meshId: ctx.mesh.id }).catch(() => {
      });
    }
    return JSON.stringify({
      ...launchPayload,
      resolvedProviderType,
      ...providerSessionId ? { providerSessionId } : {}
    }, null, 2);
  } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
    let resolvedProviderType = typeof args.type === "string" && args.type.trim() ? args.type : "";
    if (!resolvedProviderType) {
      const providerPriority = readProviderPriority(node.policy);
      if (!providerPriority.length) {
        return JSON.stringify({ success: false, error: missingProviderPriorityMessage(args.node_id) });
      }
      resolvedProviderType = providerPriority[0];
    }
    const coordinatorNode = resolveCoordinatorNode(ctx);
    const coordinatorDaemonId = coordinatorNode?.daemonId || ctx.localDaemonId;
    const spawnedSessionVisibility = readSpawnedSessionVisibility(ctx.mesh.policy);
    if (!coordinatorDaemonId) {
      return JSON.stringify(buildMissingCoordinatorDaemonIdFailure(ctx, node, resolvedProviderType), null, 2);
    }
    try {
      const res = await ctx.transport.launch(node.daemonId, {
        type: resolvedProviderType,
        dir: node.workspace,
        settings: {
          meshNodeFor: ctx.mesh.id,
          meshNodeId: args.node_id,
          spawnedSessionVisibility,
          ...coordinatorDaemonId ? { meshCoordinatorDaemonId: coordinatorDaemonId } : {},
          ...coordinatorNode?.id ? { meshCoordinatorNodeId: coordinatorNode.id } : {},
          launchedByCoordinator: true
        }
      });
      const runtimeSessionId = typeof res?.sessionId === "string" ? res.sessionId : typeof res?.id === "string" ? res.id : "";
      try {
        (0, import_daemon_core.appendLedgerEntry)(ctx.mesh.id, {
          kind: "session_launched",
          nodeId: args.node_id,
          sessionId: runtimeSessionId || void 0,
          providerType: resolvedProviderType,
          payload: {}
        });
      } catch {
      }
      return JSON.stringify({ ...res, resolvedProviderType }, null, 2);
    } catch (e) {
      return JSON.stringify(recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, e), null, 2);
    }
  } else {
    return JSON.stringify({ error: "Cloud mesh launch_session requires node daemonId" });
  }
}
async function meshGitStatus(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  const autoDiscoverSubmodules = node.policy?.autoDiscoverSubmodules !== false;
  const submoduleIgnorePaths = node.policy?.submoduleIgnorePaths || [];
  try {
    if (!isLocalTransport(ctx.transport) && node.daemonId) {
      const result = await ctx.transport.gitStatus(node.daemonId, node.workspace, true, true);
      return JSON.stringify({
        nodeId: args.node_id,
        workspace: node.workspace,
        status: extractGitStatus(result),
        diff: extractGitDiff(result),
        submodules: autoDiscoverSubmodules ? extractSubmodules(result, submoduleIgnorePaths) : void 0,
        relatedRepos: await collectRelatedRepoStatuses(ctx, node)
      }, null, 2);
    } else if (isLocalTransport(ctx.transport)) {
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
    } else {
      return JSON.stringify({ error: "No daemonId available for cloud git_status probe" });
    }
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
async function meshCheckpoint(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  if (node.policy?.readOnly) {
    return JSON.stringify({ error: `Node '${args.node_id}' is read-only \u2014 cannot checkpoint` });
  }
  if (isLocalTransport(ctx.transport)) {
    const result = await commandForNode(ctx, node, "git_checkpoint", {
      workspace: node.workspace,
      message: args.message,
      includeUntracked: true
    });
    try {
      (0, import_daemon_core.appendLedgerEntry)(ctx.mesh.id, {
        kind: "checkpoint_created",
        nodeId: args.node_id,
        payload: { message: args.message, commit: result?.checkpoint?.commit }
      });
    } catch {
    }
    return JSON.stringify(result, null, 2);
  } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
    try {
      const res = await ctx.transport.gitCheckpoint(node.daemonId, {
        workspace: node.workspace,
        message: args.message,
        includeUntracked: true
      });
      try {
        (0, import_daemon_core.appendLedgerEntry)(ctx.mesh.id, {
          kind: "checkpoint_created",
          nodeId: args.node_id,
          payload: { message: args.message, commit: res?.checkpoint?.commit }
        });
      } catch {
      }
      return JSON.stringify(res, null, 2);
    } catch (e) {
      return JSON.stringify({ success: false, error: e.message });
    }
  } else {
    return JSON.stringify({ error: "Cloud mesh checkpoint requires node daemonId" });
  }
}
async function meshApprove(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  if (isLocalTransport(ctx.transport)) {
    const cached = meshSessionProviderMetadata.get(meshSessionCacheKey(args.node_id, args.session_id));
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
  } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
    try {
      const targetId = `${node.daemonId}:session:${args.session_id}`;
      const res = await ctx.transport.approve(targetId, args.action === "reject" ? "reject" : "approve");
      return JSON.stringify(res, null, 2);
    } catch (e) {
      return JSON.stringify({ success: false, error: e.message });
    }
  } else {
    return JSON.stringify({ error: "Cloud mesh approve requires node daemonId" });
  }
}
async function meshCloneNode(ctx, args) {
  const sourceNode = await findNodeWithRefresh(ctx, args.source_node_id);
  if (isLocalTransport(ctx.transport)) {
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
  } else if (!isLocalTransport(ctx.transport) && sourceNode.daemonId) {
    try {
      const res = await ctx.transport.meshCloneNode(sourceNode.daemonId, {
        meshId: ctx.mesh.id,
        sourceNodeId: args.source_node_id,
        branch: args.branch,
        baseBranch: args.base_branch,
        inlineMesh: ctx.mesh
      });
      const clonePayload = extractCloneNodePayload(res);
      if (clonePayload?.success && clonePayload.node?.id) {
        const existingIndex = ctx.mesh.nodes.findIndex((n) => n.id === clonePayload.node.id);
        if (existingIndex >= 0) ctx.mesh.nodes[existingIndex] = clonePayload.node;
        else ctx.mesh.nodes.push(clonePayload.node);
        ctx.mesh.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        await syncCoordinatorDaemonMeshCache(ctx);
      }
      return JSON.stringify(res, null, 2);
    } catch (e) {
      return JSON.stringify({ success: false, error: e.message });
    }
  } else {
    return JSON.stringify({ error: "Cloud mesh clone_node requires source node daemonId" });
  }
}
async function meshCleanupSessions(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  if (isLocalTransport(ctx.transport)) {
    const result = await commandForNode(ctx, node, "cleanup_mesh_sessions", {
      meshId: ctx.mesh.id,
      nodeId: args.node_id,
      mode: args.mode,
      sessionIds: args.session_ids,
      dryRun: args.dry_run === true,
      inlineMesh: ctx.mesh
    });
    return JSON.stringify(result, null, 2);
  } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
    try {
      const res = await ctx.transport.meshCleanupSessions(node.daemonId, {
        meshId: ctx.mesh.id,
        nodeId: args.node_id,
        mode: args.mode,
        sessionIds: args.session_ids,
        dryRun: args.dry_run === true,
        inlineMesh: ctx.mesh
      });
      return JSON.stringify(res, null, 2);
    } catch (e) {
      return JSON.stringify({ success: false, error: e.message });
    }
  } else {
    return JSON.stringify({ error: "Cloud mesh cleanup_sessions requires node daemonId" });
  }
}
async function meshRemoveNode(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  if (isLocalTransport(ctx.transport)) {
    const removeArgs = buildRemoveNodeArgs(ctx, args.node_id, args.session_cleanup_mode);
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
  } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
    try {
      const res = await ctx.transport.meshRemoveNode(node.daemonId, {
        meshId: ctx.mesh.id,
        nodeId: args.node_id,
        ...args.session_cleanup_mode ? { sessionCleanupMode: args.session_cleanup_mode } : {},
        inlineMesh: ctx.mesh
      });
      if (res?.success && res.removed !== false) {
        const idx = ctx.mesh.nodes.findIndex((n) => n.id === args.node_id);
        if (idx >= 0) {
          ctx.mesh.nodes.splice(idx, 1);
          ctx.mesh.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        }
      }
      return JSON.stringify(res, null, 2);
    } catch (e) {
      return JSON.stringify({ success: false, error: e.message });
    }
  } else {
    return JSON.stringify({ error: "Cloud mesh remove_node requires node daemonId" });
  }
}
async function meshRefineNode(ctx, args) {
  const node = await findNodeWithRefresh(ctx, args.node_id);
  if (isLocalTransport(ctx.transport)) {
    const result = await commandForNode(ctx, node, "refine_mesh_node", {
      meshId: ctx.mesh.id,
      nodeId: args.node_id,
      inlineMesh: ctx.mesh
    });
    if (result?.success && result.removeResult?.removed !== false) {
      const idx = ctx.mesh.nodes.findIndex((n) => n.id === args.node_id);
      if (idx >= 0) {
        ctx.mesh.nodes.splice(idx, 1);
        ctx.mesh.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      }
    }
    return JSON.stringify(result, null, 2);
  } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
    try {
      const res = await ctx.transport.meshRefineNode(node.daemonId, {
        meshId: ctx.mesh.id,
        nodeId: args.node_id,
        inlineMesh: ctx.mesh
      });
      if (res?.success && res.removeResult?.removed !== false) {
        const idx = ctx.mesh.nodes.findIndex((n) => n.id === args.node_id);
        if (idx >= 0) {
          ctx.mesh.nodes.splice(idx, 1);
          ctx.mesh.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        }
      }
      return JSON.stringify(res, null, 2);
    } catch (e) {
      return JSON.stringify({ success: false, error: e.message });
    }
  } else {
    return JSON.stringify({ error: "Cloud mesh refine_node requires node daemonId" });
  }
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
adhdev-mcp \u2014 ADHDev MCP Server

Usage:
  adhdev-mcp                                    Local mode (requires standalone daemon)
  adhdev-mcp --api-key <key>                    Cloud mode (ADHDev cloud API)
  adhdev-mcp --mode ipc --repo-mesh <mesh_id>   Cloud daemon IPC mesh mode
  adhdev-mcp --repo-mesh <mesh_id>              Mesh mode (coordinator-scoped tools)

Options:
  --mode <mode>           Transport: local, cloud, or ipc
  --port <n>              Standalone or IPC daemon port (defaults: local 3847, ipc 19222)
  --password <pass>       Standalone daemon password (if set)
  --api-key <key>         ADHDev cloud API key (switches to cloud mode)
  --base-url <url>        Override cloud API base URL
  --repo-mesh <mesh_id>   Enable mesh mode \u2014 exposes only mesh-scoped coordinator tools
  --help                  Show this help

Environment variables:
  ADHDEV_API_KEY      API key (cloud mode)
  ADHDEV_PASSWORD     Daemon password (local mode)
  ADHDEV_MESH_ID      Mesh ID (mesh mode)
  ADHDEV_MCP_TRANSPORT Transport: local, cloud, or ipc

Standard tools:   ${STANDARD_TOOLS.join(", ")}
Mesh tools:       ${meshTools.join(", ")}
`.trim();
}

// src/server.ts
var import_server = require("@modelcontextprotocol/sdk/server/index.js");
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");
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

// src/transports/cloud.ts
var DEFAULT_BASE_URL = "https://api.adhf.dev";
var CloudTransport = class {
  baseUrl;
  apiKey;
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  }
  headers() {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`
    };
  }
  async listRemoteMeshes() {
    const res = await fetch(`${this.baseUrl}/api/v1/repo-meshes`, { headers: this.headers() });
    if (!res.ok) throw new Error(`List remote meshes failed: ${res.status}`);
    return res.json();
  }
  async createRemoteMesh(data) {
    const res = await fetch(`${this.baseUrl}/api/v1/repo-meshes`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Create remote mesh failed: ${res.status}`);
    return res.json();
  }
  async deleteRemoteMesh(meshId) {
    const res = await fetch(`${this.baseUrl}/api/v1/repo-meshes/${encodeURIComponent(meshId)}`, {
      method: "DELETE",
      headers: this.headers()
    });
    if (!res.ok) throw new Error(`Delete remote mesh failed: ${res.status}`);
  }
  async listDaemons() {
    const res = await fetch(`${this.baseUrl}/api/v1/daemons`, { headers: this.headers() });
    if (!res.ok) throw new Error(`List daemons failed: ${res.status}`);
    return res.json();
  }
  async getStatus(targetId) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(targetId)}/status`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Status failed: ${res.status}`);
    return res.json();
  }
  /** Get all sessions for a daemon (returns CompactSessionEntry[]). */
  async getDaemonStatus(daemonId) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/daemons/${encodeURIComponent(daemonId)}/status`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Daemon status failed: ${res.status}`);
    return res.json();
  }
  async readChat(targetId, opts = {}) {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.sessionId) params.set("sessionId", opts.sessionId);
    const qs = params.toString() ? `?${params}` : "";
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(targetId)}/chat${qs}`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Read chat failed: ${res.status}`);
    return res.json();
  }
  async getChatDebugBundle(targetId, opts = {}) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(targetId)}/chat/debug`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          ...opts.agentType ? { agentType: opts.agentType } : {},
          ...opts.sessionId ? { sessionId: opts.sessionId } : {},
          ...opts.tailLimit ? { tailLimit: opts.tailLimit } : {},
          ...opts.delivery ? { delivery: opts.delivery } : {}
        })
      }
    );
    if (!res.ok) throw new Error(`Chat debug bundle failed: ${res.status}`);
    return res.json();
  }
  async sendChat(targetId, message, opts = {}) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(targetId)}/chat`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ message, ...opts })
      }
    );
    if (!res.ok) throw new Error(`Send chat failed: ${res.status}`);
    return res.json();
  }
  async approve(targetId, action, agentType) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(targetId)}/approve`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ action, ...agentType ? { agentType } : {} })
      }
    );
    if (!res.ok) throw new Error(`Approve failed: ${res.status}`);
    return res.json();
  }
  async gitStatus(daemonId, workspace, includeDiff = true, refreshUpstream = false) {
    const params = new URLSearchParams({ workspace, includeDiff: String(includeDiff), refreshUpstream: String(refreshUpstream) });
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/git-status?${params}`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Git status failed: ${res.status}`);
    return res.json();
  }
  async stop(daemonId, opts) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/stop`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(opts)
      }
    );
    if (!res.ok) throw new Error(`Stop failed: ${res.status}`);
    return res.json();
  }
  async launch(daemonId, opts) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/launch`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(opts)
      }
    );
    if (!res.ok) throw new Error(`Launch failed: ${res.status}`);
    return res.json();
  }
  async gitLog(daemonId, workspace, opts = {}) {
    const params = new URLSearchParams({ workspace });
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.file) params.set("file", opts.file);
    if (opts.since) params.set("since", opts.since);
    if (opts.until) params.set("until", opts.until);
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/git-log?${params}`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Git log failed: ${res.status}`);
    return res.json();
  }
  async gitDiff(daemonId, workspace, opts = {}) {
    const params = new URLSearchParams({ workspace });
    if (opts.file) params.set("file", opts.file);
    if (opts.maxLines) params.set("maxLines", String(opts.maxLines));
    if (opts.staged) params.set("staged", "true");
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/git-diff?${params}`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Git diff failed: ${res.status}`);
    return res.json();
  }
  async gitPush(daemonId, opts) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/git-push`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(opts)
      }
    );
    if (!res.ok) throw new Error(`Git push failed: ${res.status}`);
    return res.json();
  }
  async gitCheckpoint(daemonId, opts) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/git-checkpoint`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(opts)
      }
    );
    if (!res.ok) throw new Error(`Git checkpoint failed: ${res.status}`);
    return res.json();
  }
  async meshCloneNode(daemonId, payload) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/mesh/clone-node`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload)
      }
    );
    if (!res.ok) throw new Error(`Mesh clone node failed: ${res.status}`);
    return res.json();
  }
  async meshRemoveNode(daemonId, payload) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/mesh/remove-node`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload)
      }
    );
    if (!res.ok) throw new Error(`Mesh remove node failed: ${res.status}`);
    return res.json();
  }
  async meshCleanupSessions(daemonId, payload) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/mesh/cleanup-sessions`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload)
      }
    );
    if (!res.ok) throw new Error(`Mesh cleanup sessions failed: ${res.status}`);
    return res.json();
  }
  async meshEnqueueTask(daemonId, payload) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/mesh/enqueue`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload)
      }
    );
    if (!res.ok) throw new Error(`Mesh enqueue task failed: ${res.status}`);
    return res.json();
  }
  async meshRefineNode(daemonId, payload) {
    const res = await fetch(
      `${this.baseUrl}/api/v1/shortcuts/${encodeURIComponent(daemonId)}/mesh/refine-node`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload)
      }
    );
    if (!res.ok) throw new Error(`Mesh refine node failed: ${res.status}`);
    return res.json();
  }
  async ping() {
    try {
      await this.listDaemons();
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
  description: "List all connected agent sessions. In cloud mode, fetches session state from each daemon (data is sourced from daemon WS status reports, up to 30s stale). Pass daemon_id to scope to a single daemon.",
  inputSchema: {
    type: "object",
    properties: {
      daemon_id: {
        type: "string",
        description: "Daemon ID (cloud mode only). Omit to list sessions across all daemons."
      },
      ...FORMAT_PROP
    },
    required: []
  }
};
async function listSessions(transport, args = {}) {
  const asJson = args.format === "json";
  if (isLocalTransport(transport)) {
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
  return listSessionsCloud(transport, args.daemon_id, asJson);
}
async function listSessionsCloud(transport, daemonId, asJson) {
  const collected = [];
  if (daemonId) {
    const daemonStatus = await transport.getDaemonStatus(daemonId);
    for (const s of daemonStatus?.sessions ?? []) {
      collected.push({ daemonId, session: s });
    }
  } else {
    const data = await transport.listDaemons();
    const daemons = data?.daemons ?? [];
    for (let i = 0; i < daemons.length; i += 5) {
      await Promise.allSettled(
        daemons.slice(i, i + 5).map(async (d) => {
          try {
            const daemonStatus = await transport.getDaemonStatus(d.id);
            for (const s of daemonStatus?.sessions ?? []) {
              collected.push({ daemonId: d.id, session: s });
            }
          } catch {
          }
        })
      );
    }
  }
  if (asJson) {
    return JSON.stringify({
      sessions: collected.map(({ daemonId: dId, session: s }) => ({
        daemon_id: dId,
        id: s.id,
        type: s.providerType ?? "unknown",
        status: s.status ?? null,
        workspace: s.workspace ?? null
      }))
    }, null, 2);
  }
  if (collected.length === 0) return "No active sessions.";
  const lines = collected.map(({ daemonId: dId, session: s }) => {
    const parts = [
      `daemon: ${dId}`,
      `session: ${s.id}`,
      `type: ${s.providerType ?? "unknown"}`
    ];
    if (s.status) parts.push(`status: ${s.status}`);
    if (s.workspace) parts.push(`workspace: ${s.workspace}`);
    return parts.join(", ");
  });
  return `Sessions (${collected.length}):
${lines.join("\n")}`;
}

// src/tools/list-daemons.ts
var LIST_DAEMONS_TOOL = {
  name: "list_daemons",
  description: "List all connected daemons (machines running the ADHDev agent). Use this to discover daemon IDs before calling launch_session, git_status, or other tools that require daemon_id. In local mode returns the single standalone daemon info.",
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
  if (isLocalTransport(transport)) {
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
  const data = await transport.listDaemons();
  const daemons = data?.daemons ?? [];
  if (asJson) {
    return JSON.stringify({
      daemons: daemons.map((d) => ({
        id: d.id,
        hostname: d.hostname ?? null,
        platform: d.platform ?? null,
        nickname: d.nickname ?? null,
        version: d.version ?? null,
        p2p_available: d.p2p?.available ?? null,
        cdp_connected: d.cdpConnected ?? null
      }))
    }, null, 2);
  }
  if (daemons.length === 0) return "No connected daemons.";
  const lines = daemons.map((d) => {
    const parts = [`id: ${d.id}`];
    if (d.nickname) parts.push(`nickname: ${d.nickname}`);
    if (d.hostname) parts.push(`hostname: ${d.hostname}`);
    if (d.platform) parts.push(`platform: ${d.platform}`);
    if (d.version) parts.push(`version: ${d.version}`);
    if (d.p2p?.available != null) parts.push(`p2p: ${d.p2p.available ? "yes" : "no"}`);
    return parts.join(", ");
  });
  return `Daemons (${daemons.length}):
${lines.join("\n")}`;
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
      daemon_id: {
        type: "string",
        description: "Daemon ID (cloud mode only). Omit for local mode."
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
  if (isLocalTransport(transport)) {
    const result2 = await transport.command("read_chat", {
      ...args.session_id ? { targetSessionId: args.session_id } : {},
      tailLimit: limit
    });
    const annotated2 = annotateRapidReadChatAdvisory(result2, {
      key: `local:${args.session_id ?? "__active__"}`,
      toolName: "read_chat",
      completionCallbackExpected: false
    });
    return formatChatResult(annotated2, args.session_id, args.format, limit, args.compact);
  }
  if (!args.daemon_id) throw new Error("daemon_id is required in cloud mode");
  const targetId = args.session_id ? `${args.daemon_id}:session:${args.session_id}` : args.daemon_id;
  const result = await transport.readChat(targetId, { limit, sessionId: args.session_id });
  const annotated = annotateRapidReadChatAdvisory(result, {
    key: `cloud:${args.daemon_id}:${args.session_id ?? "__active__"}`,
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
  const compactPayload = compact ? compactChatPayload(source, { sessionId: sessionId ?? null, limit }) : null;
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
          timestamp: m.timestamp ?? null
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
    const lines2 = outputMessages.slice(-limit).map((m) => {
      const role = m.role === "user" ? "User" : m.role === "assistant" ? "Agent" : m.role;
      const content = messageContent(m);
      const truncated = content.length > 500 ? `${content.slice(0, 500)}\u2026` : content;
      return `[${role}] ${truncated}`;
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
      daemon_id: {
        type: "string",
        description: "Daemon ID (cloud mode only). Omit for local mode."
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
  let result;
  if (isLocalTransport(transport)) {
    result = await transport.command("get_chat_debug_bundle", commandArgs);
  } else {
    if (!args.daemon_id) throw new Error("daemon_id is required in cloud mode");
    const targetId = `${args.daemon_id}:session:${sessionId}`;
    result = await transport.getChatDebugBundle(targetId, {
      sessionId,
      agentType: args.agent_type,
      tailLimit,
      delivery
    });
  }
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
      },
      daemon_id: {
        type: "string",
        description: "Daemon ID (cloud mode only). Omit for local mode."
      }
    },
    required: ["message"]
  }
};
async function sendChat(transport, args) {
  if (!args.message?.trim()) throw new Error("message is required");
  if (isLocalTransport(transport)) {
    const result2 = await transport.command("send_chat", {
      message: args.message,
      ...args.session_id ? { targetSessionId: args.session_id } : {}
    });
    if (result2?.success === false) return `Error: ${result2.error ?? "send_chat failed"}`;
    return "Message sent.";
  }
  if (!args.daemon_id) throw new Error("daemon_id is required in cloud mode");
  const targetId = args.session_id ? `${args.daemon_id}:session:${args.session_id}` : args.daemon_id;
  const result = await transport.sendChat(targetId, args.message, {
    ...args.session_id ? { sessionId: args.session_id } : {}
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
      },
      daemon_id: {
        type: "string",
        description: "Daemon ID (cloud mode only)."
      }
    },
    required: ["action"]
  }
};
async function approve(transport, args) {
  const action = args.action === "reject" ? "reject" : "approve";
  if (isLocalTransport(transport)) {
    const result2 = await transport.command("resolve_action", {
      action,
      ...args.session_id ? { targetSessionId: args.session_id } : {}
    });
    if (result2?.success === false) return `Error: ${result2.error ?? "resolve_action failed"}`;
    return `Action ${action}d.`;
  }
  if (!args.daemon_id) throw new Error("daemon_id is required in cloud mode");
  const targetId = args.session_id ? `${args.daemon_id}:session:${args.session_id}` : args.daemon_id;
  const result = await transport.approve(targetId, action);
  if (result?.success === false) return `Error: ${result.error ?? "approve failed"}`;
  return `Action ${action}d.`;
}

// src/tools/screenshot.ts
var SCREENSHOT_TOOL = {
  name: "screenshot",
  description: "Capture a screenshot of the current IDE window. Returns the image. Local mode only \u2014 screenshots require direct P2P access to the daemon and are not available in cloud mode.",
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
  let result;
  if (isLocalTransport(transport)) {
    result = await transport.command("screenshot", {
      ...args.session_id ? { targetSessionId: args.session_id } : {}
    });
  } else {
    return { type: "text", text: "Screenshots are not available in cloud mode. Run adhdev mcp in local mode (requires standalone daemon)." };
  }
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
      daemon_id: {
        type: "string",
        description: "Daemon ID (cloud mode only)."
      },
      ...FORMAT_PROP
    },
    required: ["workspace"]
  }
};
async function gitStatus(transport, args) {
  let status;
  let diffSummary;
  if (isLocalTransport(transport)) {
    const statusResult = await transport.command("git_status", {
      workspace: args.workspace
    });
    status = statusResult?.status ?? statusResult;
    if (args.include_diff !== false) {
      const diffResult = await transport.command("git_diff_summary", {
        workspace: args.workspace
      });
      diffSummary = diffResult?.diffSummary ?? diffResult;
    }
  } else {
    if (!args.daemon_id) throw new Error("daemon_id is required in cloud mode");
    const result = await transport.gitStatus(
      args.daemon_id,
      args.workspace,
      args.include_diff !== false
    );
    if (result?.error) {
      if (args.format === "json") return JSON.stringify({ error: result.error }, null, 2);
      return `Error: ${result.error}`;
    }
    status = result?.status;
    diffSummary = result?.diff;
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
      daemon_id: {
        type: "string",
        description: "Daemon ID (cloud mode only, required)."
      },
      ...FORMAT_PROP
    },
    required: ["workspace"]
  }
};
async function gitLog(transport, args) {
  const limit = Math.max(1, Math.min(100, args.limit ?? 20));
  let raw;
  if (isLocalTransport(transport)) {
    raw = await transport.command("git_log", {
      workspace: args.workspace,
      limit,
      ...args.file ? { path: args.file } : {},
      ...args.since ? { since: args.since } : {},
      ...args.until ? { until: args.until } : {}
    });
    raw = raw?.log ?? raw;
  } else {
    if (!args.daemon_id) throw new Error("daemon_id is required in cloud mode");
    const result = await transport.gitLog(args.daemon_id, args.workspace, {
      limit,
      file: args.file,
      since: args.since,
      until: args.until
    });
    raw = result?.log ?? result;
  }
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
      daemon_id: {
        type: "string",
        description: "Daemon ID (cloud mode only, required)."
      },
      ...FORMAT_PROP
    },
    required: ["workspace"]
  }
};
async function gitDiff(transport, args) {
  const maxLines = Math.max(10, Math.min(2e3, args.max_lines ?? 300));
  const staged = args.staged ?? false;
  if (isLocalTransport(transport)) {
    return localGitDiff(transport, args.workspace, args.file, maxLines, staged, args.format);
  }
  if (!args.daemon_id) throw new Error("daemon_id is required in cloud mode");
  const result = await transport.gitDiff(args.daemon_id, args.workspace, {
    file: args.file,
    maxLines,
    staged
  });
  if (result?.error) {
    if (args.format === "json") return JSON.stringify({ error: result.error }, null, 2);
    return `Git diff error: ${result.error}`;
  }
  return formatDiffResult(result, args.format);
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
      },
      daemon_id: {
        type: "string",
        description: "Daemon ID (cloud mode only, required)."
      }
    },
    required: ["workspace", "message"]
  }
};
async function gitCheckpoint(transport, args) {
  const message = args.message?.trim();
  if (!message) return "Error: message is required";
  if (message.length > 200) return "Error: message must be 200 characters or fewer";
  let raw;
  if (isLocalTransport(transport)) {
    raw = await transport.command("git_checkpoint", {
      workspace: args.workspace,
      message,
      includeUntracked: args.include_untracked ?? false
    });
    raw = raw?.checkpoint ?? raw;
  } else {
    if (!args.daemon_id) throw new Error("daemon_id is required in cloud mode");
    const result = await transport.gitCheckpoint(args.daemon_id, {
      workspace: args.workspace,
      message,
      includeUntracked: args.include_untracked ?? false
    });
    raw = result?.checkpoint ?? result;
  }
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
      },
      daemon_id: {
        type: "string",
        description: "Daemon ID (cloud mode only, required)."
      }
    },
    required: ["workspace"]
  }
};
async function gitPush(transport, args) {
  let raw;
  if (isLocalTransport(transport)) {
    raw = await transport.command("git_push", {
      workspace: args.workspace,
      remote: args.remote ?? "origin",
      ...args.branch ? { branch: args.branch } : {}
    });
    raw = raw?.push ?? raw;
  } else {
    if (!args.daemon_id) throw new Error("daemon_id is required in cloud mode");
    const result = await transport.gitPush(args.daemon_id, {
      workspace: args.workspace,
      remote: args.remote,
      branch: args.branch
    });
    raw = result?.push ?? result;
  }
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
  description: "Launch a new agent session on the daemon. Supports CLI agents (e.g. hermes-cli, claude-cli, gemini-cli), ACP agents (e.g. claude-acp), and IDEs (e.g. cursor, vscode).",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "Provider type to launch. CLI examples: hermes-cli, claude-cli, gemini-cli. ACP examples: claude-acp. IDE examples: cursor, vscode."
      },
      workspace: {
        type: "string",
        description: "Working directory for the session. Defaults to the daemon default workspace."
      },
      model: {
        type: "string",
        description: "Model override for ACP agents (e.g. claude-opus-4-7)."
      },
      daemon_id: {
        type: "string",
        description: "Daemon ID (cloud mode only). Required in cloud mode."
      }
    },
    required: ["type"]
  }
};
async function launchSession(transport, args) {
  if (isLocalTransport(transport)) {
    const isCliOrAcp = args.type.includes("-cli") || args.type.includes("-acp") || args.type === "codex";
    const commandType = isCliOrAcp ? "launch_cli" : "launch_ide";
    const payload = isCliOrAcp ? { cliType: args.type, dir: args.workspace ?? "~", ...args.model ? { model: args.model } : {} } : { ideType: args.type, enableCdp: true };
    const result2 = await transport.command(commandType, payload);
    if (result2?.success === false) return `Error: ${result2.error ?? "launch failed"}`;
    const id2 = result2?.id ?? result2?.sessionId;
    return id2 ? `Session launched. id: ${id2}, type: ${args.type}` : `Launched: ${JSON.stringify(result2)}`;
  }
  if (!args.daemon_id) throw new Error("daemon_id is required in cloud mode");
  const result = await transport.launch(args.daemon_id, {
    type: args.type,
    dir: args.workspace,
    model: args.model
  });
  if (result?.success === false || result?.error) return `Error: ${result.error ?? "launch failed"}`;
  const id = result?.id ?? result?.sessionId;
  return id ? `Session launched. id: ${id}, type: ${args.type}` : `Launched: ${JSON.stringify(result)}`;
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
      daemon_id: {
        type: "string",
        description: "Daemon ID (cloud mode only, required)."
      },
      type: {
        type: "string",
        description: "Provider type (e.g. hermes-cli, claude-cli). Local mode auto-resolves from session_id if omitted; cloud mode forwards the session_id and omits type unless explicitly provided."
      }
    },
    required: ["session_id"]
  }
};
async function stopSession(transport, args) {
  if (isLocalTransport(transport)) {
    const local = transport;
    let resolvedType = args.type;
    if (!resolvedType) {
      const status = await local.getStatus();
      const session = (status?.sessions ?? []).find((s) => s.id === args.session_id);
      resolvedType = session?.providerType ?? session?.type;
    }
    if (!resolvedType) {
      return `Error: could not resolve session type for ${args.session_id}. Pass type= explicitly.`;
    }
    const result2 = await local.command("stop_cli", {
      targetSessionId: args.session_id,
      cliType: resolvedType
    });
    if (result2?.success === false) return `Error: ${result2.error ?? "stop failed"}`;
    return `Session ${args.session_id} stopped.`;
  }
  if (!args.daemon_id) throw new Error("daemon_id is required in cloud mode");
  const result = await transport.stop(args.daemon_id, {
    id: args.session_id,
    ...args.type ? { type: args.type } : {}
  });
  if (result?.success === false || result?.error) return `Error: ${result.error ?? "stop failed"}`;
  return `Session ${args.session_id} stopped.`;
}

// src/tools/check-pending.ts
var CHECK_PENDING_TOOL = {
  name: "check_pending",
  description: "List all agent sessions currently waiting for user approval (tool-use confirmation). Returns session ID, daemon ID, workspace, and the approval prompt message when available. Use approve() with the session_id to approve or reject.",
  inputSchema: {
    type: "object",
    properties: {
      daemon_id: {
        type: "string",
        description: "Daemon ID to check (cloud mode). Omit to check all daemons."
      },
      ...FORMAT_PROP
    },
    required: []
  }
};
async function checkPending(transport, args) {
  if (isLocalTransport(transport)) {
    return checkPendingLocal(transport, args.format);
  }
  return checkPendingCloud(transport, args.daemon_id, args.format);
}
async function checkPendingLocal(transport, format) {
  const status = await transport.getStatus();
  const sessions = status?.sessions ?? [];
  const pending = sessions.filter(
    (s) => s.status === "waiting_approval" || s.agentStatus === "waiting_approval"
  );
  if (format === "json") {
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
async function checkPendingCloud(transport, daemonId, format) {
  const pending = [];
  if (daemonId) {
    const daemonStatus = await transport.getDaemonStatus(daemonId);
    const sessions = daemonStatus?.sessions ?? [];
    for (const s of sessions) {
      if (s.status === "waiting_approval") pending.push({ daemonId, session: s });
    }
  } else {
    const data = await transport.listDaemons();
    const daemons = data?.daemons ?? [];
    for (let i = 0; i < daemons.length; i += 5) {
      await Promise.allSettled(
        daemons.slice(i, i + 5).map(async (d) => {
          try {
            const daemonStatus = await transport.getDaemonStatus(d.id);
            const sessions = daemonStatus?.sessions ?? [];
            for (const s of sessions) {
              if (s.status === "waiting_approval") pending.push({ daemonId: d.id, session: s });
            }
          } catch {
          }
        })
      );
    }
  }
  if (format === "json") {
    return JSON.stringify({
      pending: pending.map(({ daemonId: dId, session: s }) => ({
        daemon_id: dId,
        session_id: s.id,
        workspace: s.workspace ?? null,
        type: s.providerType ?? null,
        modal_message: null,
        buttons: []
      }))
    }, null, 2);
  }
  if (pending.length === 0) return "No sessions waiting for approval.";
  const lines = pending.map(({ daemonId: dId, session: s }) => {
    const parts = [`daemon_id: ${dId}`, `session_id: ${s.id}`];
    if (s.workspace) parts.push(`workspace: ${s.workspace}`);
    if (s.providerType) parts.push(`type: ${s.providerType}`);
    parts.push("(use read_chat to see the approval prompt)");
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
  const transport = opts.mode === "cloud" ? new CloudTransport({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }) : opts.mode === "ipc" ? new IpcTransport({ port: opts.port }) : new LocalTransport({ port: opts.port, password: opts.password });
  const alive = await transport.ping();
  if (!alive) {
    const hint = opts.mode === "local" ? `Make sure the standalone daemon is running (adhdev standalone or npx @adhdev/daemon-standalone).` : opts.mode === "ipc" ? `Make sure the cloud daemon is running with local IPC enabled (adhdev daemon).` : `Check your API key and network connectivity.`;
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
    if (!mesh && opts.mode === "cloud" && opts.apiKey) {
      try {
        const base = opts.baseUrl || "https://api.adhf.dev";
        const res = await fetch(`${base}/api/v1/repo-meshes/${opts.meshId}`, {
          headers: { "Authorization": `Bearer ${opts.apiKey}`, "Content-Type": "application/json" }
        });
        if (res.ok) {
          const data = await res.json();
          const rm = data.mesh;
          const nodes = data.nodes || [];
          let policy = {};
          try {
            policy = JSON.parse(rm.policy_json || rm.policy || "{}");
          } catch {
          }
          let coordinator = {};
          try {
            coordinator = JSON.parse(rm.coordinator_json || rm.coordinator_config || "{}");
          } catch {
          }
          mesh = {
            id: rm.id,
            name: rm.name,
            repoIdentity: rm.repo_identity,
            repoRemoteUrl: rm.repo_remote_url,
            defaultBranch: rm.default_branch,
            policy: {
              requirePreTaskCheckpoint: false,
              requirePostTaskCheckpoint: true,
              requireApprovalForPush: true,
              requireApprovalForDestructiveGit: true,
              dirtyWorkspaceBehavior: "warn",
              maxParallelTasks: 2,
              spawnedSessionVisibility: "visible",
              ...policy
            },
            coordinator,
            nodes: nodes.map((n) => ({
              id: n.id,
              workspace: n.workspace,
              repoRoot: n.repo_root,
              daemonId: n.daemon_id,
              userOverrides: {},
              policy: {},
              isLocalWorktree: false
            })),
            createdAt: rm.created_at,
            updatedAt: rm.updated_at
          };
          process.stderr.write(`[adhdev-mcp] Loaded mesh config from cloud API
`);
        }
      } catch (e) {
        process.stderr.write(`[adhdev-mcp] Cloud mesh fetch failed, falling back to local: ${e.message}
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
      process.stderr.write(`[adhdev-mcp] Mesh '${opts.meshId}' not found in ${opts.mode === "cloud" ? "cloud or local" : "local"} config. Use 'adhdev mesh list' to see available meshes.
`);
      process.exit(1);
    }
    let localDaemonId;
    let localMachineId;
    if (transport instanceof LocalTransport || transport instanceof IpcTransport) {
      try {
        const { loadConfig } = await import("@adhdev/daemon-core");
        const cfg = loadConfig();
        if (cfg.registeredMachineId) localMachineId = cfg.registeredMachineId;
      } catch {
      }
    }
    if (transport instanceof IpcTransport) {
      try {
        const statusResult = await transport.getStatus();
        const instanceId = typeof statusResult?.status?.instanceId === "string" ? statusResult.status.instanceId.trim() : "";
        if (instanceId) localDaemonId = instanceId;
      } catch {
      }
    }
    const meshCtx = { mesh, transport, ...localDaemonId ? { localDaemonId } : {}, ...localMachineId ? { localMachineId } : {} };
    const coordinatorPrompt = await buildMeshModeCoordinatorPrompt(mesh);
    const server2 = new import_server.Server(
      { name: "adhdev-mcp-server", version: "0.9.81" },
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
            text = await meshStatus(meshCtx);
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
          case "mesh_launch_session":
            text = await meshLaunchSession(meshCtx, a);
            break;
          case "mesh_git_status":
            text = await meshGitStatus(meshCtx, a);
            break;
          case "mesh_checkpoint":
            text = await meshCheckpoint(meshCtx, a);
            break;
          case "mesh_approve":
            text = await meshApprove(meshCtx, a);
            break;
          case "mesh_clone_node":
            text = await meshCloneNode(meshCtx, a);
            break;
          case "mesh_remove_node":
            text = await meshRemoveNode(meshCtx, a);
            break;
          case "mesh_refine_node":
            text = await meshRefineNode(meshCtx, a);
            break;
          case "mesh_cleanup_sessions":
            text = await meshCleanupSessions(meshCtx, a);
            break;
          case "mesh_task_history":
            text = await meshTaskHistory(meshCtx, a);
            break;
          case "mesh_reconcile_ledger":
            text = await meshReconcileLedger(meshCtx, a);
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
    SEND_CHAT_TOOL,
    APPROVE_TOOL,
    GIT_STATUS_TOOL,
    GIT_LOG_TOOL,
    GIT_DIFF_TOOL,
    GIT_CHECKPOINT_TOOL,
    GIT_PUSH_TOOL,
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
          const text = await listSessions(transport, { format: a.format, daemon_id: a.daemon_id });
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
        case "send_chat": {
          const text = await sendChat(transport, { message: a.message, session_id: a.session_id, daemon_id: a.daemon_id });
          return { content: [{ type: "text", text }] };
        }
        case "approve": {
          const action = a.action === "reject" ? "reject" : "approve";
          const text = await approve(transport, { action, session_id: a.session_id, daemon_id: a.daemon_id });
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
          const text = await gitStatus(transport, { workspace: a.workspace, include_diff: a.include_diff, daemon_id: a.daemon_id, format: a.format });
          return { content: [{ type: "text", text }] };
        }
        case "git_log": {
          const text = await gitLog(transport, { workspace: a.workspace, limit: a.limit, file: a.file, since: a.since, until: a.until, daemon_id: a.daemon_id, format: a.format });
          return { content: [{ type: "text", text }] };
        }
        case "git_diff": {
          const text = await gitDiff(transport, { workspace: a.workspace, file: a.file, max_lines: a.max_lines, staged: a.staged, daemon_id: a.daemon_id, format: a.format });
          return { content: [{ type: "text", text }] };
        }
        case "git_checkpoint": {
          const text = await gitCheckpoint(transport, { workspace: a.workspace, message: a.message, include_untracked: a.include_untracked, daemon_id: a.daemon_id });
          return { content: [{ type: "text", text }] };
        }
        case "git_push": {
          const text = await gitPush(transport, { workspace: a.workspace, remote: a.remote, branch: a.branch, daemon_id: a.daemon_id });
          return { content: [{ type: "text", text }] };
        }
        case "launch_session": {
          const text = await launchSession(transport, {
            type: a.type,
            workspace: a.workspace,
            model: a.model,
            daemon_id: a.daemon_id
          });
          return { content: [{ type: "text", text }] };
        }
        case "stop_session": {
          const text = await stopSession(transport, {
            session_id: a.session_id,
            daemon_id: a.daemon_id,
            type: a.type
          });
          return { content: [{ type: "text", text }] };
        }
        case "check_pending": {
          const text = await checkPending(transport, { daemon_id: a.daemon_id, format: a.format });
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
  let apiKey;
  let baseUrl;
  let port;
  let password;
  let meshId;
  let explicitMode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--api-key" || arg === "-k") && args[i + 1]) {
      apiKey = args[++i];
    } else if (arg?.startsWith("--api-key=")) {
      apiKey = arg.slice("--api-key=".length);
    } else if (arg === "--base-url" && args[i + 1]) {
      baseUrl = args[++i];
    } else if (arg === "--mode" && args[i + 1]) {
      const value = String(args[++i]).trim();
      if (value === "local" || value === "cloud" || value === "ipc") explicitMode = value;
    } else if (arg?.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length).trim();
      if (value === "local" || value === "cloud" || value === "ipc") explicitMode = value;
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
  if (!apiKey && env.ADHDEV_API_KEY) apiKey = env.ADHDEV_API_KEY;
  if (!password && env.ADHDEV_PASSWORD) password = env.ADHDEV_PASSWORD;
  if (!meshId && env.ADHDEV_MESH_ID) meshId = env.ADHDEV_MESH_ID;
  if (!explicitMode && env.ADHDEV_MCP_TRANSPORT) {
    const value = env.ADHDEV_MCP_TRANSPORT.trim();
    if (value === "local" || value === "cloud" || value === "ipc") explicitMode = value;
  }
  const mode = explicitMode || (apiKey ? "cloud" : meshId && env.ADHDEV_INLINE_MESH ? "ipc" : "local");
  return { mode, port, password, apiKey, baseUrl, meshId };
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