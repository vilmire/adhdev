/**
 * Assistant store verbs (design docs/design/2026-10-07-assistant-layer.md
 * §4.4, §4.10): the assistant's memory / skill / project-note tools and the
 * owner's staged-resolve / admin / Hermes-import actions.
 *
 * Sources (pinned by test/commands/assistant-store-sources.test.ts):
 *   - tool verbs (`assistant_memory`, `assistant_skill_view`,
 *     `assistant_skill_manage`, `assistant_project_note`) — `ipc` (the
 *     assistant's MCP server) and `standalone` (HTTP API) only;
 *   - owner verbs (`assistant_staged_resolve`, `assistant_store_admin`,
 *     `assistant_import_skills`) — `p2p` / `ws` / `standalone`, never `ipc`, so
 *     the MCP server cannot reach them;
 *   - none accepts `mesh` (no mesh sender class needed). A note on a
 *     remote-hosted project is relayed to its host as
 *     `assistant_remote_project {op:'note'}` (assistant-remote.ts) AFTER the
 *     checks below ran here — origin classification and staging are this
 *     daemon's; the host only stores.
 *
 * Origin: tool writes classify their origin from the daemon's assistant input
 * log for the calling session (`assistantSessionId` arg, from
 * ADHDEV_ASSISTANT_SESSION_ID). No log → the write stages (fail-closed).
 * Review-turn writes (research 2026-10-08 Q8): a clean window applies, a
 * tainted one stages, a `project_note` always stages; staged writes carry the
 * review turn id so `assistant_staged_resolve {reviewTurnId, decision}`
 * resolves them together.
 */

import { getDriverService } from '../med-family/drivers.js';
import { readCommandSource } from '../command-args.js';
import { ASSISTANT_SESSION_ID_ARG, ASSISTANT_VERB, readOptionalRecord } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { componentsNotReadyResult, isDaemonComponentsNotReady } from '../daemon-components-port.js';
import type { CommandRouterResult } from '../router.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';
import type { LocalMeshEntry } from '../../repo-mesh-types.js';
import { getAssistantServices, type AssistantServices } from '../../assistant/assistant-services.js';
import { getAssistantProjectPorts, type AssistantProjectPorts } from '../../assistant/assistant-project-ports.js';
import type { RemoteCallOutcome, RemoteHostView } from '../../assistant/assistant-remote-host.js';
import { reviewTurnVerbDecision } from '../../assistant/assistant-review.js';
import { resolveAssistantProject } from '../../assistant/assistant-projects.js';
import { PROJECT_NOTE_CATEGORIES, type ProjectNoteCategory, type ProjectNoteOp, type StagedNoteWrite } from '../../assistant/note-staging.js';
import { detectCredential, isReviewOrigin, mustStage, scanWriteContent, type StoreWriteOrigin } from '../../assistant/store-guards.js';
import { scanHermesHome, importFromHermes, type HermesImportRequest } from '../../assistant/skills/hermes-import.js';
import type { MemoryOperation, MemoryTarget } from '../../assistant/memory/memory-store.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import type { SkillManageOp } from '../../assistant/skills/skill-store.js';
import { createLaunchDefaultsHandlers } from './launch-defaults.js';
import { readInstalledDriver } from '../../drivers/installed-driver.js';
import { getLaunchDefaultsCommandPorts } from '../../launch-defaults/ports.js';

/** The command sources an assistant tool reaches the daemon over (MCP IPC / standalone HTTP). */
export const ASSISTANT_TOOL_SOURCES = ['ipc', 'standalone'] as const;
/** Owner (dashboard) sources — never `ipc`. */
export const ASSISTANT_OWNER_SOURCES = ['p2p', 'ws', 'standalone'] as const;
/** Owner-only verb for reading and setting persistent memory character limits. */
export const ASSISTANT_MEMORY_LIMITS_COMMAND = 'assistant_memory_limits' as const;

/** Result codes that mean "the verb did its job" (refusal codes → success:false). */
const OK_RESULTS: ReadonlySet<string> = new Set(['applied', 'staged', 'memory_duplicate', 'ok', 'list', 'discarded']);

/**
 * The assistant project ports for a router context — the in-process command
 * runner, this daemon's id and the daemon↔daemon mesh transport (remote-hosted
 * projects relay over it).
 */
