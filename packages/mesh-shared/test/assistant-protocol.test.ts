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
    it('is the ten §4.4 tools, in table order, without duplicates', () => {
        expect([...ASSISTANT_TOOLS]).toEqual([
            'projects', 'project_status', 'project_send', 'project_read', 'project_add',
            'discover_repos', 'memory', 'skill_view', 'skill_manage', 'project_note',
        ])
        expect(new Set(ASSISTANT_TOOLS).size).toBe(ASSISTANT_TOOLS.length)
    })

    it('isAssistantTool accepts exactly the tuple', () => {
        for (const t of ASSISTANT_TOOLS) expect(isAssistantTool(t)).toBe(true)
        for (const t of ['mesh_status', 'report_completion', '', 'Memory', 42, null]) expect(isAssistantTool(t)).toBe(false)
    })

    it('shares no name with the mesh or worker tool sets', () => {
        const others = new Set<string>([...CANONICAL_MESH_TOOL_NAMES, ...WORKER_TOOLS])
        expect(ASSISTANT_TOOLS.filter((t) => others.has(t))).toEqual([])
    })

    it('maps every tool to an assistant_<tool> verb, one verb per tool', () => {
        expect(Object.keys(ASSISTANT_TOOL_VERBS).sort()).toEqual([...ASSISTANT_TOOLS].sort())
        for (const t of ASSISTANT_TOOLS) expect(ASSISTANT_TOOL_VERBS[t]).toBe(`assistant_${t}`)
    })

    it('write tools are memory, skill_manage and project_note', () => {
        expect([...ASSISTANT_WRITE_TOOLS].sort()).toEqual(['memory', 'project_note', 'skill_manage'])
    })
})

describe('assistant verbs', () => {
    const all = Object.values(ASSISTANT_VERB)

    it('are fifteen distinct names: ten tool verbs + launch + pending relays + three owner verbs', () => {
        expect(all.length).toBe(15)
        expect(new Set(all).size).toBe(15)
        const toolVerbs = new Set<string>(Object.values(ASSISTANT_TOOL_VERBS))
        expect(all.filter((v) => !toolVerbs.has(v)).sort()).toEqual([
            'assistant_import_skills', 'assistant_pending_relays', 'assistant_staged_resolve',
            'assistant_store_admin', 'launch_assistant',
        ])
    })

    it('owner verbs are not tool verbs (the MCP server never calls them)', () => {
        const toolVerbs = new Set<string>(Object.values(ASSISTANT_TOOL_VERBS))
        expect(ASSISTANT_OWNER_VERBS.filter((v) => toolVerbs.has(v))).toEqual([])
        expect([...ASSISTANT_OWNER_VERBS].sort()).toEqual(['assistant_import_skills', 'assistant_staged_resolve', 'assistant_store_admin'])
    })

    it('the review-turn whitelist is the four store tool verbs', () => {
        expect([...ASSISTANT_REVIEW_TURN_VERBS].sort()).toEqual([
            'assistant_memory', 'assistant_project_note', 'assistant_skill_manage', 'assistant_skill_view',
        ])
    })
})
