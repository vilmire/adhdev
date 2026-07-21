/**
 * Kimi K3 provider-spec fixture coverage.
 *
 * kimi-code v0.28.1 introduced a new "K3" model (config.toml alias `k3`,
 * default_model on upgraded installs) that the shipped provider.v1.json did
 * not expose for selection, plus two TUI-rendering changes the manifest's
 * declarative `tui` block didn't recognize (all verified live against the
 * real kimi-code v0.28.1 binary on 2026-07-21):
 *   - a braille "working..." spinner during tool-execution phases, distinct
 *     from the existing MCP-connect braille spinner and the moon-phase
 *     "· Tip:" spinner,
 *   - a one-time K3 onboarding banner ("✦ Use Kimi K3 with High thinking
 *     effort ... Run /model to switch to K3 ...") not covered by any
 *     chromePattern.
 *
 * This test loads the SHIPPING spec from adhdev-providers (the SSOT the
 * daemon loads at runtime) and drives the real declarative builders against
 * live-captured sample text. It is skipped — not failed — when that sibling
 * repo isn't checked out, so daemon-core's own CI never depends on the
 * providers repo layout (mirrors claude-cli-approval-spinner-wedge.test.ts).
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateProviderDefinition } from '../src/providers/provider-schema.js'
import { buildDetectStatusFromTui, type DetectStatusTuiSpec } from '../src/providers/sdk/v1/builders/cli/detect-status.js'
import type { CliScreenSnapshot, CliStatusInput } from '../src/providers/sdk/v1/types/cli/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SPEC_PATH = path.resolve(HERE, '../../../../adhdev-providers/cli/kimi/provider.v1.json')

const specAvailable = fs.existsSync(SPEC_PATH)
const maybe = specAvailable ? describe : describe.skip

function emptyScreen(text: string): CliScreenSnapshot {
    return {
        text,
        lineCount: text.split('\n').length,
        lines: [],
        nonEmptyLines: [],
        firstNonEmptyLineIndex: -1,
        lastNonEmptyLineIndex: -1,
        firstNonEmptyLine: null,
        lastNonEmptyLine: null,
        promptLineIndex: -1,
        promptLine: null,
        linesAbovePrompt: [],
        linesBelowPrompt: [],
    }
}

function statusInput(screenText: string, isWaitingForResponse = true): CliStatusInput {
    return {
        tail: screenText.split('\n').slice(-12).join('\n'),
        screenText,
        rawBuffer: screenText,
        isWaitingForResponse,
        screen: emptyScreen(screenText),
        tailScreen: emptyScreen(screenText),
    }
}

maybe('kimi provider.v1.json — K3 fixture coverage', () => {
    if (!specAvailable) return
    const raw = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'))

    it('validates cleanly against the provider schema (no new errors)', () => {
        const result = validateProviderDefinition(raw)
        expect(result.errors).toEqual([])
    })

    it('exposes the K3 model for selection via the fully-qualified modelOptions identifier', () => {
        // Live-verified against the real kimi-code v0.28.1 binary: a bare
        // model name (e.g. "k3", or the pre-existing "kimi-for-coding") is
        // accepted at CLI startup with no validation — the welcome banner
        // shows "Model: k3" — but EVERY subsequent generation request then
        // fails with config.invalid: Model "k3" is not configured in
        // config.toml. Only the fully-qualified "kimi-code/<alias>" form
        // (matching config.toml's top-level model table keys) actually
        // resolves and generates. This affects `-m` in both interactive/TUI
        // mode (the daemon's real launch path) and non-interactive -p mode.
        expect(raw.modelOptions).toEqual([
            'kimi-code/kimi-for-coding',
            'kimi-code/kimi-for-coding-highspeed',
            'kimi-code/k3',
        ])
        expect(raw.modelOptions).not.toContain('k3')
        expect(raw.modelOptions).not.toContain('kimi-for-coding')
        expect(raw.modelOptions).not.toContain('kimi-for-coding-highspeed')
    })

    describe('declarative detectStatus against live-captured K3 screens', () => {
        const spec: DetectStatusTuiSpec = {
            spinner: raw.tui.spinner,
            settledPrompt: raw.tui.settledPrompt,
            modal: raw.tui.modal,
            dispatchOrder: raw.tui.dispatchOrder,
        }
        const detect = buildDetectStatusFromTui(spec)

        it('recognizes the braille "working..." spinner as generating (kimi-code v0.28.1 tool-execution phase)', () => {
            // Captured live from responseBuffer during a real K3 tool-use turn.
            const screen = [
                ' ● Ran a command',
                '   $ echo APPROVAL_TEST_MARKER > marker.txt',
                '',
                '  ⠙ working...',
                '',
                ' ╭────────────────────────────────────────────────────────────────╮',
                ' │ >                                                                │',
                ' ╰────────────────────────────────────────────────────────────────╯',
                ' K3 thinking: high  /private/tmp/adhdev-kimi-probe-runC',
            ].join('\n')
            expect(detect(statusInput(screen))).toBe('generating')
        })

        it('still recognizes the existing moon-phase spinner as generating (no regression)', () => {
            const screen = [
                ' ✨ What is 17*23?',
                '',
                ' 🌓 · Tip: /plugins: manage plugins — try the "superpowers" plugin',
            ].join('\n')
            expect(detect(statusInput(screen))).toBe('generating')
        })

        it('still recognizes the existing MCP-connect braille spinner as generating (no regression)', () => {
            const screen = ['⠙ MCP server "search" connecting...'].join('\n')
            expect(detect(statusInput(screen))).toBe('generating')
        })

        it('still recognizes the settled input box as idle when no spinner/modal is present', () => {
            const screen = [
                ' ● 391',
                '',
                ' ╭────────────────────────────────────────────────────────────────╮',
                ' │ >                                                                │',
                ' ╰────────────────────────────────────────────────────────────────╯',
                ' K3 thinking: high  /private/tmp/adhdev-kimi-probe-runA',
            ].join('\n')
            expect(detect(statusInput(screen, false))).toBe('idle')
        })
    })

    describe('transcriptPty chromePatterns cover the new K3 UI elements', () => {
        const chromePatterns: Array<{ regex: string; flags?: string; label: string }> = raw.tui.transcriptPty.chromePatterns

        function matchesAny(text: string): boolean {
            return chromePatterns.some((p) => new RegExp(p.regex, p.flags || '').test(text))
        }

        it('matches the K3 onboarding banner', () => {
            const banner = '✦ Use Kimi K3 with High thinking effort - for the best balance between token'
            expect(matchesAny(banner)).toBe(true)
            expect(matchesAny('Run /model to switch to K3 and set thinking effort to High')).toBe(true)
        })

        it('matches the braille "working..." spinner line', () => {
            expect(matchesAny('  ⠙ working...')).toBe(true)
        })

        it('does not match ordinary assistant/user content (no over-broad regex)', () => {
            expect(matchesAny('391 + 100 = 491.')).toBe(false)
            expect(matchesAny('Created hello.txt containing HELLO.')).toBe(false)
        })
    })
})
