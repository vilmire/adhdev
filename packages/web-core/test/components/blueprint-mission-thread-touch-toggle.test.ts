/**
 * ★ BLUEPRINT MISSION THREAD — MOBILE SUPPRESSION REMOVED, TAP TOGGLE WIRED.
 *
 * The mission thread is the dotted decoration joining the cards of one mission
 * in time order. On 2026-08-25 it was suppressed OUTRIGHT on hover-less
 * pointers: a tap fires a synthetic `mouseenter` with no matching
 * `mouseleave`, so `hoveredMissionId` stuck and the thread became a permanent
 * line across the mobile canvas. The suppression fixed the stuck line by
 * deleting the feature on mobile — and with it the information the line
 * carries (which tasks belong to one mission, and in what order).
 *
 * The owner reversed that on 2026-09-15: keep the thread on mobile, and give
 * touch a dismiss gesture instead. This file pins the structural half of that
 * change — that the media-query suppression is GONE from the thread build —
 * because the behavioural half cannot be observed by rendering:
 * @xyflow/react measures nothing under jsdom and emits ZERO edges regardless
 * of hovered state (checked on both the `hover: none` and hover-capable
 * branches), so an edge-count assertion passes vacuously either way. The
 * decision logic itself is unit-pinned in blueprint-view-model.test.ts
 * (`nextHoveredMissionOnCardActivate`).
 *
 * Red-when-reverted: reinstating the `missionThreadsSupported` gate — the
 * `matchMedia('(hover: none)')` memo plus its `!missionThreadsSupported ||`
 * guard on the thread build — fails the first two assertions here, which is
 * exactly the regression (mobile silently loses the thread again).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const VIEW = path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshTaskDagView.tsx')
const source = fs.readFileSync(VIEW, 'utf8')

describe('mission thread is no longer suppressed on hover-less pointers', () => {
    it('the thread build gates on the hovered mission ALONE — no media-query escape hatch', () => {
        // The exact guard that decides whether any thread edge is produced.
        expect(source).toContain('if (!hoveredMissionId) return []')
        expect(source).not.toContain('missionThreadsSupported')
    })

    it('no matchMedia call sits in the thread-edge memo dependency list', () => {
        // The old shape memoized a `(hover: none)` probe and listed it as a
        // dependency of the edge memo; both are gone with the gate.
        const edgeMemoDeps = source.match(/\}, \[dag, fused, hoveredMissionId, meshTheme[^\]]*\]\)/)
        expect(edgeMemoDeps, 'thread-edge memo dependency list not found — did the memo move?').not.toBeNull()
        expect(edgeMemoDeps?.[0]).not.toContain('missionThreadsSupported')
    })
})

describe('a card activation drives the same hovered-mission state', () => {
    it('handleNodeClick routes through the unit-pinned toggle rule', () => {
        const handler = source.slice(source.indexOf('const handleNodeClick'))
        const body = handler.slice(0, handler.indexOf('\n    }, ['))
        expect(body).toContain('nextHoveredMissionOnCardActivate')
        expect(body).toContain('setHoveredMissionId')
        // Reads the device at activation time rather than at mount, so a
        // hybrid device that switches primary pointer is not stuck on the
        // branch it happened to boot with.
        expect(body).toContain('pointerHasHover()')
    })

    it('the mission is set BEFORE the onTaskOpen early return — otherwise a host that opens a detail modal never lights the thread', () => {
        const handler = source.slice(source.indexOf('const handleNodeClick'))
        const body = handler.slice(0, handler.indexOf('\n    }, ['))
        /* Scoped to the TASK-node branch: the plan-node branch above it has its
         * own `onTaskOpen(task)` early return, and matching that one instead
         * would make this assertion pass for the wrong reason. MeshBlueprintView
         * passes onTaskOpen, so this early return is the live path on every
         * real consumer — a mission set after it would never run. */
        const taskBranch = body.slice(body.indexOf('if (!isTaskFlowNode(node)) return'))
        expect(taskBranch).toContain('onTaskOpen(node.data.dagNode.task)')
        expect(taskBranch.indexOf('nextHoveredMissionOnCardActivate'))
            .toBeLessThan(taskBranch.indexOf('onTaskOpen(node.data.dagNode.task)'))
    })

    it('tapping empty canvas still clears the thread — the third way out', () => {
        expect(source).toContain('onPaneClick={() => { setSelectedTaskId(null); setFocusTaskId(null); setHoveredMissionId(null) }}')
    })

    it('desktop hover in/out is left intact', () => {
        expect(source).toContain('onNodeMouseEnter={handleNodeHover}')
        expect(source).toContain('onNodeMouseLeave={handleNodeHoverEnd}')
        // The 300ms delayed clear is a desktop-hover concern (crossing the gap
        // between two cards of one mission must not blink the thread).
        expect(source).toMatch(/hoverClearTimer\.current = setTimeout\(\(\) => \{ setHoveredMissionId\(null\) \}, 300\)/)
    })
})
