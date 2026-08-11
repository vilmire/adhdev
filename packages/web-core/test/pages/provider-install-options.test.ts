import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// INSTALL-TIME PROVIDER OPTIONS — quota tracking + auto-approve, asked when a
// provider is switched on from the machine page.
//
// The contracts that matter here are about STORAGE and HONESTY, not layout:
//
//  - No new store. Both controls write the same daemon commands the standing
//    surfaces write (`set_quota_provider_enabled`, `set_provider_setting`), so
//    the modal, the provider row and `adhdev setup` are three views of one
//    value in the daemon's config.json. A second store is how the web and CLI
//    halves would silently disagree.
//  - Nothing is persisted on cancel — including the enable itself, so a
//    cancelled install cannot leave the provider live under options the user
//    just declined.
//  - The quota row is offered ONLY for providers with a shipped fetcher. A
//    checkbox that collects nothing would be a lie told at the exact moment the
//    user is deciding.
//  - Auto-approve defaults ON (owner decision), so its copy has to state what
//    is SKIPPED rather than merely calling itself "automatic".

const MODAL = path.join(import.meta.dirname, '../../src/pages/machine/ProviderInstallOptionsModal.tsx')
const TAB = path.join(import.meta.dirname, '../../src/pages/machine/ProvidersTab.tsx')
const modalSource = fs.readFileSync(MODAL, 'utf8')
const tabSource = fs.readFileSync(TAB, 'utf8')

const LOCALES = ['en', 'ko', 'ja', 'zh-CN', 'es']
const dict = (lang: string) => JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, `../../src/i18n/locales/${lang}/common.json`), 'utf8'),
)

describe('install options — when it is asked', () => {
    it('opens on enable and returns before writing anything', () => {
        expect(tabSource).toContain('if (enabled) {\n            setInstallOptionsFor(providerType)\n            return\n        }')
    })

    it('disabling never asks — it writes false directly', () => {
        expect(tabSource).toContain("await handleSetSetting(providerType, 'enabled', false)")
    })

    it('cancelling closes without persisting', () => {
        // The only cancel path clears the modal state; no command is sent.
        expect(tabSource).toContain('onCancel={() => setInstallOptionsFor(null)}')
    })
})

describe('install options — storage is the existing one', () => {
    it('quota rides set_quota_provider_enabled, the machine page command', () => {
        expect(tabSource).toContain("'set_quota_provider_enabled'")
    })

    it('autoApprove rides set_provider_setting, the manifest-setting command', () => {
        expect(tabSource).toContain("key: 'autoApprove'")
        expect(tabSource).toContain("'set_provider_setting'")
    })

    it('writes the options BEFORE enabling', () => {
        // Enabling is what makes a provider claimable/launchable. Writing it
        // last means there is no window where it is live under declined options.
        const autoApproveAt = tabSource.indexOf("key: 'autoApprove'")
        const enabledAt = tabSource.indexOf("key: 'enabled',\n                value: true,")
        expect(autoApproveAt).toBeGreaterThan(-1)
        expect(enabledAt).toBeGreaterThan(-1)
        expect(autoApproveAt).toBeLessThan(enabledAt)
    })

    it('omits the quota write entirely when the provider has no fetcher', () => {
        expect(tabSource).toContain('if (options.quotaEnabled !== undefined) {')
    })
})

describe('install options — quota is offered only where it works', () => {
    it('the tab gates the row on the shared support list', () => {
        expect(tabSource).toContain('supportsQuota={QUOTA_PROVIDERS.has(installOptionsFor)}')
    })

    it('the modal renders no quota row when unsupported', () => {
        expect(modalSource).toContain('{supportsQuota && (')
    })

    it('confirm reports undefined quota for unsupported providers', () => {
        expect(modalSource).toContain('quotaEnabled: supportsQuota ? quotaEnabled : undefined')
    })

    it('claude gets the statusLine side-effect note, nobody else does', () => {
        expect(tabSource).toContain("quotaInstallsClaudeStatusline={installOptionsFor === 'claude-cli'}")
        expect(modalSource).toContain('{quotaInstallsClaudeStatusline && quotaEnabled && (')
    })
})

describe('install options — defaults', () => {
    it('both checkboxes default ON', () => {
        expect(modalSource).toContain('useState(true)\n    const [autoApprove, setAutoApprove] = useState(true)')
    })
})

describe('install options — the copy tells the truth', () => {
    it('auto-approve says what is skipped, not just that it is automatic', () => {
        const copy = dict('en').machine.installOptions
        // It defaults ON, so a user must be able to learn the consequence by
        // reading it once: that the prompt disappears and the action proceeds.
        expect(copy.autoApproveHint).toMatch(/permission|approval/i)
        expect(copy.autoApproveHint).toMatch(/will not see|without waiting/i)
        expect(copy.autoApproveWarning).toMatch(/without asking/i)
    })

    it('quota copy states that OFF stops collection, not just display', () => {
        expect(dict('en').machine.installOptions.quotaHint).toMatch(/nothing is collected|stops the reads/i)
    })

    it('the claude note names the file it modifies', () => {
        expect(dict('en').machine.installOptions.quotaClaudeNote).toContain('~/.claude/settings.json')
    })

    it('every key exists in all shipped locales', () => {
        const keys = Object.keys(dict('en').machine.installOptions)
        expect(keys.length).toBeGreaterThan(0)
        for (const lang of LOCALES) {
            const block = dict(lang).machine?.installOptions
            expect(block, `${lang} is missing machine.installOptions`).toBeTruthy()
            for (const key of keys) {
                expect(block[key], `${lang} is missing installOptions.${key}`).toBeTruthy()
            }
        }
    })

    it('the title interpolates the provider name in every locale', () => {
        for (const lang of LOCALES) {
            expect(dict(lang).machine.installOptions.title, lang).toContain('{{provider}}')
        }
    })
})
