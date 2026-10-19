import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    ArtifactStore,
    MAX_ARTIFACTS_PER_SESSION,
    MAX_ARTIFACT_BYTES,
    toChatAttachmentMeta,
    type ChatAttachmentMeta,
} from '../../src/artifacts/index.js';
import {
    DaemonCommandRouter,
    getDaemonCommandRegistry,
    type CommandRouterDeps,
} from '../../src/commands/router.js';
import {
    artifactHandlers,
    setArtifactCommandRuntimeForDeps,
    type ArtifactCommandContext,
} from '../../src/commands/med-family/artifacts.js';
import { buildTranscriptObservationFromReadChat } from '../../src/commands/transcript-observation-builder.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import {
    __resetWorkerSessionBindsForTest,
    __resetWorkerTaskTokensForTest,
    mintWorkerSessionBind,
    mintWorkerTaskToken,
} from '../../src/mesh/worker-mcp-isolation.js';
import { resolveWorkerIdentity } from '../../src/mesh/worker-report.js';
import {
    registerMeshCoordinator,
    unregisterMeshCoordinator,
} from '../../src/mesh/coordinator-registry.js';
import {
    CHAT_COMMIT_KIND,
    CHAT_META_KIND,
    CHAT_MSG_KIND,
    chatMessageFromWire,
    encodeChatMessageHead,
    readChatMsg,
} from '../../src/seqscribe/transcript-keyed-codec.js';
import {
    KeyedChatSessionState,
    type KeyedChatFrame,
    type PersistedChatRow,
} from '../../src/seqscribe/transcript-keyed-frame.js';
import {
    KeyedTranscriptFolder,
    type KeyedChatRow,
} from '../../src/seqscribe/transcript-keyed-folder.js';
import {
    __resetTranscriptProjectionForTests,
    configureTranscriptProjection,
} from '../../src/seqscribe/transcript-publisher.js';
import { ledgerSeedFromPersisted } from '../../src/seqscribe/transcript-keyed-publish-runtime.js';
import { mapTranscriptViewToReadChatPayload } from '../../src/mesh/transcript-read-chat-adapter.js';
import {
    TranscriptBubbleCache,
    mapTranscriptViewToChatView,
} from '../../../web-core/src/components/dashboard/transcript-chat-pane-adapter.js';

function createTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function frameToFolderRows(frame: KeyedChatFrame, writer: string, startSeq = 1): KeyedChatRow[] {
    return frame.rows.map((row, idx) => ({
        seq: startSeq + idx,
        key: row.key,
        kind: row.kind,
        writer,
        payload: row.payload,
    }));
}

