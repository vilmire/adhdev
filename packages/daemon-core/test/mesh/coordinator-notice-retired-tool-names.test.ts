import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { RETIRED_MESH_TOOLS } from '@adhdev/mesh-shared';

/**
 * 2026-09-26 tool consolidation: the MCP tool names retired by the merge answer
 * with an error, so a coordinator-facing notice that tells the coordinator to call
 * one sends it straight into that error. The coordinator-prompt test already
 * scans the rendered prompt; this scans the notice / next-action texts the daemon
 * pages to a coordinator at runtime, which never pass through the prompt.
 *
 * The gate-expiry notice was the measured case: it told the coordinator to call
 * `mesh_graph_gate_extend`, which was never an MCP tool at all (it is the daemon
 * command behind the extend verb).
 *
 * These files carry no daemon-command references, so ANY retired name in them —
 * string or comment — is treated as a leak.
 */
const NOTICE_SOURCES = [
    'mesh-event-forwarding.ts',
    'mesh-graph-staleness.ts',
    'mesh-graph-stop-notice.ts',
    'mesh-graph-view.ts',
    'mesh-queue-dependency-notice.ts',
];

describe('coordinator notice texts name only published mesh tools', () => {
    it.each(NOTICE_SOURCES)('%s names no retired tool', (file) => {
        const src = readFileSync(join(__dirname, '../../src/mesh', file), 'utf8');
        const leaked = Object.keys(RETIRED_MESH_TOOLS).filter(name => new RegExp(`\\b${name}\\b`).test(src));
        expect(leaked, `${file} still names retired tool(s): ${leaked.join(', ')}`).toEqual([]);
    });

    it('the gate notices point at the merged mesh_graph_gate tool', () => {
        const forwarding = readFileSync(join(__dirname, '../../src/mesh/mesh-event-forwarding.ts'), 'utf8');
        expect(forwarding).toContain('mesh_graph_gate action "extend" with extend_seconds');
        expect(forwarding).toContain('Claim it with mesh_graph_gate (action: "claim"');
    });
});
