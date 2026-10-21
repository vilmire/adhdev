import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const testTmpDir = join(tmpdir(), `adhdev-note-list-read-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) {
            mkdirSync(testConfigDir, { recursive: true });
        }
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import * as opNotes from '../../src/mesh/mesh-operating-notes.js';
import {
    readOperatingNotes,
    recordOperatingNote,
} from '../../src/mesh/mesh-operating-notes.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { meshLedgerHandlers } from '../../src/commands/low-family/mesh-ledger.js';
import { turnLedgerIpcHandlers } from '../../src/commands/low-family/turn-ledger-ipc.js';
import {
    buildCoordinatorSystemPrompt,
    selectOperatingNotesForPrompt,
} from '../../src/mesh/coordinator-prompt.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { assistantStoreHandlers } from '../../src/commands/high-family/assistant-store.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';
import { meshNote } from '../../../mcp-server/src/tools/mesh-tools-merged.js';
import { validateMeshToolArgs } from '../../../mcp-server/src/tools/validate-tool-args.js';
import { MESH_NOTE_TOOL } from '../../../mcp-server/src/tools/mesh-tool-schemas-admin.js';
import { resolveAssistantModeTools } from '../../../mcp-server/src/tools/assistant-tools.js';

const callMeshNote = async (deps: any, args: Record<string, unknown>) =>
    JSON.parse(await meshNote(deps, args));

function createMeshNoteDeps(meshId: string) {
    const ctx = {} as any;
    const executeCommand = async (command: string, payload?: Record<string, unknown>) => {
        if (command in meshLedgerHandlers) {
            return meshLedgerHandlers[command](ctx, payload ?? {});
        }
        if (command in turnLedgerIpcHandlers) {
            return turnLedgerIpcHandlers[command](ctx, payload ?? {});
        }
        throw new Error(`Unexpected IPC command in test: ${command}`);
    };
    return {
        mesh: { id: meshId, name: meshId },
        coordinatorSessionId: 'coord-session-1',
        transport: {
            command: executeCommand,
        },
        sendCommand: executeCommand,
    } as any;
}

describe('mesh_note and project_note list/read with IDs', () => {
    let meshA: string;
    let meshB: string;
    let assistantDir: string;

    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        meshA = `mesh-a-${randomUUID().slice(0, 8)}`;
        meshB = `mesh-b-${randomUUID().slice(0, 8)}`;
        assistantDir = join(testTmpDir, `assistant-${randomUUID().slice(0, 8)}`);
        mkdirSync(assistantDir, { recursive: true });
    });

    afterEach(() => {
        setAssistantServicesForTests(null);
        setAssistantProjectPortsForTests(null);
        MeshRuntimeStore.resetForTests();
        try {
            rmSync(testTmpDir, { recursive: true, force: true });
        } catch {
            /* best-effort cleanup */
        }
    });

    describe('schema and validation coverage', () => {
        it('exposes list and read actions on both mesh_note and project_note schemas', () => {
            const meshActions = (MESH_NOTE_TOOL.inputSchema.properties.action as any).enum;
            expect(meshActions).toEqual(['record', 'forget', 'list', 'read']);

            const projectNoteTool = resolveAssistantModeTools().find((t) => t.name === 'project_note')!;
            expect(projectNoteTool).toBeDefined();
            const projectActions = (projectNoteTool.inputSchema.properties.action as any).enum;
            expect(projectActions).toEqual(['record', 'forget', 'list', 'read']);

            expect(validateMeshToolArgs('mesh_note', { action: 'list' })).toBeNull();
            expect(validateMeshToolArgs('mesh_note', { action: 'read', note_id: 'note-123' })).toBeNull();
            expect(validateMeshToolArgs('mesh_note', { action: 'read' })).toMatch(/Required: note_id/);
        });
    });

    describe('mesh_note list and read happy paths + byte-compatible record/forget', () => {
        it('records notes, lists previews with id/scope/pinned/timestamps, and reads full text by exact id', async () => {
            const depsA = createMeshNoteDeps(meshA);
            const longBody = `Always run scoped vitest before bundling vendor files. ${'Detail-segment '.repeat(15)}END_MARKER`;
            expect(longBody.length).toBeGreaterThan(opNotes.OPERATING_NOTE_PREVIEW_MAX_CHARS ?? 160);

            const rec1 = await callMeshNote(depsA, {
                action: 'record',
                text: longBody,
                category: 'pattern_to_avoid',
            });
            expect(rec1).toMatchObject({
                success: true,
                meshId: meshA,
                noteId: expect.any(String),
                recorded: {
                    category: 'pattern_to_avoid',
                },
            });

            const pinnedEntry = recordOperatingNote(meshA, {
                text: 'BATRP pinned guidance stays intact',
                category: 'provider_quirk',
                pinned: true,
            });
            const projectEntry = recordOperatingNote(meshA, {
                text: 'Project-scoped note from assistant',
                category: 'recovery_lesson',
                sourceCoordinator: 'assistant',
            });

            const listed = await callMeshNote(depsA, { action: 'list' });
            expect(listed.success).toBe(true);
            expect(listed.meshId).toBe(meshA);
            expect(listed.count).toBe(3);

            const byId = new Map<string, any>((listed.notes as any[]).map((n) => [n.id, n]));
            const listedLong = byId.get(rec1.noteId);
            expect(listedLong).toBeDefined();
            expect(listedLong.id).toBe(rec1.noteId);
            expect(listedLong.noteId).toBe(rec1.noteId);
            expect(listedLong.scope).toBe('mesh');
            expect(listedLong.pinned).toBe(false);
            expect(listedLong.createdAt).toEqual(expect.any(String));
            expect(listedLong.updatedAt).toEqual(expect.any(String));
            expect(listedLong.truncated).toBe(true);
            expect(listedLong.preview.endsWith('…')).toBe(true);
            expect(listedLong.preview).not.toContain('END_MARKER');

            const listedPinned = byId.get(pinnedEntry.id);
            expect(listedPinned).toMatchObject({
                id: pinnedEntry.id,
                scope: 'pinned',
                pinned: true,
                preview: 'BATRP pinned guidance stays intact',
                truncated: false,
            });

            const listedProject = byId.get(projectEntry.id);
            expect(listedProject).toMatchObject({
                id: projectEntry.id,
                scope: 'project',
                pinned: false,
                preview: 'Project-scoped note from assistant',
                truncated: false,
            });

            // Read full text by exact id
            const readRes = await callMeshNote(depsA, { action: 'read', note_id: rec1.noteId });
            expect(readRes).toMatchObject({
                success: true,
                meshId: meshA,
                id: rec1.noteId,
                noteId: rec1.noteId,
                scope: 'mesh',
                pinned: false,
                category: 'pattern_to_avoid',
                text: longBody,
                createdAt: expect.any(String),
                updatedAt: expect.any(String),
            });
            expect((readRes.note as any).text).toBe(longBody);

            // Forget by exact id discovered from list/prompt
            const forgot = await callMeshNote(depsA, {
                action: 'forget',
                note_id: rec1.noteId,
                reason: 'superseded in test',
            });
            expect(forgot).toMatchObject({
                success: true,
                meshId: meshA,
                forgot: {
                    noteId: rec1.noteId,
                    matched: 1,
                },
            });

            // After forget, read returns note_not_found and list no longer includes it
            const readAfterForget = await callMeshNote(depsA, { action: 'read', note_id: rec1.noteId });
            expect(readAfterForget).toMatchObject({
                success: false,
                code: 'note_not_found',
                meshId: meshA,
                noteId: rec1.noteId,
            });
            const listedAfterForget = await callMeshNote(depsA, { action: 'list' });
            expect((listedAfterForget.notes as any[]).map((n) => n.id)).not.toContain(rec1.noteId);
        });
    });

    describe('unknown id handling', () => {
        it('returns note_not_found when reading an unknown or blank note_id', async () => {
            const depsA = createMeshNoteDeps(meshA);
            recordOperatingNote(meshA, { text: 'existing note' });

            const res = await callMeshNote(depsA, { action: 'read', note_id: 'unknown-note-id' });
            expect(res).toMatchObject({
                success: false,
                code: 'note_not_found',
                meshId: meshA,
                noteId: 'unknown-note-id',
            });

            expect(opNotes.readOperatingNoteById?.(meshA, 'unknown-note-id')).toBeNull();
            expect(opNotes.readOperatingNoteById?.(meshA, '')).toBeNull();

            const missingIdRes = await callMeshNote(depsA, { action: 'read', note_id: '   ' });
            expect(missingIdRes.success).toBe(false);
        });
    });

    describe('cross-mesh isolation and scoping (mesh vs project vs pinned)', () => {
        it('isolates notes strictly per mesh on both list and read across mesh/project/pinned scopes', async () => {
            const depsA = createMeshNoteDeps(meshA);
            const depsB = createMeshNoteDeps(meshB);

            const meshNoteA = recordOperatingNote(meshA, {
                text: 'Mesh A coordinator note',
                category: 'provider_quirk',
            });
            const pinnedNoteA = recordOperatingNote(meshA, {
                text: 'Mesh A pinned note',
                pinned: true,
            });
            const projectNoteA = recordOperatingNote(meshA, {
                text: 'Mesh A project note',
                sourceCoordinator: 'assistant',
            });
            const meshNoteB = recordOperatingNote(meshB, {
                text: 'Mesh B only note',
                category: 'recovery_lesson',
            });

            const listA = await callMeshNote(depsA, { action: 'list' });
            const listB = await callMeshNote(depsB, { action: 'list' });

            const idsA = (listA.notes as any[]).map((n) => n.id);
            const idsB = (listB.notes as any[]).map((n) => n.id);

            expect(idsA).toEqual(expect.arrayContaining([meshNoteA.id, pinnedNoteA.id, projectNoteA.id]));
            expect(idsA).not.toContain(meshNoteB.id);

            expect(idsB).toEqual([meshNoteB.id]);
            expect(idsB).not.toContain(meshNoteA.id);
            expect(idsB).not.toContain(pinnedNoteA.id);
            expect(idsB).not.toContain(projectNoteA.id);

            // Attempting to read Mesh A's notes (mesh, pinned, or project scoped) from Mesh B must fail
            for (const foreignId of [meshNoteA.id, pinnedNoteA.id, projectNoteA.id]) {
                const crossRead = await callMeshNote(depsB, { action: 'read', note_id: foreignId });
                expect(crossRead).toMatchObject({
                    success: false,
                    code: 'note_not_found',
                    meshId: meshB,
                    noteId: foreignId,
                });
            }

            // And reading Mesh B's note from Mesh A must also fail
            const reverseRead = await callMeshNote(depsA, { action: 'read', note_id: meshNoteB.id });
            expect(reverseRead).toMatchObject({
                success: false,
                code: 'note_not_found',
                meshId: meshA,
                noteId: meshNoteB.id,
            });
        });

        it('supports project_note list and read with cross-project isolation and without staging read-only calls', async () => {
            const meshes = [
                { id: meshA, name: 'Alpha', repoIdentity: 'github.com/acme/alpha' },
                { id: meshB, name: 'Beta', repoIdentity: 'github.com/acme/beta' },
            ] as unknown as LocalMeshEntry[];

            const svc = createAssistantServices({
                configDir: assistantDir,
                hermesHome: join(assistantDir, 'hermes'),
                listMeshes: () => meshes,
                isMeshHostedHere: () => true,
            });
            setAssistantServicesForTests(svc);

            const sid = 'assistant-session-1';
            svc.inputLog.begin(sid);
            svc.inputLog.append(sid, 'human');

            const longProjectNote = `Project Alpha operating rule: ${'never cross-contaminate meshes '.repeat(8)}FINAL_TOKEN`;
            const recAlpha = await assistantStoreHandlers[ASSISTANT_VERB.projectNote]({} as any, {
                assistantSessionId: sid,
                project: 'alpha',
                action: 'record',
                text: longProjectNote,
                category: 'pattern_to_avoid',
            });
            expect(recAlpha).toMatchObject({
                success: true,
                result: 'applied',
                project: 'alpha',
                meshId: meshA,
                noteId: expect.any(String),
            });

            const pinnedAlpha = recordOperatingNote(meshA, {
                text: 'Pinned Alpha invariant',
                pinned: true,
            });
            const betaNote = recordOperatingNote(meshB, {
                text: 'Beta secret lesson',
            });

            // Append a 'relay' input so write actions would be staged, then verify list/read still execute directly without staging
            svc.inputLog.append(sid, 'relay');

            const listAlpha = await assistantStoreHandlers[ASSISTANT_VERB.projectNote]({} as any, {
                assistantSessionId: sid,
                project: 'alpha',
                action: 'list',
            });
            expect(listAlpha).toMatchObject({
                success: true,
                result: 'list',
                project: 'alpha',
                meshId: meshA,
                count: 2,
            });
            expect(svc.notes.list()).toHaveLength(0);

            const alphaNotes = listAlpha.notes as any[];
            const alphaProjectEntry = alphaNotes.find((n) => n.id === recAlpha.noteId);
            const alphaPinnedEntry = alphaNotes.find((n) => n.id === pinnedAlpha.id);
            expect(alphaProjectEntry).toMatchObject({
                id: recAlpha.noteId,
                scope: 'project',
                pinned: false,
                truncated: true,
            });
            expect(alphaProjectEntry.preview).not.toContain('FINAL_TOKEN');
            expect(alphaPinnedEntry).toMatchObject({
                id: pinnedAlpha.id,
                scope: 'pinned',
                pinned: true,
                preview: 'Pinned Alpha invariant',
            });

            // Read full text of Alpha's long note via project_note
            const readAlpha = await assistantStoreHandlers[ASSISTANT_VERB.projectNote]({} as any, {
                assistantSessionId: sid,
                project: 'alpha',
                action: 'read',
                note_id: recAlpha.noteId,
            });
            expect(readAlpha).toMatchObject({
                success: true,
                result: 'ok',
                project: 'alpha',
                meshId: meshA,
                id: recAlpha.noteId,
                noteId: recAlpha.noteId,
                scope: 'project',
                pinned: false,
                text: longProjectNote,
            });

            // Cross-project isolation: Alpha cannot read Beta's noteId
            const crossProjectRead = await assistantStoreHandlers[ASSISTANT_VERB.projectNote]({} as any, {
                assistantSessionId: sid,
                project: 'alpha',
                action: 'read',
                note_id: betaNote.id,
            });
            expect(crossProjectRead).toMatchObject({
                success: false,
                code: 'note_not_found',
                project: 'alpha',
                meshId: meshA,
                noteId: betaNote.id,
            });

            // Remote-hosted project op also supports list and read via callHost('note', ...)
            const remoteHostedSvc = createAssistantServices({
                configDir: assistantDir,
                hermesHome: join(assistantDir, 'hermes'),
                listMeshes: () => meshes,
                isMeshHostedHere: (m) => m.id === meshA,
            });
            setAssistantServicesForTests(remoteHostedSvc);
            const callHost = vi.fn(async (_target: unknown, _op: string, args: any) => {
                if (args.action === 'list') {
                    return {
                        ok: true,
                        result: {
                            success: true,
                            result: 'list',
                            count: 1,
                            notes: [
                                {
                                    id: betaNote.id,
                                    noteId: betaNote.id,
                                    scope: 'project',
                                    pinned: false,
                                    createdAt: betaNote.payload.createdAt,
                                    updatedAt: betaNote.timestamp,
                                    preview: 'Beta secret lesson',
                                    truncated: false,
                                },
                            ],
                        },
                    };
                }
                if (args.action === 'read') {
                    const targetId = args.noteId ?? args.note_id;
                    if (targetId === betaNote.id) {
                        return {
                            ok: true,
                            result: {
                                success: true,
                                result: 'ok',
                                id: betaNote.id,
                                noteId: betaNote.id,
                                text: 'Beta secret lesson',
                                scope: 'project',
                                pinned: false,
                                createdAt: betaNote.payload.createdAt,
                                updatedAt: betaNote.timestamp,
                            },
                        };
                    }
                    return {
                        ok: false,
                        kind: 'refused',
                        code: 'note_not_found',
                        error: `note_not_found: ${args.note_id}`,
                        result: { success: false, code: 'note_not_found', noteId: args.note_id },
                    };
                }
                throw new Error(`unexpected remote note action: ${args.action}`);
            });
            setAssistantProjectPortsForTests(() => ({
                remoteHost: (m: LocalMeshEntry) => ({
                    label: 'beta-host',
                    hostDaemonId: 'daemon_beta',
                    hostMeshId: m.id,
                    reachable: true,
                }),
                callHost,
            }) as unknown as AssistantProjectPorts);

            const remoteList = await assistantStoreHandlers[ASSISTANT_VERB.projectNote]({} as any, {
                assistantSessionId: sid,
                project: 'beta',
                action: 'list',
            });
            expect(remoteList).toMatchObject({
                success: true,
                result: 'list',
                project: 'beta',
                meshId: meshB,
                host: 'beta-host',
                via: 'relay',
                count: 1,
            });
            expect((remoteList.notes as any[])[0]).toMatchObject({
                id: betaNote.id,
                preview: 'Beta secret lesson',
            });

            const remoteRead = await assistantStoreHandlers[ASSISTANT_VERB.projectNote]({} as any, {
                assistantSessionId: sid,
                project: 'beta',
                action: 'read',
                note_id: betaNote.id,
            });
            expect(remoteRead).toMatchObject({
                success: true,
                result: 'ok',
                project: 'beta',
                meshId: meshB,
                host: 'beta-host',
                via: 'relay',
                id: betaNote.id,
                text: 'Beta secret lesson',
            });
        });
    });

    describe('coordinator prompt injection includes note IDs within budget', () => {
        const baseMesh = {
            id: 'mesh_prompt_test',
            name: 'ADHDev',
            repoIdentity: 'github.com/acme/adhdev',
            nodes: [{ id: 'node_1', workspace: '/repo', daemonId: 'daemon_1', userOverrides: {}, policy: {} }],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
        };

        it('renders each injected operating note with [id: <noteId>] and documents read/list/forget in the section header', () => {
            const n1 = recordOperatingNote(meshA, {
                text: 'Pinned BATRP guidance note',
                category: 'provider_quirk',
                pinned: true,
            });
            const n2 = recordOperatingNote(meshA, {
                text: 'Standard recovery lesson for coordinator',
                category: 'recovery_lesson',
            });

            const entries = readOperatingNotes(meshA);
            const operatingNotes = entries.map((e) => ({
                id: e.id,
                noteId: e.id,
                text: e.payload.text,
                category: e.payload.category as any,
                createdAt: e.payload.createdAt || e.timestamp,
                pinned: e.payload.pinned,
                expiresAt: e.payload.expiresAt,
                supersedes: e.payload.supersedes,
                subjectKey: e.payload.subjectKey,
            }));

            const prompt = buildCoordinatorSystemPrompt({
                mesh: baseMesh as any,
                coordinatorCliType: 'claude-cli',
                operatingNotes,
            });

            expect(prompt).toContain('## Operating Notes');
            expect(prompt).toContain(`[id: ${n1.id}]`);
            expect(prompt).toContain(`[id: ${n2.id}]`);
            expect(prompt).toContain('Pinned BATRP guidance note');
            expect(prompt).toContain('Standard recovery lesson for coordinator');
            expect(prompt).toContain('action "read"');
            expect(prompt).toContain('action "list" / "forget"');
        });

        it('accounts for [id: <noteId>] in the operating-notes byte budget and stays within prompt limits', () => {
            const now = Date.UTC(2026, 6, 22, 0, 0, 0);
            const notes = Array.from({ length: 30 }, (_, idx) => ({
                noteId: `00000000-0000-4000-8000-${String(idx).padStart(12, '0')}`,
                text: `Note-${idx} ${'payload-segment-'.repeat(25)}`,
                category: 'provider_quirk' as const,
                createdAt: new Date(Date.UTC(2026, 6, 1, 0, idx, 0)).toISOString(),
            }));

            const { shown, omittedCount } = selectOperatingNotesForPrompt(notes, now);
            expect(shown.length).toBeGreaterThan(0);
            expect(omittedCount).toBeGreaterThan(0);

            const prompt = buildCoordinatorSystemPrompt({
                mesh: baseMesh as any,
                coordinatorCliType: 'claude-cli',
                operatingNotes: notes,
            });

            expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(96 * 1024);
            for (const item of shown) {
                expect(prompt).toContain(`[id: ${item.note.noteId}]`);
            }

            // Extract the Operating Notes section and confirm it respects the 8KB byte budget (+ small header allowance)
            const sectionStart = prompt.indexOf('## Operating Notes');
            const nextSection = prompt.indexOf('\n## ', sectionStart + 1);
            const section = nextSection > sectionStart ? prompt.slice(sectionStart, nextSection) : prompt.slice(sectionStart);
            expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(8 * 1024 + 1024);
        });
    });

    describe('helper unit checks', () => {
        it('previewOperatingNoteText normalizes whitespace and truncates over maxChars', () => {
            expect(opNotes.previewOperatingNoteText?.('  hello   world\nnext line  ')).toEqual({
                preview: 'hello world next line',
                truncated: false,
            });
            const long = 'a'.repeat(200);
            const res = opNotes.previewOperatingNoteText?.(long, 50);
            expect(res?.truncated).toBe(true);
            expect(res?.preview).toBe(`${'a'.repeat(50)}…`);
        });

        it('resolveOperatingNoteScope distinguishes pinned, project, and mesh notes', () => {
            expect(opNotes.resolveOperatingNoteScope?.({ pinned: true, sourceCoordinator: 'assistant' })).toBe('pinned');
            expect(opNotes.resolveOperatingNoteScope?.({ pinned: false, sourceCoordinator: 'assistant' })).toBe('project');
            expect(opNotes.resolveOperatingNoteScope?.({ pinned: false, sourceCoordinator: 'assistant:owner' })).toBe('project');
            expect(opNotes.resolveOperatingNoteScope?.({ pinned: false, sourceCoordinator: 'claude-cli' })).toBe('mesh');
            expect(opNotes.resolveOperatingNoteScope?.({}, 'project')).toBe('project');
        });
    });
});
