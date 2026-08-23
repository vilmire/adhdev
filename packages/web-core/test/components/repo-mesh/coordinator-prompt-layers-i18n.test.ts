/**
 * Coverage guard for the coordinator-prompt UI keys added with the repo-layer
 * notice + the mounted CoordinatorPromptsSection.
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

/** Keys for the read-only `.adhdev/mesh.json` layer notice (repoMesh.detail.*). */
const REPO_MESH_JSON_KEYS = [
    'repoMeshJsonTitle',
    'repoMeshJsonReadOnly',
    'repoMeshJsonHint',
    'repoMeshJsonOverrideLabel',
    'repoMeshJsonAppendLabel',
    'repoMeshJsonInvalid',
]

/** Keys naming the Settings section that mounts CoordinatorPromptsSection. */
const SECTION_KEYS = ['sectionTitle', 'sectionDescription']

describe('coordinator prompt layer i18n', () => {
    for (const [name, bundle] of Object.entries(LOCALES)) {
        describe(name, () => {
            it('defines every repo mesh.json notice key', () => {
                const detail = bundle?.repoMesh?.detail ?? {}
                for (const key of REPO_MESH_JSON_KEYS) {
                    expect(typeof detail[key], `repoMesh.detail.${key}`).toBe('string')
                    expect(detail[key].trim().length, `repoMesh.detail.${key}`).toBeGreaterThan(0)
                }
            })

            it('defines the preview launch-scope note', () => {
                const note = bundle?.repoMesh?.promptPreview?.launchScopeNote
                expect(typeof note, 'repoMesh.promptPreview.launchScopeNote').toBe('string')
                expect(note.trim().length).toBeGreaterThan(0)
            })

            it('defines the coordinator prompts settings section keys', () => {
                const group = bundle?.settings?.coordinatorPrompts ?? {}
                for (const key of SECTION_KEYS) {
                    expect(typeof group[key], `settings.coordinatorPrompts.${key}`).toBe('string')
                    expect(group[key].trim().length, `settings.coordinatorPrompts.${key}`).toBeGreaterThan(0)
                }
            })

            it('keeps the pre-existing CoordinatorPromptsSection keys intact', () => {
                // Over-correction guard: the section was already fully translated
                // before it had a mount site. Adding the section title must not
                // disturb the keys the component already renders.
                const group = bundle?.settings?.coordinatorPrompts ?? {}
                for (const key of ['overrideDesc', 'appendDesc', 'overrideLabel', 'appendLabel']) {
                    expect(typeof group[key], `settings.coordinatorPrompts.${key}`).toBe('string')
                }
            })
        })
    }
})
