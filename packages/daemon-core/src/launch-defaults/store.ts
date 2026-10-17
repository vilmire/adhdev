import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StoreWriteOrigin } from '../assistant/store-guards.js';
import { hasOnlyKeys, isLaunchRole, isRecord, selectionSchemaIssue, validateLaunchDefault,
    type LaunchRole, type LaunchSelection, type LaunchValidationPorts, type LaunchValidationResult,
    type LaunchValidationWarning, type ToolRestriction } from './validate.js';

export interface LaunchDefaultEntry extends LaunchSelection {
    revision: number;
    setBy: 'owner' | 'assistant';
    setAt: number;
}
export interface LaunchDefaultChange {
    at: number;
    role: LaunchRole;
    by: 'owner' | 'assistant';
    origin: StoreWriteOrigin;
    from: LaunchDefaultEntry | null;
    to: LaunchDefaultEntry | null;
}
export interface LaunchDefaultsDocument {
    version: 1;
    /** Document-wide CAS token, including clears; never an entry revision. */
    revision: number;
    assistant?: LaunchDefaultEntry;
    coordinator?: LaunchDefaultEntry;
    history: LaunchDefaultChange[];
}
export type LaunchDefaultsRead =
    | { status: 'ok'; document: LaunchDefaultsDocument }
    | { status: 'missing' | 'unreadable' | 'invalid'; reason: string };
const entryKeys = ['provider', 'model', 'thinkingLevel', 'revision', 'setBy', 'setAt'];
const origins: readonly StoreWriteOrigin[] = ['human', 'relay', 'review', 'review_tainted', 'owner'];
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function isEntry(value: unknown): value is LaunchDefaultEntry {
    if (!isRecord(value) || !hasOnlyKeys(value, entryKeys)) return false;
    const { revision, setBy, setAt, ...selection } = value;
    return !selectionSchemaIssue(selection) && integer(revision) && revision > 0
        && (setBy === 'owner' || setBy === 'assistant') && integer(setAt);
}
/** Strict, versioned disk schema. Invalid bytes are preserved, never repaired on read. */
export function isLaunchDefaultsDocument(value: unknown): value is LaunchDefaultsDocument {
    if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'revision', 'assistant', 'coordinator', 'history'])
        || value.version !== 1 || !integer(value.revision) || value.revision < 1
        || !Array.isArray(value.history) || value.history.length > 20) return false;
    const revision = value.revision;
    for (const role of ['assistant', 'coordinator'] as const) {
        if (Object.hasOwn(value, role) && (!isEntry(value[role]) || value[role].revision > revision)) return false;
    }
    return value.history.every(change => isRecord(change)
        && hasOnlyKeys(change, ['at', 'role', 'by', 'origin', 'from', 'to'])
        && integer(change.at) && isLaunchRole(change.role)
        && (change.by === 'owner' || change.by === 'assistant')
        && origins.includes(change.origin as StoreWriteOrigin)
        && (change.from === null || isEntry(change.from) && change.from.revision <= revision)
        && (change.to === null || isEntry(change.to) && change.to.revision <= revision));
}
export interface LaunchDefaultsWrite {
    role: LaunchRole;
    /** null explicitly clears the role. A set replaces the whole triple. */
    selection: LaunchSelection | null;
    /** 0 explicitly bootstraps an absent document. Required on every write. */
    expectedRevision: number;
    by: 'owner' | 'assistant';
    origin: StoreWriteOrigin;
    previousToolRestriction?: ToolRestriction;
}
export type LaunchDefaultsWriteResult =
    | { ok: true; document: LaunchDefaultsDocument; previous: LaunchDefaultEntry | null;
        warnings: LaunchValidationWarning[]; lowersToolLock: boolean; durable: true }
    | { ok: false; code: 'invalid_args' | 'revision_conflict' | 'launch_default_invalid' | 'store_unavailable' | 'store_busy' | 'persistence_failed';
        reason: string; committed: boolean; actualRevision?: number;
        validation?: Extract<LaunchValidationResult, { ok: false }>;
        /** Present after replacement if durability confirmation failed. Re-read before retrying. */
        document?: LaunchDefaultsDocument };

/** The only launch-defaults persistence authority. No launch API writes here.
 * Every read loads disk (no stale cache). A lock directory serializes all store
 * instances/processes; abandoned locks fail closed and require operator recovery.
 * Unlike writeFileAtomic600, this writer fsyncs the file AND parent directory. */