export async function projectPortsFor(ctx: HighFamilyContext): Promise<AssistantProjectPorts> {
    return getAssistantProjectPorts({
        components: ctx.components,
        execute: (cmd, args) => ctx.execute(cmd, args, 'ipc', { inProcess: true }),
        selfDaemonId: str(ctx.deps?.statusInstanceId),
        transport: {
            ...(ctx.deps?.dispatchMeshCommand ? { dispatch: ctx.deps.dispatchMeshCommand } : {}),
            ...(ctx.deps?.getMeshPeerConnectionStatus ? { peerStatus: ctx.deps.getMeshPeerConnectionStatus } : {}),
        },
    });
}

/** `note_secret_rejected` / `note_hidden_chars_rejected` / `note_injection_rejected`, or null. */
export function noteTextRefusal(text: string | undefined): ({ result: string; pattern?: string }) | null {
    if (!text) return null;
    if (detectCredential(text)) return { result: 'note_secret_rejected' };
    const f = scanWriteContent(text);
    if (!f) return null;
    return { result: f.kind === 'hidden_chars' ? 'note_hidden_chars_rejected' : 'note_injection_rejected', pattern: f.pattern };
}

/** M7: credit the review turn when one of its writes landed. */
function creditReview(svc: AssistantServices, reviewTurnId: string | undefined, result: string, kind: 'applied' | 'approved'): void {
    if (!reviewTurnId || result !== 'applied') return;
    try {
        svc.reviewMetrics?.creditReviewWrite(reviewTurnId, kind, Date.now());
    } catch { /* metrics never fail a write */ }
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function rawStr(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}

function respond(outcome: { result: string } & Record<string, unknown>, extra: Record<string, unknown> = {}): CommandRouterResult {
    const success = OK_RESULTS.has(outcome.result);
    return { success, ...(success ? {} : { code: outcome.result }), ...extra, ...outcome };
}

function invalidArgs(error: string): CommandRouterResult {
    return { success: false, code: 'invalid_args', error };
}

export function readAssistantSessionId(args: unknown): string {
    return str(readOptionalRecord(args)?.[ASSISTANT_SESSION_ID_ARG]);
}

/**
 * Shared gate for every tool verb the assistant calls: the review-turn
 * whitelist (§4.10.7). Returns a refusal, or null to proceed.
 */
export function assistantToolGate(verb: string, args: unknown, svc: AssistantServices = getAssistantServices()): CommandRouterResult | null {
    const sid = readAssistantSessionId(args);
    const decision = reviewTurnVerbDecision(verb, !!sid && svc.inputLog.isReviewTurnOpen(sid));
    if (decision.allowed) return null;
    return { success: false, code: decision.code, error: `${verb} is not available during the review turn` };
}

// ── project resolution (project_note) ──────────────────────────────────────

/** `remote` (with the ports to call it) is set when another daemon hosts the mesh. */
type ProjectResolution =
    | { ok: true; mesh: LocalMeshEntry; slug: string; remote?: { host: RemoteHostView; ports: AssistantProjectPorts } }
    | { ok: false; result: CommandRouterResult };

async function resolveNoteProject(ctx: HighFamilyContext, svc: AssistantServices, ref: unknown): Promise<ProjectResolution> {
    const r = resolveAssistantProject(ref, svc.listMeshes());
    if (!r.ok) {
        const detail = r.code === 'project_not_found' ? { projects: r.projects } : { candidates: r.candidates };
        return { ok: false, result: { success: false, code: r.code, error: r.code, ...detail } };
    }
    let hosted: boolean;
    if (svc.isMeshHostedHere) {
        hosted = svc.isMeshHostedHere(r.mesh);
    } else {
        try {
            const components = ctx.components();
            const { hostedMeshes } = await import('../../mesh/mesh-housekeeping-tick.js');
            hosted = hostedMeshes(components, [r.mesh]).length > 0;
        } catch (e) {
            if (isDaemonComponentsNotReady(e)) return { ok: false, result: componentsNotReadyResult(e) };
            throw e;
        }
    }
    if (!hosted) {
        // Notes live in the host daemon's DB (§4.10.3): relay the write there.
        try {
            const ports = await projectPortsFor(ctx);
            return { ok: true, mesh: r.mesh, slug: r.slug, remote: { host: ports.remoteHost(r.mesh), ports } };
        } catch (e) {
            if (isDaemonComponentsNotReady(e)) return { ok: false, result: componentsNotReadyResult(e) };
            throw e;
        }
    }
    return { ok: true, mesh: r.mesh, slug: r.slug };
}

export type ProjectNoteCommandOp =
    | ProjectNoteOp
    | { action: 'list' }
    | { action: 'read'; noteId: string };

/** Apply an already-checked note op on the project's host (`assistant_remote_project {op:'note'}`). */
async function applyRemoteNote(
    project: Extract<ProjectResolution, { ok: true }>,
    op: ProjectNoteCommandOp,
    origin: 'human' | 'owner',
    callerSessionId?: string,
): Promise<{ result: string } & Record<string, unknown>> {
    const remote = project.remote!;
    const out: RemoteCallOutcome = remote.host.reachable
        ? await remote.ports.callHost(remote.host, 'note', { ...op, origin, ...(callerSessionId ? { callerSessionId } : {}) })
        : { ok: false, kind: 'unreachable', code: 'project_unreachable', reason: remote.host.reason ?? 'relay_failed', error: 'host unreachable' };
    if (out.ok) {
        const r = out.result;
        return {
            result: typeof r.result === 'string' ? r.result : 'applied',
            ...(typeof r.noteId === 'string' ? { noteId: r.noteId } : {}),
            ...(typeof r.id === 'string' ? { id: r.id } : {}),
            ...(typeof r.matched === 'number' ? { matched: r.matched } : {}),
            ...(typeof r.count === 'number' ? { count: r.count } : {}),
            ...(Array.isArray(r.notes) ? { notes: r.notes } : {}),
            ...(r.note && typeof r.note === 'object' ? { note: r.note } : {}),
            ...(typeof r.text === 'string' ? { text: r.text } : {}),
            ...(typeof r.scope === 'string' ? { scope: r.scope } : {}),
            ...(typeof r.pinned === 'boolean' ? { pinned: r.pinned } : {}),
            ...(r.category !== undefined ? { category: r.category } : {}),
            ...(typeof r.createdAt === 'string' ? { createdAt: r.createdAt } : {}),
            ...(typeof r.updatedAt === 'string' ? { updatedAt: r.updatedAt } : {}),
            ...(typeof r.expired === 'boolean' ? { expired: r.expired } : {}),
            host: remote.host.label,
            via: 'relay',
        };
    }
    if (out.kind === 'unreachable') return { result: 'project_unreachable', reason: out.reason, host: remote.host.label, error: out.error };
    return { result: out.code, host: remote.host.label, error: out.error };
}

export function parseNoteOp(args: any): ProjectNoteCommandOp | string {
    const action = str(args?.action);
    const text = str(args?.text);
    if (action === 'record') {
        if (!text) return 'text required for record';
        const category = str(args?.category);
        if (category && !(PROJECT_NOTE_CATEGORIES as readonly string[]).includes(category)) {
            return `category must be one of ${PROJECT_NOTE_CATEGORIES.join(', ')}`;
        }
        return { action, text, ...(category ? { category: category as ProjectNoteCategory } : {}) };
    }
    if (action === 'forget') {
        const noteId = str(args?.note_id) || str(args?.noteId);
        if (!noteId && !text) return 'note_id or text required for forget';
        return { action, ...(noteId ? { noteId } : {}), ...(text ? { text } : {}) };
    }
    if (action === 'list') {
        return { action };
    }
    if (action === 'read') {
        const noteId = str(args?.note_id) || str(args?.noteId);
        if (!noteId) return 'note_id required for read';
        return { action, noteId };
    }
    return 'action must be record, forget, list or read';
}

export async function applyNote(
    svc: AssistantServices,
    meshId: string,
    op: ProjectNoteCommandOp,
    origin: StoreWriteOrigin,
    callerSessionId?: string,
): Promise<{ result: string } & Record<string, unknown>> {
    if (op.action === 'record') {
        const entry = await svc.operatingNotes.record(meshId, {
            text: op.text,
            ...(op.category ? { category: op.category } : {}),
            sourceCoordinator: origin === 'owner' ? 'assistant:owner' : 'assistant',
            ...(callerSessionId ? { callerSessionId } : {}),
        });
        return { result: 'applied', noteId: entry.id };
    }
    if (op.action === 'forget') {
        const r = await svc.operatingNotes.forget(meshId, { ...(op.noteId ? { noteId: op.noteId } : {}), ...(op.text ? { text: op.text } : {}), reason: 'assistant' });
        return { result: 'applied', matched: r.matched };
    }
    const {
        readOperatingNotes,
        readOperatingNoteById,
        resolveNoteExpiry,
        previewOperatingNoteText,
        resolveOperatingNoteScope,
    } = await import('../../mesh/mesh-operating-notes.js');
    const nowMs = Date.now();
    if (op.action === 'list') {
        const entries = svc.operatingNotes.list
            ? await svc.operatingNotes.list(meshId, { tail: 100 })
            : readOperatingNotes(meshId, { tail: 100 });
        const notes = entries.map((e) => {
            const p = (e.payload || {}) as Record<string, unknown>;
            const text = typeof p.text === 'string' ? p.text : '';
            const createdAt = typeof p.createdAt === 'string' ? p.createdAt : e.timestamp;
            const pinned = p.pinned === true;
            const category = typeof p.category === 'string' ? p.category : undefined;
            const sourceCoordinator = typeof p.sourceCoordinator === 'string' ? p.sourceCoordinator : undefined;
            const explicitExpiry = typeof p.expiresAt === 'string' ? p.expiresAt : undefined;
            const lifetime = resolveNoteExpiry({ category, pinned, createdAt, ...(explicitExpiry ? { expiresAt: explicitExpiry } : {}) }, nowMs);
            const { preview, truncated } = previewOperatingNoteText(text);
            const scope = resolveOperatingNoteScope({ pinned, sourceCoordinator }, 'project');
            return {
                id: e.id,
                noteId: e.id,
                scope,
                pinned,
                category: category ?? null,
                createdAt,
                updatedAt: createdAt,
                preview,
                truncated,
                expired: lifetime.expired,
                ...(explicitExpiry ? { expiresAt: explicitExpiry } : {}),
                ...(lifetime.effectiveExpiresAt ? { effectiveExpiresAt: lifetime.effectiveExpiresAt } : {}),
                ...(typeof p.subjectKey === 'string' ? { subjectKey: p.subjectKey } : {}),
                ...(sourceCoordinator ? { sourceCoordinator } : {}),
            };
        });
        return { result: 'list', count: notes.length, notes };
    }
    // op.action === 'read'
    const entry = svc.operatingNotes.read
        ? await svc.operatingNotes.read(meshId, op.noteId)
        : readOperatingNoteById(meshId, op.noteId);
    if (!entry) {
        return {
            result: 'note_not_found',
            noteId: op.noteId,
            error: `No live operating note matched note_id '${op.noteId}'.`,
        };
    }
    const p = (entry.payload || {}) as Record<string, unknown>;
    const text = typeof p.text === 'string' ? p.text : '';
    const createdAt = typeof p.createdAt === 'string' ? p.createdAt : entry.timestamp;
    const pinned = p.pinned === true;
    const category = typeof p.category === 'string' ? p.category : undefined;
    const sourceCoordinator = typeof p.sourceCoordinator === 'string' ? p.sourceCoordinator : undefined;
    const explicitExpiry = typeof p.expiresAt === 'string' ? p.expiresAt : undefined;
    const lifetime = resolveNoteExpiry({ category, pinned, createdAt, ...(explicitExpiry ? { expiresAt: explicitExpiry } : {}) }, nowMs);
    const scope = resolveOperatingNoteScope({ pinned, sourceCoordinator }, 'project');
    const detail = {
        id: entry.id,
        noteId: entry.id,
        scope,
        text,
        pinned,
        category: category ?? null,
        createdAt,
        updatedAt: createdAt,
        expired: lifetime.expired,
        ...(explicitExpiry ? { expiresAt: explicitExpiry } : {}),
        ...(lifetime.effectiveExpiresAt ? { effectiveExpiresAt: lifetime.effectiveExpiresAt } : {}),
        ...(typeof p.subjectKey === 'string' ? { subjectKey: p.subjectKey } : {}),
        ...(typeof p.supersedes === 'string' ? { supersedes: p.supersedes } : {}),
        ...(sourceCoordinator ? { sourceCoordinator } : {}),
    };
    return {
        result: 'ok',
        ...detail,
        note: detail,
    };
}

// ── tool verbs ──────────────────────────────────────────────────────────────

function parseMemoryOp(args: any): MemoryOperation | string {
    const action = str(args?.action);
    const target = str(args?.target) as MemoryTarget;
    if (target !== 'memory' && target !== 'user') return 'target must be memory or user';
    const text = rawStr(args?.text);
    const match = rawStr(args?.match);
    if (action === 'add') return { action, target, content: text ?? '' };
    if (action === 'replace') return { action, target, match: match ?? '', content: text ?? '' };
    if (action === 'remove') return { action, target, match: match ?? '' };
    return 'action must be add, replace or remove';
}

function parseSkillOp(args: any): SkillManageOp | string {
    const action = str(args?.action);
    const name = str(args?.name);
    if (action === 'create') {
        const project = str(args?.project);
        return { action, name, description: rawStr(args?.description) ?? '', body: rawStr(args?.body) ?? '', ...(project ? { project } : {}) };
    }
    if (action === 'patch') {
        const op: Extract<SkillManageOp, { action: 'patch' }> = { action, name };
        for (const k of ['old', 'new', 'file', 'description'] as const) {
            const v = rawStr(args?.[k]);
            if (v !== undefined) op[k] = v;
        }
        return op;
    }
    if (action === 'archive') return { action, name };
    return 'action must be create, patch or archive';
}

export const assistantStoreHandlers: Record<string, HighFamilyHandler> = {
    [ASSISTANT_VERB.memory]: async (_ctx, args) => {
        const svc = getAssistantServices();
        const gate = assistantToolGate(ASSISTANT_VERB.memory, args, svc);
        if (gate) return gate;
        const op = parseMemoryOp(args);
        if (typeof op === 'string') return invalidArgs(op);
        const w = svc.inputLog.writeContext(readAssistantSessionId(args));
        const out = svc.memory.apply(op, w.origin, { reviewTurnId: w.reviewTurnId });
        creditReview(svc, w.reviewTurnId, out.result, 'applied');
        return respond(out);
    },

    [ASSISTANT_VERB.skillView]: async (_ctx, args) => {
        const svc = getAssistantServices();
        const gate = assistantToolGate(ASSISTANT_VERB.skillView, args, svc);
        if (gate) return gate;
        const name = str(args?.name);
        if (!name) return invalidArgs('name required');
        const file = rawStr(args?.file);
        return respond(svc.skills.view(name, file !== undefined ? { file } : {}));
    },

    [ASSISTANT_VERB.skillManage]: async (_ctx, args) => {
        const svc = getAssistantServices();
        const gate = assistantToolGate(ASSISTANT_VERB.skillManage, args, svc);
        if (gate) return gate;
        const op = parseSkillOp(args);
        if (typeof op === 'string') return invalidArgs(op);
        const w = svc.inputLog.writeContext(readAssistantSessionId(args));
        const out = svc.skills.manage(op, w.origin, { sessionId: w.sessionId, turnId: w.turnId, ...(w.reviewTurnId ? { reviewTurnId: w.reviewTurnId } : {}) });
        creditReview(svc, w.reviewTurnId, out.result, 'applied');
        return respond(out);
    },

    [ASSISTANT_VERB.projectNote]: async (ctx, args) => {
        const svc = getAssistantServices();
        const gate = assistantToolGate(ASSISTANT_VERB.projectNote, args, svc);
        if (gate) return gate;
        const op = parseNoteOp(args);
        if (typeof op === 'string') return invalidArgs(op);
        const project = await resolveNoteProject(ctx, svc, args?.project);
        if (!project.ok) return project.result;
        const wrap = { project: project.slug, meshId: project.mesh.id };
        const sid = readAssistantSessionId(args);
        if (op.action === 'list' || op.action === 'read') {
            if (project.remote) return respond(await applyRemoteNote(project, op, 'human', sid || undefined), wrap);
            return respond(await applyNote(svc, project.mesh.id, op, 'human', sid || undefined), wrap);
        }
        const refusal = noteTextRefusal(op.text);
        if (refusal) return respond(refusal, wrap);
        const { origin, reviewTurnId } = svc.inputLog.writeContext(sid);
        // A note written in a review turn is always held, clean window or not (note-staging.ts).
        if (mustStage(origin) || isReviewOrigin(origin)) {
            const stagedId = svc.notes.write({
                origin, meshId: project.mesh.id, project: project.slug, ...(sid ? { callerSessionId: sid } : {}), op,
                ...(reviewTurnId ? { reviewTurnId } : {}),
            });
            return respond({ result: 'staged', stagedId }, wrap);
        }
        if (project.remote) return respond(await applyRemoteNote(project, op, origin === 'owner' ? 'owner' : 'human', sid || undefined), wrap);
        return respond(await applyNote(svc, project.mesh.id, op, origin, sid || undefined), wrap);
    },

    // ── owner verbs ─────────────────────────────────────────────────────────

    [ASSISTANT_VERB.stagedResolve]: async (ctx, args) => {
        const svc = getAssistantServices();
        const action = str(args?.action) || 'resolve';
        if (action === 'list') {
            let driverActions: unknown[] = [];
            if (typeof ctx.deps?.providerLoader?.getByCategory === 'function') {
                const drivers = getDriverService(ctx);
                await drivers.list().catch(() => {});
                driverActions = drivers.stagedActions();
            }
            return { success: true, memory: svc.memory.listStaged(), skills: svc.skills.listStaged(), notes: svc.notes.list(),
                launchDefaults: svc.launchDefaults?.list() ?? [], driverActivations: svc.driverStaging?.list() ?? [],
                driverActions, memoryStatus: svc.memory.status() };
        }
        if (action !== 'resolve') return invalidArgs('action must be list or resolve');
        const id = str(args?.id);
        const reviewTurnId = str(args?.reviewTurnId);
        const decision = str(args?.decision);
        if (!id && !reviewTurnId) return invalidArgs('id or reviewTurnId required');
        if (id && reviewTurnId) return invalidArgs('pass id or reviewTurnId, not both');
        if (id.startsWith('ldf-')) {
            // Defaults consent is only the owner resolving this exact Inbox id.
            // Reject supplied scope/modal/generation/authorization instead of
            // silently treating consent for another operation as this decision.
            if (Object.keys(args ?? {}).some(key => !['action', 'id', 'decision', '_interactionId', '_meshSenderDaemonId', '_commandSource'].includes(key))) {
                return invalidArgs('Launch-default resolution accepts only id and decision.');
            }
            if (decision !== 'apply' && decision !== 'discard' && decision !== 'reject') return invalidArgs('decision must be apply, discard or reject');
            return resolveStagedOne(ctx, svc, id, decision === 'reject' ? 'discard' : decision);
        }
        if (decision !== 'apply' && decision !== 'discard') return invalidArgs('decision must be apply or discard');
        if (id.startsWith('driver-action-')) {
            const source = readCommandSource(args);
            if (source !== 'p2p' && source !== 'ws' && source !== 'standalone') return { success: false, code: 'COMMAND_SOURCE_REJECTED' };
            return getDriverService(ctx).resolveAction(id, decision, source);
        }
        if (reviewTurnId) return resolveReviewBatch(ctx, svc, reviewTurnId, decision);
        return resolveStagedOne(ctx, svc, id, decision);
    },

    [ASSISTANT_VERB.storeAdmin]: async (_ctx, args) => {
        const svc = getAssistantServices();
        const target = str(args?.target);
        const action = str(args?.action);
        if (target === 'skill') {
            const name = str(args?.name);
            if (!name) return invalidArgs('name required');
            if (action === 'pin') return respond(svc.skills.pin(name));
            if (action === 'unpin') return respond(svc.skills.unpin(name));
            if (action === 'clear_review') return respond(svc.skills.clearReviewLock(name));
            if (action === 'restore') return respond(svc.skills.restore(name));
            return invalidArgs('skill action must be pin, unpin, clear_review or restore');
        }
        if (target === 'memory') {
            if (action === 'get_limits') {
                return { success: true, result: 'ok', ...svc.memory.status() };
            }
            if (action === 'set_limits') {
                return applyMemoryLimitsUpdate(svc, args);
            }
            if (action !== 'remove') return invalidArgs('memory action must be remove, get_limits or set_limits');
            const file = str(args?.file) as MemoryTarget;
            if (file !== 'memory' && file !== 'user') return invalidArgs('file must be memory or user');
            return respond(svc.memory.apply({ action: 'remove', target: file, match: rawStr(args?.match) ?? '' }, 'owner'));
        }
        return invalidArgs('target must be skill or memory');
    },

    [ASSISTANT_MEMORY_LIMITS_COMMAND]: async (_ctx, args) => {
        const svc = getAssistantServices();
        const rawAction = str(args?.action);
        const hasBudgetField = args !== null && typeof args === 'object' && ('memory' in args || 'user' in args);
        const action = rawAction || (hasBudgetField ? 'set' : 'get');
        if (action === 'get') {
            return { success: true, result: 'ok', ...svc.memory.status() };
        }
        if (action === 'set') {
            return applyMemoryLimitsUpdate(svc, args);
        }
        return invalidArgs('action must be get or set');
    },

    [ASSISTANT_VERB.importSkills]: async (ctx, args) => {
        const svc = getAssistantServices();
        if (str(args?.action) === 'scan') return { success: true, result: 'scan', scan: scanHermesHome(svc.hermesHome) };
        // hermesHome comes from the daemon, never from the request.
        const req: HermesImportRequest = {
            hermesHome: svc.hermesHome,
            dryRun: args?.dryRun !== false,
            ...(Array.isArray(args?.skills) ? { skills: args.skills.filter((s: unknown) => typeof s === 'string') } : {}),
            ...(Array.isArray(args?.memory) ? { memory: args.memory } : {}),
        };
        const result = importFromHermes(req, { skills: svc.skills, memory: svc.memory });
        const notes: Array<Record<string, unknown>> = [];
        for (const n of result.operatingNotes) {
            const project = await resolveNoteProject(ctx, svc, n.project);
            if (!project.ok) {
                notes.push({ id: n.id, project: n.project, result: project.result.code });
                continue;
            }
            const refusal = noteTextRefusal(n.text);
            if (refusal) {
                notes.push({ id: n.id, project: project.slug, ...refusal });
                continue;
            }
            if (result.dryRun) {
                notes.push({ id: n.id, project: project.slug, meshId: project.mesh.id, result: 'would_record' });
                continue;
            }
            const applied = project.remote
                ? await applyRemoteNote(project, { action: 'record', text: n.text }, 'owner')
                : await applyNote(svc, project.mesh.id, { action: 'record', text: n.text }, 'owner');
            notes.push({ id: n.id, project: project.slug, meshId: project.mesh.id, ...applied });
        }
        return { success: true, ...result, operatingNoteResults: notes };
    },
};

/** One staged write by id (prefix picks the store). Credits M7 when an approved write came from a review turn. */
async function resolveStagedOne(ctx: HighFamilyContext, svc: AssistantServices, id: string, decision: 'apply' | 'discard'): Promise<CommandRouterResult> {
    if (id.startsWith('ldf-')) {
        if (!svc.launchDefaults) return { success: false, code: 'staging_unavailable' };
        return svc.launchDefaults.resolve(id, decision, async (proposal, documentRevision) => {
            const ports = getLaunchDefaultsCommandPorts(ctx);
            if (proposal.project) {
                const stored = ports.store.read();
                if (stored.status !== 'ok') return { success: false, code: 'launch_default_unavailable',
                    error: 'Global launch-default setup cannot be read.' };
                if (stored.document.revision !== documentRevision) return { success: false, code: 'revision_conflict',
                    error: 'Global launch-default generation changed.', actualRevision: stored.document.revision, committed: false };
            }
            // This branch is reached only by the existing owner-source command.
            // Do not reclassify owner approval using the assistant input log, and
            // never forward request args or replay an execution/modal consent.
            return createLaunchDefaultsHandlers(ports).launch_defaults_set(ctx, {
                action: proposal.selection === null ? 'clear' : 'set', role: proposal.role,
                expectedRevision: proposal.expectedRevision,
                ...(proposal.project ? { project: proposal.project } : {}), ...proposal.selection,
            });
        });
    }
    if (id.startsWith('driver-activation-')) {
        if (!svc.driverStaging || !svc.driverActivations) return { success: false, code: 'staging_unavailable' };
        return svc.driverStaging.resolve(id, decision, svc.driverActivations,
            type => readInstalledDriver(ctx.deps.providerLoader, type));
    }
    if (id.startsWith('mem-')) {
        const reviewTurnId = decision === 'apply' ? svc.memory.listStaged().find((r) => r.id === id)?.reviewTurnId : undefined;
        const out = svc.memory.resolveStaged(id, decision);
        creditReview(svc, reviewTurnId, out.result, 'approved');
        return respond(out);
    }
    if (id.startsWith('skl-')) {
        const reviewTurnId = decision === 'apply' ? svc.skills.listStaged().find((r) => r.id === id)?.reviewTurnId : undefined;
        const out = svc.skills.resolveStaged(id, decision);
        creditReview(svc, reviewTurnId, out.result, 'approved');
        return respond(out);
    }
    if (id.startsWith('note-')) return resolveStagedNote(ctx, svc, id, decision);
    return respond({ result: 'staged_not_found' });
}

/**
 * Every staged write of one review turn, in staging order, with one decision
 * (research 2026-10-08 Q8 — one card per review). Each write is resolved
 * exactly as its single-id resolve would be: a failed re-check keeps that
 * write staged and does not stop the others.
 */
async function resolveReviewBatch(ctx: HighFamilyContext, svc: AssistantServices, reviewTurnId: string, decision: 'apply' | 'discard'): Promise<CommandRouterResult> {
    const ids = [
        ...svc.memory.listStaged().filter((r) => r.reviewTurnId === reviewTurnId),
        ...svc.skills.listStaged().filter((r) => r.reviewTurnId === reviewTurnId),
        ...svc.notes.list().filter((r) => r.reviewTurnId === reviewTurnId),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => r.id);
    if (!ids.length) return respond({ result: 'staged_not_found' }, { reviewTurnId });
    const results: Array<Record<string, unknown>> = [];
    for (const id of ids) {
        const r = await resolveStagedOne(ctx, svc, id, decision);
        results.push({ id, ...r });
    }
    const failed = results.filter((r) => r.success !== true).length;
    return {
        success: failed === 0,
        ...(failed ? { code: 'staged_batch_partial' } : {}),
        result: failed ? 'staged_batch_partial' : decision === 'apply' ? 'applied' : 'discarded',
        reviewTurnId,
        resolved: results.length - failed,
        failed,
        results,
    };
}

async function resolveStagedNote(ctx: HighFamilyContext, svc: AssistantServices, id: string, decision: 'apply' | 'discard'): Promise<CommandRouterResult> {
    const rec: StagedNoteWrite | null = svc.notes.read(id);
    if (!rec) return respond({ result: 'staged_not_found' });
    if (decision === 'discard') {
        svc.notes.remove(id);
        return respond({ result: 'discarded' });
    }
    // Re-check against the current inventory and text; a failure keeps the staged file.
    const project = await resolveNoteProject(ctx, svc, rec.meshId);
    if (!project.ok) return project.result;
    const wrap = { project: project.slug, meshId: project.mesh.id };
    const refusal = noteTextRefusal(rec.op.text);
    if (refusal) return respond(refusal, wrap);
    if (project.remote) {
        // A host that cannot store it now keeps the staged file here (retry later).
        const remote = await applyRemoteNote(project, rec.op, 'owner', rec.callerSessionId);
        if (remote.result !== 'applied') return respond(remote, wrap);
        svc.notes.remove(id);
        creditReview(svc, rec.reviewTurnId, remote.result, 'approved');
        return respond(remote, wrap);
    }
    const applied = await applyNote(svc, rec.meshId, rec.op, 'owner', rec.callerSessionId);
    svc.notes.remove(id);
    creditReview(svc, rec.reviewTurnId, applied.result, 'approved');
    return respond(applied, wrap);
}

function applyMemoryLimitsUpdate(svc: AssistantServices, args: any): CommandRouterResult {
    const hasMemory = args !== null && typeof args === 'object' && args.memory !== undefined;
    const hasUser = args !== null && typeof args === 'object' && args.user !== undefined;
    if (!hasMemory && !hasUser) {
        return invalidArgs('memory or user limit required');
    }
    if (hasMemory && (typeof args.memory !== 'number' || !Number.isFinite(args.memory))) {
        return invalidArgs('memory limit must be a finite number');
    }
    if (hasUser && (typeof args.user !== 'number' || !Number.isFinite(args.user))) {
        return invalidArgs('user limit must be a finite number');
    }
    const patch = {
        ...(hasMemory ? { memory: Math.round(args.memory) } : {}),
        ...(hasUser ? { user: Math.round(args.user) } : {}),
    };
    const rangeErr = svc.memory.validateBudgets(patch);
    if (rangeErr) {
        return {
            success: false,
            ...rangeErr,
        };
    }
    svc.memory.setBudgets(patch);
    try {
        getAssistantRegistry().reload();
    } catch { /* registry singleton may not be initialized in unit tests */ }
    const status = svc.memory.status();
    return { success: true, result: 'applied', limits: status.budgets, ...status };
}

export const assistantStoreSpecs = defineCommandSpecs('high', assistantStoreHandlers, {
    [ASSISTANT_VERB.memory]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.skillView]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.skillManage]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.projectNote]: { sources: [...ASSISTANT_TOOL_SOURCES] },
    [ASSISTANT_VERB.stagedResolve]: { sources: [...ASSISTANT_OWNER_SOURCES] },
    [ASSISTANT_VERB.storeAdmin]: { sources: [...ASSISTANT_OWNER_SOURCES] },
    [ASSISTANT_MEMORY_LIMITS_COMMAND]: { sources: [...ASSISTANT_OWNER_SOURCES] },
    [ASSISTANT_VERB.importSkills]: { sources: [...ASSISTANT_OWNER_SOURCES] },
});
