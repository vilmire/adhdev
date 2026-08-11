import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import ProviderInstallOptionsModal from '../../src/pages/machine/ProviderInstallOptionsModal'

// RENDER CHECK for the install-options modal — the source-level contracts live
// in provider-install-options.test.ts; this one boots the real component with
// the real i18n instance (test/setup.ts) and asserts what a user actually SEES.
//
// It exists because a source assertion cannot catch a key that renders as its
// own name: `t('machine.installOptions.autoApproveHint')` matching in the file
// proves the call, not that the string resolves. For a control that defaults to
// ON and suppresses approval prompts, "the warning text actually appears" is
// the property worth pinning.

function render(props: Partial<React.ComponentProps<typeof ProviderInstallOptionsModal>> = {}) {
    return renderToStaticMarkup(
        React.createElement(ProviderInstallOptionsModal, {
            providerType: 'codex-cli',
            displayName: 'Codex CLI',
            supportsQuota: true,
            quotaInstallsClaudeStatusline: false,
            onCancel: () => {},
            onConfirm: () => {},
            ...props,
        }),
    )
}

describe('install options modal — rendered output', () => {
    it('resolves every string (no raw i18n keys leak through)', () => {
        expect(render()).not.toContain('machine.installOptions.')
    })

    it('names the provider being set up', () => {
        expect(render({ displayName: 'Codex CLI' })).toContain('Codex CLI')
    })

    it('shows both checkboxes checked by default', () => {
        const html = render()
        const checkboxes = html.match(/<input type="checkbox"[^>]*>/g) ?? []
        expect(checkboxes).toHaveLength(2)
        expect(checkboxes.every((box) => box.includes('checked'))).toBe(true)
    })

    it('states the auto-approve consequence in the visible text', () => {
        // The user must be able to learn, by reading, that commands will run
        // without a prompt — this defaults ON.
        const html = render()
        expect(html).toContain('without asking you first')
        expect(html).toMatch(/will not see the approval prompt/i)
    })

    it('renders no quota checkbox for a provider that cannot report quota', () => {
        const html = render({ supportsQuota: false, providerType: 'cursor-cli', displayName: 'Cursor CLI' })
        expect(html.match(/<input type="checkbox"[^>]*>/g) ?? []).toHaveLength(1)
        expect(html).not.toContain('Track plan usage')
    })

    it('warns about the ~/.claude/settings.json write only for claude', () => {
        const claude = render({
            providerType: 'claude-cli',
            displayName: 'Claude Code',
            quotaInstallsClaudeStatusline: true,
        })
        expect(claude).toContain('~/.claude/settings.json')
        expect(render()).not.toContain('~/.claude/settings.json')
    })
})
