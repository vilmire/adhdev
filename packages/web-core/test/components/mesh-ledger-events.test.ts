// Activity-record kinds → the handful of user events (meshLedgerEvents.ts).
// Internal bookkeeping kinds are hidden by default in the Overview "Activity"
// card and must never render as raw "ledger reconciled"-style labels there.
import { describe, expect, it } from 'vitest'
import en from '../../src/i18n/locales/en/common.json'
import ko from '../../src/i18n/locales/ko/common.json'
import ja from '../../src/i18n/locales/ja/common.json'
import zhCN from '../../src/i18n/locales/zh-CN/common.json'
import es from '../../src/i18n/locales/es/common.json'
import {
    MESH_USER_EVENT_LABEL_KEYS,
    classifyLedgerEntry,
    classifyLedgerKind,
    filterLedgerEntriesForDisplay,
    ledgerEntryNodeLabel,
    ledgerKindDisplayLabel,
} from '../../src/components/MeshGraph/meshLedgerEvents'
import { payloadSummary } from '../../src/components/MeshGraph/meshOverviewPrimitives'

describe('classifyLedgerKind', () => {
    it('maps the user-meaningful kinds onto six events', () => {
        expect(classifyLedgerKind('task_dispatched')).toBe('taskStarted')
        expect(classifyLedgerKind('task_claimed')).toBe('taskStarted')
        expect(classifyLedgerKind('task_completed')).toBe('taskFinished')
        expect(classifyLedgerKind('task_failed')).toBe('taskFailed')
        expect(classifyLedgerKind('task_stalled')).toBe('taskFailed')
        expect(classifyLedgerKind('dispatch_failed')).toBe('taskFailed')
        expect(classifyLedgerKind('task_approval_needed')).toBe('needsInput')
        expect(classifyLedgerKind('task_question_pending')).toBe('needsInput')
        expect(classifyLedgerKind('session_launched')).toBe('sessionStarted')
        expect(classifyLedgerKind('node_joined')).toBe('nodeChanged')
        expect(new Set(Object.keys(MESH_USER_EVENT_LABEL_KEYS)).size).toBe(6)
    })

    it('treats bookkeeping kinds as internal', () => {
        for (const kind of ['ledger_reconciled', 'ledger_replicated', 'claim_refused', 'event_held', 'checkpoint_created', 'dispatch_duplicate_rebound', '', undefined]) {
            expect(classifyLedgerKind(kind as any)).toBeNull()
        }
    })
})

describe('display', () => {
    it('hides internal kinds unless "show all"', () => {
        const entries = [{ kind: 'task_completed' }, { kind: 'ledger_reconciled' }, { kind: 'session_launched' }]
        expect(filterLedgerEntriesForDisplay(entries, false).map(e => e.kind)).toEqual(['task_completed', 'session_launched'])
        expect(filterLedgerEntriesForDisplay(entries, true)).toHaveLength(3)
    })

    it('labels user events through i18n and internal kinds readably', () => {
        const t = (key: string) => `T(${key})`
        expect(ledgerKindDisplayLabel('task_completed', t)).toBe('T(mesh.activity.taskFinished)')
        expect(ledgerKindDisplayLabel('ledger_reconciled', t)).toBe('ledger reconciled')
    })

    it('labels node kinds specifically — a cloned worktree is not "Machine joined or left"', () => {
        const t = (key: string) => `T(${key})`
        expect(ledgerKindDisplayLabel('node_cloned', t)).toBe('T(mesh.activity.worktreeCreated)')
        expect(ledgerKindDisplayLabel('node_joined', t)).toBe('T(mesh.activity.nodeJoined)')
        expect(ledgerKindDisplayLabel('node_removed', t)).toBe('T(mesh.activity.nodeRemoved)')
        for (const bundle of [en, ko, ja, zhCN, es] as any[]) {
            for (const key of ['worktreeCreated', 'nodeJoined', 'nodeRemoved']) {
                expect(typeof bundle.mesh.activity[key], key).toBe('string')
            }
        }
    })

    it('collapses adjacent rows of one event for the same node/task (dispatched+claimed, auto_launch+launched)', () => {
        const entries = [
            { kind: 'session_launched', nodeId: 'n1', sessionId: 's1' },
            { kind: 'session_auto_launch', nodeId: 'n1' },
            { kind: 'task_claimed', nodeId: 'n1', taskId: 't1' },
            { kind: 'task_dispatched', nodeId: 'n1', taskId: 't1' },
            { kind: 'task_dispatched', nodeId: 'n2', taskId: 't2' },
        ]
        expect(filterLedgerEntriesForDisplay(entries, false).map(e => `${e.kind}:${e.nodeId}`))
            .toEqual(['session_launched:n1', 'task_claimed:n1', 'task_dispatched:n2'])
        expect(filterLedgerEntriesForDisplay(entries, true)).toHaveLength(5)
    })

    it('every event label exists in all five locales', () => {
        for (const bundle of [en, ko, ja, zhCN, es] as any[]) {
            for (const key of Object.values(MESH_USER_EVENT_LABEL_KEYS)) {
                const leaf = key.split('.').reduce((node: any, part) => node?.[part], bundle)
                expect(typeof leaf, key).toBe('string')
                expect(leaf.length).toBeGreaterThan(0)
            }
        }
    })
})

