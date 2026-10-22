import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
    const real: any = await importOriginal();
    return {
        ...real,
        realpathSync: vi.fn(real.realpathSync),
    };
});
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
    attachTrustedOwnerIngressProof,
    isTrustedOwnerIngress,
    issueTrustedOwnerIngressProof,
    markTrustedOwnerIngress,
    preserveTrustedOwnerIngress,
} from '../../src/commands/command-args.js';
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
import { seedMeshAttempt } from '../helpers/turn-attempt-seed.js';
import {
    registerMeshCoordinator,
    unregisterMeshCoordinator,
} from '../../src/mesh/coordinator-registry.js';
import { MeshRpcEndpoint } from '../../src/mesh/transport/mesh-rpc-endpoint.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';
import { workerReportHandlers } from '../../src/commands/low-family/worker-report.js';
import { wrapUntrustedArtifactContent } from '../../src/artifacts/index.js';
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
        configureTranscriptProjection({
            daemonId: () => 'test-daemon',
            writerId: () => 'test-writer',
            epoch: 'test-epoch',
            appendChatFrame: async () => {},
        });

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
        it('registers artifact_register, artifact_list, and artifact_fetch in DaemonCommandRegistry with non-mesh, non-ws sources', () => {
            const registry = getDaemonCommandRegistry();
            for (const name of [
                'artifact_register',
                'session_artifact_register',
                'artifact_list',
                'session_artifact_list',
                'artifact_fetch',
                'artifact_read',
                'session_artifact_fetch',
            ]) {
                const spec = registry.get(name);
                expect(spec).toBeDefined();
                expect(spec?.family).toBe('med');
                expect(spec?.sources.includes('ipc')).toBe(true);
                expect(spec?.sources.includes('standalone')).toBe(true);
                expect(spec?.sources.includes('p2p')).toBe(true);
                expect(spec?.sources.includes('ws')).toBe(false);
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

            const listRes = await router.execute('artifact_list', { sessionId }, 'standalone', {
                ownerVerified: true,
            });
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
                { peerId: 'peer-owner', ownerVerified: true },
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
            seedMeshAttempt({
                meshId,
                taskId,
                sessionId: workerSessionId,
                nodeId,
                attemptId: 'attempt-worker-101',
                attemptNo: 0,
                stage: 'generating',
            });

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
                attemptId: 'attempt-worker-101',
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
            seedMeshAttempt({
                meshId,
                taskId: 'task-mismatch-ws',
                sessionId: mismatchSessionId,
                nodeId: 'node-2',
                attemptId: 'attempt-mismatch-ws',
                attemptNo: 0,
                stage: 'generating',
            });
            const mismatchToken = mintWorkerTaskToken({
                meshId,
                taskId: 'task-mismatch-ws',
                sessionId: mismatchSessionId,
                nodeId: 'node-2',
                attemptId: 'attempt-mismatch-ws',
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

        it('verifies writer-change restore and web cache invalidation when only sha256 or updatedAt changes', () => {
            const attachment: ChatAttachmentMeta = {
                artifactId: 'art_test_restore01',
                kind: 'text',
                mime: 'text/plain',
                filename: 'note.txt',
                title: 'Note',
                sizeBytes: 1,
                sha256: 'a'.repeat(64),
                previewText: 'a',
                createdAt: 1,
                updatedAt: 2,
            };
            const context = {
                writerId: 'w',
                producerDaemonId: 'd',
                observedAt: '2026-10-20T00:00:00.000Z',
                nowMs: 100,
            };

            let state = new KeyedChatSessionState('s', 'ep');
            const folder = new KeyedTranscriptFolder({ expectedSessionId: 's' });
            const persisted: any[] = [];
            let seq = 1;
            const apply = (result: any, writer = 'w') => {
                expect(result.status).toBe('frame');
                state.commit(result.frame, context.nowMs++);
                const rows = result.frame.rows.map((r: any) => ({ ...r, writer, seq: seq++ }));
                persisted.push(...rows);
                folder.ingestRows(rows);
                expect(folder.needsResync).toBeNull();
                expect(folder.stats().digestMismatches).toBe(0);
                return result.frame;
            };

            apply(state.buildArtifactFrame({ attachment }, context));
            const initial = folder.view()!.messages[0];
            for (let n = 1; n <= 3; n++) {
                const frame = apply(
                    state.build(
                        {
                            sessionId: 's',
                            providerType: 'x',
                            status: 'running',
                            providerObservedStatus: null,
                            messages: [
                                {
                                    messageId: 'chat1',
                                    ord: 'a1',
                                    role: 'assistant',
                                    kind: 'standard',
                                    content: `tick${n}`,
                                },
                            ],
                            coverage: { mode: 'full', omittedBefore: false },
                        },
                        context,
                    ),
                );
                expect(
                    frame.rows.some(
                        (r: any) => r.kind === 'chat.del.v2' && r.key === 'm:artifact:art_test_restore01',
                    ),
                ).toBe(false);
                expect(folder.lastCommit()!.liveCount).toBe(2);
                expect(folder.view()!.coverage.omittedBefore).toBe(false);
            }

            apply(
                state.buildArtifactFrame(
                    { attachment: { ...attachment, sha256: 'b'.repeat(64), updatedAt: 3 } },
                    context,
                ),
            );
            const updatedArtifact = folder
                .view()!
                .messages.find((m) => m.messageId === 'artifact:art_test_restore01')!;
            expect(updatedArtifact.rev).toBe(initial.rev + 1);
            expect(updatedArtifact.ord).toBe(initial.ord);
            expect(updatedArtifact.attachment!.sha256).toBe('b'.repeat(64));

            const latest = new Map<string, any>();
            for (const row of persisted) latest.set(row.key, row);
            state = new KeyedChatSessionState('s', 'ep2');
            state.restore({ committed: [...latest.values()], torn: [] }, 'w2');
            const base = apply(
                state.build(
                    {
                        sessionId: 's',
                        providerType: 'x',
                        status: 'running',
                        providerObservedStatus: null,
                        messages: [
                            {
                                messageId: 'chat1',
                                ord: 'a1',
                                role: 'assistant',
                                kind: 'standard',
                                content: 'tick3',
                            },
                        ],
                        coverage: { mode: 'full', omittedBefore: false },
                    },
                    { ...context, writerId: 'w2' },
                ),
                'w2',
            );
            expect(base.commit.baseReason).toBe('writer_change');
            expect(folder.lastCommit()!.liveCount).toBe(2);
            expect(
                folder.view()!.messages.find((m) => m.messageId === 'artifact:art_test_restore01')!.ord,
            ).toBe(initial.ord);

            // Web cache invalidation when only sha256 or updatedAt changes
            const view1 = folder.view()!;
            const cache = new TranscriptBubbleCache();
            const one = mapTranscriptViewToChatView(view1, cache)!.messages.find(
                (m) => m.id === 'artifact:art_test_restore01',
            )!;
            const view2 = {
                ...view1,
                messages: view1.messages.map((m) =>
                    m.messageId === 'artifact:art_test_restore01'
                        ? { ...m, attachment: { ...m.attachment!, sha256: 'c'.repeat(64) } }
                        : m,
                ),
            };
            const two = mapTranscriptViewToChatView(view2, cache)!.messages.find(
                (m) => m.id === 'artifact:art_test_restore01',
            )!;
            expect(two).not.toBe(one);
            expect(two.attachment!.sha256).toBe('c'.repeat(64));

            const view3 = {
                ...view2,
                messages: view2.messages.map((m) =>
                    m.messageId === 'artifact:art_test_restore01'
                        ? { ...m, attachment: { ...m.attachment!, updatedAt: 99 } }
                        : m,
                ),
            };
            const three = mapTranscriptViewToChatView(view3, cache)!.messages.find(
                (m) => m.id === 'artifact:art_test_restore01',
            )!;
            expect(three).not.toBe(two);
            expect(three.attachment!.updatedAt).toBe(99);
        });
    });

    describe('Local security & correctness regressions (F2, F3, F4, F5, and WS source defense-in-depth)', () => {
        const allAliases = [
            'artifact_register',
            'session_artifact_register',
            'artifact_list',
            'session_artifact_list',
            'artifact_fetch',
            'artifact_read',
            'session_artifact_fetch',
        ];

        it('rejects all 7 artifact command aliases from ws, mesh, internal, ext, api, and unknown sources', async () => {
            sessionRegistry.register({
                sessionId: 'victim',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            fs.writeFileSync(path.join(workspaceA, 'private.md'), 'SECRET-MARKER', 'utf8');
            const router = new DaemonCommandRouter(deps);
            const reg = await router.execute(
                'artifact_register',
                { sessionId: 'victim', path: 'private.md' },
                'ipc',
            );
            expect(reg.success).toBe(true);

            for (const source of ['ws', 'mesh', 'internal', 'ext', 'api', 'invented']) {
                for (const cmd of allAliases) {
                    const res = await router.execute(
                        cmd,
                        { sessionId: 'victim', artifactId: reg.artifactId, path: 'private.md' },
                        source,
                    );
                    expect(res.success).toBe(false);
                    expect(res.code).toBe('COMMAND_SOURCE_REJECTED');
                }
            }
        });

        it('F2: rejects replacement of the stored canonical workspace by an outside-root symlink at fetch time via DaemonCommandRouter', async () => {
            sessionRegistry.register({
                sessionId: 'victim',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            fs.writeFileSync(path.join(workspaceA, 'private.md'), 'LOCAL-WORKSPACE-CONTENT', 'utf8');
            const router = new DaemonCommandRouter(deps);
            const reg = await router.execute(
                'artifact_register',
                { sessionId: 'victim', path: 'private.md' },
                'ipc',
            );
            expect(reg.success).toBe(true);

            const outside = path.join(tempRoot, 'outside-f2');
            fs.mkdirSync(outside, { recursive: true });
            fs.writeFileSync(path.join(outside, 'private.md'), 'OUTSIDE-ROOT-SECRET', 'utf8');
            fs.renameSync(workspaceA, path.join(tempRoot, 'original-workspace-a'));
            fs.symlinkSync(outside, workspaceA, 'dir');

            const res = await router.execute(
                'artifact_fetch',
                { sessionId: 'victim', artifactId: reg.artifactId },
                'p2p',
                { peerId: 'peer-owner', ownerVerified: true },
            );
            expect(res.success).toBe(false);
            expect(res.code).toBe('path_outside_workspace');
        });

        it('F3: rejects stale worker token and stale worker bind against a newer attempt of the same task and session while allowing the current attempt', async () => {
            sessionRegistry.register({
                sessionId: 'worker',
                parentSessionId: null,
                providerType: 'codex-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            fs.writeFileSync(path.join(workspaceA, 'private.md'), 'WORKER-CONTENT', 'utf8');
            const router = new DaemonCommandRouter(deps);
            const now = new Date().toISOString();

            meshStore.insertQueueEntry({
                id: 'task',
                meshId: 'mesh',
                message: 'fixture',
                status: 'assigned',
                assignedSessionId: 'worker',
                workspace: workspaceA,
                createdAt: now,
                updatedAt: now,
            } as any);

            // Case 1: Old token against newer attempt
            const old = seedMeshAttempt({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
                attemptId: 'attempt-old',
                attemptNo: 0,
                stage: 'failed',
            });
            const oldToken = mintWorkerTaskToken({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
                attemptId: old.attemptId,
            });
            const bindBeforeNewAttempt = mintWorkerSessionBind({
                meshId: 'mesh',
                sessionId: 'worker',
            });
            seedMeshAttempt({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
                attemptId: 'attempt-current',
                attemptNo: 1,
                stage: 'generating',
            });
            expect(meshStore.turnStore().findLatestAttemptForTask('mesh', 'task')?.attemptId).toBe(
                'attempt-current',
            );

            const staleTokenRes = await router.execute(
                'artifact_register',
                { token: oldToken.token, path: 'private.md' },
                'ipc',
            );
            expect(staleTokenRes.success).toBe(false);
            expect(staleTokenRes.code).toBe('stale_attempt');

            // Case 2: Stale bind resolution against newer attempt
            const staleBindRes = await router.execute(
                'artifact_register',
                { bind: bindBeforeNewAttempt.bind, path: 'private.md' },
                'ipc',
            );
            expect(staleBindRes.success).toBe(false);
            expect(staleBindRes.code).toBe('stale_attempt');

            // Positive control: token minted for the current active attempt succeeds
            __resetWorkerTaskTokensForTest();
            const currentToken = mintWorkerTaskToken({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
                attemptId: 'attempt-current',
            });
            const currentTokenRes = await router.execute(
                'artifact_register',
                { token: currentToken.token, path: 'private.md' },
                'ipc',
            );
            expect(currentTokenRes.success).toBe(true);
            expect(currentTokenRes.sessionId).toBe('worker');

            const currentBindRes = await router.execute(
                'artifact_list',
                { bind: bindBeforeNewAttempt.bind },
                'ipc',
            );
            expect(currentBindRes.success).toBe(true);
            expect((currentBindRes.artifacts as any[]).length).toBe(1);
        });

        it('F4: does not let caller-selected meshId/nodeId/taskId authorize an unregistered target session', async () => {
            sessionRegistry.register({
                sessionId: 'victim',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            fs.writeFileSync(path.join(workspaceA, 'private.md'), 'VICTIM-FILE', 'utf8');

            const now = new Date().toISOString();
            meshStore.insertQueueEntry({
                id: 'other-task',
                meshId: 'mesh',
                message: 'fixture',
                status: 'assigned',
                assignedSessionId: 'victim',
                workspace: workspaceA,
                createdAt: now,
                updatedAt: now,
            } as any);

            const router = new DaemonCommandRouter(deps);
            const res = await router.execute(
                'artifact_register',
                {
                    sessionId: 'invented-session',
                    meshId: 'mesh',
                    taskId: 'other-task',
                    path: 'private.md',
                },
                'ipc',
            );
            expect(res.success).toBe(false);

            // Also reject when registered session B attempts to claim victim's taskId
            sessionRegistry.register({
                sessionId: 'sess-other-b',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            const crossTaskRes = await router.execute(
                'artifact_register',
                {
                    sessionId: 'sess-other-b',
                    meshId: 'mesh',
                    taskId: 'other-task',
                    path: 'private.md',
                },
                'ipc',
            );
            expect(crossTaskRes.success).toBe(false);
            expect(crossTaskRes.code).toBe('task_mismatch');
        });

        it('F5: surfaces failed artifact-bubble publication as success: false with persisted artifactId, and succeeds idempotently on retry', async () => {
            sessionRegistry.register({
                sessionId: 'victim',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            fs.writeFileSync(path.join(workspaceA, 'private.md'), '# First Draft\n', 'utf8');

            const router = new DaemonCommandRouter(deps);
            const folder = new KeyedTranscriptFolder({ expectedSessionId: 'victim' });
            let seq = 1;
            let shouldThrow = true;

            const append = vi.fn(async (_sid: string, frame: KeyedChatFrame) => {
                if (shouldThrow) {
                    throw new Error('fixture append failed');
                }
                folder.ingestRows(frameToFolderRows(frame, 'w', seq));
                seq += frame.rows.length;
            });

            const service = configureTranscriptProjection({
                daemonId: () => 'd',
                writerId: () => 'w',
                epoch: 'ep',
                appendChatFrame: append,
            })!;

            try {
                // Attempt 1: appendChatFrame throws -> must return success: false, code: artifact_publication_failed
                const failedRes = await router.execute(
                    'artifact_register',
                    { sessionId: 'victim', path: 'private.md', title: 'Report v1' },
                    'ipc',
                );
                expect(append).toHaveBeenCalledTimes(1);
                expect(failedRes.success).toBe(false);
                expect(failedRes.code).toBe('artifact_publication_failed');
                expect(failedRes.registered).toBe(true);
                expect(failedRes.published).toBe(false);
                expect(failedRes.artifactId).toMatch(/^art_[0-9a-f]{16}$/);
                expect(failedRes.messageId).toBeUndefined();
                expect(artifactStore.countBySession('victim')).toBe(1);
                expect(folder.view()).toBeNull();

                // Attempt 2 (retry on same path when publisher recovers): idempotent upsert + valid committed frame
                shouldThrow = false;
                const retryRes = await router.execute(
                    'artifact_register',
                    { sessionId: 'victim', path: 'private.md', title: 'Report v1' },
                    'ipc',
                );
                expect(append).toHaveBeenCalledTimes(2);
                expect(retryRes.success).toBe(true);
                expect(retryRes.registered).toBe(true);
                expect(retryRes.published).toBe(true);
                expect(retryRes.isUpdate).toBe(true);
                expect(retryRes.artifactId).toBe(failedRes.artifactId);
                expect(retryRes.messageKey).toBe(`m:artifact:${failedRes.artifactId}`);
                expect(artifactStore.countBySession('victim')).toBe(1);

                expect(folder.needsResync).toBeNull();
                expect(folder.stats().digestMismatches).toBe(0);
                expect(folder.lastCommit()?.liveCount).toBe(1);
                expect(folder.view()?.messages).toHaveLength(1);
                expect(folder.view()?.messages[0].messageId).toBe(`artifact:${failedRes.artifactId}`);

                // Normal read_chat tick preserves the artifact bubble
                service.observe('victim', {
                    sessionId: 'victim',
                    providerType: 'claude-cli',
                    status: 'running',
                    providerObservedStatus: 'running',
                    messages: [
                        {
                            messageId: 'd.ep.1',
                            ord: 'a1',
                            srcId: null,
                            role: 'assistant',
                            kind: 'standard',
                            content: 'Published report',
                            bubbleState: 'final',
                        },
                    ],
                    coverage: { mode: 'full', omittedBefore: false },
                });
                await new Promise((resolve) => setImmediate(resolve));
                expect(folder.needsResync).toBeNull();
                expect(folder.stats().digestMismatches).toBe(0);
                expect(folder.lastCommit()?.liveCount).toBe(2);
            } finally {
                __resetTranscriptProjectionForTests();
            }
        });

        it('F2 delta: does not rebaseline root between store verification and the guarded reader when realpathSync races', async () => {
            sessionRegistry.register({
                sessionId: 'victim',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            fs.writeFileSync(path.join(workspaceA, 'private.md'), 'LOCAL-ARTIFACT-CONTENT-TEST-MARKER', 'utf8');
            const router = new DaemonCommandRouter(deps);
            const artifactId = artifactStore.register({
                sessionId: 'victim',
                workspaceRoot: workspaceA,
                path: 'private.md',
            }).record.artifactId;

            const real: any = await vi.importActual('node:fs');
            const pinned = real.realpathSync(workspaceA);
            const outside = path.join(tempRoot, 'outside-race');
            fs.mkdirSync(outside, { recursive: true });
            fs.writeFileSync(path.join(outside, 'private.md'), 'OUTSIDE-RACE-MARKER', 'utf8');

            let count = 0;
            let swapped = false;
            vi.mocked(fs.realpathSync).mockImplementation(((target: any, ...args: any[]) => {
                const result = real.realpathSync(target, ...args);
                if ((String(target) === workspaceA || String(target) === pinned) && ++count === 2) {
                    fs.renameSync(workspaceA, path.join(tempRoot, 'old-workspace-a'));
                    fs.symlinkSync(outside, workspaceA, 'dir');
                    swapped = true;
                }
                return result;
            }) as any);

            try {
                const result = await router.execute(
                    'artifact_fetch',
                    { sessionId: 'victim', artifactId },
                    'p2p',
                    { peerId: 'peer-owner', ownerVerified: true },
                );
                expect(swapped).toBe(true);
                expect(result.success).toBe(false);
                expect(result.code).toBe('path_outside_workspace');
            } finally {
                vi.mocked(fs.realpathSync).mockImplementation(real.realpathSync);
            }
        });

        it('F3 delta: refuses a token naming an absent queue assignment and absent attempt', async () => {
            sessionRegistry.register({
                sessionId: 'worker',
                parentSessionId: null,
                providerType: 'codex-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            const router = new DaemonCommandRouter(deps);
            const missingToken = mintWorkerTaskToken({
                meshId: 'mesh',
                taskId: 'missing-task',
                sessionId: 'worker',
                attemptId: 'missing-attempt',
            });
            expect(meshStore.findAssignedBySession('mesh', 'worker')).toBeNull();
            expect(meshStore.turnStore().getAttempt('missing-attempt')).toBeNull();
            const res = await router.execute('artifact_list', { token: missingToken.token }, 'ipc');
            expect(res.success).toBe(false);
        });

        it('F3 delta: refuses an assigned token or bind with no corresponding real ledger attempt', async () => {
            sessionRegistry.register({
                sessionId: 'worker',
                parentSessionId: null,
                providerType: 'codex-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            const router = new DaemonCommandRouter(deps);
            const now = new Date().toISOString();
            meshStore.insertQueueEntry({
                id: 'task',
                meshId: 'mesh',
                message: 'fixture',
                status: 'assigned',
                assignedSessionId: 'worker',
                workspace: workspaceA,
                createdAt: now,
                updatedAt: now,
            } as any);
            const token = mintWorkerTaskToken({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
                attemptId: 'absent-attempt',
            });
            const bind = mintWorkerSessionBind({ meshId: 'mesh', sessionId: 'worker' });
            for (const credential of [{ token: token.token }, { bind: bind.bind }]) {
                const res = await router.execute('artifact_list', credential, 'ipc');
                expect(res.success).toBe(false);
            }
        });

        it('F3 delta: refuses a current real attempt whose queue assignment no longer exists', async () => {
            sessionRegistry.register({
                sessionId: 'worker',
                parentSessionId: null,
                providerType: 'codex-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            const router = new DaemonCommandRouter(deps);
            seedMeshAttempt({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
                attemptId: 'attempt-current',
                attemptNo: 0,
                stage: 'generating',
            });
            const token = mintWorkerTaskToken({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
                attemptId: 'attempt-current',
            });
            const res = await router.execute('artifact_list', { token: token.token }, 'ipc');
            expect(res.success).toBe(false);
        });

        it('F3 delta: rejects a terminal real attempt for all aliases with stale_attempt', async () => {
            sessionRegistry.register({
                sessionId: 'worker',
                parentSessionId: null,
                providerType: 'codex-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            fs.writeFileSync(path.join(workspaceA, 'private.md'), 'WORKER-CONTENT', 'utf8');
            const router = new DaemonCommandRouter(deps);
            const now = new Date().toISOString();
            meshStore.insertQueueEntry({
                id: 'task',
                meshId: 'mesh',
                message: 'fixture',
                status: 'assigned',
                assignedSessionId: 'worker',
                workspace: workspaceA,
                createdAt: now,
                updatedAt: now,
            } as any);
            seedMeshAttempt({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
                attemptId: 'terminal',
                attemptNo: 0,
                stage: 'completed',
            });
            const termToken = mintWorkerTaskToken({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
                attemptId: 'terminal',
            });
            const termBind = mintWorkerSessionBind({ meshId: 'mesh', sessionId: 'worker' });
            const ownedId = artifactStore.register({
                sessionId: 'worker',
                workspaceRoot: workspaceA,
                path: 'private.md',
            }).record.artifactId;
            for (const credential of [{ token: termToken.token }, { bind: termBind.bind }]) {
                for (const cmd of allAliases) {
                    const result = await router.execute(
                        cmd,
                        { ...credential, path: 'private.md', artifactId: ownedId },
                        'ipc',
                    );
                    expect(result.success).toBe(false);
                    expect(result.code).toBe('stale_attempt');
                }
            }
        });

        it('F3 delta: refuses task assignment to a different session even with a nonterminal token attempt', async () => {
            sessionRegistry.register({
                sessionId: 'victim',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            sessionRegistry.register({
                sessionId: 'worker',
                parentSessionId: null,
                providerType: 'codex-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            const router = new DaemonCommandRouter(deps);
            const now = new Date().toISOString();
            meshStore.insertQueueEntry({
                id: 'task',
                meshId: 'mesh',
                message: 'fixture',
                status: 'assigned',
                assignedSessionId: 'victim',
                workspace: workspaceA,
                createdAt: now,
                updatedAt: now,
            } as any);
            seedMeshAttempt({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
                attemptId: 'current',
                attemptNo: 0,
                stage: 'generating',
            });
            const crossSessToken = mintWorkerTaskToken({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
                attemptId: 'current',
            });
            const res = await router.execute('artifact_list', { token: crossSessToken.token }, 'ipc');
            expect(res.success).toBe(false);
            expect(res.code).toBe('artifact_session_mismatch');
        });

        it('F5 delta: reports unpublished (artifact_publication_failed) when the projection service is unavailable', async () => {
            sessionRegistry.register({
                sessionId: 'victim',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            fs.writeFileSync(path.join(workspaceA, 'private.md'), 'SECRET', 'utf8');
            const preId = artifactStore.register({
                sessionId: 'victim',
                workspaceRoot: workspaceA,
                path: 'private.md',
            }).record.artifactId;

            configureTranscriptProjection(null);
            const router = new DaemonCommandRouter(deps);
            const result = await router.execute(
                'artifact_register',
                { sessionId: 'victim', path: 'private.md' },
                'ipc',
            );
            expect(result.registered).toBe(true);
            expect(result.artifactId).toBe(preId);
            expect(result.success).toBe(false);
            expect(result.code).toBe('artifact_publication_failed');
            expect(result.published).toBe(false);
            expect(result.messageKey).toBeUndefined();
        });

        it('F3 delta2: requires queue attemptId to agree with the ledger even for an unscoped first-attempt token and bind', async () => {
            sessionRegistry.register({
                sessionId: 'worker',
                parentSessionId: null,
                providerType: 'codex-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            const router = new DaemonCommandRouter(deps);
            const now = new Date().toISOString();

            meshStore.insertQueueEntry({
                id: 'task',
                meshId: 'mesh',
                message: 'fixture',
                status: 'assigned',
                assignedSessionId: 'worker',
                workspace: workspaceA,
                attemptId: 'ledger-current',
                createdAt: now,
                updatedAt: now,
            } as any);
            seedMeshAttempt({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
                attemptId: 'ledger-current',
                attemptNo: 0,
                stage: 'generating',
            });

            const token = mintWorkerTaskToken({
                meshId: 'mesh',
                taskId: 'task',
                sessionId: 'worker',
            });
            const bind = mintWorkerSessionBind({
                meshId: 'mesh',
                sessionId: 'worker',
            });

            // Positive control: matching queue.attemptId and ledger.attemptId with unscoped first-attempt credentials
            for (const credentials of [{ token: token.token }, { bind: bind.bind }]) {
                const okRes = await router.execute('artifact_list', credentials, 'ipc');
                expect(okRes.success).toBe(true);
            }

            // Negative regression: queue.attemptId diverges from ledger.attemptId
            meshStore.db
                .prepare("UPDATE mesh_queue SET payload=json_set(payload, '$.attemptId', ?) WHERE mesh_id=? AND id=?")
                .run('queue-other', 'mesh', 'task');
            expect((meshStore.findQueueEntryById('mesh', 'task') as any).attemptId).toBe('queue-other');
            expect(meshStore.turnStore().findLatestAttemptForTask('mesh', 'task')?.attemptId).toBe('ledger-current');

            for (const credentials of [{ token: token.token }, { bind: bind.bind }]) {
                const deniedRes = await router.execute('artifact_list', credentials, 'ipc');
                expect(deniedRes.success).toBe(false);
                expect(deniedRes.code).toBe('stale_attempt');
            }
        });
    });

    describe('F1 shared-ingress foundation consumer & provenance enforcement', () => {
        const allAliases = [
            'artifact_register',
            'session_artifact_register',
            'artifact_list',
            'session_artifact_list',
            'artifact_fetch',
            'artifact_read',
            'session_artifact_fetch',
        ] as const;

        it('F1: rejects all 7 artifact aliases on unverified p2p/standalone, shared/unknown peer, inProcess, downgraded ipc, forged payload flags, and cloned _interactionId args before side effects or content read', async () => {
            sessionRegistry.register({
                sessionId: 'victim',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            fs.writeFileSync(path.join(workspaceA, 'private.md'), 'OWNER-ONLY-SECRET-MARKER', 'utf8');
            fs.writeFileSync(path.join(workspaceA, 'second.md'), 'SECOND-SECRET-MARKER', 'utf8');
            const router = new DaemonCommandRouter(deps);

            const ownedId = artifactStore.register({
                sessionId: 'victim',
                workspaceRoot: workspaceA,
                path: 'private.md',
            }).record.artifactId;

            const basePayload = {
                sessionId: 'victim',
                artifactId: ownedId,
                path: 'second.md',
            };

            // 1. Unverified p2p and standalone (missing opts, shared viewer, unknown peer, non-boolean ownerVerified, inProcess)
            const unverifiedCases: Array<{ source: string; opts?: any }> = [
                { source: 'p2p' },
                { source: 'p2p', opts: { peerId: 'peer-unknown' } },
                { source: 'p2p', opts: { peerId: 'peer-shared', ownerVerified: false } },
                { source: 'p2p', opts: { peerId: 'peer-owner', ownerVerified: false } },
                { source: 'p2p', opts: { peerId: 'peer-owner', ownerVerified: 'true' } },
                { source: 'p2p', opts: { peerId: 'peer-owner', ownerVerified: true, inProcess: true } },
                { source: 'standalone' },
                { source: 'standalone', opts: { ownerVerified: false } },
                { source: 'standalone', opts: { ownerVerified: 1 } },
                { source: 'standalone', opts: { ownerVerified: true, inProcess: true } },
                { source: 'ipc', opts: { ownerVerified: false } },
                { source: 'ipc', opts: { inProcess: true } },
            ];

            for (const { source, opts } of unverifiedCases) {
                for (const cmd of allAliases) {
                    const res = await router.execute(cmd, { ...basePayload }, source, opts);
                    expect(res.success, `${cmd} via ${source} (${JSON.stringify(opts)})`).toBe(false);
                    expect(res.code, `${cmd} via ${source} (${JSON.stringify(opts)})`).toBe('COMMAND_SOURCE_REJECTED');
                    expect(res.content).toBeUndefined();
                    expect(res.artifacts).toBeUndefined();
                }
            }

            // Ensure no side effects occurred (second.md was never registered)
            expect(artifactStore.listBySession('victim')).toHaveLength(1);

            // 2. Forged provenance fields in payload on unverified ipc/p2p/standalone
            const forgedPayloads = [
                { ...basePayload, ownerVerified: true },
                { ...basePayload, _ownerVerified: true },
                { ...basePayload, source: 'p2p' },
                { ...basePayload, _commandSource: 'p2p' },
            ];
            for (const payload of forgedPayloads) {
                for (const cmd of allAliases) {
                    const res = await router.execute(cmd, payload, 'ipc');
                    expect(res.success, `${cmd} with forged payload ${JSON.stringify(payload)}`).toBe(false);
                    expect(res.code).toBe('COMMAND_SOURCE_REJECTED');
                }
            }

            // 3. Direct handler invocation with cloned/spread router args (_interactionId without WeakMap stamp)
            for (const cmd of allAliases) {
                const clonedRouterArgs = {
                    ...basePayload,
                    _interactionId: 'itx_cloned_without_weakmap',
                    ownerVerified: true,
                    _ownerVerified: true,
                };
                const res = await (artifactHandlers as any)[cmd](ctx, clonedRouterArgs);
                expect(res.success, `direct ${cmd} with cloned _interactionId`).toBe(false);
                expect(res.code).toBe('COMMAND_SOURCE_REJECTED');
            }
        });

        it('F1: enforces live foundation proof lifecycle and immediate revocation across all 7 artifact aliases and get_command_history', async () => {
            sessionRegistry.register({
                sessionId: 'victim',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            fs.writeFileSync(path.join(workspaceA, 'private.md'), 'LIVE-PROOF-CONTENT', 'utf8');
            const router = new DaemonCommandRouter(deps);

            let p2pLive = true;
            const p2pProof = issueTrustedOwnerIngressProof({
                source: 'p2p',
                peerId: 'peer-owner',
                ownerVerified: true,
                verifyCurrent: () => p2pLive,
            });
            expect(p2pProof).not.toBeNull();

            let standaloneLive = true;
            const standaloneProof = issueTrustedOwnerIngressProof({
                source: 'standalone',
                ownerVerified: true,
                verifyCurrent: () => standaloneLive,
            });
            expect(standaloneProof).not.toBeNull();

            // Positive controls across all 7 aliases with live owner proofs (both p2p and standalone)
            for (const regAlias of ['artifact_register', 'session_artifact_register'] as const) {
                const p2pReg = await router.execute(
                    regAlias,
                    attachTrustedOwnerIngressProof({ sessionId: 'victim', path: 'private.md' }, p2pProof),
                    'p2p',
                    { peerId: 'peer-owner', ownerVerified: true, ownerProof: p2pProof },
                );
                expect(p2pReg.success, `${regAlias} p2p live`).toBe(true);
            }
            const artifactId = artifactStore.listBySession('victim')[0].artifactId;

            for (const listAlias of ['artifact_list', 'session_artifact_list'] as const) {
                const saList = await router.execute(
                    listAlias,
                    attachTrustedOwnerIngressProof({ sessionId: 'victim' }, standaloneProof),
                    'standalone',
                    { ownerVerified: true, ownerProof: standaloneProof },
                );
                expect(saList.success, `${listAlias} standalone live`).toBe(true);
                expect((saList.artifacts as any[])[0].artifactId).toBe(artifactId);
            }

            for (const fetchAlias of ['artifact_fetch', 'artifact_read', 'session_artifact_fetch'] as const) {
                const p2pFetch = await router.execute(
                    fetchAlias,
                    attachTrustedOwnerIngressProof({ sessionId: 'victim', artifactId }, p2pProof),
                    'p2p',
                    { peerId: 'peer-owner', ownerVerified: true, ownerProof: p2pProof },
                );
                expect(p2pFetch.success, `${fetchAlias} p2p live`).toBe(true);
                expect(p2pFetch.content).toBe(
                    fetchAlias === 'artifact_read'
                        ? wrapUntrustedArtifactContent('LIVE-PROOF-CONTENT')
                        : 'LIVE-PROOF-CONTENT',
                );
            }

            // Cross-source proof mismatch must fail closed even while proofs are live
            for (const cmd of allAliases) {
                const crossRes = await router.execute(
                    cmd,
                    attachTrustedOwnerIngressProof({ sessionId: 'victim', artifactId, path: 'private.md' }, standaloneProof),
                    'p2p',
                    { peerId: 'peer-owner', ownerVerified: true, ownerProof: standaloneProof },
                );
                expect(crossRes.success, `${cmd} cross-source standalone proof on p2p`).toBe(false);
                expect(crossRes.code).toBe('COMMAND_SOURCE_REJECTED');
            }

            // Pre-mark and copy args while proof is still live, then revoke proof (epoch rotation / disconnect / logout)
            const markedWhileLive = markTrustedOwnerIngress(
                { sessionId: 'victim', artifactId, path: 'private.md' },
                p2pProof,
            );
            const copiedWhileLive = preserveTrustedOwnerIngress(markedWhileLive, { ...markedWhileLive });
            expect(isTrustedOwnerIngress(markedWhileLive, 'p2p')).toBe(true);
            expect(isTrustedOwnerIngress(copiedWhileLive, 'p2p')).toBe(true);

            p2pLive = false;
            standaloneLive = false;
            expect(isTrustedOwnerIngress(markedWhileLive, 'p2p')).toBe(false);
            expect(isTrustedOwnerIngress(copiedWhileLive, 'p2p')).toBe(false);

            // Revoked proofs must fail closed across all 7 aliases on p2p, standalone, ipc fallthrough, and direct handler call
            for (const cmd of allAliases) {
                const revokedP2p = await router.execute(
                    cmd,
                    attachTrustedOwnerIngressProof({ sessionId: 'victim', artifactId, path: 'private.md' }, p2pProof),
                    'p2p',
                    { peerId: 'peer-owner', ownerVerified: true, ownerProof: p2pProof },
                );
                expect(revokedP2p.success, `${cmd} revoked p2p`).toBe(false);
                expect(revokedP2p.code).toBe('COMMAND_SOURCE_REJECTED');

                const revokedSa = await router.execute(
                    cmd,
                    attachTrustedOwnerIngressProof({ sessionId: 'victim', artifactId, path: 'private.md' }, standaloneProof),
                    'standalone',
                    { ownerVerified: true, ownerProof: standaloneProof },
                );
                expect(revokedSa.success, `${cmd} revoked standalone`).toBe(false);
                expect(revokedSa.code).toBe('COMMAND_SOURCE_REJECTED');

                const revokedIpcFallthrough = await router.execute(cmd, copiedWhileLive, 'ipc');
                expect(revokedIpcFallthrough.success, `${cmd} revoked proof ipc fallthrough`).toBe(false);
                expect(revokedIpcFallthrough.code).toBe('COMMAND_SOURCE_REJECTED');

                const directRevoked = await (artifactHandlers as any)[cmd](ctx, copiedWhileLive);
                expect(directRevoked.success, `${cmd} direct handler with revoked proof`).toBe(false);
                expect(directRevoked.code).toBe('COMMAND_SOURCE_REJECTED');
            }
        });

        it('F1: enforces worker/coordinator MCP IPC provenance while preserving legitimate worker and coordinator flows', async () => {
            sessionRegistry.register({
                sessionId: 'victim',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            sessionRegistry.register({
                sessionId: 'coord-sess',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            sessionRegistry.register({
                sessionId: 'worker-sess',
                parentSessionId: 'coord-sess',
                providerType: 'codex-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            sessionRegistry.register({
                sessionId: 'foreign-sess',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceB,
            });
            fs.writeFileSync(path.join(workspaceA, 'report.md'), 'WORKER-REPORT-CONTENT', 'utf8');
            fs.writeFileSync(path.join(workspaceB, 'foreign.md'), 'FOREIGN-SECRET-CONTENT', 'utf8');

            const router = new DaemonCommandRouter(deps);
            const now = new Date().toISOString();
            meshStore.insertQueueEntry({
                id: 'task-1',
                meshId: 'mesh-1',
                message: 'implement feature',
                status: 'assigned',
                assignedSessionId: 'worker-sess',
                attemptId: 'att-1',
                workspace: workspaceA,
                createdAt: now,
                updatedAt: now,
            } as any);
            seedMeshAttempt({
                meshId: 'mesh-1',
                taskId: 'task-1',
                sessionId: 'worker-sess',
                attemptId: 'att-1',
                attemptNo: 0,
                stage: 'generating',
            });

            const workerToken = mintWorkerTaskToken({
                meshId: 'mesh-1',
                taskId: 'task-1',
                sessionId: 'worker-sess',
                attemptId: 'att-1',
            });
            const workerBind = mintWorkerSessionBind({
                meshId: 'mesh-1',
                sessionId: 'worker-sess',
            });

            const foreignArtId = artifactStore.register({
                sessionId: 'foreign-sess',
                workspaceRoot: workspaceB,
                path: 'foreign.md',
            }).record.artifactId;

            // Positive control 1: Legitimate worker MCP IPC across all 7 aliases (both token and bind)
            for (const cred of [{ token: workerToken.token }, { bind: workerBind.bind }]) {
                for (const regAlias of ['artifact_register', 'session_artifact_register'] as const) {
                    const reg = await router.execute(regAlias, { ...cred, path: 'report.md' }, 'ipc');
                    expect(reg.success, `worker ${regAlias}`).toBe(true);
                }
                const workerArtId = artifactStore.listBySession('worker-sess')[0].artifactId;
                for (const listAlias of ['artifact_list', 'session_artifact_list'] as const) {
                    const list = await router.execute(listAlias, { ...cred }, 'ipc');
                    expect(list.success, `worker ${listAlias}`).toBe(true);
                    expect((list.artifacts as any[])[0].artifactId).toBe(workerArtId);
                }
                for (const fetchAlias of ['artifact_fetch', 'artifact_read', 'session_artifact_fetch'] as const) {
                    const fetched = await router.execute(fetchAlias, { ...cred, artifactId: workerArtId }, 'ipc');
                    expect(fetched.success, `worker ${fetchAlias}`).toBe(true);
                    expect(fetched.content).toBe(
                        fetchAlias === 'artifact_read'
                            ? wrapUntrustedArtifactContent('WORKER-REPORT-CONTENT')
                            : 'WORKER-REPORT-CONTENT',
                    );
                }
            }

            // Negative control 1: Unauthenticated IPC cannot fetch/read artifact content without worker credential or owner proof
            const workerArtId = artifactStore.listBySession('worker-sess')[0].artifactId;
            for (const fetchAlias of ['artifact_fetch', 'artifact_read', 'session_artifact_fetch'] as const) {
                const bareFetch = await router.execute(
                    fetchAlias,
                    { sessionId: 'worker-sess', artifactId: workerArtId },
                    'ipc',
                );
                expect(bareFetch.success, `bare ipc ${fetchAlias}`).toBe(false);
                expect(bareFetch.code).toBe('COMMAND_SOURCE_REJECTED');
                expect(bareFetch.content).toBeUndefined();

                const forgedCoordFetch = await router.execute(
                    fetchAlias,
                    {
                        sessionId: 'foreign-sess',
                        callerSessionId: 'coord-sess',
                        meshId: 'mesh-1',
                        artifactId: foreignArtId,
                    },
                    'ipc',
                );
                expect(forgedCoordFetch.success, `forged coordinator ipc ${fetchAlias}`).toBe(false);
                expect(forgedCoordFetch.code).toBe('COMMAND_SOURCE_REJECTED');
            }

            // Negative control 2: Unauthenticated IPC cannot list artifacts without meshId or worker credential
            for (const listAlias of ['artifact_list', 'session_artifact_list'] as const) {
                const bareList = await router.execute(listAlias, { sessionId: 'foreign-sess' }, 'ipc');
                expect(bareList.success, `bare ipc ${listAlias}`).toBe(false);
                expect(bareList.code).toBe('COMMAND_SOURCE_REJECTED');
            }

            // Positive control 2: Registered coordinator MCP IPC can list its own session and mesh-authorized worker session
            registerMeshCoordinator({
                meshId: 'mesh-1',
                sessionId: 'coord-sess',
                workspace: workspaceA,
            });
            try {
                for (const listAlias of ['artifact_list', 'session_artifact_list'] as const) {
                    const coordWorkerList = await router.execute(
                        listAlias,
                        {
                            sessionId: 'worker-sess',
                            meshId: 'mesh-1',
                        },
                        'ipc',
                    );
                    expect(coordWorkerList.success, `coordinator ${listAlias} worker-sess`).toBe(true);
                    expect((coordWorkerList.artifacts as any[])[0].artifactId).toBe(workerArtId);

                    const coordSelfList = await router.execute(
                        listAlias,
                        {
                            sessionId: 'coord-sess',
                            callerSessionId: 'coord-sess',
                            meshId: 'mesh-1',
                        },
                        'ipc',
                    );
                    expect(coordSelfList.success, `coordinator ${listAlias} coord-sess`).toBe(true);
                }

                // Negative control 3: Coordinator cannot list foreign session outside mesh-1 or with mismatched callerSessionId
                for (const listAlias of ['artifact_list', 'session_artifact_list'] as const) {
                    const foreignList = await router.execute(
                        listAlias,
                        {
                            sessionId: 'foreign-sess',
                            meshId: 'mesh-1',
                        },
                        'ipc',
                    );
                    expect(foreignList.success, `coordinator ${listAlias} foreign-sess`).toBe(false);
                    expect(foreignList.code).toBe('artifact_session_mismatch');

                    const spoofedCallerList = await router.execute(
                        listAlias,
                        {
                            sessionId: 'worker-sess',
                            callerSessionId: 'foreign-sess',
                            meshId: 'mesh-1',
                        },
                        'ipc',
                    );
                    expect(spoofedCallerList.success, `spoofed caller ${listAlias}`).toBe(false);
                    expect(spoofedCallerList.code).toBe('artifact_session_mismatch');
                }

                // Negative control 4: Unauthenticated IPC register with forged taskId / meshId / callerSessionId
                for (const regAlias of ['artifact_register', 'session_artifact_register'] as const) {
                    const forgedTaskReg = await router.execute(
                        regAlias,
                        {
                            sessionId: 'victim',
                            taskId: 'task-1',
                            meshId: 'mesh-1',
                            path: 'report.md',
                        },
                        'ipc',
                    );
                    expect(forgedTaskReg.success, `${regAlias} forged taskId`).toBe(false);
                    expect(forgedTaskReg.code).toBe('task_mismatch');

                    const forgedCallerReg = await router.execute(
                        regAlias,
                        {
                            sessionId: 'victim',
                            callerSessionId: 'coord-sess',
                            meshId: 'mesh-1',
                            path: 'report.md',
                        },
                        'ipc',
                    );
                    expect(forgedCallerReg.success, `${regAlias} forged callerSessionId`).toBe(false);
                    expect(forgedCallerReg.code).toBe('artifact_session_mismatch');
                }
            } finally {
                unregisterMeshCoordinator('coord-sess');
            }
        });
    });

    describe('Mission b295ce35 — Artifact sharing (OD-4, Coordinator, Defects 1 & 2, P2P origin fetch, Content boundary)', () => {
        it('OD-4: allows a worker to read another session artifact only in the same mission AND listed in inputArtifactIds; denies unlisted or cross-mission artifacts', async () => {
            sessionRegistry.register({
                sessionId: 'sess-worker-a',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            sessionRegistry.register({
                sessionId: 'sess-worker-b',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceB,
            });

            // Worker A produces two artifacts in mission-od4
            fs.writeFileSync(path.join(workspaceA, 'shared-spec.md'), '# Shared Spec\nLine 1\nLine 2\n');
            fs.writeFileSync(path.join(workspaceA, 'unlisted-notes.md'), '# Private Notes\nDo not share\n');

            const nowIso = new Date().toISOString();
            meshStore.insertQueueEntry({
                id: 'task-od4-a',
                meshId: 'mesh-od4',
                targetNodeId: 'node-a',
                status: 'assigned',
                assignedSessionId: 'sess-worker-a',
                message: 'Produce spec',
                workspace: workspaceA,
                missionId: 'mission-od4',
                createdAt: nowIso,
                updatedAt: nowIso,
            } as any);
            seedMeshAttempt({
                attemptId: 'att-od4-a',
                taskId: 'task-od4-a',
                meshId: 'mesh-od4',
                nodeId: 'node-a',
                sessionId: 'sess-worker-a',
                attemptNo: 0,
                stage: 'generating',
            });
            const bindA = mintWorkerSessionBind({
                sessionId: 'sess-worker-a',
                meshId: 'mesh-od4',
                nodeId: 'node-a',
                spawnedForTaskId: 'task-od4-a',
            });
            const tokenA = mintWorkerTaskToken({
                taskId: 'task-od4-a',
                attemptId: 'att-od4-a',
                meshId: 'mesh-od4',
                nodeId: 'node-a',
                sessionId: 'sess-worker-a',
            });

            const regShared = await artifactHandlers.artifact_register(ctx, {
                path: 'shared-spec.md',
                title: 'Shared Spec',
                bind: bindA.bind,
                token: tokenA.token,
            });
            expect(regShared.success).toBe(true);

            const regUnlisted = await artifactHandlers.artifact_register(ctx, {
                path: 'unlisted-notes.md',
                title: 'Unlisted Notes',
                bind: bindA.bind,
                token: tokenA.token,
            });
            expect(regUnlisted.success).toBe(true);

            // Worker B is in the SAME mission (mission-od4) and coordinator named regShared.artifactId in inputArtifactIds
            meshStore.insertQueueEntry({
                id: 'task-od4-b',
                meshId: 'mesh-od4',
                targetNodeId: 'node-b',
                status: 'assigned',
                assignedSessionId: 'sess-worker-b',
                message: 'Consume spec',
                workspace: workspaceB,
                missionId: 'mission-od4',
                inputArtifactIds: [regShared.artifactId],
                createdAt: nowIso,
                updatedAt: nowIso,
            } as any);
            seedMeshAttempt({
                attemptId: 'att-od4-b',
                taskId: 'task-od4-b',
                meshId: 'mesh-od4',
                nodeId: 'node-b',
                sessionId: 'sess-worker-b',
                attemptNo: 0,
                stage: 'generating',
            });
            const bindB = mintWorkerSessionBind({
                sessionId: 'sess-worker-b',
                meshId: 'mesh-od4',
                nodeId: 'node-b',
                spawnedForTaskId: 'task-od4-b',
            });
            const tokenB = mintWorkerTaskToken({
                taskId: 'task-od4-b',
                attemptId: 'att-od4-b',
                meshId: 'mesh-od4',
                nodeId: 'node-b',
                sessionId: 'sess-worker-b',
            });

            // ALLOW: Worker B reads regShared.artifactId
            const allowedRead = await artifactHandlers.artifact_read(ctx, {
                artifactId: regShared.artifactId,
                bind: bindB.bind,
                token: tokenB.token,
            });
            expect(allowedRead.success).toBe(true);
            expect(allowedRead.content).toContain('<untrusted_artifact_content>');
            expect(allowedRead.content).toContain('# Shared Spec\nLine 1\nLine 2');
            expect(allowedRead.content).toContain('</untrusted_artifact_content>');

            // DENY 1: Worker B tries to read regUnlisted.artifactId (same mission, but NOT in inputArtifactIds)
            const deniedUnlisted = await artifactHandlers.artifact_read(ctx, {
                artifactId: regUnlisted.artifactId,
                bind: bindB.bind,
                token: tokenB.token,
            });
            expect(deniedUnlisted.success).toBe(false);
            expect(deniedUnlisted.code).toBe('artifact_access_denied');

            // DENY 2: Worker C in a DIFFERENT mission tries to read regShared.artifactId even if inputArtifactIds lists it
            const workspaceC = path.join(tempRoot, 'workspace-c');
            fs.mkdirSync(workspaceC, { recursive: true });
            sessionRegistry.register({
                sessionId: 'sess-worker-c',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceC,
            });
            meshStore.insertQueueEntry({
                id: 'task-od4-c',
                meshId: 'mesh-od4',
                targetNodeId: 'node-c',
                status: 'assigned',
                assignedSessionId: 'sess-worker-c',
                message: 'Different mission worker',
                workspace: workspaceC,
                missionId: 'mission-different',
                inputArtifactIds: [regShared.artifactId],
                createdAt: nowIso,
                updatedAt: nowIso,
            } as any);
            seedMeshAttempt({
                attemptId: 'att-od4-c',
                taskId: 'task-od4-c',
                meshId: 'mesh-od4',
                nodeId: 'node-c',
                sessionId: 'sess-worker-c',
                attemptNo: 0,
                stage: 'generating',
            });
            const bindC = mintWorkerSessionBind({
                sessionId: 'sess-worker-c',
                meshId: 'mesh-od4',
                nodeId: 'node-c',
                spawnedForTaskId: 'task-od4-c',
            });
            const tokenC = mintWorkerTaskToken({
                taskId: 'task-od4-c',
                attemptId: 'att-od4-c',
                meshId: 'mesh-od4',
                nodeId: 'node-c',
                sessionId: 'sess-worker-c',
            });

            const deniedCrossMission = await artifactHandlers.artifact_read(ctx, {
                artifactId: regShared.artifactId,
                bind: bindC.bind,
                token: tokenC.token,
            });
            expect(deniedCrossMission.success).toBe(false);
            expect(deniedCrossMission.code).toBe('artifact_access_denied');
        });

        it('Defect 2: View full (artifact_fetch & artifact_read) succeeds after the producer session has ended by falling back to stored workspace_root', async () => {
            sessionRegistry.register({
                sessionId: 'sess-ended-1',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            fs.writeFileSync(path.join(workspaceA, 'postmortem.md'), '# Postmortem\nSession ended cleanly.\n');

            const reg = await artifactHandlers.artifact_register(ctx, {
                sessionId: 'sess-ended-1',
                path: 'postmortem.md',
                title: 'Postmortem',
            });
            expect(reg.success).toBe(true);

            // End and remove the session from the live SessionRegistry
            sessionRegistry.terminate('sess-ended-1', 'stop' as any);
            expect(sessionRegistry.get('sess-ended-1')).toBeUndefined();

            // "View full" via artifact_fetch for the ended session must still succeed using stored workspace_root
            const fetched = await artifactHandlers.artifact_fetch(ctx, {
                artifactId: reg.artifactId,
                sessionId: 'sess-ended-1',
            });
            expect(fetched.success).toBe(true);
            expect(fetched.content).toBe('# Postmortem\nSession ended cleanly.\n');

            // artifact_read wraps in <untrusted_artifact_content>
            const readRes = await artifactHandlers.artifact_read(ctx, {
                artifactId: reg.artifactId,
                sessionId: 'sess-ended-1',
            });
            expect(readRes.success).toBe(true);
            expect(readRes.content).toBe(
                '<untrusted_artifact_content>\n# Postmortem\nSession ended cleanly.\n\n</untrusted_artifact_content>',
            );
        });

        it('Defect 1 & Remote Worker P2P: remote worker registers locally without host DB rows, forwards metadata-only (artifact_index_forwarded) to host, and host fetches >16 KB content from origin over chunked MeshRpcEndpoint', async () => {
            const remoteDir = path.join(tempRoot, 'remote-daemon');
            const remoteWorkspace = path.join(remoteDir, 'wt-remote');
            fs.mkdirSync(remoteWorkspace, { recursive: true });

            // Write a ~80 KB markdown artifact so P2P fetch exercises multiple 16 KB MeshRpcEndpoint chunks (> 60 KB inline ceiling)
            const bodyBlock = 'Remote analysis paragraph with detailed telemetry data. '.repeat(20) + '\n';
            const largeMarkdown = '# Remote Worker Report\n' + bodyBlock.repeat(75);
            expect(Buffer.byteLength(largeMarkdown, 'utf8')).toBeGreaterThan(64 * 1024);
            fs.writeFileSync(path.join(remoteWorkspace, 'remote-report.md'), largeMarkdown);

            // Remote daemon has its OWN SQLite store with ZERO task/attempt rows (host owns the queue/attempt ledger)
            const remoteMeshStore = new MeshRuntimeStore(path.join(remoteDir, 'remote-mesh.db'));
            const remoteArtifactStore = new ArtifactStore(remoteMeshStore.db);
            const remoteSessionRegistry = new SessionRegistry();
            remoteSessionRegistry.register({
                sessionId: 'sess-remote-worker-1',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: remoteWorkspace,
            });

            // Host has the task & attempt row in its meshStore
            const nowIso = new Date().toISOString();
            meshStore.insertQueueEntry({
                id: 'task-remote-1',
                meshId: 'mesh-p2p-1',
                targetNodeId: 'node-remote-2',
                assignedNodeId: 'node-remote-2',
                status: 'assigned',
                assignedSessionId: 'sess-remote-worker-1',
                message: 'Remote investigation',
                workspace: remoteWorkspace,
                missionId: 'mission-p2p-1',
                createdAt: nowIso,
                updatedAt: nowIso,
            } as any);
            const seededAttempt = seedMeshAttempt({
                attemptId: 'att-remote-1',
                taskId: 'task-remote-1',
                meshId: 'mesh-p2p-1',
                nodeId: 'node-remote-2',
                sessionId: 'sess-remote-worker-1',
                attemptNo: 0,
                stage: 'generating',
            });
            meshStore.turnStore().upsertAttempt(
                {
                    ...seededAttempt,
                    ownerDaemonId: 'daemon_host_1',
                },
                Date.now(),
            );

            // Remote daemon minted bind + task token when spawning the worker locally
            const remoteBind = mintWorkerSessionBind({
                sessionId: 'sess-remote-worker-1',
                meshId: 'mesh-p2p-1',
                nodeId: 'node-remote-2',
                spawnedForTaskId: 'task-remote-1',
            });
            const remoteToken = mintWorkerTaskToken({
                taskId: 'task-remote-1',
                attemptId: 'att-remote-1',
                meshId: 'mesh-p2p-1',
                nodeId: 'node-remote-2',
                sessionId: 'sess-remote-worker-1',
            });

            // Defect 1 check: resolveWorkerIdentity against remoteMeshStore (which has no task/attempt rows!)
            const resolvedRemoteIdentity = resolveWorkerIdentity(
                remoteMeshStore,
                remoteBind.bind,
                remoteToken.token,
            );
            expect(resolvedRemoteIdentity).toMatchObject({
                sessionId: 'sess-remote-worker-1',
                taskId: 'task-remote-1',
                attemptId: 'att-remote-1',
                meshId: 'mesh-p2p-1',
                nodeId: 'node-remote-2',
            });

            // Wire two real MeshRpcEndpoint instances (host <-> remote worker daemon) over in-memory DataChannels
            class FakeRpcEndpoint extends MeshRpcEndpoint {
                constructor(
                    cb?: (sender: string, command: string, args: Record<string, unknown>) => Promise<unknown>,
                ) {
                    super();
                    this.commandCallback = cb;
                }
                protected failure(message: string): any {
                    return new Error(message);
                }
                protected noteRequestTimeout(): void {}
                protected emitPeerOpen(): void {}
                protected flushConnectQueue(): void {}
                public sendRpc(peer: any, id: string, command: string, args: Record<string, unknown>): Promise<any> {
                    return new Promise((resolve, reject) => {
                        this.writeRequest(peer, {
                            id,
                            command,
                            args,
                            resolve,
                            reject,
                            queuedAt: new Date().toISOString(),
                            resultTimeoutMs: 5000,
                        });
                    });
                }
                public deliverRaw(peer: any, raw: string): void {
                    this.onMessage(peer, raw);
                }
            }

            const rawFramesFromRemoteToHost: string[] = [];
            const rawFramesFromHostToRemote: string[] = [];
            const chunkFramesObserved: any[] = [];

            let hostEndpoint!: FakeRpcEndpoint;
            let remoteEndpoint!: FakeRpcEndpoint;

            const remoteDeps: CommandRouterDeps = {
                commandHandler: { handle: async () => ({ success: true }) } as any,
                cliManager: {} as any,
                cdpManagers: new Map(),
                providerLoader: {} as any,
                instanceManager: { getInstance: () => undefined } as any,
                detectedIdes: { value: [] },
                sessionRegistry: remoteSessionRegistry,
                statusInstanceId: 'daemon_remote_worker_2',
                dispatchMeshCommand: async (targetDaemonId: string, command: string, args: Record<string, unknown>) => {
                    expect(targetDaemonId).toBe('daemon_host_1');
                    return remoteEndpoint.sendRpc(hostPeerOnRemote, `rpc-r2h-${Date.now()}`, command, args);
                },
            };
            setArtifactCommandRuntimeForDeps(remoteDeps, {
                artifactStore: remoteArtifactStore,
                meshRuntimeStore: remoteMeshStore,
            });

            deps.statusInstanceId = 'daemon_host_1';
            deps.dispatchMeshCommand = async (targetDaemonId: string, command: string, args: Record<string, unknown>) => {
                expect(targetDaemonId).toBe('daemon_remote_worker_2');
                return hostEndpoint.sendRpc(remotePeerOnHost, `rpc-h2r-${Date.now()}`, command, args);
            };

            const sharedMeshTopology: any = {
                id: 'mesh-p2p-1',
                name: 'P2PMesh',
                meshHost: { role: 'member', hostDaemonId: 'daemon_host_1' },
                nodes: [
                    { id: 'node-host-1', daemonId: 'daemon_host_1', workspace: workspaceA, role: 'host' },
                    {
                        id: 'node-remote-2',
                        daemonId: 'daemon_remote_worker_2',
                        workspace: remoteWorkspace,
                        role: 'worker',
                        activeSessionId: 'sess-remote-worker-1',
                    },
                ],
            };

            const remoteCtx: ArtifactCommandContext = {
                deps: remoteDeps,
                getMeshForCommand: async () => sharedMeshTopology,
                getCachedInlineMesh: () => sharedMeshTopology,
            };
            const hostCtx: ArtifactCommandContext = {
                deps,
                getMeshForCommand: async () => ({
                    ...sharedMeshTopology,
                    meshHost: { role: 'host', hostDaemonId: 'daemon_host_1' },
                }),
                getCachedInlineMesh: () => ({
                    ...sharedMeshTopology,
                    meshHost: { role: 'host', hostDaemonId: 'daemon_host_1' },
                }),
            };

            hostEndpoint = new FakeRpcEndpoint(async (senderDaemonId, command, args) => {
                if (command === 'artifact_index_forwarded') {
                    return (artifactHandlers as any).artifact_index_forwarded(
                        hostCtx,
                        { ...args, [MESH_SENDER_DAEMON_ID_ARG]: senderDaemonId },
                    );
                }
                throw new Error(`Unexpected command on host: ${command}`);
            });

            remoteEndpoint = new FakeRpcEndpoint(async (senderDaemonId, command, args) => {
                if (command === 'artifact_fetch_origin') {
                    return (artifactHandlers as any).artifact_fetch_origin(
                        remoteCtx,
                        { ...args, [MESH_SENDER_DAEMON_ID_ARG]: senderDaemonId },
                    );
                }
                throw new Error(`Unexpected command on remote: ${command}`);
            });

            const hostPeerOnRemote: any = {
                daemonId: 'daemon_host_1',
                inflight: new Map(),
                attempt: 1,
                dc: {
                    isOpen: () => true,
                    sendMessage: (json: string) => {
                        rawFramesFromRemoteToHost.push(json);
                        const parsed = JSON.parse(json);
                        if (parsed.kind === 'rpc_chunk') chunkFramesObserved.push(parsed);
                        queueMicrotask(() => hostEndpoint.deliverRaw(remotePeerOnHost, json));
                    },
                },
            };
            const remotePeerOnHost: any = {
                daemonId: 'daemon_remote_worker_2',
                inflight: new Map(),
                attempt: 1,
                dc: {
                    isOpen: () => true,
                    sendMessage: (json: string) => {
                        rawFramesFromHostToRemote.push(json);
                        const parsed = JSON.parse(json);
                        if (parsed.kind === 'rpc_chunk') chunkFramesObserved.push(parsed);
                        queueMicrotask(() => remoteEndpoint.deliverRaw(hostPeerOnRemote, json));
                    },
                },
            };

            try {
                // 1) Remote worker registers the artifact on remote daemon
                const remoteReg = await artifactHandlers.artifact_register(remoteCtx, {
                    path: 'remote-report.md',
                    title: 'Remote Report',
                    bind: remoteBind.bind,
                    token: remoteToken.token,
                });
                expect({
                    success: remoteReg.success,
                    code: remoteReg.code,
                    error: remoteReg.error,
                }).toEqual({
                    success: true,
                    code: undefined,
                    error: undefined,
                });

                // Metadata was forwarded to host via artifact_index_forwarded, without sending the full file body
                const forwardedFrames = rawFramesFromRemoteToHost.filter((f) => f.includes('artifact_index_forwarded'));
                expect(forwardedFrames.length).toBe(1);
                expect(forwardedFrames[0]).not.toContain(bodyBlock.repeat(5));

                const hostRecord = artifactStore.get(remoteReg.artifactId);
                expect(hostRecord).not.toBeNull();
                expect((hostRecord as any)?.originDaemonId).toBe('daemon_remote_worker_2');
                expect((hostRecord as any)?.missionId).toBe('mission-p2p-1');
                expect((hostRecord as any)?.meshId).toBe('mesh-p2p-1');

                // 2) Host coordinator reads the remote-origin artifact; host fetches from origin over P2P (16 KB chunks)
                registerMeshCoordinator({
                    meshId: 'mesh-p2p-1',
                    sessionId: 'coord-p2p-1',
                    workspace: workspaceA,
                    startedAt: Date.now(),
                    cliType: 'claude-cli',
                });
                const hostRead = await artifactHandlers.artifact_read(hostCtx, {
                    artifactId: remoteReg.artifactId,
                    callerSessionId: 'coord-p2p-1',
                    meshId: 'mesh-p2p-1',
                });
                expect(hostRead.success).toBe(true);
                expect(hostRead.content).toContain('<untrusted_artifact_content>');
                expect(hostRead.content).toContain(largeMarkdown);
                expect(hostRead.content).toContain('</untrusted_artifact_content>');
                // Verify the response was split into multiple 16 KB mesh_chunk frames over MeshRpcEndpoint
                expect(chunkFramesObserved.length).toBeGreaterThanOrEqual(2);
            } finally {
                unregisterMeshCoordinator('coord-p2p-1');
                remoteMeshStore.close();
            }
        });

        it('Content boundary: status and transcript observation payloads never carry full artifact bytes beyond previewText', async () => {
            sessionRegistry.register({
                sessionId: 'sess-boundary-1',
                parentSessionId: null,
                providerType: 'claude-cli',
                transport: 'pty',
                workspace: workspaceA,
            });
            const secretSentinel = 'SENTINEL_FULL_BODY_NEVER_ON_STATUS_PATH_' + 'X'.repeat(2000);
            const fileContent = 'Short header line.\n'.repeat(40) + secretSentinel;
            expect(fileContent.length).toBeGreaterThan(2600);
            fs.writeFileSync(path.join(workspaceA, 'boundary.md'), fileContent);

            const reg = await artifactHandlers.artifact_register(ctx, {
                sessionId: 'sess-boundary-1',
                path: 'boundary.md',
                title: 'Boundary Check',
            });
            expect(reg.success).toBe(true);
            expect(reg.attachment.previewText?.length).toBeLessThanOrEqual(600);
            expect(JSON.stringify(reg.attachment)).not.toContain('SENTINEL_FULL_BODY_NEVER_ON_STATUS_PATH_');
            // Even when wrapped in <untrusted_artifact_content>, artifact_read is an explicit fetch verb, never status
            const readRes = await artifactHandlers.artifact_read(ctx, {
                sessionId: 'sess-boundary-1',
                artifactId: reg.artifactId,
            });
            expect(readRes.content).toContain('<untrusted_artifact_content>');

            const listRes = await artifactHandlers.artifact_list(ctx, {
                sessionId: 'sess-boundary-1',
            });
            expect(listRes.success).toBe(true);
            expect(JSON.stringify(listRes)).not.toContain('SENTINEL_FULL_BODY_NEVER_ON_STATUS_PATH_');
        });
    });
});
