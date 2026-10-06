/**
 * Assistant verb sources (design 2026-10-07-assistant-layer.md §4.4): tool
 * verbs are ipc + standalone (`assistant_projects` also p2p / ws for the
 * dashboard); owner verbs are p2p / ws / standalone and never ipc (the
 * assistant's MCP server must not reach them); no assistant verb accepts mesh.
 */
import { describe, expect, it } from 'vitest';
import { ASSISTANT_OWNER_VERBS, ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { specAcceptsMeshSource } from '../../src/commands/command-registry.js';

const EXPECTED_SOURCES: Record<string, string[]> = {
    assistant_projects: ['ipc', 'p2p', 'standalone', 'ws'],
    assistant_project_status: ['ipc', 'standalone'],
    assistant_project_send: ['ipc', 'standalone'],
    assistant_project_read: ['ipc', 'standalone'],
    assistant_project_add: ['ipc', 'standalone'],
    assistant_discover_repos: ['ipc', 'standalone'],
    assistant_memory: ['ipc', 'standalone'],
    assistant_skill_view: ['ipc', 'standalone'],
    assistant_skill_manage: ['ipc', 'standalone'],
    assistant_project_note: ['ipc', 'standalone'],
    assistant_staged_resolve: ['p2p', 'standalone', 'ws'],
    assistant_store_admin: ['p2p', 'standalone', 'ws'],
    assistant_import_skills: ['p2p', 'standalone', 'ws'],
    launch_assistant: ['ipc', 'p2p', 'standalone', 'ws'],
    assistant_pending_relays: ['ipc', 'standalone'],
};

describe('assistant verbs — sources', () => {
    const registry = getDaemonCommandRegistry();

    it('registers the store, project and session verbs with exactly the §4.4 sources', () => {
        const actual: Record<string, string[] | undefined> = {};
        for (const name of Object.keys(EXPECTED_SOURCES)) {
            const spec = registry.get(name);
            actual[name] = spec?.sources ? [...spec.sources].sort() : undefined;
        }
        expect(actual).toEqual(EXPECTED_SOURCES);
    });

    it('no registered assistant verb accepts mesh or omits a sources list', () => {
        const assistantVerbs = new Set<string>(Object.values(ASSISTANT_VERB));
        const specs = registry.list().filter((s) => assistantVerbs.has(s.name));
        // Every ASSISTANT_VERB is registered (15 = 10 tool verbs + launch + pull + 3 owner verbs).
        expect(specs.map((s) => s.name).sort()).toEqual([...assistantVerbs].sort());
        expect(specs.length).toBe(Object.keys(EXPECTED_SOURCES).length);
        expect(specs.filter((s) => !s.sources).map((s) => s.name)).toEqual([]);
        expect(specs.filter((s) => specAcceptsMeshSource(s)).map((s) => s.name)).toEqual([]);
        expect(specs.filter((s) => s.meshSender).map((s) => s.name)).toEqual([]);
    });

    it('no owner verb accepts ipc', () => {
        for (const verb of ASSISTANT_OWNER_VERBS) {
            expect(registry.get(verb)?.sources ?? ['<all>']).not.toContain('ipc');
            expect(registry.get(verb)?.sources).toBeDefined();
        }
    });
});
