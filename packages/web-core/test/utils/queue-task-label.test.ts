import { describe, expect, it } from 'vitest'
import { queueTaskDisplayText } from '../../src/utils/queue-task-label'

describe('queueTaskDisplayText', () => {
    it('passes a plain message through unchanged', () => {
        expect(queueTaskDisplayText('Fix the flaky test in mesh-events.test.ts')).toBe('Fix the flaky test in mesh-events.test.ts')
    })

    it('strips markdown syntax but keeps the wording', () => {
        expect(queueTaskDisplayText('## Question\n**Why** does `x` fail?')).toBe('Question\nWhy does x fail?')
    })

    it('returns empty string for empty input', () => {
        expect(queueTaskDisplayText(undefined)).toBe('')
        expect(queueTaskDisplayText('   ')).toBe('')
    })
})
