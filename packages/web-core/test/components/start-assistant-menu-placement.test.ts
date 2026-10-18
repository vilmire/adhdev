/** The start-assistant menu always fits on screen (2026-10-18: on a phone it ran past the bottom). */
import { describe, expect, it } from 'vitest'
import { placeAssistantMenu } from '../../src/components/dashboard/StartAssistantButton'

const phone = { width: 390, height: 700 }

describe('placeAssistantMenu', () => {
    it('opens down when there is room, sized to the room left', () => {
        const p = placeAssistantMenu({ top: 100, bottom: 136, left: 200 }, phone) as any
        expect(p.top).toBe(142)
        expect(p.maxHeight).toBe(700 - 136 - 6 - 8)
        expect(p.left).toBe(390 - 280 - 8)
    })
    it('opens up when the button is low and there is more room above', () => {
        const p = placeAssistantMenu({ top: 520, bottom: 556, left: 20 }, phone) as any
        expect(p.top).toBeUndefined()
        expect(p.bottom).toBe(700 - 520 + 6)
        expect(p.maxHeight).toBe(520 - 6 - 8)
    })
    it('never ends below the screen', () => {
        for (const top of [40, 200, 360, 480, 600]) {
            const p = placeAssistantMenu({ top, bottom: top + 36, left: 0 }, phone) as any
            if ('top' in p) expect(p.top + p.maxHeight).toBeLessThanOrEqual(phone.height)
            else expect(phone.height - p.bottom - p.maxHeight).toBeGreaterThanOrEqual(0)
        }
    })
})
