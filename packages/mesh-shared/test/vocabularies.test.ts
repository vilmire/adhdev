import { describe, expect, it } from 'vitest'
import {
    SESSION_STATUSES,
    SESSION_STATUS_CLASS,
    SESSION_STATUS_ALIASES,
    classifySessionStatus,
    isBusyStatus,
    isDeadStatus,
    normalizeSessionStatus,
    statusesOfClass,
} from '../src/session-status'
import {
    MESH_TASK_STATUSES,
    MESH_TERMINAL_TASK_STATUSES,
    MESH_TASK_MODES,
    enumOf,
    isMeshTaskStatus,
    isMeshTerminalTaskStatus,
} from '../src/mesh-vocabulary'
import {
    WORKER_TOOLS,
    appendWorkerProtocolFooter,
    hasWorkerProtocolFooter,
    renderCoordinatorWorkerSection,
    renderWorkerProtocolFooter,
} from '../src/worker-protocol'

describe('session-status vocabulary', () => {
    it('classifies every canonical member (the class map is total)', () => {
        for (const status of SESSION_STATUSES) {
            expect(SESSION_STATUS_CLASS[status]).toBeDefined()
            expect(classifySessionStatus(status)).not.toBe('unknown')
        }
    })

    it('maps every alias onto a canonical member', () => {
        for (const [alias, target] of Object.entries(SESSION_STATUS_ALIASES)) {
            expect(SESSION_STATUSES).toContain(target)
            expect(normalizeSessionStatus(alias)).toBe(target)
        }
    })

    it('agrees with the pre-unification busy semantics that the five old sets shared', () => {
        // Working
        for (const raw of ['generating', 'running', 'streaming', 'starting', 'no_progress', 'long_generating', 'GENERATING ']) {
            expect(classifySessionStatus(raw)).toBe('working')
            expect(isBusyStatus(raw)).toBe(true)
        }
        // Blocked on a human — busy for delivery purposes, alive
        for (const raw of ['waiting_approval', 'waiting_choice', 'waiting']) {
            expect(classifySessionStatus(raw)).toBe('blocked')
            expect(isBusyStatus(raw)).toBe(true)
            expect(isDeadStatus(raw)).toBe(false)
        }
        // Ready
        for (const raw of ['idle', 'panel_hidden', 'not_monitored']) {
            expect(classifySessionStatus(raw)).toBe('ready')
            expect(isBusyStatus(raw)).toBe(false)
        }
        // Dead is not busy — callers must check it first
        for (const raw of ['error', 'stopped', 'disconnected']) {
            expect(isDeadStatus(raw)).toBe(true)
            expect(isBusyStatus(raw)).toBe(false)
        }
        // Unknown spellings never classify as ready by accident
        expect(classifySessionStatus('online')).toBe('unknown')
        expect(classifySessionStatus(undefined)).toBe('unknown')
        expect(isBusyStatus('what')).toBe(false)
    })

    it('statusesOfClass partitions the vocabulary', () => {
        const all = [...statusesOfClass('working'), ...statusesOfClass('blocked'), ...statusesOfClass('ready'), ...statusesOfClass('dead')]
        expect([...all].sort()).toEqual([...SESSION_STATUSES].sort())
    })
})

describe('mesh vocabulary', () => {
    it('task status has exactly the five states a queue row can hold', () => {
        expect([...MESH_TASK_STATUSES]).toEqual(['pending', 'assigned', 'completed', 'failed', 'cancelled'])
        expect(isMeshTaskStatus('in_progress')).toBe(false)
        for (const terminal of MESH_TERMINAL_TASK_STATUSES) {
            expect(isMeshTaskStatus(terminal)).toBe(true)
            expect(isMeshTerminalTaskStatus(terminal)).toBe(true)
        }
        expect(isMeshTerminalTaskStatus('assigned')).toBe(false)
    })

    it('enumOf derives a JSON-schema fragment from the tuple', () => {
        expect(enumOf(MESH_TASK_MODES, 'x')).toEqual({ type: 'string', enum: [...MESH_TASK_MODES], description: 'x' })
        expect(enumOf(MESH_TASK_MODES)).not.toHaveProperty('description')
    })
})

describe('worker protocol', () => {
    it('footer names every worker tool and is idempotent', () => {
        const footer = renderWorkerProtocolFooter({ taskId: 't1', taskMode: 'code_change', difficulty: 'medium' })
        for (const tool of ['report_completion', 'progress_update', 'peer_context_pull']) {
            expect(footer).toContain(`\`${tool}\``)
        }
        expect(footer).toContain('task t1')
        const once = appendWorkerProtocolFooter('Do the thing.\n\n')
        const twice = appendWorkerProtocolFooter(once)
        expect(hasWorkerProtocolFooter(once)).toBe(true)
        expect(twice).toBe(once)
        expect(once.startsWith('Do the thing.\n\n')).toBe(true)
    })

    it('coordinator section lists the same tools as the footer contract', () => {
        const section = renderCoordinatorWorkerSection()
        for (const tool of WORKER_TOOLS) expect(section).toContain(`\`${tool}\``)
        expect(section).toMatch(/Do NOT poll/)
    })
})
