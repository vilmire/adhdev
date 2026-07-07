import { describe, expect, it } from 'vitest'
import { describeQueueTaskMessage } from '../../src/utils/queue-task-label'

const MAGI_PROMPT = [
    'You are one independent member of a multi-agent cross-verification quorum (MAGI). Several other agents on different machines/providers are answering the SAME question independently; your job is a rigorous, READ-ONLY investigation. Do NOT write, edit, commit, or push anything.',
    'Task kind: rca.',
    '\n## Question\n현재 git 상태를 확인하고 문제나 변경사항을 분석해주세요.',
    '\n## Target to investigate\ngit repository',
    '\n## Output\nRespond with ONLY a single JSON object…',
].join('\n')

describe('describeQueueTaskMessage', () => {
    it('derives a readable label from a MAGI dispatch prompt', () => {
        expect(describeQueueTaskMessage(MAGI_PROMPT)).toBe(
            'MAGI cross-verify — 현재 git 상태를 확인하고 문제나 변경사항을 분석해주세요.',
        )
    })

    it('falls back to a generic MAGI label when the question section is missing', () => {
        expect(describeQueueTaskMessage('You are one independent member of a multi-agent cross-verification quorum (MAGI). No sections.')).toBe(
            'MAGI cross-verification task',
        )
    })

    it('passes non-MAGI messages through unchanged', () => {
        expect(describeQueueTaskMessage('Fix the flaky test in mesh-events.test.ts')).toBe('Fix the flaky test in mesh-events.test.ts')
    })

    it('returns empty string for empty input', () => {
        expect(describeQueueTaskMessage(undefined)).toBe('')
        expect(describeQueueTaskMessage('   ')).toBe('')
    })

    it('collapses multi-line questions to one line', () => {
        const prompt = 'You are one independent member of a multi-agent cross-verification quorum (MAGI).\n## Question\nline one\nline two\n## Output\nschema'
        expect(describeQueueTaskMessage(prompt)).toBe('MAGI cross-verify — line one line two')
    })
})
