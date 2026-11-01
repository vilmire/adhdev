/**
 * Mission ed23a6a1 — owner-uploaded images reach a project as artifacts.
 *
 *  1. dashboard upload → staged artifact id visible in what the assistant is sent
 *     (real handleSendChat, trusted owner proof, bound assistant session)
 *  2. attach on project_send (local project): committed, mesh-bound, id in the coordinator text
 *  3. refusals: unauthenticated caller, foreign/unknown/expired/forged ids, missing messageId
 *  4. remote host over a FAKE transport that runs the real host handler
 *     (`assistant_remote_project` send): host commits its own copy, no bytes in the result
 *  5. read ACL: assistant artifact read is mesh-scoped
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testConfigDir = join(tmpdir(), `adhdev-owner-upload-e2e-${randomUUID().slice(0, 8)}`, '.adhdev');
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));
const assistantSession = { sid: 'assistant-session-1' };
vi.mock('../../src/assistant/assistant-registry.js', () => ({
    getAssistantRegistry: () => ({ read: () => ({ sessionId: assistantSession.sid }), reload: () => ({ sessionId: assistantSession.sid }) }),
}));

import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { assistantProjectHandlers, localArtifactRead } from '../../src/commands/high-family/assistant.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js';
import { handleSendChat } from '../../src/commands/chat-commands.js';
import { COMMAND_SOURCE_ARG, issueTrustedOwnerIngressProof, markTrustedOwnerIngress } from '../../src/commands/command-args.js';
import { __resetMcpSessionCredentialsForTest, mintMcpSessionCredential } from '../../src/commands/mcp-command-ingress.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { stageOwnerUploads } from '../../src/artifacts/owner-upload.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js';
import { loadMeshConfig, saveMeshConfig } from '../../src/config/mesh-config-store.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
);
const SELF = 'daemon_mach_assistant00001';
const HOST = 'daemon_mach_host0000000001';
const MESH = 'mesh_up_a';
const MESH_OTHER = 'mesh_up_b';

let hostedHere = true;
let remote = false;
let sent: Array<Record<string, any>>;
let callHost: ReturnType<typeof vi.fn>;
let hostAnswer: ((op: string, args: any) => any) | null;
const db = () => MeshRuntimeStore.getInstance().db;
const artifacts = () => new ArtifactStore(db());

function meshEntry(id = MESH): LocalMeshEntry {
    return {
        id, name: 'Blog', repoIdentity: `github.com/acme/${id}`,
        ...(remote ? { meshHost: { role: 'host', hostDaemonId: HOST } } : {}),
        nodes: [{ id: 'n-host', workspace: '/w', daemonId: remote ? HOST : SELF, role: 'host' }, { id: 'n-asst', workspace: '/a', daemonId: SELF }],
    } as unknown as LocalMeshEntry;
}

function stage(ownerMessageId = 'owner-msg-1', sid = assistantSession.sid): string {
    const r = stageOwnerUploads(artifacts(), { rootDir: join(testConfigDir, 'owner-uploads'), assistantSessionId: sid, ownerMessageId, images: [{ index: 0, mimeType: 'image/png', data: PNG.toString('base64') }] });
    return r.imported[0].artifactId;
}
const authed = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    assistantSessionId: assistantSession.sid,
    mcpSessionCredential: mintMcpSessionCredential({ sessionId: assistantSession.sid, isCoordinator: false }),
    ...extra,
});
const send = (args: Record<string, unknown>) => assistantProjectHandlers[ASSISTANT_VERB.projectSend]({} as any, args);

function installPorts(): void {
    const ports = {
        selfDaemonId: () => (hostedHere ? (remote ? HOST : SELF) : SELF),
        listMeshes: () => [meshEntry(), meshEntry(MESH_OTHER)],
        isHostedHere: () => hostedHere,
        aliases: () => ({}),
        coordinators: () => [{ sessionId: 'coord-1', idle: true, modalParked: false, managedByAssistant: true }],
        lastCoordinatorSessionId: () => 'coord-1',
        queueCounts: () => ({ pending: 0, assigned: 0, failed: 0 }),
        activeMissionCount: () => 0,
        pendingApprovals: () => 0,
        relay: { openThread: vi.fn(), isThreadOpen: () => false, lastRelayAt: () => 0, remoteSent: vi.fn(), assistantSessionId: () => assistantSession.sid },
        execute: vi.fn(async (cmd: string, a: any) => { if (cmd === 'send_chat') sent.push(a); return { success: true }; }) as any,
        remoteHost: () => ({ label: 'host-box', hostDaemonId: HOST, hostMeshId: MESH, reachable: true }),
        callHost: callHost as any,
        coordinatorTurns: () => ({ open: false, committed: [] }),
        meshStatusLine: () => null,
    };
    setAssistantProjectPortsForTests(() => ports as unknown as AssistantProjectPorts);
}

beforeEach(() => {
    sent = [];
    hostedHere = true;
    remote = false;
    hostAnswer = null;
    saveMeshConfig({ ...loadMeshConfig(), meshes: [meshEntry(), meshEntry(MESH_OTHER)] as any });
    setAssistantServicesForTests(createAssistantServices({ configDir: testConfigDir, listMeshes: () => [meshEntry(), meshEntry(MESH_OTHER)] }));
    const hostHandler = getDaemonCommandRegistry().get('assistant_remote_project')!.run as any;
    // The fake transport: route the sender's call into the REAL host handler as the host daemon.
    callHost = vi.fn(async (_target: unknown, op: string, args: Record<string, unknown>) => {
        if (hostAnswer) return hostAnswer(op, args);
        hostedHere = true;
        try {
            const result = await hostHandler({} as any, { meshId: MESH, op, ...args, [MESH_SENDER_DAEMON_ID_ARG]: SELF });
            return result.success === true ? { ok: true, result } : { ok: false, kind: 'refused', code: result.code, error: result.error, result };
        } finally { hostedHere = false; }
    });
    installPorts();
});
afterEach(() => {
    setAssistantProjectPortsForTests(null);
    setAssistantServicesForTests(null);
    __resetMcpSessionCredentialsForTest();
    MeshRuntimeStore.resetForTests();
    try { rmSync(dirname(testConfigDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('dashboard upload → artifact id visible in the assistant chat', () => {
    function chatFixture() {
        const sessionId = assistantSession.sid;
        const sendMessage = vi.fn(async (): Promise<any> => ({ status: 'delivered' }));
        const instance = Object.create(CliProviderInstance.prototype) as any;
        const provider = { type: 'hermes-cli', category: 'cli', capabilities: { input: { multipart: true, mediaTypes: ['text', 'image'] } } };
        const adapter = { cliType: 'hermes-cli', sendMessage, getScriptParsedStatus: () => null, getStatus: () => ({ status: 'idle' }) };
        Object.assign(instance, { category: 'cli', type: 'hermes-cli', provider, adapter, instanceId: sessionId, workingDir: '/tmp/owner-upload', runtimeMessages: [], recentUserInputAcks: new Map(), historyWriter: { appendNewMessages: vi.fn() } });
        const helpers = {
            getProvider: () => provider, getCliAdapter: () => adapter,
            currentSession: { sessionId, transport: 'pty', providerType: 'hermes-cli' },
            ctx: { adapters: new Map([[sessionId, adapter]]), instanceManager: { getInstance: (key: string) => (key === sessionId ? instance : null) } },
        } as any;
        const input = { parts: [{ type: 'text', text: 'see this' }, { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }], textFallback: 'see this' };
        const trusted = (extra: Record<string, unknown> = {}) => {
            const args: Record<string, unknown> = { targetSessionId: sessionId, input, messageId: `msg_${randomUUID().slice(0, 6)}`, [COMMAND_SOURCE_ARG]: 'p2p', ...extra };
            return markTrustedOwnerIngress(args, issueTrustedOwnerIngressProof({ source: 'p2p', ownerVerified: true, peerId: 'owner-peer' }));
        };
        return { helpers, sendMessage, trusted, input };
    }

    it('stages the image and tells the assistant its artifact id', async () => {
        const { helpers, sendMessage, trusted } = chatFixture();
        const args = trusted();
        const result = await handleSendChat(helpers, args);
        expect(result).toMatchObject({ success: true });
        const delivered = JSON.stringify(sendMessage.mock.calls);
        const staged = artifacts().listBySession(`owner-upload:${assistantSession.sid}:${args.messageId}`);
        expect(staged).toHaveLength(1);
        expect(staged[0]).toMatchObject({ kind: 'image', producerRole: 'user', mime: 'image/png' });
        expect(staged[0].meshId ?? null).toBeNull();
        expect(delivered).toContain(staged[0].artifactId);
        expect(delivered).toContain('project_send');
    });

    it('does not stage for a forged source, a missing owner proof, or another session', async () => {
        const { helpers, sendMessage, trusted, input } = chatFixture();
        // Payload-only source claim, no live proof.
        await handleSendChat(helpers, { targetSessionId: assistantSession.sid, input, messageId: 'forged', [COMMAND_SOURCE_ARG]: 'p2p' });
        expect(JSON.stringify(sendMessage.mock.calls)).not.toContain('Owner upload');
        expect(artifacts().listBySession(`owner-upload:${assistantSession.sid}:forged`)).toHaveLength(0);
        // Owner proof but the target is not the bound assistant session.
        const other = chatFixture();
        const registryOther = { ...other.helpers, currentSession: { sessionId: 'other', transport: 'pty', providerType: 'hermes-cli' } };
        const a = trusted({ targetSessionId: 'other' });
        await handleSendChat({ ...registryOther, ctx: { adapters: new Map([['other', other.helpers.getCliAdapter()]]), instanceManager: { getInstance: () => null } } }, a).catch(() => undefined);
        expect(artifacts().listBySession(`owner-upload:other:${a.messageId}`)).toHaveLength(0);
        expect(artifacts().listBySession(`owner-upload:${assistantSession.sid}:${a.messageId}`)).toHaveLength(0);
    });

    it('a refused image never blocks the chat and is reported to the assistant', async () => {
        const { helpers, sendMessage } = chatFixture();
        const bad = { parts: [{ type: 'image', mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }], textFallback: 'x' };
        const args = markTrustedOwnerIngress({ targetSessionId: assistantSession.sid, input: bad, messageId: 'm-bad', [COMMAND_SOURCE_ARG]: 'p2p' } as Record<string, unknown>, issueTrustedOwnerIngressProof({ source: 'p2p', ownerVerified: true, peerId: 'owner-peer' }));
        await expect(handleSendChat(helpers, args)).resolves.toMatchObject({ success: true });
        expect(JSON.stringify(sendMessage.mock.calls)).toContain('upload_unsupported_type');
    });
});

describe('project_send attachments — local project', () => {
    it('commits a mesh-bound copy and puts only its id and metadata in the coordinator text', async () => {
        const id = stage();
        const r: any = await send(authed({ project: MESH, message: 'look at this', messageId: 'turn1', attachments: [id] }));
        expect(r).toMatchObject({ success: true, result: { attachments: 1 } });
        expect(sent).toHaveLength(1);
        const text: string = sent[0].text;
        const committed = artifacts().listByMesh(MESH, {});
        expect(committed).toHaveLength(1);
        expect(committed[0]).toMatchObject({ meshId: MESH, producerRole: 'user', originDaemonId: SELF, kind: 'image' });
        expect(committed[0].artifactId).not.toBe(id);
        expect(text).toContain(committed[0].artifactId);
        expect(text).toContain('input_artifact_ids');
        expect(text).not.toContain(PNG.toString('base64'));
        // A retry with the same messageId resolves to the same artifact and the same text.
        await send(authed({ project: MESH, message: 'look at this', messageId: 'turn1', attachments: [id] }));
        expect(artifacts().listByMesh(MESH, {})).toHaveLength(1);
        expect(sent[1].text).toBe(text);
    });

    it('requires the bound assistant\'s credential and a messageId', async () => {
        const id = stage();
        expect(await send({ project: MESH, message: 'x', messageId: 'm', attachments: [id] })).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        expect(await send(authed({ project: MESH, message: 'x', attachments: [id] }))).toMatchObject({ success: false, code: 'invalid_args' });
        expect(sent).toHaveLength(0);
        expect(artifacts().listByMesh(MESH, {})).toHaveLength(0);
    });

    it('refuses unknown, foreign-session, already-bound and expired ids without sending anything', async () => {
        const mine = stage('m-a');
        const foreign = stage('m-b', 'someone-else');
        for (const attachments of [['art_does_not_exist'], [foreign], [mine, 'art_nope']]) {
            expect(await send(authed({ project: MESH, message: 'x', messageId: 'm1', attachments }))).toMatchObject({ success: false, code: 'attachment_not_found' });
        }
        // A committed (mesh-bound) artifact cannot be re-attached as an upload.
        await send(authed({ project: MESH, message: 'x', messageId: 'm2', attachments: [mine] }));
        const bound = artifacts().listByMesh(MESH, {})[0].artifactId;
        expect(await send(authed({ project: MESH_OTHER, message: 'x', messageId: 'm3', attachments: [bound] }))).toMatchObject({ success: false, code: 'attachment_not_found' });
        expect(artifacts().listByMesh(MESH_OTHER, {})).toHaveLength(0);
        // Expired: age the staged record past the TTL.
        const old = stage('m-old');
        db().prepare('UPDATE session_artifacts SET created_at = ? WHERE artifact_id = ?').run(Date.now() - 2 * 60 * 60 * 1000, old);
        expect(await send(authed({ project: MESH, message: 'x', messageId: 'm4', attachments: [old] }))).toMatchObject({ success: false, code: 'attachment_expired' });
        expect(sent).toHaveLength(1);
    });

    it('text-only sends are unchanged', async () => {
        const r: any = await send({ project: MESH, message: 'plain' });
        expect(r.success).toBe(true);
        expect(sent[0].text).toBe('plain');
        expect(r.result.attachments).toBeUndefined();
    });
});

describe('project_send attachments — remote host over the fake transport', () => {
    beforeEach(() => { remote = true; hostedHere = false; saveMeshConfig({ ...loadMeshConfig(), meshes: [meshEntry(), meshEntry(MESH_OTHER)] as any }); });

    it('sends the bytes through the mesh RPC `send` op and the host commits its own copy', async () => {
        const id = stage();
        const r: any = await send(authed({ project: MESH, message: 'remote look', messageId: 'rturn1', attachments: [id] }));
        expect(r).toMatchObject({ success: true, result: { attachments: 1, via: 'relay' } });
        const [, op, callArgs] = callHost.mock.calls[0];
        expect(op).toBe('send');
        expect(callArgs.attachments).toEqual([{ mimeType: 'image/png', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), dataBase64: PNG.toString('base64') }]);
        // The sender's text carries no block; the host appended it after committing.
        expect(callArgs.text).toBe('remote look');
        const committed = artifacts().listByMesh(MESH, {});
        expect(committed).toHaveLength(1);
        expect(committed[0]).toMatchObject({ originDaemonId: HOST, meshId: MESH, producerRole: 'user' });
        expect(sent[0].text).toContain(committed[0].artifactId);
        expect(JSON.stringify(r)).not.toContain(PNG.toString('base64'));
    });

    it('refuses on the host — before writing anything — when an attachment is tampered with', async () => {
        const id = stage();
        hostAnswer = (op, args) => {
            const hostHandler = getDaemonCommandRegistry().get('assistant_remote_project')!.run as any;
            const tampered = { ...args, attachments: args.attachments.map((a: any) => ({ ...a, sha256: 'f'.repeat(64) })) };
            hostedHere = true;
            return hostHandler({} as any, { meshId: MESH, op, ...tampered, [MESH_SENDER_DAEMON_ID_ARG]: SELF })
                .then((res: any) => (res.success ? { ok: true, result: res } : { ok: false, kind: 'refused', code: res.code, error: res.error, result: res }))
                .finally(() => { hostedHere = false; });
        };
        const r: any = await send(authed({ project: MESH, message: 'x', messageId: 'rturn2', attachments: [id] }));
        expect(r).toMatchObject({ success: false });
        expect(JSON.stringify(r)).toContain('upload_hash_mismatch');
        expect(sent).toHaveLength(0);
        expect(artifacts().listByMesh(MESH, {})).toHaveLength(0);
    });

    it('warns instead of claiming a clean send when the host predates attachments', async () => {
        const id = stage();
        hostAnswer = () => ({ ok: true, result: { success: true, result: { status: 'accepted', launched: false, coordinatorSessionId: 'coord-1', messageId: 'assistant:x:rturn3', cursor: null } } });
        const r: any = await send(authed({ project: MESH, message: 'x', messageId: 'rturn3', attachments: [id] }));
        expect(r.success).toBe(true);
        expect(r.result.attachments).toBe(0);
        expect(r.result.attachmentsWarning).toMatch(/WITHOUT the images/);
    });
});

describe('assistant read ACL over a committed owner upload', () => {
    it('is readable for its own mesh and denied for any other mesh', async () => {
        const id = stage();
        await send(authed({ project: MESH, message: 'x', messageId: 'acl1', attachments: [id] }));
        const committedId = artifacts().listByMesh(MESH, {})[0].artifactId;
        const ports = { selfDaemonId: () => SELF } as unknown as AssistantProjectPorts;
        const ok = await localArtifactRead(ports, MESH, { artifactId: committedId });
        expect(ok).toMatchObject({ ok: true });
        if (ok.ok) expect(ok.result).toMatchObject({ totalBytes: PNG.length });
        expect(await localArtifactRead(ports, MESH_OTHER, { artifactId: committedId })).toMatchObject({ ok: false, code: 'cross_mesh_artifact_denied' });
        // The staged copy is mesh-less: no project can read it through the assistant read.
        expect(await localArtifactRead(ports, MESH, { artifactId: id })).toMatchObject({ ok: false, code: 'cross_mesh_artifact_denied' });
    });
});
