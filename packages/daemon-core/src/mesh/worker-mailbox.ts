/**
 * Worker mailbox — E-T0 (mailbox piggyback).
 *
 * Design SoT: docs/design/2026-08-28-worker-mcp.md §7.1 (T0), §9.2 (G lifecycle
 * table), §13.2 (scenario walkthrough).
 *
 * ─── What this is, and what it deliberately is not ───────────────────────
 *
 * A coordinator (or an owner speaking through one) sometimes needs to reach a
 * worker mid-task with something urgent enough that "wait for the next
 * dispatch" is too slow, but not urgent enough to justify T3's destructive
 * interrupt (which discards whatever the worker was mid-way through). §7.2's
 * hook infrastructure — the mechanism that WOULD deliver this the instant it
 * is written, mid-turn — does not exist in this repo (§7.3) and is out of
 * scope here (owner decision §12-5). What DOES exist, unconditionally, is the
 * worker calling an MCP tool: `report_completion`, `progress_update`,
 * `peer_context_pull`, even `git_status`. T0 rides on that — every worker tool
 * RESPONSE carries any undelivered mailbox message, so the next time the
 * worker's turn touches MCP at all, it reads the memo.
 *
 * ★The honest limit (design §7.1, restated so it is not lost here): a worker
 * deep in a long generation turn that calls no tool sees nothing until it
 * does. This module does not pretend otherwise.
 *
 * ─── Why this is a bare in-memory map, like the token/bind above it ───────
 *
 * A mailbox message is disposable by construction (design §9.2 G row
 * "메일박스 메모"): it lives until delivered, or until the task it was written
 * for goes terminal, whichever comes first. Nothing about it needs to survive
 * a daemon restart — a restarted daemon has no live worker session either, so
 * a persisted-but-undeliverable memo would just be dead weight. This mirrors
 * `worker-mcp-isolation.ts`'s token table exactly, including the reason: the
 * thing the secret authorizes/names does not outlive the process that minted
 * it.
 *
 * ─── Where this lives physically (the asymmetric-machine fixture) ─────────
 *
 * ★A mesh spans machines. The coordinator that decides to send an urgent memo
 * runs on ITS daemon; the worker the memo is FOR may be running under a
 * DIFFERENT daemon entirely. This module only ever holds state for tasks the
 * LOCAL daemon actually owns — `depositWorkerMailboxMessage` is deliberately
 * dumb about that (it takes whatever (meshId, taskId) it is given), so the
 * caller at the low-family boundary (`commands/low-family/worker-mailbox.ts`)
 * is where the "does this daemon even know this task" check happens, via
 * `MeshRuntimeStore.findQueueEntryById`. A coordinator's `mesh_notify_worker`
 * call is routed to the correct daemon by the mesh RPC layer
 * (`commandForNode`) exactly the same way `mesh_send_task` is — this module
 * has no opinion about routing and must not grow one.
 */

import { randomUUID } from 'crypto';

/** A single undelivered memo. */
export interface WorkerMailboxMessage {
    id: string;
    meshId: string;
    taskId: string;
    text: string;
    mintedAtMs: number;
}

/** Reject rather than truncate — same rule §4/§5 apply to worker-authored text. */
export const MAILBOX_TEXT_MAX_CHARS = 2_000;

/**
 * Cap on undelivered messages per task. A worker that never calls a tool
 * accumulates nothing it will ever see; this bounds how much a daemon holds
 * for that case rather than trying to guess when the situation resolved.
 */
export const MAILBOX_MAX_PENDING_PER_TASK = 20;

const PENDING = new Map<string, WorkerMailboxMessage[]>();

function mailboxKey(meshId: string, taskId: string): string {
    return `${meshId} ${taskId}`;
}

export type MailboxDepositResult =
    | { ok: true; id: string; pending: number }
    | { ok: false; error: 'invalid_input' | 'text_too_long' | 'mailbox_full'; detail: string };

