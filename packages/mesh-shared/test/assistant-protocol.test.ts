import { describe, expect, it } from 'vitest'
import {
    ASSISTANT_OWNER_VERBS,
    ASSISTANT_REVIEW_TURN_VERBS,
    ASSISTANT_TOOLS,
    ASSISTANT_TOOL_VERBS,
    ASSISTANT_VERB,
    ASSISTANT_WRITE_TOOLS,
    isAssistantTool,
} from '../src/assistant-protocol'
import { CANONICAL_MESH_TOOL_NAMES } from '../src/mesh-tool-names'
import { WORKER_TOOLS } from '../src/worker-protocol'

/**
 * Assistant tool contract (design 2026-10-07-assistant-layer.md §4.4). The
 * mcp-server `--assistant` ListTools parity check lands with that mode; this
 * pins the tuple itself and its relation to the other tool sets.
 */
describe('ASSISTANT_TOOLS', () => {
    it('includes the additive assistant surface in contract order without duplicates', () => {
        expect([...ASSISTANT_TOOLS]).toEqual([
            'projects', 'environment', 'assistant_action', 'project_watch', 'project_status', 'project_send', 'project_read', 'project_add',
            'project_attach_remote', 'discover_repos', 'memory', 'skill_view', 'skill_manage', 'project_note',
            'launch_defaults', 'launch_defaults_set', 'driver_list', 'driver_describe', 'artifact_list', 'artifact_read',
            'decision_answer', 'decision_request',
        ])
        expect(new Set(ASSISTANT_TOOLS).size).toBe(ASSISTANT_TOOLS.length)
    })

    it('isAssistantTool accepts exactly the tuple', () => {
        for (const t of ASSISTANT_TOOLS) expect(isAssistantTool(t)).toBe(true)
        for (const t of ['mesh_status', 'report_completion', '', 'Memory', 42, null]) expect(isAssistantTool(t)).toBe(false)
    })

    it('shares only driver discovery and read-only artifact tools with the mesh and worker tool sets', () => {
        const others = new Set<string>([...CANONICAL_MESH_TOOL_NAMES, ...WORKER_TOOLS])
        expect(ASSISTANT_TOOLS.filter((t) => others.has(t))).toEqual(['driver_list', 'driver_describe', 'artifact_list', 'artifact_read'])
    })

    it('maps assistant tools and shared driver discovery to their daemon verbs', () => {
        expect(Object.keys(ASSISTANT_TOOL_VERBS).sort()).toEqual([...ASSISTANT_TOOLS].sort())
        for (const t of ASSISTANT_TOOLS) expect(ASSISTANT_TOOL_VERBS[t]).toBe(t === 'assistant_action' || t.startsWith('driver_') ? t : `assistant_${t}`)
    })

    it('write tools are memory, skill_manage, project_note and the owner-decision tools', () => {
        expect([...ASSISTANT_WRITE_TOOLS].sort()).toEqual(['assistant_action', 'decision_answer', 'decision_request', 'launch_defaults_set', 'memory', 'project_add', 'project_attach_remote', 'project_note', 'project_send', 'project_watch', 'skill_manage'])
    })
})

describe('assistant verbs', () => {
    const all = Object.values(ASSISTANT_VERB)

    it('are thirty-one distinct names: twenty-two tool verbs + launch/pull/state/threads + five owner verbs', () => {
        expect(all.length).toBe(31)
        expect(new Set(all).size).toBe(31)
        const toolVerbs = new Set<string>(Object.values(ASSISTANT_TOOL_VERBS))
        expect(all.filter((v) => !toolVerbs.has(v)).sort()).toEqual([
            'assistant_execution_settings', 'assistant_execution_state', 'assistant_import_skills', 'assistant_pending_relays', 'assistant_staged_resolve',
            'assistant_store_admin', 'assistant_thread_close', 'assistant_threads', 'launch_assistant',
        ])
    })

    it('owner verbs are not tool verbs (the MCP server never calls them)', () => {
        const toolVerbs = new Set<string>(Object.values(ASSISTANT_TOOL_VERBS))
        expect(ASSISTANT_OWNER_VERBS.filter((v) => toolVerbs.has(v))).toEqual([])
        expect([...ASSISTANT_OWNER_VERBS].sort()).toEqual(['assistant_execution_settings', 'assistant_import_skills', 'assistant_staged_resolve', 'assistant_store_admin', 'assistant_thread_close'])
    })

    it('the review-turn whitelist is the four store tool verbs', () => {
        expect([...ASSISTANT_REVIEW_TURN_VERBS].sort()).toEqual([
            'assistant_memory', 'assistant_project_note', 'assistant_skill_manage', 'assistant_skill_view',
        ])
    })
})
