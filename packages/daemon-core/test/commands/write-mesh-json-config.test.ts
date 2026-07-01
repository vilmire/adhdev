import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { meshCrudHandlers } from '../../src/commands/med-family/mesh-crud.js'
import { createMesh, updateMesh } from '../../src/config/mesh-config.js'
import type { MedFamilyContext } from '../../src/commands/med-family/types.js'

/**
 * write_mesh_json_config daemon-core handler (mesh-crud.ts) — the gated WRITE sibling
 * of the draft-only export_mesh_json_config. It reuses mesh_init's write/overwrite/
 * dry-run contract: dry-run by default (no write), existing-wins unless overwrite=true,
 * validate the scaffold before persisting. Scope is the repo `.adhdev/mesh.json`
 * (commit target). The scaffold is built from the machine-local mesh entry's
 * coordinator prompt override/append (policy/operating-notes are NOT exported).
 *
 * The mesh entry store is ~/.adhdev/meshes.json — isolated via ADHDEV_CONFIG_DIR.
 */
const ctx = {} as MedFamilyContext
const MESH_JSON_PATH = '.adhdev/mesh.json'

describe('write_mesh_json_config — gated write of repo .adhdev/mesh.json', () => {
    let prevConfigDir: string | undefined
    let cfgDir: string
    let ws: string
    let meshId: string

    beforeEach(async () => {
        prevConfigDir = process.env.ADHDEV_CONFIG_DIR
        cfgDir = await mkdtemp(join(tmpdir(), 'write-mesh-json-cfg-'))
        process.env.ADHDEV_CONFIG_DIR = cfgDir
        ws = await mkdtemp(join(tmpdir(), 'write-mesh-json-ws-'))
        await mkdir(join(ws, '.adhdev'), { recursive: true })
        // A mesh with a coordinator prompt append so the scaffold is non-empty.
        const mesh = createMesh({ name: 'test-mesh', repoIdentity: 'test/repo' })
        meshId = mesh.id
        updateMesh(meshId, { coordinator: { systemPromptAppend: 'Always run lint before merge.' } } as any)
    })

    afterEach(async () => {
        if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
        else process.env.ADHDEV_CONFIG_DIR = prevConfigDir
        await rm(cfgDir, { recursive: true, force: true }).catch(() => {})
        await rm(ws, { recursive: true, force: true }).catch(() => {})
    })

    it('dry-run (default) returns the scaffold without writing', async () => {
        const res: any = await meshCrudHandlers.write_mesh_json_config(ctx, { meshId, workspace: ws })
        expect(res.success).toBe(true)
        expect(res.written).toBe(false)
        expect(res.dryRun).toBe(true)
        expect(res.scaffold.version).toBe(1)
        expect(res.scaffold.coordinator.systemPromptAppend).toBe('Always run lint before merge.')
        expect(existsSync(join(ws, MESH_JSON_PATH))).toBe(false)
    })

    it('write=true persists a valid, loadable .adhdev/mesh.json', async () => {
        const res: any = await meshCrudHandlers.write_mesh_json_config(ctx, { meshId, workspace: ws, write: true })
        expect(res.success).toBe(true)
        expect(res.written).toBe(true)
        expect(existsSync(join(ws, MESH_JSON_PATH))).toBe(true)
        const raw = await readFile(join(ws, MESH_JSON_PATH), 'utf-8')
        expect(raw.endsWith('\n')).toBe(true)
        const parsed = JSON.parse(raw)
        expect(parsed.version).toBe(1)
        expect(parsed.coordinator.systemPromptAppend).toBe('Always run lint before merge.')
    })

    it('never clobbers an existing mesh.json unless overwrite=true', async () => {
        const handAuthored = { version: 1, coordinator: { systemPromptAppend: 'HAND EDITED — do not lose me.' } }
        await writeFile(join(ws, MESH_JSON_PATH), JSON.stringify(handAuthored, null, 2))

        const kept: any = await meshCrudHandlers.write_mesh_json_config(ctx, { meshId, workspace: ws, write: true })
        expect(kept.written).toBe(false)
        expect(kept.skippedReason).toBe('already_exists')
        // The existing file is echoed back so the coordinator can diff before overwriting.
        expect(kept.existing.coordinator.systemPromptAppend).toBe('HAND EDITED — do not lose me.')
        const afterKeep = JSON.parse(await readFile(join(ws, MESH_JSON_PATH), 'utf-8'))
        expect(afterKeep.coordinator.systemPromptAppend).toBe('HAND EDITED — do not lose me.')

        const overwritten: any = await meshCrudHandlers.write_mesh_json_config(ctx, { meshId, workspace: ws, write: true, overwrite: true })
        expect(overwritten.written).toBe(true)
        const afterOver = JSON.parse(await readFile(join(ws, MESH_JSON_PATH), 'utf-8'))
        expect(afterOver.coordinator.systemPromptAppend).toBe('Always run lint before merge.')
    })

    it('requires a meshId', async () => {
        const res: any = await meshCrudHandlers.write_mesh_json_config(ctx, { workspace: ws })
        expect(res.success).toBe(false)
        expect(res.error).toMatch(/meshId required/)
    })
})
