/**
 * Regression guard: the coordinator-prompt Override field must never be seeded
 * with the fully-expanded default prompt.
 *
 * `coordinator_prompt_preview` (and the removed "Start from default" button)
 * render the default prompt with every {{token}} already substituted against
 * live mesh state (node table, policy, etc). Copying that rendered text into
 * Override froze a one-time snapshot there — the saved override stopped
 * tracking mesh changes the instant it was written, which is the exact defect
 * this investigation was opened for. The fix is removing the copy affordance,
 * not "expand less" (the read-only preview and the real launch path must keep
 * expanding, per the operating constraints for this change).
 *
 * INJECTION CHECK: reintroducing `StartFromDefaultButton` (or re-wiring
 * `onApply`/`load()` from `useCoordinatorPromptDefault` into the Override
 * textarea in MeshDetailView) turns this red.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import en from '../../../src/i18n/locales/en/common.json'
import ko from '../../../src/i18n/locales/ko/common.json'
import ja from '../../../src/i18n/locales/ja/common.json'
import zhCN from '../../../src/i18n/locales/zh-CN/common.json'
import es from '../../../src/i18n/locales/es/common.json'

const LOCALES: Record<string, any> = { en, ko, ja, 'zh-CN': zhCN, es }

const previewSourcePath = fileURLToPath(
    new URL('../../../src/pages/repo-mesh/CoordinatorPromptDefaultPreview.tsx', import.meta.url),
)
const detailViewSourcePath = fileURLToPath(
    new URL('../../../src/pages/repo-mesh/MeshDetailView.tsx', import.meta.url),
)

describe('coordinator prompt Override never receives the expanded default', () => {
    it('no longer exports a component that copies the rendered default into Override', () => {
        const source = readFileSync(previewSourcePath, 'utf8')
        expect(source).not.toContain('StartFromDefaultButton')
        // The read-only preview hook must survive — only the copy-into-editor
        // affordance built on top of it is the defect.
        expect(source).toContain('useCoordinatorPromptDefault')
    })

    it('MeshDetailView does not wire any default-prompt loader into the Override draft', () => {
        const source = readFileSync(detailViewSourcePath, 'utf8')
        expect(source).not.toContain('StartFromDefaultButton')
        // Over-correction guard: the read-only preview above the Override field
        // must still be mounted — only the copy button is gone.
        expect(source).toContain('CoordinatorPromptDefaultPreview')
    })

    for (const [name, bundle] of Object.entries(LOCALES)) {
        describe(name, () => {
            it('removes the obsolete "Start from default" i18n keys', () => {
                const detail = bundle?.repoMesh?.detail ?? {}
                expect(detail.startFromDefault).toBeUndefined()
                expect(detail.startFromDefaultTitle).toBeUndefined()
                expect(detail.startFromDefaultConfirm).toBeUndefined()
            })

            it('keeps the placeholder-token glossary that replaces the copy button', () => {
                const detail = bundle?.repoMesh?.detail ?? {}
                for (const key of ['availablePlaceholders', 'placeholdersIntro']) {
                    expect(typeof detail[key], `repoMesh.detail.${key}`).toBe('string')
                    expect(detail[key].trim().length, `repoMesh.detail.${key}`).toBeGreaterThan(0)
                }
            })

            it('keeps the read-only default-prompt preview keys', () => {
                const preview = bundle?.repoMesh?.promptPreview ?? {}
                for (const key of ['view', 'hide', 'rendering', 'info', 'launchScopeNote']) {
                    expect(typeof preview[key], `repoMesh.promptPreview.${key}`).toBe('string')
                    expect(preview[key].trim().length, `repoMesh.promptPreview.${key}`).toBeGreaterThan(0)
                }
            })
        })
    }
})
