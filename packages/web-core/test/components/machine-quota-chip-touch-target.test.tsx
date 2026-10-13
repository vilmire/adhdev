// @vitest-environment jsdom
/**
 * MachineQuotaChip — mobile/touch Tooltip trigger ≥44px, desktop compact.
 *
 * Production CSS (`index.css`) uses `@media (max-width: 640px), (pointer: coarse)`.
 * jsdom does not reliably evaluate those media features for getComputedStyle, so
 * runtime cases inject the *resolved* rule for synthetic widths 375 / 390 /
 * 1280 (mirroring what a browser would apply) and measure hit boxes from
 * computed min-* + a flex-row layout stub. Source assertions pin the live CSS.
 */
import fs from 'node:fs'
import path from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FleetQuotaCard from '../../src/pages/machine/FleetQuotaCard'
import { MachineQuotaChip } from '../../src/pages/machine/MachineQuotaChip'
import {
    buildQuotaDisplayModel,
    selectMachineQuotaChips,
    shortQuotaChipLabel,
} from '../../src/utils/quota-format'

const CSS_PATH = path.join(import.meta.dirname, '../../src/index.css')
const CHIP_SRC = path.join(import.meta.dirname, '../../src/pages/machine/MachineQuotaChip.tsx')

/** Resolved form of the production rule when the media query matches / misses. */
function resolvedTouchTargetCss(active: boolean): string {
    return `
.machine-quota-chip-trigger { box-sizing: border-box; }
${active ? `.machine-quota-chip-trigger {
  min-height: 44px;
  min-width: 44px;
  justify-content: center;
  align-items: center;
}` : ''}
`
}

function antigravityLive(now: number = Date.now()) {
    const gemini5h = now + 2 * 3600_000 + 35 * 60_000
    const claude5h = now + 1 * 3600_000 + 58 * 60_000
    const gemini7d = now + 28 * 3600_000
    const claude7d = now + 13 * 3600_000
    return {
        provider: 'antigravity-cli',
        status: 'ok',
        updatedAt: now,
        error: null,
        session: { usedPercent: 1.34, windowMinutes: 300, resetsAt: claude5h },
        weekly: { usedPercent: 2.35, windowMinutes: 10080, resetsAt: claude7d },
        buckets: [
            { name: 'Gemini Models · Five Hour Limit Remaining', usedPercent: 0, windowMinutes: 300, resetsAt: gemini5h },
            { name: 'Gemini Models · Weekly Limit Remaining', usedPercent: 0.32, windowMinutes: 10080, resetsAt: gemini7d },
            { name: 'Claude and GPT models · Five Hour Limit Remaining', usedPercent: 1.34, windowMinutes: 300, resetsAt: claude5h },
            { name: 'Claude and GPT models · Weekly Limit Remaining', usedPercent: 2.35, windowMinutes: 10080, resetsAt: claude7d },
        ],
    } as any
}

function parsePx(value: string): number {
    if (!value || value === 'none' || value === 'auto') return 0
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : 0
}

/** Whether production media query would match at this synthetic viewport. */
function mediaQueryActive(width: number, coarse = false): boolean {
    return width <= 640 || coarse
}

function placeRowHitBoxes(triggers: HTMLElement[], gapPx = 4) {
    let x = 0
    return triggers.map((el) => {
        const style = window.getComputedStyle(el)
        const w = Math.max(parsePx(style.minWidth), parsePx(style.width) || 0, 1)
        const h = Math.max(parsePx(style.minHeight), parsePx(style.height) || 0, 1)
        const left = x
        x += w + gapPx
        const rect = { x: left, y: 0, top: 0, left, right: left + w, bottom: h, width: w, height: h, toJSON: () => ({}) }
        el.getBoundingClientRect = () => rect
        return rect
    })
}

let container: HTMLDivElement
let root: Root
let styleEl: HTMLStyleElement

beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    styleEl = document.createElement('style')
    document.head.appendChild(styleEl)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    styleEl.remove()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})

describe('MachineQuotaChip touch target — source contract', () => {
    it('wires the shared trigger class, compact pill, and ≥44px media rule', () => {
        const src = fs.readFileSync(CHIP_SRC, 'utf8')
        expect(src).toContain('className="machine-quota-chip-trigger"')
        expect(src).toContain('min-h-5')
        expect(src).not.toContain('-m-')
        const css = fs.readFileSync(CSS_PATH, 'utf8')
        expect(css).toContain('.machine-quota-chip-trigger')
        expect(css).toContain('@media (max-width: 640px), (pointer: coarse)')
        expect(css).toContain('min-height: 44px')
        expect(css).toContain('min-width: 44px')
    })
})

