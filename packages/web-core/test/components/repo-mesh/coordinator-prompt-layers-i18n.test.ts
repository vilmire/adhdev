/**
 * Coverage guard for the coordinator-prompt UI keys added with the repo-layer
 * notice. (The Settings CoordinatorPromptsSection and its keys were removed on
 * 2026-10-08 together with the per-machine coordinator-prompts/ layer.)
 *
 * A missing key does not crash React — i18next renders the raw key string — so
 * a partially-translated surface ships silently. This pins every new key across
 * all five shipped locales.
 *
 * INJECTION CHECK: deleting any one key from any one locale turns this red.
 */
import { describe, expect, it } from 'vitest'
import en from '../../../src/i18n/locales/en/common.json'
import ko from '../../../src/i18n/locales/ko/common.json'
import ja from '../../../src/i18n/locales/ja/common.json'
import zhCN from '../../../src/i18n/locales/zh-CN/common.json'
import es from '../../../src/i18n/locales/es/common.json'

const LOCALES: Record<string, any> = { en, ko, ja, 'zh-CN': zhCN, es }

/** Keys for the read-only `.adhdev/mesh.json` layer notice (mesh.detail.*). */
const REPO_MESH_JSON_KEYS = [
    // repoMeshJsonReadOnly was folded into the title ("From repo file (read-only)").
    'repoMeshJsonTitle',
    'repoMeshJsonHint',
    'repoMeshJsonAppendLabel',
    'repoMeshJsonInvalid',
]

describe('coordinator prompt layer i18n', () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
        describe(name, () => {
            it('defines every repo mesh.json notice key', () => {
                const detail = bundle?.mesh?.detail ?? {}
                for (const key of REPO_MESH_JSON_KEYS) {
                    expect(typeof detail[key], `mesh.detail.${key}`).toBe('string')
                    expect(detail[key].trim().length, `mesh.detail.${key}`).toBeGreaterThan(0)
                }
            })

            it('defines the preview launch-scope note', () => {
                const note = bundle?.mesh?.promptPreview?.launchScopeNote
                expect(typeof note, 'mesh.promptPreview.launchScopeNote').toBe('string')
                expect(note.trim().length).toBeGreaterThan(0)
            })

            it('no longer ships the removed coordinator-prompts settings keys', () => {
                expect(bundle?.settings?.coordinatorPrompts).toBeUndefined()
                expect(bundle?.mesh?.detail?.overrideLabel).toBeUndefined()
                expect(bundle?.mesh?.detail?.repoMeshJsonOverrideLabel).toBeUndefined()
            })
        })
    }
})
