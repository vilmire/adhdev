/**
 * Sparse mesh policy in the dashboard (docs/design/2026-10-07-mesh-workspace-policy.md §A).
 *
 * The daemon stores only the policy keys the owner set (`mesh.policy`) and ships what
 * every key resolves to (`mesh.effectivePolicy`). The dashboard therefore:
 *   - displays the EFFECTIVE value, with no defaults copy of its own (the old copy said
 *     maxParallelTasks 2 while the daemon resolved 64);
 *   - marks each row "Default" (unset) or offers "Reset to default" (set → sends null);
 *   - saves ONLY the changed keys — sending the whole displayed policy would persist
 *     every default as if the owner had chosen it;
 *   - no longer shows the retired checkpoint / dirty-workspace rows (B4).
 *
 * INJECTION CHECK: restoring `{ ...readMeshPolicy(selectedMesh), ...patch }` in the
 * save, re-adding a defaults object to types.ts, dropping the reset button's `null`,
 * re-adding a retired row, or dropping a locale key turns this red.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import en from '../../../src/i18n/locales/en/common.json'
import ko from '../../../src/i18n/locales/ko/common.json'
import ja from '../../../src/i18n/locales/ja/common.json'
import zhCN from '../../../src/i18n/locales/zh-CN/common.json'
import es from '../../../src/i18n/locales/es/common.json'
import { readMeshPolicy, isMeshPolicyKeySet, type MeshEntry } from '../../../src/pages/repo-mesh/types'

const LOCALES: Record<string, any> = { en, ko, ja, 'zh-CN': zhCN, es }
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../src/${rel}`, import.meta.url)), 'utf8')
const detailView = read('pages/repo-mesh/MeshDetailView.tsx')
const nodeActions = read('pages/repo-mesh/useMeshNodeActions.ts')
const types = read('pages/repo-mesh/types.ts')

const RETIRED = ['requirePreTaskCheckpoint', 'requirePostTaskCheckpoint', 'dirtyWorkspaceBehavior', 'checkpoint_then_continue']
const RETIRED_LOCALE_KEYS = ['checkpointBefore', 'checkpointAfter', 'uncommittedChanges', 'warnAndContinue', 'blockTask', 'checkpointThenContinue']

const mesh = (policy: Record<string, any> | undefined, effectivePolicy?: Record<string, any>): MeshEntry => ({
    id: 'm', name: 'm', repoIdentity: 'r', nodes: [], createdAt: '', updatedAt: '',
    ...(policy ? { policy } : {}), ...(effectivePolicy ? { effectivePolicy } : {}),
})

describe('reading the policy', () => {
    it('displays the daemon-resolved effective policy, not a local defaults copy', () => {
        const m = mesh({ requireApprovalForPush: false }, { requireApprovalForPush: false, maxParallelTasks: 64, spawnedSessionVisibility: 'hidden' })
        expect(readMeshPolicy(m)).toEqual({ requireApprovalForPush: false, maxParallelTasks: 64, spawnedSessionVisibility: 'hidden' })
        expect(types).not.toMatch(/DEFAULT_MESH_POLICY/)
    })

    it('falls back to the stored policy for an older daemon that sends no effectivePolicy', () => {
        expect(readMeshPolicy(mesh({ maxParallelTasks: 4 }))).toEqual({ maxParallelTasks: 4 })
        expect(readMeshPolicy(null)).toEqual({})
    })

    it('"set" means present in the stored overrides', () => {
        const m = mesh({ requireApprovalForPush: false }, { requireApprovalForPush: false, allowAutoPublishSubmoduleMainCommits: false })
        expect(isMeshPolicyKeySet(m, 'requireApprovalForPush')).toBe(true)
        expect(isMeshPolicyKeySet(m, 'allowAutoPublishSubmoduleMainCommits')).toBe(false)
        expect(isMeshPolicyKeySet(null, 'requireApprovalForPush')).toBe(false)
    })
})

describe('writing the policy', () => {
    it('the detail-view save sends only the patch', () => {
        expect(nodeActions).toMatch(/const nextPolicy = \{ \.\.\.patch \}/)
        expect(nodeActions).not.toMatch(/\.\.\.readMeshPolicy\(selectedMesh\),\s*\.\.\.patch/)
    })

    it('a set row offers "Reset to default", which sends null for that key; an unset row shows the Default badge', () => {
        expect(detailView).toMatch(/onUpdatePolicy\(\{ \[key\]: null \}\)/)
        expect(detailView).toContain("t('mesh.detail.policyResetToDefault')")
        expect(detailView).toContain("t('mesh.detail.policyDefaultBadge')")
        expect(detailView).toMatch(/isMeshPolicyKeySet\(selectedMesh, key\)/)
    })
})

describe('retired policy rows (B4)', () => {
    it('the detail view renders none of the retired keys', () => {
        for (const key of RETIRED) expect(detailView).not.toContain(key)
    })

    it.each(Object.keys(LOCALES))('%s: retired strings removed, new strings present', (locale) => {
        const detail = LOCALES[locale].mesh.detail
        for (const key of RETIRED_LOCALE_KEYS) expect(detail, `${locale} still has ${key}`).not.toHaveProperty(key)
        expect(typeof detail.policyDefaultBadge).toBe('string')
        expect(typeof detail.policyResetToDefault).toBe('string')
        expect(String(detail.safetyDescription).length).toBeGreaterThan(0)
    })
})
