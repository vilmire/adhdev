/**
 * QUOTED-MARKER FALSE PROMPT (live defect, 2026-08-28)
 *
 * maybeCaptureClaudeTuiPrompt scrapes the terminal screen, so a session that
 * merely PRINTS the picker's marker strings ("Enter to select", "✔ Submit",
 * "❐ 1. …") — quoting a TUI layout in its own output — was captured as a live
 * picker and published a phony waiting_choice prompt (observed as promptId
 * ask-user-tui-5eeccf8a while the session was generating).
 *
 * Defence: gate the capture on the FSM status. The claude spec has a dedicated
 * `picker` state whose status falls through to idle, and its `busy` state
 * transitions explicitly NOT-match the picker footer — so a REAL picker is
 * never reported as generating, while quoted output in mid-turn scrollback is.
 * Same cross-check the kimi built-in selector already applies.
 */
import { describe, expect, it } from 'vitest'
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js'

const PICKER_SCREEN = [
    '워커 MCP 격리를 어떻게 적용할까요?',
    '',
    '❯ 1. 세션 바인딩 교환 (권장)',
    '  2. 클레임 시 config 재작성',
    '  3. Type something.',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

function makeAdapter(status: 'idle' | 'generating', screen: string): any {
    const adapter = Object.create(SpecCliAdapter.prototype)
    Object.assign(adapter, {
        cliType: 'claude-cli',
        cliName: 'claude-cli',
        spawned: true,
        exited: false,
        activeInteractivePrompt: null,
        interactivePromptTransport: null,
        interactivePromptLostAt: null,
        claudeTuiPromptCaptureInFlight: false,
        claudeTuiCaptureSuppressed: false,
        claudeTuiCaptureFooterAbsentAt: null,
        claudeTuiCaptureFailures: null,
        latestState: { id: status === 'generating' ? 'busy' : 'picker', label: 'x', title: null, status },
        latestModal: null,
        statusCallback: () => { /* noop */ },
        spec: { id: 'claude-cli', name: 'claude-cli' },
        driver: {
            snapshot: () => screen,
            dispatch: () => { /* noop */ },
            hasSeenReady: () => true,
        },
    })
    return adapter
}

describe('claude TUI capture — quoted marker defence', () => {
    it('does not capture a prompt from picker markers quoted while generating', () => {
        // The agent is mid-turn and its own output happens to contain the
        // picker's marker strings. No prompt may be published.
        const adapter = makeAdapter('generating', PICKER_SCREEN)
        adapter.maybeCaptureClaudeTuiPrompt()
        expect(adapter.activeInteractivePrompt).toBeNull()
    })

    it('still captures a real picker (FSM reports the picker state, not generating)', () => {
        // REGRESSION GUARD: the gate above must not suppress genuine prompts.
        // The claude spec's `picker` state carries no status field, so it maps
        // to idle — this is why gating on `generating` is safe.
        const adapter = makeAdapter('idle', PICKER_SCREEN)
        adapter.maybeCaptureClaudeTuiPrompt()
        expect(adapter.activeInteractivePrompt).not.toBeNull()
        expect(adapter.activeInteractivePrompt.questions[0].question)
            .toBe('워커 MCP 격리를 어떻게 적용할까요?')
        expect(adapter.interactivePromptTransport).toBe('tui')
    })
})
