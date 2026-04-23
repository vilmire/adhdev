import { describe, expect, it, vi } from 'vitest'
import {
    buildApprovalToastDescriptors,
    buildViewRequestToastActions,
    cleanApprovalButtonText,
    formatApprovalToastMessage,
} from '../../src/managers/event-manager-helpers'

describe('event-manager-helpers', () => {
    it('normalizes approval button labels and variants', () => {
        expect(cleanApprovalButtonText('⌘↵ Allow once')).toBe('Allow once')

        expect(buildApprovalToastDescriptors([
            '⌘↵ Allow once',
            'Esc Deny',
            'Maybe later',
        ])).toEqual([
            {
                label: 'Allow once',
                variant: 'primary',
                action: 'approve',
                button: '⌘↵ Allow once',
                buttonIndex: 0,
            },
            {
                label: 'Deny',
                variant: 'danger',
                action: 'reject',
                button: 'Esc Deny',
                buttonIndex: 1,
            },
            {
                label: 'Maybe later',
                variant: 'default',
                action: 'reject',
                button: 'Maybe later',
                buttonIndex: 2,
            },
        ])
    })

    it('formats approval toast text for modal message and fallback contexts', () => {
        expect(formatApprovalToastMessage('MacBook/Cursor', 'Line 1\nLine 2', 'fallback'))
            .toBe('⚡ MacBook/Cursor: Line 1 Line 2')

        expect(formatApprovalToastMessage('MacBook/Cursor', undefined, 'fallback'))
            .toBe('fallback')
    })

    it('wires view request actions to the provided responder', async () => {
        const respond = vi.fn().mockResolvedValue(undefined)
        const onError = vi.fn()
        const actions = buildViewRequestToastActions('org_1', 'req_1', respond, onError)

        actions[0].onClick()
        actions[1].onClick()
        await Promise.resolve()

        expect(respond).toHaveBeenNthCalledWith(1, 'org_1', 'req_1', 'approve')
        expect(respond).toHaveBeenNthCalledWith(2, 'org_1', 'req_1', 'reject')
        expect(onError).not.toHaveBeenCalled()
    })
})
