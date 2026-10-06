/**
 * Assistant store verb sources (design 2026-10-07-assistant-layer.md §4.4):
 * tool verbs are ipc + standalone; owner verbs are p2p / ws / standalone and
 * never ipc (the assistant's MCP server must not reach them); no assistant
 * verb accepts mesh.
 */
import { describe, expect, it } from 'vitest';
import { ASSISTANT_OWNER_VERBS, ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { specAcceptsMeshSource } from '../../src/commands/command-registry.js';

const EXPECTED_SOURCES: Record<string, string[]> = {
    assistant_memory: ['ipc', 'standalone'],
    assistant_skill_view: ['ipc', 'standalone'],
    assistant_skill_manage: ['ipc', 'standalone'],
    assistant_project_note: ['ipc', 'standalone'],
    assistant_staged_resolve: ['p2p', 'standalone', 'ws'],
    assistant_store_admin: ['p2p', 'standalone', 'ws'],
    assistant_import_skills: ['p2p', 'standalone', 'ws'],
};

describe('assistant store verbs — sources', () => {
    const registry = getDaemonCommandRegistry();

    it('registers the seven store verbs with exactly the §4.4 sources', () => {
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
        expect(specs.length).toBeGreaterThanOrEqual(7);
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
