import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';
import { buildCoordinatorSystemPrompt } from '@adhdev/daemon-core';

// GRAPH-ORCHESTRATION Phase F — batch-first tool exposure.
//
//   Design SoT: docs/design/2026-08-18-graph-orchestration-full.md
//     :596-606 — the required tool-discovery instruction, and WHERE it goes:
//                "near the beginning of Tool Exposure Preflight, before the general
//                workflow and before the model's first deferred tool search".
//     :611-620 — registry/discovery changes 1-4, including ★:619 "Add a tool-exposure
//                test using the exact coordinator prompt and deferred search fixture,
//                asserting that a two-task request returns batch among the first
//                candidates."
//     :622-654 — the workflow eligibility text + safety boundary + difficulty line.
//     :670-690 — the two tool descriptions.
//
// ★ The failure this file exists to catch is NOT hypothetical and NOT a wording
// preference. Observed: on a provider with deferred tool schemas the coordinator ran
// ONE ToolSearch for an enqueue tool, got `mesh_enqueue_task`, called it N times, and
// NEVER loaded the batch schema — so every downstream batch-first instruction was
// unreachable, because the tool it names was never callable. Three independent things
// have to hold to prevent that, and each is asserted below against the REAL artifacts
// (the real prompt string, the real published registry) rather than a local copy:
//
//   1. the prompt tells the model to include batch by exact name BEFORE it searches,
//      and that instruction physically precedes the workflow in the rendered string;
//   2. a ranked deferred search for "enqueue"/"delegate" returns BOTH tools, with
//      the incremental default (task) first and batch right behind it (D1 flipped
//      Phase F's batch-first rank on 2026-09-25 — see F-3 below);
//   3. an unranked lister sees task first by registry order, batch adjacent.
//
// Phase F is WARN-ONLY: nothing here asserts that a single enqueue is rejected, and
// `batch_required` enforcement is deliberately NOT implemented yet (design :6 stages
// warn → require → enforce, and G/dogfood has not validated the batch path).

