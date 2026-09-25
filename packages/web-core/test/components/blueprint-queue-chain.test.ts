/**
 * ★ W24 — queue `depends_on` chains are visible in the Blueprint.
 *
 * `mesh_enqueue_task` + `depends_on` (design 2026-09-25 D1, the default way
 * coordinators chain work) creates NO mesh_task_graphs rows, so the
 * graph-backed Blueprint affordances never saw it. The queue snapshot in
 * mesh_status already carries dependsOn/missionId, so the fix is a pure
 * view-time derivation:
 *
 *  - every Blocked task names what it waits on (short id + first-line title)
 *  - "By mission" groups a mission-less chain as ONE chain group (anchored
 *    on its root), or folds it into its single mission — never into the
 *    shared "No mission" bucket
 *
 * Red-when-reverted: each case names the piece whose removal breaks it.
 */
import { describe, expect, it } from 'vitest'
import type { RepoMeshQueueTask } from '@adhdev/daemon-core'
import {
    BLUEPRINT_DEP_TITLE_MAX,
    buildBlueprintGroups,
    buildBlueprintMissionGroups,
    describeDepRef,
    type BlueprintRow,
    type BlueprintTaskRow,
} from '../../src/components/MeshGraph/useBlueprintGroups'

const A = 'aaaaaaaa-1111-4000-8000-000000000001'
const B = 'bbbbbbbb-2222-4000-8000-000000000002'
const C = 'cccccccc-3333-4000-8000-000000000003'
const D = 'dddddddd-4444-4000-8000-000000000004'

const task = (over: Partial<RepoMeshQueueTask> & { id: string }): RepoMeshQueueTask => ({
    meshId: 'mesh-1',
    message: `message for ${over.id}`,
    status: 'pending',
    createdAt: '2026-09-25T10:00:00Z',
    updatedAt: '2026-09-25T10:00:00Z',
    ...over,
} as RepoMeshQueueTask)

const noStatus = { nodes: [] } as any

function allRows(groups: ReturnType<typeof buildBlueprintGroups>): BlueprintRow[] {
    return [...groups.running, ...groups.blocked, ...groups.recent, ...groups.history]
}

function taskRow(groups: ReturnType<typeof buildBlueprintGroups>, id: string): BlueprintTaskRow {
    const row = allRows(groups).find(candidate => candidate.kind === 'task' && candidate.task.id === id)
    if (!row || row.kind !== 'task') throw new Error(`no row ${id}`)
    return row
}

function groupIds(groups: ReturnType<typeof buildBlueprintMissionGroups>) {
    return groups.map(group => ({
        key: group.key,
        kind: group.kind,
        ids: group.rows.map(row => (row.kind === 'task' ? row.task.id : row.nodeId)).sort(),
    }))
}

describe('waiting on — named dependencies', () => {
    it('D1: a Blocked task names its unmet dep by short id + first-line display title', () => {
        const groups = buildBlueprintGroups([
            task({ id: A, status: 'assigned', message: '## Build the **parser**\n\nlong body that must not leak into the title' }),
            task({ id: B, status: 'pending', dependsOn: [A] }),
        ], noStatus, [])
        expect(taskRow(groups, B).waitingOnRefs).toEqual([
            { id: A, shortId: 'aaaaaaaa', title: 'Build the parser', status: 'assigned', present: true },
        ])
        // Satisfied deps release the row — nothing to name.
        expect(taskRow(groups, A).waitingOnRefs).toEqual([])
    })

    it('D2: a dep absent from the snapshot is named by short id only, not openable', () => {
        const groups = buildBlueprintGroups([task({ id: B, dependsOn: [D] })], noStatus, [])
        expect(taskRow(groups, B).waitingOnRefs).toEqual([{ id: D, shortId: 'dddddddd', present: false }])
    })

    it('D3: a long title is capped', () => {
        const ref = describeDepRef(A, task({ id: A, message: 'x'.repeat(100) }))
        expect(ref.title).toBe(`${'x'.repeat(BLUEPRINT_DEP_TITLE_MAX)}…`)
    })
})

