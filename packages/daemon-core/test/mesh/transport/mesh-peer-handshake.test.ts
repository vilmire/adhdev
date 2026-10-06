import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    MESH_HANDSHAKE_CLOSE_CODE,
    MeshHandshakeError,
    computeClientProof,
    computeServerProof,
    createHandshakeInitiator,
    createHandshakeResponder,
    mintHandshakeNonce,
    parseHandshakeFrame,
    performMeshHandshake,
    proofsEqual,
    type HandshakeStep,
    type MeshHandshakeFrame,
    type WebSocketLike,
} from '../../../src/mesh/transport/mesh-peer-handshake.js'
import { mintPeerSecret } from '../../../src/mesh/transport/mesh-peer-secrets.js'

const CLIENT_HEX = '11111111111111111111111111111111'
const SERVER_HEX = '22222222222222222222222222222222'
const CLIENT_ID = `standalone_mach_${CLIENT_HEX}`
const CLIENT_CANON = `daemon_mach_${CLIENT_HEX}`
const SERVER_ID = `mach_${SERVER_HEX}`
const SERVER_CANON = `daemon_mach_${SERVER_HEX}`
const MESH = 'mesh_home'

/** Two in-process machines with explicit outboxes so tests can intercept/tamper frames. */
function pair(opts: {
    clientSecret: string
    serverSecrets?: Record<string, string>
    meshId?: string
    serverDaemonIdExpected?: string
}) {
    const toServer: MeshHandshakeFrame[] = []
    const toClient: MeshHandshakeFrame[] = []
    const lookups: Array<[string, string]> = []
    const initiator = createHandshakeInitiator({
        meshId: opts.meshId ?? MESH,
        daemonId: CLIENT_ID,
        serverDaemonIdExpected: opts.serverDaemonIdExpected,
        secret: opts.clientSecret,
        send: (f) => toServer.push(f),
    })
    const responder = createHandshakeResponder({
        localDaemonId: SERVER_ID,
        resolveSecret: (meshId, daemonId) => {
            lookups.push([meshId, daemonId])
            return opts.serverSecrets?.[`${meshId}/${daemonId}`] ?? null
        },
        send: (f) => toClient.push(f),
    })
    return { initiator, responder, toServer, toClient, lookups }
}

const json = (f: MeshHandshakeFrame) => JSON.stringify(f)

