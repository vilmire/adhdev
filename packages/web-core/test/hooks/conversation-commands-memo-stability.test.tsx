// @vitest-environment jsdom
/**
 * (COMMANDS-PROP-BUNDLE) Guards the one performance hazard introduced by
 * passing the whole command surface as a single `commands` prop.
 *
 * `PaneGroupContent` is a `React.memo` whose comparator now checks
 * `prev.commands === next.commands` — ONE reference comparison standing in for
 * the 9 fields it used to enumerate by hand. That substitution is only valid
 * while `useDashboardConversationCommands` returns a referentially stable
 * object. If its `useMemo` is ever dropped, the hook hands back a fresh literal
 * every render, the comparator returns false unconditionally, and the chat pane
 * re-renders on every parent render — a silent render amplification that no
 * type check and no behavioral test would catch.
 *
 * These tests fail loudly in that case.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { useDashboardConversationCommands } from '../../src/hooks/useDashboardConversationCommands'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Render the real hook behind a parent that can re-render WITHOUT changing any
 * hook input — the exact situation the memo exists to absorb.
 */
function renderCommandsHarness() {
    const container = document.createElement('div')
    const root = createRoot(container)
    const sendDaemonCommand = vi.fn().mockResolvedValue({ success: true })
    let latest: any = null
    let renderCount = 0

    // ★ One stable object per tabKey. The hook's handlers depend on
    // `activeConv` identity, and the real call sites hand it down from context
    // rather than rebuilding it per render — a harness that allocated a fresh
    // literal each time would measure the harness, not the memo.
    // Same reasoning as `convFor`: `handleModalButton` depends on this setter,
    // which the real call sites take from a `useState` tuple (stable identity).
    const setActionLogs = () => {}
    const convs = new Map<string, any>()
    const convFor = (tabKey: string) => {
        if (!convs.has(tabKey)) {
            convs.set(tabKey, {
                tabKey,
                routeId: `daemon-1:${tabKey}`,
                daemonId: 'daemon-1',
                sessionId: tabKey,
                status: 'idle',
            })
        }
        return convs.get(tabKey)
    }

    function Harness({ tabKey }: { tabKey: string }) {
        renderCount++
        latest = useDashboardConversationCommands({
            sendDaemonCommand,
            activeConv: convFor(tabKey),
            setActionLogs,
            isStandalone: false,
        })
        return null
    }

    return {
        get current() { return latest },
        get renderCount() { return renderCount },
        render(tabKey: string) {
            act(() => { root.render(createElement(Harness, { tabKey })) })
        },
        unmount() { act(() => { root.unmount() }) },
    }
}

describe('useDashboardConversationCommands reference stability (memo contract)', () => {
    it('returns the SAME object across a re-render with unchanged inputs', () => {
        const h = renderCommandsHarness()
        h.render('tab-1')
        const first = h.current

        h.render('tab-1')

        // ★ The load-bearing assertion. Object identity — not deep equality —
        // is what `PaneGroupContent`'s comparator relies on.
        expect(h.current).toBe(first)
        h.unmount()
    })

    it('stays stable across several consecutive no-op re-renders', () => {
        const h = renderCommandsHarness()
        h.render('tab-1')
        const first = h.current

        for (let i = 0; i < 5; i++) h.render('tab-1')

        expect(h.current).toBe(first)
        // The parent really did re-render; stability is the memo's doing, not
        // React skipping the work.
        expect(h.renderCount).toBeGreaterThan(5)
        h.unmount()
    })

    it('keeps every handler referentially stable when nothing changed', () => {
        const h = renderCommandsHarness()
        h.render('tab-1')
        const before = h.current

        h.render('tab-1')
        const after = h.current

        // A new handler identity would break the memo just as surely as a new
        // container object, so the useCallback deps are pinned here too.
        expect(after.handleSendChat).toBe(before.handleSendChat)
        expect(after.handleForceSendChat).toBe(before.handleForceSendChat)
        expect(after.handleRelaunch).toBe(before.handleRelaunch)
        expect(after.handleModalButton).toBe(before.handleModalButton)
        expect(after.handleFocusAgent).toBe(before.handleFocusAgent)
        h.unmount()
    })

    it('DOES produce a new object when the conversation actually changes', () => {
        // The complement of the above: stability must not be achieved by
        // freezing a stale object. Switching conversations changes identity so
        // the pane re-renders and picks the new command closures up.
        const h = renderCommandsHarness()
        h.render('tab-1')
        const first = h.current

        h.render('tab-2')

        expect(h.current).not.toBe(first)
        h.unmount()
    })

    it('exposes the full command surface the bundled prop promises', () => {
        const h = renderCommandsHarness()
        h.render('tab-1')

        // Mirrors `DashboardConversationCommands`. A field dropped from the
        // hook return is a silently-undefined prop at every render site.
        for (const key of [
            'isSendingChat',
            'sendFeedbackMessage',
            'lastSendQueued',
            'pendingLocalMessage',
            'isFocusingAgent',
            'handleSendChat',
            'handleForceSendChat',
            'handleRelaunch',
            'handleModalButton',
            'handleFocusAgent',
        ]) {
            expect(h.current).toHaveProperty(key)
        }
        h.unmount()
    })
})
