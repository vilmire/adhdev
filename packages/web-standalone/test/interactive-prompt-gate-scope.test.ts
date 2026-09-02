import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveInteractivePromptGateScope } from '../src/interactive-prompt-gate-scope.ts'

// Regression guard for two live defects in the standalone InteractivePromptGate.
//
// The gate used to run an UNSCOPED prompt scan on every route, on the premise —
// written into a code comment — that "standalone has no tab selection". That
// premise was false: standalone renders web-core's Dockview `Dashboard`, which
// has a real tab bar and a real selected session.
//
// Live repro that this file locks down: with `wsA` selected and no prompt of its
// own, a refresh surfaced `e2e-ws`'s question. And because the modal is a
// `fixed inset-0` overlay, the leaked prompt covered the tab bar so the user
// could not navigate to the session that actually had the question.
describe('resolveInteractivePromptGateScope', () => {
    it('scopes to the selected session from ?activeTab', () => {
        const scope = resolveInteractivePromptGateScope('/settings', 'wsA')
        assert.equal(scope.sessionId, 'wsA')
        assert.equal(scope.suppressed, false)
    })

    it('reports no selection when ?activeTab is absent, rather than inventing one', () => {
        // The gate must NOT fall back to "first prompt-bearing session in ides
        // order" here — that unscoped scan is exactly the leak being fixed.
        assert.equal(resolveInteractivePromptGateScope('/settings', null).sessionId, null)
        assert.equal(resolveInteractivePromptGateScope('/settings', undefined).sessionId, null)
    })

    it('treats a blank/whitespace ?activeTab as no selection', () => {
        assert.equal(resolveInteractivePromptGateScope('/settings', '').sessionId, null)
        assert.equal(resolveInteractivePromptGateScope('/settings', '   ').sessionId, null)
    })

    it('suppresses itself on /dashboard, which renders its own scoped modal', () => {
        // Dashboard passes activeConv into useInteractivePrompt and renders the
        // modal via DashboardOverlays. Mounting this gate there stacked a second
        // full-screen overlay on top of that one.
        assert.equal(resolveInteractivePromptGateScope('/dashboard', 'wsA').suppressed, true)
        assert.equal(resolveInteractivePromptGateScope('/dashboard?x=1', 'wsA').suppressed, true)
    })

    it('stays active on the routes that have no prompt surface of their own', () => {
        for (const path of ['/settings', '/mesh', '/about', '/notifications', '/machines/abc']) {
            assert.equal(
                resolveInteractivePromptGateScope(path, 'wsA').suppressed,
                false,
                `${path} should keep the gate mounted`,
            )
        }
    })
})