describe('mesh peer handshake state machines', () => {
    it('completes mutually with the same secret, binding canonical ids on both sides', () => {
        const secret = mintPeerSecret()
        const p = pair({ clientSecret: secret, serverSecrets: { [`${MESH}/${CLIENT_CANON}`]: secret } })

        p.initiator.start()
        p.initiator.start() // idempotent
        expect(p.toServer).toHaveLength(1)
        const hello = p.toServer[0]
        expect(hello).toMatchObject({ v: 1, kind: 'mesh_hello', meshId: MESH, daemonId: CLIENT_ID })
        expect(Buffer.from((hello as { nonce: string }).nonce, 'base64')).toHaveLength(16)

        expect(p.responder.onFrame(json(hello))).toEqual({ status: 'pending' })
        expect(p.lookups).toEqual([[MESH, CLIENT_CANON]])
        const challenge = p.toClient[0]
        expect(challenge).toMatchObject({ v: 1, kind: 'mesh_challenge', daemonId: SERVER_ID })

        expect(p.initiator.onFrame(json(challenge))).toEqual({ status: 'pending' })
        const proof = p.toServer[1]
        expect(proof.kind).toBe('mesh_proof')

        const serverStep = p.responder.onFrame(json(proof))
        expect(serverStep).toEqual({ status: 'ok', meshId: MESH, peerDaemonId: CLIENT_CANON })
        const ok = p.toClient[1]
        expect(ok).toEqual({ v: 1, kind: 'mesh_ok', daemonId: SERVER_ID })

        expect(p.initiator.onFrame(json(ok))).toEqual({ status: 'ok', meshId: MESH, peerDaemonId: SERVER_CANON })
        expect(p.initiator.current()).toEqual({ status: 'ok', meshId: MESH, peerDaemonId: SERVER_CANON })

        // Secrets never travel in any frame.
        expect(JSON.stringify([...p.toServer, ...p.toClient])).not.toContain(secret)
    })

    it('also accepts parsed objects, not only JSON strings', () => {
        const secret = mintPeerSecret()
        const p = pair({ clientSecret: secret, serverSecrets: { [`${MESH}/${CLIENT_CANON}`]: secret } })
        p.initiator.start()
        p.responder.onFrame(p.toServer[0])
        p.initiator.onFrame(p.toClient[0])
        expect(p.responder.onFrame(p.toServer[1]).status).toBe('ok')
    })

    it('mismatched secrets fail with bad_proof, detected by the initiator on the challenge', () => {
        const p = pair({ clientSecret: mintPeerSecret(), serverSecrets: { [`${MESH}/${CLIENT_CANON}`]: mintPeerSecret() } })
        p.initiator.start()
        p.responder.onFrame(json(p.toServer[0]))
        // The initiator detects the mismatch first (server proof does not verify under its key) ...
        const clientStep = p.initiator.onFrame(json(p.toClient[0]))
        expect(clientStep).toEqual({ status: 'failed', code: 'bad_proof' })
        expect(p.toServer[1]).toEqual({ v: 1, kind: 'mesh_error', code: 'bad_proof' })
    })

    it('the server rejects a client proof computed with the wrong secret', () => {
        const serverSecret = mintPeerSecret()
        const p = pair({ clientSecret: serverSecret, serverSecrets: { [`${MESH}/${CLIENT_CANON}`]: serverSecret } })
        p.initiator.start()
        const hello = p.toServer[0] as { nonce: string }
        p.responder.onFrame(json(p.toServer[0]))
        const challenge = p.toClient[0] as { nonce: string }
        const forged = computeClientProof({
            secret: mintPeerSecret(),
            clientNonce: hello.nonce,
            serverNonce: challenge.nonce,
            meshId: MESH,
            clientDaemonId: CLIENT_ID,
            serverDaemonId: SERVER_ID,
        })
        expect(p.responder.onFrame(json({ v: 1, kind: 'mesh_proof', proof: forged }))).toEqual({ status: 'failed', code: 'bad_proof' })
        expect(p.toClient.at(-1)).toEqual({ v: 1, kind: 'mesh_error', code: 'bad_proof' })
    })

    it('the initiator rejects a server that does not hold the secret (forged challenge)', () => {
        const secret = mintPeerSecret()
        const sent: MeshHandshakeFrame[] = []
        const initiator = createHandshakeInitiator({ meshId: MESH, daemonId: CLIENT_ID, secret, send: (f) => sent.push(f) })
        initiator.start()
        const step = initiator.onFrame(json({
            v: 1, kind: 'mesh_challenge', nonce: mintHandshakeNonce(), daemonId: SERVER_ID,
            proof: Buffer.alloc(32, 7).toString('base64'),
        }))
        expect(step).toEqual({ status: 'failed', code: 'bad_proof' })
        expect(sent.map((f) => f.kind)).toEqual(['mesh_hello', 'mesh_error'])
    })

    it('the initiator rejects a challenge from an unexpected server daemon id', () => {
        const secret = mintPeerSecret()
        const p = pair({
            clientSecret: secret,
            serverSecrets: { [`${MESH}/${CLIENT_CANON}`]: secret },
            serverDaemonIdExpected: 'mach_33333333333333333333333333333333',
        })
        p.initiator.start()
        p.responder.onFrame(json(p.toServer[0]))
        expect(p.initiator.onFrame(json(p.toClient[0]))).toEqual({ status: 'failed', code: 'bad_proof' })
    })

    it('accepts the expected server id in any id form', () => {
        const secret = mintPeerSecret()
        const p = pair({
            clientSecret: secret,
            serverSecrets: { [`${MESH}/${CLIENT_CANON}`]: secret },
            serverDaemonIdExpected: `standalone_mach_${SERVER_HEX}`,
        })
        p.initiator.start()
        p.responder.onFrame(json(p.toServer[0]))
        expect(p.initiator.onFrame(json(p.toClient[0]))).toEqual({ status: 'pending' })
    })

    it('an unknown peer gets unknown_peer, the same code for unknown mesh and unknown daemon', () => {
        const secret = mintPeerSecret()
        const known = { [`${MESH}/${CLIENT_CANON}`]: secret }

        const wrongMesh = pair({ clientSecret: secret, serverSecrets: known, meshId: 'mesh_nope' })
        wrongMesh.initiator.start()
        expect(wrongMesh.responder.onFrame(json(wrongMesh.toServer[0]))).toEqual({ status: 'failed', code: 'unknown_peer' })
        expect(wrongMesh.toClient).toEqual([{ v: 1, kind: 'mesh_error', code: 'unknown_peer' }])

        const noPeers = pair({ clientSecret: secret, serverSecrets: {} })
        noPeers.initiator.start()
        expect(noPeers.responder.onFrame(json(noPeers.toServer[0]))).toEqual({ status: 'failed', code: 'unknown_peer' })
        expect(noPeers.toClient).toEqual(wrongMesh.toClient)

        // The initiator surfaces the server's code.
        expect(noPeers.initiator.onFrame(json(noPeers.toClient[0]))).toEqual({ status: 'failed', code: 'unknown_peer' })
    })

    it('a replayed hello to a responder already awaiting the proof fails', () => {
        const secret = mintPeerSecret()
        const p = pair({ clientSecret: secret, serverSecrets: { [`${MESH}/${CLIENT_CANON}`]: secret } })
        p.initiator.start()
        p.responder.onFrame(json(p.toServer[0]))
        expect(p.responder.onFrame(json(p.toServer[0]))).toEqual({ status: 'failed', code: 'bad_frame' })
        // ... and the session is dead: a now-valid proof cannot revive it.
        p.initiator.onFrame(json(p.toClient[0]))
        expect(p.responder.onFrame(json(p.toServer.at(-1)!)).status).toBe('failed')
    })

    it('a proof captured from one session does not verify in a new session (fresh server nonce)', () => {
        const secret = mintPeerSecret()
        const secrets = { [`${MESH}/${CLIENT_CANON}`]: secret }
        const first = pair({ clientSecret: secret, serverSecrets: secrets })
        first.initiator.start()
        first.responder.onFrame(json(first.toServer[0]))
        first.initiator.onFrame(json(first.toClient[0]))
        const capturedHello = first.toServer[0]
        const capturedProof = first.toServer[1]
        expect(first.responder.onFrame(json(capturedProof)).status).toBe('ok')

        // An eavesdropper replays the whole client side against a fresh responder.
        const replay = pair({ clientSecret: secret, serverSecrets: secrets })
        expect(replay.responder.onFrame(json(capturedHello))).toEqual({ status: 'pending' })
        expect(replay.responder.onFrame(json(capturedProof))).toEqual({ status: 'failed', code: 'bad_proof' })
    })

    it('a duplicate proof after success fails', () => {
        const secret = mintPeerSecret()
        const p = pair({ clientSecret: secret, serverSecrets: { [`${MESH}/${CLIENT_CANON}`]: secret } })
        p.initiator.start()
        p.responder.onFrame(json(p.toServer[0]))
        p.initiator.onFrame(json(p.toClient[0]))
        expect(p.responder.onFrame(json(p.toServer[1])).status).toBe('ok')
        expect(p.responder.onFrame(json(p.toServer[1]))).toEqual({ status: 'failed', code: 'bad_frame' })
    })

    it('a duplicate challenge to the initiator fails', () => {
        const secret = mintPeerSecret()
        const p = pair({ clientSecret: secret, serverSecrets: { [`${MESH}/${CLIENT_CANON}`]: secret } })
        p.initiator.start()
        p.responder.onFrame(json(p.toServer[0]))
        p.initiator.onFrame(json(p.toClient[0]))
        expect(p.initiator.onFrame(json(p.toClient[0]))).toEqual({ status: 'failed', code: 'bad_frame' })
    })

    it('out-of-order frames fail on both sides', () => {
        const responder = createHandshakeResponder({ localDaemonId: SERVER_ID, resolveSecret: () => 'x', send: () => undefined })
        expect(responder.onFrame(json({ v: 1, kind: 'mesh_proof', proof: 'AAAA' }))).toEqual({ status: 'failed', code: 'bad_frame' })

        const initiator = createHandshakeInitiator({ meshId: MESH, daemonId: CLIENT_ID, secret: 'x', send: () => undefined })
        // A frame before start() is out of order.
        expect(initiator.onFrame(json({ v: 1, kind: 'mesh_ok', daemonId: SERVER_ID })).status).toBe('failed')

        const started = createHandshakeInitiator({ meshId: MESH, daemonId: CLIENT_ID, secret: 'x', send: () => undefined })
        started.start()
        expect(started.onFrame(json({ v: 1, kind: 'mesh_ok', daemonId: SERVER_ID }))).toEqual({ status: 'failed', code: 'bad_frame' })
    })

    it('a meshId tampered in transit makes the handshake fail', () => {
        const secret = mintPeerSecret()
        // The server knows the client in BOTH meshes with the same secret, so only the binding protects.
        const secrets = { [`${MESH}/${CLIENT_CANON}`]: secret, [`mesh_other/${CLIENT_CANON}`]: secret }
        const p = pair({ clientSecret: secret, serverSecrets: secrets })
        p.initiator.start()
        const tampered = { ...(p.toServer[0] as object), meshId: 'mesh_other' }
        expect(p.responder.onFrame(JSON.stringify(tampered))).toEqual({ status: 'pending' })
        // The server proof is bound to the tampered mesh id, so the client refuses it.
        expect(p.initiator.onFrame(json(p.toClient[0]))).toEqual({ status: 'failed', code: 'bad_proof' })
    })

    it('a proof bound to a different mesh or a different client id does not verify', () => {
        const base = {
            secret: mintPeerSecret(),
            clientNonce: mintHandshakeNonce(),
            serverNonce: mintHandshakeNonce(),
            meshId: MESH,
            clientDaemonId: CLIENT_ID,
            serverDaemonId: SERVER_ID,
        }
        const proof = computeClientProof(base)
        expect(proofsEqual(proof, computeClientProof({ ...base, clientDaemonId: `mach_${CLIENT_HEX}` }))).toBe(true)
        expect(proofsEqual(proof, computeClientProof({ ...base, meshId: 'mesh_other' }))).toBe(false)
        expect(proofsEqual(proof, computeClientProof({ ...base, clientDaemonId: 'mach_33333333333333333333333333333333' }))).toBe(false)
        // Server and client proofs are domain-separated.
        expect(proofsEqual(computeServerProof(base), proof)).toBe(false)
        expect(proofsEqual(proof, 'short')).toBe(false)
        expect(proofsEqual(proof, 42)).toBe(false)
    })

    it('a protocol version mismatch fails with bad_version and tells the peer', () => {
        const sent: MeshHandshakeFrame[] = []
        const responder = createHandshakeResponder({ localDaemonId: SERVER_ID, resolveSecret: () => 'x', send: (f) => sent.push(f) })
        const step = responder.onFrame(JSON.stringify({ v: 2, kind: 'mesh_hello', meshId: MESH, daemonId: CLIENT_ID, nonce: mintHandshakeNonce() }))
        expect(step).toEqual({ status: 'failed', code: 'bad_version' })
        expect(sent).toEqual([{ v: 1, kind: 'mesh_error', code: 'bad_version' }])
    })

    it('malformed frames fail with bad_frame', () => {
        expect(parseHandshakeFrame('not json')).toEqual({ error: 'bad_frame' })
        expect(parseHandshakeFrame(null)).toEqual({ error: 'bad_frame' })
        expect(parseHandshakeFrame({ v: 1, kind: 'mesh_hello', meshId: MESH, daemonId: CLIENT_ID, nonce: 'too-short' })).toEqual({ error: 'bad_frame' })
        expect(parseHandshakeFrame({ v: 1, kind: 'mesh_error', code: 'made_up' })).toEqual({ error: 'bad_frame' })
        expect(parseHandshakeFrame({ v: 1, kind: 'mesh_rpc' })).toEqual({ error: 'bad_frame' })
        const responder = createHandshakeResponder({ localDaemonId: SERVER_ID, resolveSecret: () => 'x', send: () => undefined })
        expect(responder.onFrame('{')).toEqual({ status: 'failed', code: 'bad_frame' })
    })
})