describe('Task B — Daemon Artifact Commands & Keyed-Chat Attachment Transport', () => {
    let tempRoot: string;
    let workspaceA: string;
    let workspaceB: string;
    let prevConfigDir: string | undefined;
    let meshStore: MeshRuntimeStore;
    let artifactStore: ArtifactStore;
    let sessionRegistry: SessionRegistry;
    let deps: CommandRouterDeps;
    let ctx: ArtifactCommandContext;

    beforeEach(() => {
        tempRoot = createTempDir('adhdev-taskb-artifacts-');
        workspaceA = path.join(tempRoot, 'workspace-a');
        workspaceB = path.join(tempRoot, 'workspace-b');
        fs.mkdirSync(workspaceA, { recursive: true });
        fs.mkdirSync(workspaceB, { recursive: true });

        prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
        process.env.ADHDEV_CONFIG_DIR = path.join(tempRoot, 'config');
        fs.mkdirSync(process.env.ADHDEV_CONFIG_DIR, { recursive: true });

        MeshRuntimeStore.resetForTests();
        __resetWorkerTaskTokensForTest();
        __resetWorkerSessionBindsForTest();
        __resetTranscriptProjectionForTests();

        meshStore = MeshRuntimeStore.getInstance();
        artifactStore = new ArtifactStore(meshStore.db);
        sessionRegistry = new SessionRegistry();

        deps = {
            commandHandler: { handle: async () => ({ success: true }) } as any,
            cliManager: {} as any,
            cdpManagers: new Map(),
            providerLoader: {} as any,
            instanceManager: {
                getInstance: () => undefined,
            } as any,
            detectedIdes: { value: [] },
            sessionRegistry,
        };
        setArtifactCommandRuntimeForDeps(deps, {
            artifactStore,
            meshRuntimeStore: meshStore,
        });

        ctx = {
            deps,
            getMeshForCommand: async () => null,
            getCachedInlineMesh: () => undefined,
        };
    });

    afterEach(() => {
        __resetTranscriptProjectionForTests();
        __resetWorkerTaskTokensForTest();
        __resetWorkerSessionBindsForTest();
        MeshRuntimeStore.resetForTests();
        if (prevConfigDir === undefined) {
            delete process.env.ADHDEV_CONFIG_DIR;
        } else {
            process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
        }
        try {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        } catch {
            // Best-effort temp cleanup.
        }
    });

    describe('Command registry & normal/coordinator/worker authority', () => {
        it('registers artifact_register, artifact_list, and artifact_fetch in DaemonCommandRegistry with non-mesh sources', () => {
            const registry = getDaemonCommandRegistry();
            for (const name of [
                'artifact_register',
                'artifact_list',
                'artifact_fetch',
                'artifact_read',
            ]) {
                const spec = registry.get(name);
                expect(spec).toBeDefined();
                expect(spec?.family).toBe('med');
                expect(spec?.sources.includes('ipc')).toBe(true);
                expect(spec?.sources.includes('standalone')).toBe(true);
                expect(spec?.sources.includes('p2p')).toBe(true);
                expect(spec?.sources.includes('ws')).toBe(true);
                expect(spec?.sources.includes('mesh')).toBe(false);
            }
        });

        it('registers, lists, and fetches artifacts for a registered normal session via DaemonCommandRouter', async () => {
            const sessionId = 'sess-normal-1';
            sessionRegistry.register({
                sessionId,
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });

            const mdPath = path.join(workspaceA, 'docs', 'summary.md');
            fs.mkdirSync(path.dirname(mdPath), { recursive: true });
            fs.writeFileSync(mdPath, '# Summary\n\nAll checks green.\n', 'utf8');

            const router = new DaemonCommandRouter(deps);
            const regRes = await router.execute(
                'artifact_register',
                {
                    sessionId,
                    path: 'docs/summary.md',
                    title: 'Build Summary',
                },
                'ipc',
            );

            expect(regRes.success).toBe(true);
            expect(regRes.isUpdate).toBe(false);
            expect(regRes.artifactId).toMatch(/^art_[0-9a-f]{16}$/);
            expect(regRes.messageId).toBe(`artifact:${regRes.artifactId}`);
            expect(regRes.messageKey).toBe(`m:artifact:${regRes.artifactId}`);
            expect(regRes.attachment).toMatchObject({
                artifactId: regRes.artifactId,
                kind: 'markdown',
                mime: 'text/markdown',
                filename: 'summary.md',
                title: 'Build Summary',
            });

            const listRes = await router.execute('artifact_list', { sessionId }, 'ws');
            expect(listRes.success).toBe(true);
            expect((listRes.artifacts as any[]).length).toBe(1);
            expect((listRes.attachments as any[])[0].artifactId).toBe(regRes.artifactId);

            const fetchRes = await router.execute(
                'artifact_fetch',
                {
                    sessionId,
                    artifactId: regRes.artifactId,
                },
                'p2p',
            );
            expect(fetchRes.success).toBe(true);
            expect(fetchRes.encoding).toBe('utf8');
            expect(fetchRes.content).toBe('# Summary\n\nAll checks green.\n');
            expect(fetchRes.sha256Changed).toBe(false);
            expect(fetchRes.hashChanged).toBe(false);
        });

        it('rejects arbitrary payload workspace paths and unregistered sessions', async () => {
            fs.writeFileSync(path.join(workspaceA, 'secret.txt'), 'secret-data', 'utf8');
            fs.writeFileSync(path.join(workspaceB, 'other.txt'), 'other-data', 'utf8');

            // Unregistered session trying to supply workspaceRoot in payload
            const unregRes = await artifactHandlers.artifact_register(ctx, {
                sessionId: 'sess-unregistered',
                workspaceRoot: workspaceA,
                path: 'secret.txt',
            });
            expect(unregRes.success).toBe(false);
            expect(unregRes.code).toBe('invalid_workspace_root');

            // Registered session in workspaceA trying to override workspaceRoot to workspaceB
            sessionRegistry.register({
                sessionId: 'sess-registered-a',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            const overrideRes = await artifactHandlers.artifact_register(ctx, {
                sessionId: 'sess-registered-a',
                workspaceRoot: workspaceB,
                path: 'other.txt',
            });
            expect(overrideRes.success).toBe(false);
            expect(overrideRes.code).toBe('invalid_workspace_root');
        });

        it('rejects cross-session artifact_fetch with artifact_session_mismatch', async () => {
            sessionRegistry.register({
                sessionId: 'sess-owner',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            sessionRegistry.register({
                sessionId: 'sess-other',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceB,
            });

            fs.writeFileSync(path.join(workspaceA, 'report.json'), '{"ok":true}', 'utf8');
            const regRes = await artifactHandlers.artifact_register(ctx, {
                sessionId: 'sess-owner',
                path: 'report.json',
            });
            expect(regRes.success).toBe(true);

            // Session B attempting to fetch Session A's artifact
            const crossFetch = await artifactHandlers.artifact_fetch(ctx, {
                sessionId: 'sess-other',
                artifactId: regRes.artifactId,
            });
            expect(crossFetch.success).toBe(false);
            expect(crossFetch.code).toBe('artifact_session_mismatch');

            // Conflicting sessionId and targetSessionId
            const conflictFetch = await artifactHandlers.artifact_fetch(ctx, {
                sessionId: 'sess-owner',
                targetSessionId: 'sess-other',
                artifactId: regRes.artifactId,
            });
            expect(conflictFetch.success).toBe(false);
            expect(conflictFetch.code).toBe('artifact_session_mismatch');
        });

        it('resolves coordinator session workspace from coordinator-registry', async () => {
            const coordSessionId = 'coord-sess-1';
            registerMeshCoordinator({
                meshId: 'mesh-coord-1',
                sessionId: coordSessionId,
                workspace: workspaceA,
                startedAt: Date.now(),
                cliType: 'claude-cli',
            });
            try {
                fs.writeFileSync(path.join(workspaceA, 'plan.md'), '# Coordinator Plan\n', 'utf8');
                const reg = await artifactHandlers.artifact_register(ctx, {
                    sessionId: coordSessionId,
                    path: 'plan.md',
                });
                expect(reg.success).toBe(true);
                expect(reg.sessionId).toBe(coordSessionId);
            } finally {
                unregisterMeshCoordinator(coordSessionId);
            }
        });

        it('authenticates worker callers via resolveWorkerIdentity(store, bind, token) and enforces exact session, task, and workspace ownership', async () => {
            const meshId = 'mesh-worker-test';
            const workerSessionId = 'worker-sess-1';
            const taskId = 'task-worker-101';
            const nodeId = 'node-worker-1';

            sessionRegistry.register({
                sessionId: workerSessionId,
                parentSessionId: null,
                providerType: 'codex-cli',
                transport: 'pty',
                workspace: workspaceA,
            });

            const nowIso = new Date().toISOString();
            meshStore.insertQueueEntry({
                id: taskId,
                meshId,
                targetNodeId: nodeId,
                status: 'assigned',
                assignedSessionId: workerSessionId,
                message: 'Worker artifact test',
                workspace: workspaceA,
                createdAt: nowIso,
                updatedAt: nowIso,
            } as any);

            const bind = mintWorkerSessionBind({
                meshId,
                sessionId: workerSessionId,
                nodeId,
                spawnedForTaskId: taskId,
            });
            const token = mintWorkerTaskToken({
                meshId,
                taskId,
                sessionId: workerSessionId,
                nodeId,
            });

            // Verify 3-arg resolveWorkerIdentity(store, bind, token) directly
            const resolvedViaBind = resolveWorkerIdentity(meshStore, bind.bind, undefined);
            expect(resolvedViaBind).toMatchObject({
                meshId,
                taskId,
                sessionId: workerSessionId,
                nodeId,
            });
            const resolvedViaToken = resolveWorkerIdentity(meshStore, undefined, token.token);
            expect(resolvedViaToken).toMatchObject({
                meshId,
                taskId,
                sessionId: workerSessionId,
                nodeId,
            });

            fs.writeFileSync(path.join(workspaceA, 'changes.diff'), '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n', 'utf8');

            // 1. Valid worker bind registration
            const regRes = await artifactHandlers.artifact_register(ctx, {
                bind: bind.bind,
                path: 'changes.diff',
                title: 'Worker Patch',
            });
            expect(regRes.success).toBe(true);
            expect(regRes.sessionId).toBe(workerSessionId);
            expect(regRes.taskId).toBe(taskId);

            // 2. Valid worker token fetch
            const fetchRes = await artifactHandlers.artifact_fetch(ctx, {
                token: token.token,
                artifactId: regRes.artifactId,
            });
            expect(fetchRes.success).toBe(true);
            expect(fetchRes.kind).toBe('diff');

            // 3. Forged/unknown worker credential -> unauthenticated
            const badCredRes = await artifactHandlers.artifact_register(ctx, {
                bind: 'wsb_forged_invalid_bind',
                path: 'changes.diff',
            });
            expect(badCredRes.success).toBe(false);
            expect(badCredRes.code).toBe('unauthenticated');

            // 4. Worker attempting to claim another sessionId -> artifact_session_mismatch
            const wrongSessionRes = await artifactHandlers.artifact_register(ctx, {
                bind: bind.bind,
                sessionId: 'some-other-session',
                path: 'changes.diff',
            });
            expect(wrongSessionRes.success).toBe(false);
            expect(wrongSessionRes.code).toBe('artifact_session_mismatch');

            // 5. Worker attempting to claim another taskId -> task_mismatch
            const wrongTaskRes = await artifactHandlers.artifact_register(ctx, {
                token: token.token,
                taskId: 'other-task-999',
                path: 'changes.diff',
            });
            expect(wrongTaskRes.success).toBe(false);
            expect(wrongTaskRes.code).toBe('task_mismatch');

            // 6. Worker with mismatched session workspace vs task workspace -> invalid_workspace_root
            const mismatchSessionId = 'worker-sess-mismatch';
            sessionRegistry.register({
                sessionId: mismatchSessionId,
                parentSessionId: null,
                providerType: 'codex-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            meshStore.insertQueueEntry({
                id: 'task-mismatch-ws',
                meshId,
                targetNodeId: 'node-2',
                status: 'assigned',
                assignedSessionId: mismatchSessionId,
                message: 'Mismatched workspace task',
                workspace: workspaceB,
                createdAt: nowIso,
                updatedAt: nowIso,
            } as any);
            const mismatchToken = mintWorkerTaskToken({
                meshId,
                taskId: 'task-mismatch-ws',
                sessionId: mismatchSessionId,
                nodeId: 'node-2',
            });
            const wsMismatchRes = await artifactHandlers.artifact_register(ctx, {
                token: mismatchToken.token,
                path: 'changes.diff',
            });
            expect(wsMismatchRes.success).toBe(false);
            expect(wsMismatchRes.code).toBe('invalid_workspace_root');
        });

        it('enforces ArtifactStore guard errors (traversal, HTML/SVG ban, 4 MiB cap, 50-artifact cap with update at cap, and hashChanged on edit)', async () => {
            const sessionId = 'sess-guards';
            sessionRegistry.register({
                sessionId,
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });

            // Traversal
            const travRes = await artifactHandlers.artifact_register(ctx, {
                sessionId,
                path: '../outside.txt',
            });
            expect(travRes.success).toBe(false);
            expect(travRes.code).toBe('path_outside_workspace');

            // HTML / SVG ban
            fs.writeFileSync(path.join(workspaceA, 'xss.html'), '<script>alert(1)</script>', 'utf8');
            fs.writeFileSync(path.join(workspaceA, 'icon.svg'), '<svg></svg>', 'utf8');
            const htmlRes = await artifactHandlers.artifact_register(ctx, {
                sessionId,
                path: 'xss.html',
            });
            expect(htmlRes.success).toBe(false);
            expect(htmlRes.code).toBe('unsupported_mime_or_kind');

            const svgRes = await artifactHandlers.artifact_register(ctx, {
                sessionId,
                path: 'icon.svg',
            });
            expect(svgRes.success).toBe(false);
            expect(svgRes.code).toBe('unsupported_mime_or_kind');

            // Over 4 MiB
            const bigPath = path.join(workspaceA, 'huge.txt');
            fs.writeFileSync(bigPath, Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x61));
            const bigRes = await artifactHandlers.artifact_register(ctx, {
                sessionId,
                path: 'huge.txt',
            });
            expect(bigRes.success).toBe(false);
            expect(bigRes.code).toBe('artifact_too_large');

            // Image base64 fetch + sha256Changed when modified after registration
            const pngPath = path.join(workspaceA, 'shot.png');
            const pngBytes1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
            fs.writeFileSync(pngPath, pngBytes1);
            const imgReg = await artifactHandlers.artifact_register(ctx, {
                sessionId,
                path: 'shot.png',
            });
            expect(imgReg.success).toBe(true);
            expect((imgReg.attachment as ChatAttachmentMeta).previewText).toBeUndefined();

            const imgFetch1 = await artifactHandlers.artifact_fetch(ctx, {
                sessionId,
                artifactId: imgReg.artifactId,
            });
            expect(imgFetch1.success).toBe(true);
            expect(imgFetch1.encoding).toBe('base64');
            expect(imgFetch1.content).toBe(pngBytes1.toString('base64'));
            expect(imgFetch1.sha256Changed).toBe(false);

            const pngBytes2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02, 0x03]);
            fs.writeFileSync(pngPath, pngBytes2);
            const imgFetch2 = await artifactHandlers.artifact_fetch(ctx, {
                sessionId,
                artifactId: imgReg.artifactId,
            });
            expect(imgFetch2.success).toBe(true);
            expect(imgFetch2.content).toBe(pngBytes2.toString('base64'));
            expect(imgFetch2.sha256Changed).toBe(true);
            expect(imgFetch2.hashChanged).toBe(true);

            // Fill remaining slots up to MAX_ARTIFACTS_PER_SESSION (50)
            for (let i = 2; i <= MAX_ARTIFACTS_PER_SESSION; i += 1) {
                const name = `file-${i}.txt`;
                fs.writeFileSync(path.join(workspaceA, name), `content ${i}`, 'utf8');
                const r = await artifactHandlers.artifact_register(ctx, {
                    sessionId,
                    path: name,
                });
                expect(r.success).toBe(true);
            }

            // 51st distinct file must fail with session_artifact_limit_reached
            fs.writeFileSync(path.join(workspaceA, 'file-51.txt'), 'overflow', 'utf8');
            const overflowRes = await artifactHandlers.artifact_register(ctx, {
                sessionId,
                path: 'file-51.txt',
            });
            expect(overflowRes.success).toBe(false);
            expect(overflowRes.code).toBe('session_artifact_limit_reached');

            // Re-registering an existing file at cap 50 succeeds in-place with same artifactId
            const updateAtCap = await artifactHandlers.artifact_register(ctx, {
                sessionId,
                path: 'shot.png',
                title: 'Updated Screenshot',
            });
            expect(updateAtCap.success).toBe(true);
            expect(updateAtCap.isUpdate).toBe(true);
            expect(updateAtCap.artifactId).toBe(imgReg.artifactId);
        });
    });

    describe('Keyed-Chat Attachment Transport, Projection Sites & Frame/Digest/Retention Invariants', () => {
        it('projects ChatAttachmentMeta across observation builder, wire codec, read_chat adapter, and web chat pane adapter', () => {
            const attachment: ChatAttachmentMeta = {
                artifactId: 'art_0123456789abcdef',
                kind: 'markdown',
                mime: 'text/markdown',
                filename: 'design.md',
                title: 'Architecture Spec',
                sizeBytes: 1280,
                sha256: 'a'.repeat(64),
                previewText: '# Architecture Spec\n\nPreview content',
                createdAt: 1700000000000,
                updatedAt: 1700000005000,
            };

            // 1. Observation builder (@message-projection l3 identity)
            const obs = buildTranscriptObservationFromReadChat({
                sessionId: 'sess-proj-1',
                providerType: 'claude-cli',
                status: 'running',
                providerObservedStatus: 'running',
                turn: null,
                messages: [
                    {
                        id: `artifact:${attachment.artifactId}`,
                        messageId: `artifact:${attachment.artifactId}`,
                        role: 'system',
                        kind: 'artifact',
                        content: attachment.title,
                        bubbleState: 'final',
                        receivedAt: attachment.createdAt,
                        timestamp: attachment.updatedAt,
                        attachment,
                    },
                ],
                coverage: { mode: 'full', omittedBefore: false },
            })!;
            expect(obs).not.toBeNull();
            expect(obs.messages).toHaveLength(1);
            expect(obs.messages[0].messageId).toBe(`artifact:${attachment.artifactId}`);
            expect(obs.messages[0].attachment).toEqual(attachment);

            // 2. Wire head encoder & reader (@message-projection l2k)
            const head = encodeChatMessageHead(obs.messages[0], {
                id: `artifact:${attachment.artifactId}`,
                ord: 'a0',
                rev: 1,
                epoch: 'ep1',
                frame: 1,
                srcId: null,
                body: { text: attachment.title },
            });
            expect(head.attachment).toEqual(attachment);
            expect(readChatMsg(head)).toEqual(head);

            // Reject malformed attachment on wire
            expect(
                readChatMsg({
                    ...head,
                    attachment: { ...attachment, kind: 'html' },
                }),
            ).toBeNull();

            // 3. Wire decoder (@message-projection l2k-decode)
            const decoded = chatMessageFromWire(head, attachment.title);
            expect(decoded.messageId).toBe(`artifact:${attachment.artifactId}`);
            expect(decoded.kind).toBe('artifact');
            expect(decoded.attachment).toEqual(attachment);

            // 4. Read-chat adapter & Web chat-pane adapter (@message-projection l2k-decode)
            const state = new KeyedChatSessionState('sess-proj-1', 'ep1');
            const built = state.buildArtifactFrame(
                {
                    attachment,
                    providerType: 'claude-cli',
                    status: 'running',
                    title: 'Proj Session',
                },
                {
                    writerId: 'w1',
                    producerDaemonId: 'd1',
                    observedAt: '2026-10-20T00:00:00.000Z',
                    nowMs: 1700000005000,
                },
            );
            expect(built.status).toBe('frame');
            if (built.status !== 'frame') throw new Error('expected frame');
            state.commit(built.frame, 1700000005000);

            const folder = new KeyedTranscriptFolder({ expectedSessionId: 'sess-proj-1' });
            const deltas = folder.ingestRows(frameToFolderRows(built.frame, 'w1'));
            expect(deltas).toHaveLength(1);
            expect(folder.needsResync).toBeNull();
            expect(folder.stats().digestMismatches).toBe(0);
            expect(folder.stats().rejectedRows).toBe(0);

            const view = folder.view();
            expect(view).not.toBeNull();
            expect(view!.messages).toHaveLength(1);
            expect(view!.messages[0].attachment).toEqual(attachment);

            const readChatPayload = mapTranscriptViewToReadChatPayload(view!, { includeActivity: true });
            const mappedReadChatMsgs = readChatPayload.messages as any[];
            expect(mappedReadChatMsgs).toHaveLength(1);
            expect(mappedReadChatMsgs[0].id).toBe(`artifact:${attachment.artifactId}`);
            expect(mappedReadChatMsgs[0].kind).toBe('artifact');
            expect(mappedReadChatMsgs[0].attachment).toEqual(attachment);

            const bubbleCache = new TranscriptBubbleCache();
            const paneView = mapTranscriptViewToChatView(view!, bubbleCache);
            expect(paneView).not.toBeNull();
            expect(paneView!.messages).toHaveLength(1);
            expect(paneView!.messages[0].id).toBe(`artifact:${attachment.artifactId}`);
            expect(paneView!.messages[0].kind).toBe('artifact');
            expect(paneView!.messages[0].attachment).toEqual(attachment);
        });

        it('retains m:artifact:<id> across normal read_chat ticks, updates rev in-place on same-path re-register, and verifies every frame in KeyedTranscriptFolder', async () => {
            const sessionId = 'sess-retention-1';
            sessionRegistry.register({
                sessionId,
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });

            const persistedRows: PersistedChatRow[] = [];
            const folder = new KeyedTranscriptFolder({ expectedSessionId: sessionId });
            let seqCounter = 1;

            configureTranscriptProjection({
                daemonId: () => 'daemon-1',
                writerId: () => 'writer-1',
                epoch: 'epoch-ret-1',
                appendChatFrame: async (_sid, frame) => {
                    for (const row of frame.rows) {
                        persistedRows.push({
                            key: row.key,
                            kind: row.kind,
                            writer: 'writer-1',
                            payload: row.payload,
                        });
                    }
                    folder.ingestRows(frameToFolderRows(frame, 'writer-1', seqCounter));
                    seqCounter += frame.rows.length;
                },
                readPersistedChat: () => ({
                    committed: persistedRows,
                    torn: [],
                }),
            });

            // Step 1: Register an artifact via artifact_register command before any read_chat tick
            const filePath = path.join(workspaceA, 'notes.md');
            fs.writeFileSync(filePath, '# Initial Notes\nFirst version.\n', 'utf8');

            const reg1 = await artifactHandlers.artifact_register(ctx, {
                sessionId,
                path: 'notes.md',
                title: 'Session Notes',
            });
            expect(reg1.success).toBe(true);
            const artifactId = reg1.artifactId as string;
            const bubbleId = `artifact:${artifactId}`;
            const wireKey = `m:artifact:${artifactId}`;

            // Verify frame 1 committed with meta + msg + commit and verified in KeyedTranscriptFolder
            expect(folder.needsResync).toBeNull();
            expect(folder.stats().commitsApplied).toBe(1);
            expect(folder.stats().digestMismatches).toBe(0);
            expect(folder.view()?.messages).toHaveLength(1);
            expect(folder.view()?.messages[0]).toMatchObject({
                messageId: bubbleId,
                rev: 1,
                kind: 'artifact',
                content: 'Session Notes',
            });
            const initialOrd = folder.view()!.messages[0].ord;

            // Step 2: Normal read_chat tick arrives (contains only user/assistant messages, no artifact message)
            const service = configureTranscriptProjection({
                daemonId: () => 'daemon-1',
                writerId: () => 'writer-1',
                epoch: 'epoch-ret-1',
                appendChatFrame: async (_sid, frame) => {
                    for (const row of frame.rows) {
                        persistedRows.push({
                            key: row.key,
                            kind: row.kind,
                            writer: 'writer-1',
                            payload: row.payload,
                        });
                    }
                    folder.ingestRows(frameToFolderRows(frame, 'writer-1', seqCounter));
                    seqCounter += frame.rows.length;
                },
                readPersistedChat: () => ({
                    committed: persistedRows,
                    torn: [],
                }),
            })!;

            service.observe(sessionId, {
                sessionId,
                providerType: 'claude-cli',
                status: 'running',
                providerObservedStatus: 'running',
                messages: [
                    {
                        messageId: 'd.ep.1',
                        ord: 'a1',
                        srcId: null,
                        role: 'user',
                        kind: 'standard',
                        content: 'Please write notes.md',
                        bubbleState: 'final',
                    },
                    {
                        messageId: 'd.ep.2',
                        ord: 'a2',
                        srcId: null,
                        role: 'assistant',
                        kind: 'standard',
                        content: 'Done writing notes.md',
                        bubbleState: 'final',
                    },
                ],
                coverage: { mode: 'full', omittedBefore: false },
            });
            await new Promise((resolve) => setImmediate(resolve));

            // Artifact bubble MUST be retained (not tombstoned), liveCount === 3, omittedBefore === false!
            expect(folder.needsResync).toBeNull();
            expect(folder.stats().digestMismatches).toBe(0);
            expect(folder.lastCommit()?.liveCount).toBe(3);
            expect(folder.view()?.coverage.omittedBefore).toBe(false);
            expect(folder.view()?.messages.map((m) => m.messageId)).toEqual([
                bubbleId,
                'd.ep.1',
                'd.ep.2',
            ]);

            // Step 3: Modify notes.md and re-register the SAME path
            fs.writeFileSync(filePath, '# Updated Notes\nSecond revision with new details.\n', 'utf8');
            const reg2 = await artifactHandlers.artifact_register(ctx, {
                sessionId,
                path: 'notes.md',
                title: 'Session Notes v2',
            });
            expect(reg2.success).toBe(true);
            expect(reg2.isUpdate).toBe(true);
            expect(reg2.artifactId).toBe(artifactId);
            expect(reg2.messageKey).toBe(wireKey);

            // Verify in-place revision update (rev: 2, same artifactId, same ord, no duplicate bubble)
            expect(folder.needsResync).toBeNull();
            expect(folder.stats().digestMismatches).toBe(0);
            expect(folder.lastCommit()?.liveCount).toBe(3);
            const artifactMsgAfterUpdate = folder.view()?.messages.find((m) => m.messageId === bubbleId);
            expect(artifactMsgAfterUpdate).toBeDefined();
            expect(artifactMsgAfterUpdate?.rev).toBe(2);
            expect(artifactMsgAfterUpdate?.ord).toBe(initialOrd);
            expect(artifactMsgAfterUpdate?.attachment?.title).toBe('Session Notes v2');
            expect(artifactMsgAfterUpdate?.attachment?.previewText).toContain('Second revision');

            // Step 4: Subsequent normal read_chat tick with unchanged messages writes 0 rows (no duplicate, no tombstone)
            const commitsBeforeTick = folder.stats().commitsApplied;
            service.observe(sessionId, {
                sessionId,
                providerType: 'claude-cli',
                status: 'running',
                providerObservedStatus: 'running',
                messages: [
                    {
                        messageId: 'd.ep.1',
                        ord: 'a1',
                        srcId: null,
                        role: 'user',
                        kind: 'standard',
                        content: 'Please write notes.md',
                        bubbleState: 'final',
                    },
                    {
                        messageId: 'd.ep.2',
                        ord: 'a2',
                        srcId: null,
                        role: 'assistant',
                        kind: 'standard',
                        content: 'Done writing notes.md',
                        bubbleState: 'final',
                    },
                ],
                coverage: { mode: 'full', omittedBefore: false },
            });
            await new Promise((resolve) => setImmediate(resolve));

            expect(folder.stats().commitsApplied).toBe(commitsBeforeTick);
            expect(service.getCounters().deduped).toBeGreaterThanOrEqual(1);
            expect(folder.view()?.messages).toHaveLength(3);

            // Step 5: Verify ledgerSeedFromPersisted excludes artifact:* so MessageIdentityLedger only seeds chat bubbles
            const seed = ledgerSeedFromPersisted({ committed: persistedRows, torn: [] });
            expect(seed?.entries.some((e) => e.messageId.startsWith('artifact:'))).toBe(false);
        });
    });
});