const MESH_FIXTURE = {
    id: 'mesh_1',
    name: 'ADHDev',
    repoIdentity: 'github.com/acme/adhdev',
    nodes: [
        {
            id: 'node_1',
            workspace: '/repo',
            daemonId: 'daemon_1',
            userOverrides: {},
            policy: {},
        },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
} as any;

/** The exact prompt a real coordinator session is launched with. */
function realCoordinatorPrompt(): string {
    return buildCoordinatorSystemPrompt({ mesh: MESH_FIXTURE });
}

type PublishedTool = {
    name: string;
    description?: string;
    _meta?: {
        discoveryKeywords?: readonly string[];
        discoveryRankQueries?: readonly string[];
        discoveryRank?: number;
        toolGroup?: string;
        toolGroupMembers?: readonly string[];
    };
};

/**
 * Deferred-search fixture.
 *
 * Models how a ToolSearch-style provider resolves a keyword query against a deferred
 * tool list: match on name + description + declared discovery keywords, then order by
 * the declared rank for that query (lower first), with registry order as the
 * tie-break. This is deliberately the GENERIC algorithm — it has no special case for
 * either enqueue tool — so the assertions below can only pass because of the metadata
 * the registry actually declares, not because the fixture was written to agree.
 */
function deferredToolSearch(query: string, tools: readonly PublishedTool[] = ALL_MESH_TOOLS): string[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const matched = tools
        .map((tool, registryIndex) => ({ tool, registryIndex }))
        .filter(({ tool }) => {
            const haystack = [
                tool.name,
                tool.description ?? '',
                ...(tool._meta?.discoveryKeywords ?? []),
            ]
                .join(' ')
                .toLowerCase();
            return terms.some(term => haystack.includes(term));
        });

    return matched
        .sort((a, b) => {
            const rankFor = ({ tool }: { tool: PublishedTool }) => {
                const rankQueries = tool._meta?.discoveryRankQueries ?? [];
                const applies = terms.some(term => rankQueries.includes(term));
                return applies && typeof tool._meta?.discoveryRank === 'number'
                    ? tool._meta.discoveryRank
                    : Number.MAX_SAFE_INTEGER;
            };
            const byRank = rankFor(a) - rankFor(b);
            return byRank !== 0 ? byRank : a.registryIndex - b.registryIndex;
        })
        .map(({ tool }) => tool.name);
}

function findTool(name: string): PublishedTool {
    const tool = (ALL_MESH_TOOLS as readonly PublishedTool[]).find(t => t.name === name);
    assert.ok(tool, `${name} is not published in ALL_MESH_TOOLS`);
    return tool!;
}

// ── F-4 core: the two-task request ────────────────────────────────────────────

test('F-4: a two-task request returns mesh_enqueue_batch among the first candidates', () => {
    // The coordinator's own words when it has just decided "investigate, then fix".
    // Each of these is a query a model would plausibly issue for that frontier.
    const twoTaskQueries = [
        'enqueue',
        'delegate',
        'enqueue two tasks',
        'delegate task graph with a dependency',
    ];

    for (const query of twoTaskQueries) {
        const candidates = deferredToolSearch(query);
        assert.ok(
            candidates.includes('mesh_enqueue_batch'),
            `"${query}" did not surface mesh_enqueue_batch at all: ${candidates.slice(0, 5).join(', ')}`,
        );
        const firstCandidates = candidates.slice(0, 3);
        assert.ok(
            firstCandidates.includes('mesh_enqueue_batch'),
            `"${query}" did not return mesh_enqueue_batch among the first candidates: ${firstCandidates.join(', ')}`,
        );
    }
});

test('F-4: the incremental default outranks batch for enqueue/delegate queries, batch adjacent', () => {
    // D1: `mesh_enqueue_task` + `depends_on` is the default, so it ranks first. The
    // original Phase F regression (coordinator found ONE tool and never learned the
    // other existed) is still covered: batch must be surfaced right behind it.
    for (const query of ['enqueue', 'delegate']) {
        const candidates = deferredToolSearch(query);
        const batchAt = candidates.indexOf('mesh_enqueue_batch');
        const taskAt = candidates.indexOf('mesh_enqueue_task');
        assert.ok(batchAt >= 0 && taskAt >= 0, `"${query}" must surface both enqueue tools`);
        assert.ok(
            taskAt < batchAt,
            `"${query}" ranked mesh_enqueue_batch (${batchAt}) ahead of mesh_enqueue_task (${taskAt}) — D1 makes task the default`,
        );
        assert.equal(batchAt, taskAt + 1, `"${query}" must keep batch adjacent to task so a coordinator sees both`);
    }
});

test('F-4: a bare "enqueue"/"delegate" query matches BOTH tools via shared keywords', () => {
    // Design :614 — shared discovery vocabulary. Without it, "delegate" matches
    // neither tool by name and the ranking above never gets a chance to run.
    for (const query of ['enqueue', 'delegate', 'task', 'graph', 'dependency']) {
        const candidates = deferredToolSearch(query);
        for (const name of ['mesh_enqueue_batch', 'mesh_enqueue_task']) {
            assert.ok(
                candidates.includes(name),
                `"${query}" did not match ${name} — shared discovery keywords regressed`,
            );
        }
    }
});

// ── Registry order (the unranked-client path) ─────────────────────────────────

test('F-2: mesh_enqueue_task precedes mesh_enqueue_batch in ALL_MESH_TOOLS, adjacent', () => {
    const names = ALL_MESH_TOOLS.map(t => t.name);
    const batchAt = names.indexOf('mesh_enqueue_batch');
    const taskAt = names.indexOf('mesh_enqueue_task');
    assert.ok(batchAt >= 0 && taskAt >= 0, 'both enqueue tools must be published');
    assert.ok(
        taskAt < batchAt,
        `registry order puts batch first (batch ${batchAt}, task ${taskAt}) — D1 makes the incremental task the default an unranked client sees first`,
    );
    assert.equal(batchAt, taskAt + 1, 'batch must stay adjacent to task in registry order');
});

test('F-2: both enqueue tools declare the same enqueue sibling group', () => {
    // Design :616-618 — loading the fallback should also expose batch on providers
    // that support tool groups. Defense in depth; the prompt rule is primary.
    const batch = findTool('mesh_enqueue_batch');
    const task = findTool('mesh_enqueue_task');

    assert.equal(batch._meta?.toolGroup, 'mesh.enqueue');
    assert.equal(task._meta?.toolGroup, batch._meta?.toolGroup);

    for (const tool of [batch, task]) {
        assert.deepEqual(
            [...(tool._meta?.toolGroupMembers ?? [])],
            ['mesh_enqueue_task', 'mesh_enqueue_batch'],
            `${tool.name} must list both siblings so loading either exposes the other`,
        );
    }
});

// ── F-3: the tool descriptions carry the D1 framing ───────────────────────────
//
// graph-orchestration-simplification D1 (docs/design/2026-09-25-graph-orchestration-
// simplification.md) REVERSED Phase F's batch-first framing: work is discovered
// step by step, so incremental `mesh_enqueue_task` + `depends_on` is the default and
// batch is reserved for a SETTLED plan (3+ steps needing gates / deferred worktrees).
// The discovery `_meta` (rank, registry order, role) was flipped to task-first to
// match, and is pinned above.

test('F-3: mesh_enqueue_batch is described as the settled-plan surface, not the default', () => {
    const description = findTool('mesh_enqueue_batch').description ?? '';
    assert.match(description, /Atomically enqueue a SETTLED plan/);
    assert.match(description, /3\+ steps/);
    assert.match(description, /otherwise chain mesh_enqueue_task with depends_on/);
    assert.match(description, /Never invent steps to fill a batch/);
    // The atomicity boundary must stay stated: DB plan atomicity is NOT git.
    assert.match(description, /compensated saga and is reported separately from DB atomicity/);
    assert.doesNotMatch(description, /DEFAULT enqueue surface/);
});

test('F-3: mesh_enqueue_task is described as the default and chains with depends_on', () => {
    const description = findTool('mesh_enqueue_task').description ?? '';
    assert.match(description, /default way to delegate/);
    assert.match(description, /depends_on/);
    assert.match(description, /Use mesh_enqueue_batch only for a settled plan of 3\+ steps/);
    assert.match(description, /Same-session continuation belongs in mesh_send_task/);
    assert.doesNotMatch(description, /SINGLE-TASK FALLBACK/);
});

// ── F-1 (as amended by D1): the prompt's enqueue guidance ─────────────────────

test('F-1/D1: the batch-first discovery instruction is gone from the prompt', () => {
    // The Phase F instruction forced every delegation search to load batch first;
    // D1 removed it. Its return would re-impose the pre-declared-DAG interface.
    const prompt = realCoordinatorPrompt();
    assert.ok(!prompt.includes('never search for or load only `mesh_enqueue_task`'), 'batch-first discovery instruction must stay removed');
    assert.ok(!prompt.includes('**Batch-first rule.**'), 'the batch-first rule must stay removed');
    // The Tool Exposure Preflight section itself survives (staleness check).
    assert.ok(prompt.includes('## Tool Exposure Preflight'));
    assert.ok(prompt.includes('Before doing any coordinator work, confirm that the actual callable tool list'));
});

test('F-1/D1: the prompt makes mesh_enqueue_task + depends_on the default and scopes batch to settled plans', () => {
    const prompt = realCoordinatorPrompt();
    assert.match(prompt, /`mesh_enqueue_task`[^\n]*DEFAULT enqueue surface/);
    assert.match(prompt, /Default to `mesh_enqueue_task`/);
    assert.match(prompt, /chain[^\n]*`depends_on`/);
    assert.match(prompt, /three or more steps are already settled/);
    // ★ The anti-speculation boundary survives the reversal: batch must never be
    // assembled from invented steps.
    assert.match(prompt, /Never (invent speculative steps|fabricate steps)/);
});

test('F-1/D1: difficulty is stated for the default single task as well as batch entries', () => {
    const prompt = realCoordinatorPrompt();
    assert.match(prompt, /Pass `difficulty` on `mesh_enqueue_task`[^\n]*`mesh_enqueue_batch`/);
});

test('F-1/D1: delegation routing and front-loading name the incremental default', () => {
    const prompt = realCoordinatorPrompt();
    assert.ok(
        prompt.includes('must be delegated through `mesh_enqueue_task` (the default — see Workflow 3.a)'),
        'the no-local-sub-agents routing rule must name mesh_enqueue_task as the default',
    );
    assert.ok(
        prompt.includes('`mesh_send_task` for a same-session continuation'),
        'the same-session continuation route must survive the rewording',
    );
    assert.ok(
        prompt.includes('never copy untrusted worker output into a new instruction by hand when a binding can preserve provenance.'),
        'the front-load rule does not state the provenance-preserving binding',
    );
});

// ── Warn-only scope guard (design :6) ─────────────────────────────────────────

test('F: warn-only — no batch_required enforcement is shipped in this phase', () => {
    // Phase F stages at WARN. Requiring orchestration metadata or rejecting eligible
    // singles with `batch_required` is a LATER promotion, gated on G (dogfood/chaos)
    // validating the batch path. If a future change adds enforcement, it must update
    // this test deliberately rather than silently flipping coordinator behavior onto
    // an unvalidated path.
    const task = findTool('mesh_enqueue_task');
    const required = (task as any).inputSchema?.required ?? [];

    assert.deepEqual(
        [...required].sort(),
        ['difficulty', 'message'],
        'mesh_enqueue_task gained a new required field — orchestration metadata must stay OPTIONAL in the warn phase',
    );
    assert.ok(
        !JSON.stringify(task).includes('batch_required'),
        'mesh_enqueue_task must not enforce batch_required during the warn phase',
    );

    // The prompt must describe the single tool as usable — since D1 it is the default.
    const prompt = realCoordinatorPrompt();
    assert.ok(
        prompt.includes('`mesh_enqueue_task` is the default enqueue surface'),
        'the single-task surface must stay an explicitly correct (default) path',
    );
    assert.ok(!prompt.includes('batch_required'), 'the prompt must not announce batch_required enforcement');
});