// ─── performMeshHandshake ────────────────────────────────────────────────────

class FakeSocket extends EventEmitter implements WebSocketLike {
    readyState = 1
    peer: FakeSocket | null = null
    sent: string[] = []
    closed: { code?: number; reason?: string } | null = null
    send(data: string): void {
        this.sent.push(data)
        const peer = this.peer
        if (peer) queueMicrotask(() => peer.emit('message', Buffer.from(data, 'utf8')))
    }
    close(code?: number, reason?: string): void {
        if (this.closed) return
        this.closed = { code, reason }
        this.readyState = 3
    }
}

function connected(): [FakeSocket, FakeSocket] {
    const a = new FakeSocket()
    const b = new FakeSocket()
    a.peer = b
    b.peer = a
    return [a, b]
}

const HANDSHAKE_EVENTS = ['open', 'message', 'close', 'error'] as const
const listenerCounts = (s: FakeSocket) => HANDSHAKE_EVENTS.map((e) => s.listenerCount(e))

describe('performMeshHandshake', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('completes over a socket pair and removes every listener it added', async () => {
        const secret = mintPeerSecret()
        const [client, server] = connected()
        const serverP = performMeshHandshake(server, 'responder', {
            localDaemonId: SERVER_ID,
            resolveSecret: (m, d) => (m === MESH && d === CLIENT_CANON ? secret : null),
        })
        const clientP = performMeshHandshake(client, 'initiator', { meshId: MESH, daemonId: CLIENT_ID, secret })

        await expect(clientP).resolves.toEqual({ meshId: MESH, peerDaemonId: SERVER_CANON })
        await expect(serverP).resolves.toEqual({ meshId: MESH, peerDaemonId: CLIENT_CANON })
        expect(listenerCounts(client)).toEqual([0, 0, 0, 0])
        expect(listenerCounts(server)).toEqual([0, 0, 0, 0])
        expect(client.closed).toBeNull()
        expect(server.closed).toBeNull()
    })

    it('waits for open before sending hello when the socket is still connecting', async () => {
        const secret = mintPeerSecret()
        const [client, server] = connected()
        client.readyState = 0
        const serverP = performMeshHandshake(server, 'responder', { localDaemonId: SERVER_ID, resolveSecret: () => secret })
        const clientP = performMeshHandshake(client, 'initiator', { meshId: MESH, daemonId: CLIENT_ID, secret })
        await Promise.resolve()
        expect(client.sent).toEqual([])
        client.readyState = 1
        client.emit('open')
        await expect(clientP).resolves.toMatchObject({ peerDaemonId: SERVER_CANON })
        await expect(serverP).resolves.toMatchObject({ peerDaemonId: CLIENT_CANON })
    })

    it('rejects both sides and closes with 4401 on a wrong secret', async () => {
        const [client, server] = connected()
        const serverP = performMeshHandshake(server, 'responder', { localDaemonId: SERVER_ID, resolveSecret: () => mintPeerSecret() })
        const clientP = performMeshHandshake(client, 'initiator', { meshId: MESH, daemonId: CLIENT_ID, secret: mintPeerSecret() })
        const clientErr = await clientP.catch((e) => e)
        const serverErr = await serverP.catch((e) => e)
        expect(clientErr).toBeInstanceOf(MeshHandshakeError)
        expect(clientErr.code).toBe('bad_proof')
        expect(serverErr).toBeInstanceOf(MeshHandshakeError)
        expect(serverErr.code).toBe('bad_proof')
        expect(client.closed?.code).toBe(MESH_HANDSHAKE_CLOSE_CODE)
        expect(server.closed?.code).toBe(MESH_HANDSHAKE_CLOSE_CODE)
        expect(listenerCounts(client)).toEqual([0, 0, 0, 0])
    })

    it('times out when the peer never answers, sends a timeout error, closes with 4401 and detaches', async () => {
        vi.useFakeTimers()
        const client = new FakeSocket() // no peer: hello goes nowhere
        const p = performMeshHandshake(client, 'initiator', { meshId: MESH, daemonId: CLIENT_ID, secret: mintPeerSecret() }, 250)
        const settled = p.catch((e) => e)
        await vi.advanceTimersByTimeAsync(249)
        expect(client.closed).toBeNull()
        await vi.advanceTimersByTimeAsync(1)
        const err = await settled
        expect(err).toBeInstanceOf(MeshHandshakeError)
        expect(err.code).toBe('timeout')
        expect(client.closed?.code).toBe(MESH_HANDSHAKE_CLOSE_CODE)
        expect(client.sent.map((s) => JSON.parse(s).kind)).toEqual(['mesh_hello', 'mesh_error'])
        expect(JSON.parse(client.sent[1]).code).toBe('timeout')
        expect(listenerCounts(client)).toEqual([0, 0, 0, 0])
    })

    it('rejects with socket_closed when the socket closes mid-handshake', async () => {
        const server = new FakeSocket()
        const p = performMeshHandshake(server, 'responder', { localDaemonId: SERVER_ID, resolveSecret: () => 'x' })
        server.emit('close', 1006, Buffer.alloc(0))
        const err = await p.catch((e) => e)
        expect(err.code).toBe('socket_closed')
        expect(listenerCounts(server)).toEqual([0, 0, 0, 0])
    })

    it('rejects immediately on an already-closed socket', async () => {
        const s = new FakeSocket()
        s.readyState = 3
        const err = await performMeshHandshake(s, 'initiator', { meshId: MESH, daemonId: CLIENT_ID, secret: 'x' }).catch((e) => e)
        expect(err.code).toBe('socket_closed')
    })

    it('leaves later socket traffic to the caller after success', async () => {
        const secret = mintPeerSecret()
        const [client, server] = connected()
        const serverP = performMeshHandshake(server, 'responder', { localDaemonId: SERVER_ID, resolveSecret: () => secret })
        await performMeshHandshake(client, 'initiator', { meshId: MESH, daemonId: CLIENT_ID, secret })
        await serverP
        const received: string[] = []
        server.on('message', (d: Buffer) => received.push(d.toString('utf8')))
        client.send('{"type":"rpc"}')
        await Promise.resolve()
        expect(received).toEqual(['{"type":"rpc"}'])
        expect(server.closed).toBeNull()
    })
})

// Type-level guard: HandshakeStep stays the documented union.
const _stepCheck: HandshakeStep[] = [{ status: 'pending' }, { status: 'ok', meshId: 'm', peerDaemonId: 'p' }, { status: 'failed', code: 'timeout' }]
void _stepCheck