export class LaunchDefaultsStore {
    readonly path: string;
    constructor(configDir: string, private readonly ports: LaunchValidationPorts) {
        this.path = join(resolve(configDir), 'launch-defaults.json');
    }
    read(): LaunchDefaultsRead {
        let contents: string;
        try { contents = readFileSync(this.path, 'utf8'); }
        catch (error) {
            return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', reason: 'launch_defaults_read_failed' };
        }
        try {
            const document: unknown = JSON.parse(contents);
            return isLaunchDefaultsDocument(document) ? { status: 'ok', document }
                : { status: 'invalid', reason: 'launch_defaults_schema_invalid' };
        } catch { return { status: 'invalid', reason: 'launch_defaults_json_invalid' }; }
    }
    /** Call only after owner/tool authorization and staging decisions. */
    write(request: LaunchDefaultsWrite): LaunchDefaultsWriteResult {
        const fail = (code: Extract<LaunchDefaultsWriteResult, { ok: false }>['code'], reason: string): LaunchDefaultsWriteResult =>
            ({ ok: false, code, reason, committed: false });
        if (!isRecord(request) || !hasOnlyKeys(request, ['role', 'selection', 'expectedRevision', 'by', 'origin', 'previousToolRestriction'])
            || !isLaunchRole(request.role) || !integer(request.expectedRevision)
            || !['owner', 'assistant'].includes(request.by) || !origins.includes(request.origin)
            || (request.previousToolRestriction !== undefined && !['enforced', 'prompt_only'].includes(request.previousToolRestriction))) {
            return fail('invalid_args', 'invalid_write_request');
        }
        const dir = resolve(this.path, '..');
        const lock = `${this.path}.lock`;
        try { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
        catch { return fail('persistence_failed', 'config_directory_unavailable'); }
        try { mkdirSync(lock, { mode: 0o700 }); }
        catch (error) {
            return fail((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'store_busy' : 'persistence_failed', 'write_lock_unavailable');
        }
        try {
            const current = this.read();
            if (current.status === 'invalid' || current.status === 'unreadable') return fail('store_unavailable', current.reason);
            const revision = current.status === 'ok' ? current.document.revision : 0;
            if (revision !== request.expectedRevision) return { ok: false, code: 'revision_conflict', reason: 'document_revision_changed', committed: false, actualRevision: revision };
            if (revision >= Number.MAX_SAFE_INTEGER) return fail('store_unavailable', 'revision_exhausted');
            let selection: LaunchSelection | null = null;
            let warnings: LaunchValidationWarning[] = [];
            let lowersToolLock = false;
            if (request.selection !== null) {
                const validated = validateLaunchDefault(request.role, request.selection, this.ports, request.previousToolRestriction);
                if (!validated.ok) return { ok: false, code: 'launch_default_invalid', reason: validated.issue.reason, validation: validated, committed: false };
                selection = validated.selection;
                warnings = validated.warnings;
                lowersToolLock = validated.lowersToolLock;
            }
            const document: LaunchDefaultsDocument = current.status === 'ok' ? current.document : { version: 1, revision: 0, history: [] };
            const previous = document[request.role] ?? null;
            const at = Date.now();
            const entry = selection ? { ...selection, revision: revision + 1, setBy: request.by, setAt: at } : null;
            document.revision = revision + 1;
            if (entry) document[request.role] = entry;
            else delete document[request.role];
            document.history = [...document.history, { at, role: request.role, by: request.by, origin: request.origin, from: previous, to: entry }].slice(-20);
            return this.persist(document, previous, warnings, lowersToolLock);
        } finally {
            // A failed release leaves a visible busy lock, never an unguarded writer.
            try { rmdirSync(lock); } catch { /* operator recovery required */ }
        }
    }
    private persist(document: LaunchDefaultsDocument, previous: LaunchDefaultEntry | null,
        warnings: LaunchValidationWarning[], lowersToolLock: boolean): LaunchDefaultsWriteResult {
        const temp = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
        let committed = false;
        try {
            const fd = openSync(temp, 'wx', 0o600);
            try { writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, 'utf8'); fsyncSync(fd); }
            finally { closeSync(fd); }
            renameSync(temp, this.path);
            committed = true;
            const parent = openSync(resolve(this.path, '..'), 'r');
            try { fsyncSync(parent); } finally { closeSync(parent); }
            return { ok: true, document, previous, warnings, lowersToolLock, durable: true };
        } catch {
            return { ok: false, code: 'persistence_failed', reason: committed ? 'durability_unconfirmed' : 'atomic_replace_failed',
                committed, ...(committed ? { document } : {}) };
        } finally {
            try { unlinkSync(temp); } catch { /* renamed or never created */ }
        }
    }
}