/**
 * Deposit an urgent memo for a task's worker. Called from the low-family
 * `deposit_worker_mailbox` handler, which owns the "does this daemon know
 * this task" gate — this function trusts its caller on that question.
 */
export function depositWorkerMailboxMessage(input: {
    meshId: string;
    taskId: string;
    text: string;
}): MailboxDepositResult {
    const meshId = String(input.meshId || '').trim();
    const taskId = String(input.taskId || '').trim();
    const text = String(input.text || '').trim();
    if (!meshId || !taskId || !text) {
        return { ok: false, error: 'invalid_input', detail: 'meshId, taskId and text are all required' };
    }
    if (text.length > MAILBOX_TEXT_MAX_CHARS) {
        return {
            ok: false,
            error: 'text_too_long',
            detail: `message is ${text.length} chars, over the ${MAILBOX_TEXT_MAX_CHARS} limit — shorten it`,
        };
    }

    const key = mailboxKey(meshId, taskId);
    const list = PENDING.get(key) || [];
    if (list.length >= MAILBOX_MAX_PENDING_PER_TASK) {
        return {
            ok: false,
            error: 'mailbox_full',
            detail: `task ${taskId} already holds ${list.length} undelivered message(s) — it is not reading its tool responses`,
        };
    }

    const message: WorkerMailboxMessage = { id: randomUUID(), meshId, taskId, text, mintedAtMs: Date.now() };
    list.push(message);
    PENDING.set(key, list);
    return { ok: true, id: message.id, pending: list.length };
}

/**
 * Drain (and thereby mark delivered) every pending message for a task. There
 * is no separate "delivered" flag to set afterward — removal from the pending
 * map IS the delivery stamp (design §7.1 "동봉과 동시에 ... delivered 스탬프"), and
 * a message this function has returned once is gone from here for good;
 * re-delivering it would defeat the point of a mailbox rather than a log.
 */
export function drainWorkerMailboxForTask(meshId: string, taskId: string): WorkerMailboxMessage[] {
    const key = mailboxKey(String(meshId || '').trim(), String(taskId || '').trim());
    const list = PENDING.get(key);
    if (!list || !list.length) return [];
    PENDING.delete(key);
    return list;
}

/** Diagnostic — never exposes message text. */
export function peekWorkerMailboxCount(meshId: string, taskId: string): number {
    return PENDING.get(mailboxKey(String(meshId || '').trim(), String(taskId || '').trim()))?.length ?? 0;
}

/**
 * Drop undelivered messages for a task. Called from the single terminal-
 * acceptance chokepoint alongside {@link expireWorkerTaskTokensForTask} (design
 * §9.2 G: "태스크 terminal 시 미전달분 폐기") — a memo about a task that no longer
 * has a running worker cannot be delivered, and holding it would leak forever
 * for a task that finishes without ever calling another tool.
 */
export function discardWorkerMailboxForTask(meshId: string, taskId: string): number {
    const key = mailboxKey(String(meshId || '').trim(), String(taskId || '').trim());
    const list = PENDING.get(key);
    if (!list) return 0;
    PENDING.delete(key);
    return list.length;
}

/** Test-only reset so mailbox state cannot leak between cases. */
export function __resetWorkerMailboxForTest(): void {
    PENDING.clear();
}

/**
 * Render drained messages as the block appended to a worker tool response.
 * Returns null for an empty list so a caller can skip touching the response
 * entirely on the (overwhelmingly common) case of nothing pending.
 */
export function renderMailboxBlock(messages: readonly WorkerMailboxMessage[]): string | null {
    if (!messages.length) return null;
    const heading = messages.length > 1 ? 'Urgent messages from the coordinator' : 'Urgent message from the coordinator';
    const lines = messages.map((m, i) => `${i + 1}. ${m.text}`);
    return `\n\n---\n\n## ${heading}\n\n${lines.join('\n')}\n`;
}