describe('By mission — queue chains group together', () => {
    it('D4: a mission-less chain is ONE chain group anchored on its root; an unrelated task stays ad-hoc', () => {
        const groups = buildBlueprintGroups([
            task({ id: A, status: 'assigned', message: 'Build the parser' }),
            task({ id: B, dependsOn: [A] }),
            task({ id: C }),
        ], noStatus, [])
        const missionGroups = buildBlueprintMissionGroups(allRows(groups), {}, groups.chainByTaskId)
        expect(groupIds(missionGroups)).toEqual([
            { key: `chain:${A}`, kind: 'chain', ids: [A, B] },
            { key: '(ad-hoc)', kind: 'adhoc', ids: [C] },
        ])
        const chain = missionGroups[0]
        expect(chain.title).toBe('Build the parser')
        expect(chain.anchorTaskId).toBe(A)
        expect(chain.missionId).toBeNull()
    })

    it('D5: a chain touching exactly one mission folds its mission-less members into that mission', () => {
        const groups = buildBlueprintGroups([
            task({ id: A, status: 'assigned', missionId: 'm1' }),
            task({ id: B, dependsOn: [A] }),
        ], noStatus, [])
        const missionGroups = buildBlueprintMissionGroups(allRows(groups), { m1: 'Mission One' }, groups.chainByTaskId)
        expect(groupIds(missionGroups)).toEqual([{ key: 'm1', kind: 'mission', ids: [A, B] }])
        expect(missionGroups[0].title).toBe('Mission One')
    })

    it('D6: a chain spanning two missions does not guess — the mission-less member gets the chain group', () => {
        const groups = buildBlueprintGroups([
            task({ id: A, status: 'assigned', missionId: 'm1', createdAt: '2026-09-25T09:00:00Z' }),
            task({ id: B, status: 'assigned', missionId: 'm2', createdAt: '2026-09-25T09:30:00Z' }),
            task({ id: C, dependsOn: [A, B] }),
        ], noStatus, [])
        const missionGroups = buildBlueprintMissionGroups(allRows(groups), {}, groups.chainByTaskId)
        const byKey = Object.fromEntries(groupIds(missionGroups).map(group => [group.key, group.ids]))
        expect(byKey).toEqual({ m1: [A], m2: [B], [`chain:${A}`]: [C] })
    })

    it('D7: the anchor is the root (no in-snapshot deps), earliest created, regardless of input order', () => {
        const groups = buildBlueprintGroups([
            task({ id: C, dependsOn: [B], createdAt: '2026-09-25T08:00:00Z' }),
            task({ id: B, dependsOn: [A], createdAt: '2026-09-25T07:00:00Z' }),
            task({ id: A, status: 'assigned', createdAt: '2026-09-25T09:00:00Z' }),
        ], noStatus, [])
        // A is the ONLY root even though it was created last.
        expect(groups.chainByTaskId.get(C)?.anchorTaskId).toBe(A)
        expect(groups.chainByTaskId.get(C)?.size).toBe(3)

        const diamond = buildBlueprintGroups([
            task({ id: B, status: 'assigned', createdAt: '2026-09-25T09:00:00Z' }),
            task({ id: A, status: 'assigned', createdAt: '2026-09-25T08:00:00Z' }),
            task({ id: C, dependsOn: [A, B] }),
        ], noStatus, [])
        expect(diamond.chainByTaskId.get(C)?.anchorTaskId).toBe(A)
    })

    it('D8: chain membership is computed over the whole snapshot — a hidden finished head still links its tail', () => {
        const groups = buildBlueprintGroups([
            task({ id: A, status: 'completed', message: 'Build the parser' }),
            task({ id: B, status: 'pending', dependsOn: [A] }),
            task({ id: C, status: 'pending', dependsOn: [B] }),
        ], noStatus, [])
        // Default scope: Running + Blocked only — A (terminal) is not visible.
        const visible = [...groups.running, ...groups.blocked]
        expect(visible.some(row => row.kind === 'task' && row.task.id === A)).toBe(false)
        const missionGroups = buildBlueprintMissionGroups(visible, {}, groups.chainByTaskId)
        expect(groupIds(missionGroups)).toEqual([{ key: `chain:${A}`, kind: 'chain', ids: [B, C] }])
        expect(missionGroups[0].title).toBe('Build the parser')
    })

    it('without a chain index the legacy 2-arg grouping is unchanged (chain members stay ad-hoc)', () => {
        const groups = buildBlueprintGroups([
            task({ id: A, status: 'assigned' }),
            task({ id: B, dependsOn: [A] }),
        ], noStatus, [])
        expect(groupIds(buildBlueprintMissionGroups(allRows(groups), {}))).toEqual([
            { key: '(ad-hoc)', kind: 'adhoc', ids: [A, B] },
        ])
    })
})