describe('auto-launch phases', () => {
    it('only a started auto-launch is "Agent started"', () => {
        expect(classifyLedgerEntry({ kind: 'session_auto_launch', payload: { phase: 'started' } })).toBe('sessionStarted')
        expect(classifyLedgerEntry({ kind: 'session_auto_launch' })).toBe('sessionStarted')
        expect(classifyLedgerEntry({ kind: 'session_auto_launch', payload: { phase: 'skipped', reason: 'auto_launch_orphan_session_detected' } })).toBeNull()
        const shown = filterLedgerEntriesForDisplay([
            { kind: 'session_auto_launch', nodeId: 'n1', payload: { phase: 'skipped' } },
            { kind: 'session_auto_launch', nodeId: 'n1', payload: { phase: 'started' } },
        ], false)
        expect(shown).toHaveLength(1)
        expect(shown[0].payload?.phase).toBe('started')
    })
})

describe('payloadSummary', () => {
    it('skips machine reason codes but keeps prose', () => {
        expect(payloadSummary({ reason: 'auto_launch_orphan_session_detected' })).toBeNull()
        expect(payloadSummary({ reason: 'auto_launch_orphan_session_detected', title: 'Add search' })).toBe('Add search')
        expect(payloadSummary({ reason: 'Worker exited unexpectedly' })).toBe('Worker exited unexpectedly')
    })
})

describe('ledgerEntryNodeLabel', () => {
    const resolve = (id: string | undefined | null) => (id === 'known' ? 'MacBook · todo-web' : id ?? '')
    it('prefers the live node label', () => {
        expect(ledgerEntryNodeLabel({ nodeId: 'known', payload: { worktreeBranch: 'b' } }, resolve)).toBe('MacBook · todo-web')
    })
    it('names a removed node by its branch, then workspace', () => {
        expect(ledgerEntryNodeLabel({ nodeId: 'node_gone', payload: { worktreeBranch: 'mesh/task-42' } }, resolve)).toBe('mesh/task-42')
        expect(ledgerEntryNodeLabel({ nodeId: 'node_gone', payload: { mergedBranch: 'mesh/task-7' } }, resolve)).toBe('mesh/task-7')
        expect(ledgerEntryNodeLabel({ nodeId: 'node_gone', payload: { workspace: '/Users/me/demo/todo-web-wt-3/' } }, resolve)).toBe('todo-web-wt-3')
        expect(ledgerEntryNodeLabel({ nodeId: 'node_gone' }, resolve)).toBe('node_gone')
    })
})
