import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOG } from '../../../src/logging/logger.js'
import {
    MESH_PEER_SECRETS_FILE,
    getPeerSecret,
    listPeerSecrets,
    mintPeerSecret,
    onPeerSecretsChanged,
    putPeerSecret,
    removePeerSecret,
    resetPeerSecretsWarningsForTest,
    resolvePeerSecretsPath,
    type PeerSecretRecord,
    type PeerSecretsChange,
} from '../../../src/mesh/transport/mesh-peer-secrets.js'

const HEX = '0123456789abcdef0123456789abcdef'

function record(overrides: Partial<PeerSecretRecord> = {}): PeerSecretRecord {
    return {
        meshId: 'mesh_a',
        peerDaemonId: `mach_${HEX}`,
        role: 'host',
        secret: mintPeerSecret(),
        createdAt: '2026-10-07T00:00:00.000Z',
        ...overrides,
    }
}

describe('mesh-peer-secrets store', () => {
    let dir: string
    let filePath: string
    let opts: { filePath: string }

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mesh-peer-secrets-'))
        filePath = join(dir, MESH_PEER_SECRETS_FILE)
        opts = { filePath }
        resetPeerSecretsWarningsForTest()
    })

    afterEach(() => {
        vi.restoreAllMocks()
        rmSync(dir, { recursive: true, force: true })
    })

    it('mints 32 random bytes as base64, distinct on every call', () => {
        const a = mintPeerSecret()
        const b = mintPeerSecret()
        expect(Buffer.from(a, 'base64')).toHaveLength(32)
        expect(a).not.toBe(b)
    })

    it('resolves the file under the config dir named by env when no filePath is given', () => {
        const path = resolvePeerSecretsPath({ env: { ADHDEV_CONFIG_DIR: dir } })
        expect(path).toBe(join(dir, MESH_PEER_SECRETS_FILE))
        putPeerSecret(record(), { env: { ADHDEV_CONFIG_DIR: dir } })
        expect(existsSync(join(dir, MESH_PEER_SECRETS_FILE))).toBe(true)
        expect(listPeerSecrets({ env: { ADHDEV_CONFIG_DIR: dir } })).toHaveLength(1)
    })

    it('treats a missing file as empty without warning', () => {
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => undefined)
        expect(listPeerSecrets(opts)).toEqual([])
        expect(getPeerSecret('mesh_a', `mach_${HEX}`, opts)).toBeNull()
        expect(warn).not.toHaveBeenCalled()
    })

    it('round-trips a record, storing the peer id in canonical form and matching any id form', () => {
        const rec = record({ role: 'member', hostAddress: ' 192.168.1.5:3847 ' })
        putPeerSecret(rec, opts)

        const listed = listPeerSecrets(opts)
        expect(listed).toHaveLength(1)
        expect(listed[0]).toEqual({
            meshId: 'mesh_a',
            peerDaemonId: `daemon_mach_${HEX}`,
            role: 'member',
            secret: rec.secret,
            hostAddress: '192.168.1.5:3847',
            createdAt: rec.createdAt,
        })

        for (const form of [`mach_${HEX}`, `daemon_mach_${HEX}`, `standalone_mach_${HEX}`]) {
            expect(getPeerSecret('mesh_a', form, opts)?.secret).toBe(rec.secret)
        }
        expect(getPeerSecret('mesh_other', `mach_${HEX}`, opts)).toBeNull()
        expect(getPeerSecret('mesh_a', 'mach_ffffffffffffffffffffffffffffffff', opts)).toBeNull()
    })

    it('returns copies — mutating a result never changes the store', () => {
        putPeerSecret(record(), opts)
        const got = getPeerSecret('mesh_a', `mach_${HEX}`, opts)!
        got.secret = 'tampered'
        listPeerSecrets(opts)[0].secret = 'tampered'
        expect(getPeerSecret('mesh_a', `mach_${HEX}`, opts)!.secret).not.toBe('tampered')
    })

    it('replaces the record for the same mesh+peer even when given a different id form', () => {
        putPeerSecret(record({ secret: 'first-secret' }), opts)
        putPeerSecret(record({ peerDaemonId: `standalone_mach_${HEX}`, secret: 'second-secret', role: 'member' }), opts)
        putPeerSecret(record({ meshId: 'mesh_b', secret: 'other-mesh' }), opts)

        const all = listPeerSecrets(opts)
        expect(all).toHaveLength(2)
        expect(getPeerSecret('mesh_a', `mach_${HEX}`, opts)).toMatchObject({ secret: 'second-secret', role: 'member' })
        expect(getPeerSecret('mesh_b', `mach_${HEX}`, opts)?.secret).toBe('other-mesh')
    })

    it('removes a record and reports whether one existed', () => {
        putPeerSecret(record(), opts)
        putPeerSecret(record({ meshId: 'mesh_b' }), opts)
        expect(removePeerSecret('mesh_a', `standalone_mach_${HEX}`, opts)).toBe(true)
        expect(removePeerSecret('mesh_a', `mach_${HEX}`, opts)).toBe(false)
        expect(removePeerSecret('mesh_a', '', opts)).toBe(false)
        expect(listPeerSecrets(opts).map((r) => r.meshId)).toEqual(['mesh_b'])
    })

    it('rejects an invalid record instead of silently dropping it', () => {
        expect(() => putPeerSecret(record({ secret: '' }), opts)).toThrow()
        expect(() => putPeerSecret(record({ meshId: '  ' }), opts)).toThrow()
        expect(() => putPeerSecret({ ...record(), role: 'boss' as never }, opts)).toThrow()
        expect(existsSync(filePath)).toBe(false)
    })

    it('notifies listeners after put/remove with no secret value, and stops after unsubscribe', () => {
        const changes: PeerSecretsChange[] = []
        const off = onPeerSecretsChanged((c) => changes.push(c))
        const rec = record()
        putPeerSecret(rec, opts)
        removePeerSecret('mesh_a', `mach_${HEX}`, opts)
        removePeerSecret('mesh_a', `mach_${HEX}`, opts) // no-op: nothing to remove, no event
        off()
        putPeerSecret(record({ meshId: 'mesh_z' }), opts)

        expect(changes).toEqual([
            { kind: 'put', meshId: 'mesh_a', peerDaemonId: `daemon_mach_${HEX}`, role: 'host', filePath },
            { kind: 'remove', meshId: 'mesh_a', peerDaemonId: `daemon_mach_${HEX}`, role: 'host', filePath },
        ])
        expect(JSON.stringify(changes)).not.toContain(rec.secret)
    })

    it('keeps notifying other listeners when one throws', () => {
        vi.spyOn(LOG, 'warn').mockImplementation(() => undefined)
        const seen: string[] = []
        const offA = onPeerSecretsChanged(() => {
            throw new Error('boom')
        })
        const offB = onPeerSecretsChanged((c) => seen.push(c.kind))
        putPeerSecret(record(), opts)
        offA()
        offB()
        expect(seen).toEqual(['put'])
    })

    it('tolerates a corrupt file: empty result, one warning without contents, and a put recovers it', () => {
        const leaked = 'SUPER-SECRET-VALUE-THAT-MUST-NOT-BE-LOGGED'
        writeFileSync(filePath, `{"records": [ {"secret": "${leaked}" `)
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => undefined)

        expect(listPeerSecrets(opts)).toEqual([])
        expect(getPeerSecret('mesh_a', `mach_${HEX}`, opts)).toBeNull()
        expect(listPeerSecrets(opts)).toEqual([])
        expect(warn).toHaveBeenCalledTimes(1)
        expect(JSON.stringify(warn.mock.calls)).not.toContain(leaked)

        putPeerSecret(record(), opts)
        expect(listPeerSecrets(opts)).toHaveLength(1)
    })

    it('drops malformed records but keeps the valid ones', () => {
        const good = record()
        writeFileSync(filePath, JSON.stringify({
            version: 1,
            records: [good, { meshId: 'mesh_a', role: 'host' }, 42, { ...good, peerDaemonId: '' }],
        }))
        const warn = vi.spyOn(LOG, 'warn').mockImplementation(() => undefined)
        const listed = listPeerSecrets(opts)
        expect(listed).toHaveLength(1)
        expect(listed[0].secret).toBe(good.secret)
        expect(warn).toHaveBeenCalledTimes(1)
    })

    it('treats an unexpected top-level shape as empty', () => {
        writeFileSync(filePath, JSON.stringify([1, 2, 3]))
        vi.spyOn(LOG, 'warn').mockImplementation(() => undefined)
        expect(listPeerSecrets(opts)).toEqual([])
    })

    it('writes a versioned file atomically, leaving no tmp file behind', () => {
        putPeerSecret(record(), opts)
        removePeerSecret('mesh_a', `mach_${HEX}`, opts)
        putPeerSecret(record({ meshId: 'mesh_c' }), opts)
        expect(readdirSync(dir)).toEqual([MESH_PEER_SECRETS_FILE])
        const parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
        expect(parsed.version).toBe(1)
        expect(parsed.records).toHaveLength(1)
    })

    it.skipIf(process.platform === 'win32')('writes the file with mode 0600, even over a pre-existing looser file', () => {
        writeFileSync(filePath, JSON.stringify({ version: 1, records: [] }), { mode: 0o644 })
        putPeerSecret(record(), opts)
        expect(statSync(filePath).mode & 0o777).toBe(0o600)
    })
})
