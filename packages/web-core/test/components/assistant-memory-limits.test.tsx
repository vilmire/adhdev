// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantMemoryLimitsSection } from '../../src/components/settings/AssistantMemoryLimitsSection'
import { ASSISTANT_MEMORY_LIMITS_COMMAND } from '../../src/components/dashboard/assistant-staged'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Payload = Record<string, unknown> | undefined
type Send = (daemonId: string, type: string, payload?: Payload) => Promise<unknown>

function makeStatusResponse(overrides?: {
    memUsed?: number
    memBudget?: number
    userUsed?: number
    userBudget?: number
}) {
    const memUsed = overrides?.memUsed ?? 1892
    const memBudget = overrides?.memBudget ?? 2200
    const userUsed = overrides?.userUsed ?? 550
    const userBudget = overrides?.userBudget ?? 1375
    const memPct = Math.round((memUsed / memBudget) * 100)
    const userPct = Math.round((userUsed / userBudget) * 100)
    const memNear = memPct >= 90
    const userNear = userPct >= 90
    const memMin = Math.max(2200, memUsed)
    const userMin = Math.max(1375, userUsed)
    return {
        success: true,
        budgets: { memory: memBudget, user: userBudget },
        defaults: { memory: 2200, user: 1375 },
        min: { memory: memMin, user: userMin },
        max: { memory: 8800, user: 5500 },
        warningThresholdPct: 90,
        nearLimit: memNear || userNear,
        usage: { memory: `${memPct}%`, user: `${userPct}%` },
        memory: {
            used: memUsed,
            budget: memBudget,
            percent: memPct,
            usage: `${memPct}%`,
            nearLimit: memNear,
            defaultBudget: 2200,
            min: memMin,
            max: 8800,
        },
        user: {
            used: userUsed,
            budget: userBudget,
            percent: userPct,
            usage: `${userPct}%`,
            nearLimit: userNear,
            defaultBudget: 1375,
            min: userMin,
            max: 5500,
        },
    }
}

describe('AssistantMemoryLimitsSection', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    async function mount(send: Send, daemonId: string | null = 'daemon-1') {
        await act(async () => {
            root.render(<AssistantMemoryLimitsSection daemonId={daemonId} sendCommand={send} />)
        })
    }

    it('renders two number inputs with defaults, min/max, prompt note, and current usage below 90% without warning', async () => {
        const send = vi.fn(async () => makeStatusResponse({ memUsed: 1892, memBudget: 2200, userUsed: 550, userBudget: 1375 }))
        await mount(send)

        expect(send).toHaveBeenCalledWith('daemon-1', ASSISTANT_MEMORY_LIMITS_COMMAND, { action: 'get' })
        expect(container.textContent).toContain('Persistent memory is injected into every assistant prompt')
        expect(container.querySelector('[data-assistant-memory-settings-warning]')).toBeNull()

        const memInput = container.querySelector('[data-memory-limit-input="memory"]') as HTMLInputElement
        const userInput = container.querySelector('[data-memory-limit-input="user"]') as HTMLInputElement
        expect(memInput).toBeTruthy()
        expect(userInput).toBeTruthy()
        expect(memInput.type).toBe('number')
        expect(userInput.type).toBe('number')
        expect(memInput.value).toBe('2200')
        expect(memInput.min).toBe('2200')
        expect(memInput.max).toBe('8800')
        expect(userInput.value).toBe('1375')
        expect(userInput.min).toBe('1375')
        expect(userInput.max).toBe('5500')

        expect(container.querySelector('[data-memory-usage="memory"]')?.textContent).toContain('1,892 / 2,200 chars (86%)')
        expect(container.querySelector('[data-memory-usage="user"]')?.textContent).toContain('550 / 1,375 chars (40%)')
        expect(container.textContent).toContain('Default: 2,200 · Min: 2,200 · Max: 8,800')
        expect(container.textContent).toContain('Default: 1,375 · Min: 1,375 · Max: 5,500')
    })

    it('shows a visible warning banner in settings when MEMORY or USER usage is ≥90%', async () => {
        const send = vi.fn(async () => makeStatusResponse({ memUsed: 2178, memBudget: 2200, userUsed: 550, userBudget: 1375 }))
        await mount(send)

        const warning = container.querySelector('[data-assistant-memory-settings-warning]')
        expect(warning).toBeTruthy()
        expect(container.textContent).toContain('Assistant memory is near its limit')
        expect(container.querySelector('[data-memory-limit-card="memory"]')?.getAttribute('data-near-limit')).toBe('true')
        expect(container.querySelector('[data-memory-limit-card="user"]')?.getAttribute('data-near-limit')).toBe('false')
        expect(container.querySelector('[data-memory-usage="memory"]')?.textContent).toContain('2,178 / 2,200 chars (99%)')
    })

    it('saves updated limits via assistant_memory_limits and updates usage % and warning state', async () => {
        const send = vi.fn(async (_d: string, _t: string, payload?: Payload) => {
            if (payload?.action === 'set') {
                return makeStatusResponse({
                    memUsed: 2178,
                    memBudget: Number(payload.memory),
                    userUsed: 550,
                    userBudget: Number(payload.user),
                })
            }
            return makeStatusResponse({ memUsed: 2178, memBudget: 2200, userUsed: 550, userBudget: 1375 })
        })
        await mount(send)
        expect(container.querySelector('[data-assistant-memory-settings-warning]')).toBeTruthy()

        const memInput = container.querySelector('[data-memory-limit-input="memory"]') as HTMLInputElement
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            setter?.call(memInput, '4400')
            memInput.dispatchEvent(new Event('input', { bubbles: true }))
            memInput.dispatchEvent(new Event('change', { bubbles: true }))
        })

        const saveBtn = container.querySelector('[data-memory-limit-save]') as HTMLButtonElement
        await act(async () => {
            saveBtn.click()
        })

        expect(send).toHaveBeenCalledWith('daemon-1', ASSISTANT_MEMORY_LIMITS_COMMAND, {
            action: 'set',
            memory: 4400,
            user: 1375,
        })
        expect(container.querySelector('[data-memory-usage="memory"]')?.textContent).toContain('2,178 / 4,400 chars (50%)')
        expect(container.querySelector('[data-assistant-memory-settings-warning]')).toBeNull()
    })
})