describe('MachineQuotaChip touch target — synthetic viewports', () => {
    it.each([375, 390] as const)(
        'viewport %ipx → Tooltip trigger hit box ≥44×44, no sibling overlap, pools intact',
        (width) => {
            expect(mediaQueryActive(width)).toBe(true)
            styleEl.textContent = resolvedTouchTargetCss(true)
            Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })

            const now = Date.now()
            const model = buildQuotaDisplayModel(antigravityLive(now), now)
            const chips = selectMachineQuotaChips(model, 'fleet')
            expect(chips).toHaveLength(4)

            act(() => {
                root.render(
                    <div className="flex flex-wrap gap-1" style={{ width }}>
                        {chips.map((chip) => (
                            <MachineQuotaChip
                                key={chip.key}
                                chip={chip}
                                kindHint="bucket"
                                label={shortQuotaChipLabel(chip)}
                                now={now}
                                locale="en-US"
                            />
                        ))}
                    </div>,
                )
            })

            const triggers = Array.from(container.querySelectorAll<HTMLElement>('.machine-quota-chip-trigger'))
            expect(triggers).toHaveLength(4)

            for (const el of triggers) {
                const style = window.getComputedStyle(el)
                expect(parsePx(style.minHeight)).toBeGreaterThanOrEqual(44)
                expect(parsePx(style.minWidth)).toBeGreaterThanOrEqual(44)
            }

            const placed = placeRowHitBoxes(triggers)
            for (const rect of placed) {
                expect(rect.height).toBeGreaterThanOrEqual(44)
                expect(rect.width).toBeGreaterThanOrEqual(44)
            }
            for (let i = 0; i < placed.length - 1; i++) {
                expect(placed[i]!.right).toBeLessThanOrEqual(placed[i + 1]!.left)
            }

            expect(container.querySelector('[data-machine-quota-chip="Gemini 5h"]')).toBeTruthy()
            expect(container.querySelector('[data-machine-quota-chip="Claude and GPT 5h"]')).toBeTruthy()
            expect(container.textContent).toMatch(/resets .+ · resets in/)
            for (const trigger of triggers) {
                expect(trigger.getAttribute('tabindex')).toBe('0')
                expect(trigger.querySelector('[data-machine-quota-chip]')?.className).toContain('min-h-5')
            }
        },
    )

    it('desktop 1280px fine pointer keeps compact trigger (no forced 44px min)', () => {
        expect(mediaQueryActive(1280, false)).toBe(false)
        styleEl.textContent = resolvedTouchTargetCss(false)
        Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true })

        const now = Date.now()
        const model = buildQuotaDisplayModel(antigravityLive(now), now)
        const chip = selectMachineQuotaChips(model, 'row').find((c) => c.key === 'Gemini 5h')!

        act(() => {
            root.render(
                <MachineQuotaChip
                    chip={chip}
                    kindHint="Per-pool quota bucket"
                    label={shortQuotaChipLabel(chip)}
                    now={now}
                    locale="en-US"
                />,
            )
        })

        const trigger = container.querySelector<HTMLElement>('.machine-quota-chip-trigger')!
        expect(trigger).toBeTruthy()
        const style = window.getComputedStyle(trigger)
        expect(parsePx(style.minHeight)).toBe(0)
        expect(parsePx(style.minWidth)).toBe(0)
        expect(trigger.querySelector('[data-machine-quota-chip]')?.className).toContain('min-h-5')
        expect(container.textContent).toMatch(/resets .+ · resets in/)
        // Unknown path still explicit on a null-reset chip.
        const unknown = selectMachineQuotaChips(
            buildQuotaDisplayModel({
                provider: 'codex-cli', status: 'ok', updatedAt: now, error: null,
                session: { usedPercent: 5, windowMinutes: 300, resetsAt: null },
                weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null },
            } as any, now),
            'row',
        )[0]!
        act(() => {
            root.render(<MachineQuotaChip chip={unknown} kindHint="session hint" label={shortQuotaChipLabel(unknown)} now={now} />)
        })
        expect(container.textContent).toContain('reset time unknown')
    })

    it('FleetQuotaCard Antigravity row uses the same ≥44px triggers at 390px', () => {
        styleEl.textContent = resolvedTouchTargetCss(true)
        Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })

        const now = Date.now()
        act(() => {
            root.render(
                <MemoryRouter>
                    <FleetQuotaCard
                        machines={[{
                            machineId: 'm1',
                            label: 'mac',
                            quota: { 'antigravity-cli': antigravityLive(now) },
                        }]}
                    />
                </MemoryRouter>,
            )
        })

        const triggers = Array.from(container.querySelectorAll<HTMLElement>('.machine-quota-chip-trigger'))
        expect(triggers.length).toBeGreaterThanOrEqual(4)
        for (const el of triggers) {
            const style = window.getComputedStyle(el)
            expect(parsePx(style.minHeight)).toBeGreaterThanOrEqual(44)
            expect(parsePx(style.minWidth)).toBeGreaterThanOrEqual(44)
        }
        const placed = placeRowHitBoxes(triggers)
        for (let i = 0; i < placed.length - 1; i++) {
            expect(placed[i]!.right).toBeLessThanOrEqual(placed[i + 1]!.left)
        }
        expect(container.textContent).toContain('Gemini 5h')
        expect(container.textContent).toContain('Claude and GPT')
        expect(container.textContent).toMatch(/resets .+ · resets in/)
    })
})
