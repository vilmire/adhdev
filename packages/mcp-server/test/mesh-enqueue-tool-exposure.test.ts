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
//   2. a ranked deferred search for "enqueue"/"delegate" returns batch first;
//   3. an unranked lister sees batch first by registry order.
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

test('F-4: batch outranks the single-task fallback for enqueue/delegate queries', () => {
    // ★ The precise regression: the coordinator picked the FALLBACK first and stopped.
    for (const query of ['enqueue', 'delegate']) {
        const candidates = deferredToolSearch(query);
        const batchAt = candidates.indexOf('mesh_enqueue_batch');
        const taskAt = candidates.indexOf('mesh_enqueue_task');
        assert.ok(batchAt >= 0 && taskAt >= 0, `"${query}" must surface both enqueue tools`);
        assert.ok(
            batchAt < taskAt,
            `"${query}" ranked mesh_enqueue_task (${taskAt}) ahead of mesh_enqueue_batch (${batchAt})`,
        );
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

test('F-2: mesh_enqueue_batch precedes mesh_enqueue_task in ALL_MESH_TOOLS', () => {
    const names = ALL_MESH_TOOLS.map(t => t.name);
    const batchAt = names.indexOf('mesh_enqueue_batch');
    const taskAt = names.indexOf('mesh_enqueue_task');
    assert.ok(batchAt >= 0 && taskAt >= 0, 'both enqueue tools must be published');
    assert.ok(
        batchAt < taskAt,
        `registry order puts the fallback first (batch ${batchAt}, task ${taskAt}) — a client that lists without ranking sees the wrong default`,
    );
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
            ['mesh_enqueue_batch', 'mesh_enqueue_task'],
            `${tool.name} must list both siblings so loading either exposes the other`,
        );
    }
});

// ── F-3: the tool descriptions carry the design's verbatim framing ────────────

test('F-3: mesh_enqueue_batch is described as the DEFAULT enqueue surface', () => {
    const description = findTool('mesh_enqueue_batch').description ?? '';
    assert.match(description, /DEFAULT enqueue surface for a plan with two or more known graph steps/);
    assert.match(description, /Atomically persists the graph plan and worker queue entries/);
    // The atomicity boundary must stay stated: DB plan atomicity is NOT git.
    assert.match(description, /compensated saga and is reported separately from DB atomicity/);
});

test('F-3: mesh_enqueue_task is described as the SINGLE-TASK FALLBACK and redirects to batch', () => {
    const description = findTool('mesh_enqueue_task').description ?? '';
    assert.match(description, /SINGLE-TASK FALLBACK/);
    assert.match(description, /load and use mesh_enqueue_batch instead/);
    assert.match(description, /Same-session continuation belongs in mesh_send_task/);
});

// ── F-1: the prompt instruction, and its ORDERING ─────────────────────────────

test('F-1: the prompt carries the verbatim tool-discovery instruction', () => {
    const prompt = realCoordinatorPrompt();
    assert.ok(
        prompt.includes(
            'Before searching for an enqueue tool, classify the whole currently known work frontier. For every new delegation search, include `mesh_enqueue_batch` by exact name; never search for or load only `mesh_enqueue_task`. Load `mesh_enqueue_task` only as the single-task fallback after the batch eligibility check below fails.',
        ),
        'the required tool-discovery instruction is missing or reworded',
    );
});

test('F-1: ★ the discovery instruction precedes the workflow and the tool table rows', () => {
    // ★ This ordering assertion is the whole point of placement. The instruction only
    // works if the model reads it BEFORE issuing its first deferred tool search; an
    // identical sentence further down the prompt would not have prevented the observed
    // failure. Assert position, not just presence.
    const prompt = realCoordinatorPrompt();

    const discoveryAt = prompt.indexOf('Before searching for an enqueue tool');
    const preflightAt = prompt.indexOf('## Tool Exposure Preflight');
    const stalenessAt = prompt.indexOf('Before doing any coordinator work, confirm that the actual callable tool list');
    const workflowAt = prompt.indexOf('## Orchestration Workflow');

    assert.ok(discoveryAt >= 0, 'discovery instruction missing');
    assert.ok(preflightAt >= 0 && stalenessAt >= 0 && workflowAt >= 0, 'prompt sections missing');

    assert.ok(
        discoveryAt > preflightAt,
        'the discovery instruction must live inside Tool Exposure Preflight',
    );
    assert.ok(
        discoveryAt < stalenessAt,
        'the discovery instruction must come at the BEGINNING of Tool Exposure Preflight, before the staleness check',
    );
    assert.ok(
        discoveryAt < workflowAt,
        'the discovery instruction must precede the general Orchestration Workflow',
    );
});

test('F-1: the prompt carries the batch-first eligibility text and its safety boundary', () => {
    const prompt = realCoordinatorPrompt();

    // ★ GRAPH-ADOPTION P4-b restated the ELIGIBILITY TRIGGER, not the rule's content.
    // The original phrasing ("whenever the currently known plan contains two or more
    // graph steps") is a predicate over the coordinator's own private, momentary
    // awareness — it has no observable referent, so it cannot actually be checked, and
    // measured adoption was zero. It is now a binary question about a checkable fact,
    // matching the shape of Workflow 3.b0, which is followed 100% of the time. What
    // this test protects is unchanged: the trigger exists, the whole plan goes in one
    // batch, the single fallback has a stated condition, and the anti-speculation
    // boundary sits with the rule.
    assert.ok(
        prompt.includes('will I read its result and then dispatch more work'),
        'batch-first eligibility trigger missing',
    );
    assert.ok(
        prompt.includes('You will act on the result → `mesh_enqueue_batch`'),
        'the trigger must resolve to the batch surface when a successor is intended',
    );
    assert.ok(
        prompt.includes('Submit the whole materializable plan in ONE batch.'),
        'the "submit the whole plan once" clause is missing',
    );
    assert.ok(
        prompt.includes('The result goes to the user and nothing follows → `mesh_enqueue_task`'),
        'single-task fallback condition missing',
    );

    // ★ Without this boundary the batch-first rule actively backfires: a coordinator
    // pressured to "form a batch" invents downstream tasks it cannot faithfully state.
    assert.ok(
        prompt.includes('Do not invent speculative downstream instructions merely to form a batch'),
        'the anti-speculation safety boundary is missing',
    );
    assert.ok(
        prompt.includes('is single-task enqueue correct'),
        'the safety boundary must end by blessing the single-task enqueue',
    );

    // The boundary has to sit WITH the rule it constrains, not elsewhere in the prompt.
    const ruleAt = prompt.indexOf('**Batch-first rule.**');
    const boundaryAt = prompt.indexOf('Do not invent speculative downstream instructions');
    assert.ok(ruleAt >= 0 && boundaryAt > ruleAt, 'the safety boundary must follow the batch-first rule');
});

test('F-1: difficulty is stated for batch worker entries as well as the single-task fallback', () => {
    const prompt = realCoordinatorPrompt();
    assert.ok(
        prompt.includes(
            'Pass `difficulty` on every worker entry in `mesh_enqueue_batch`, or on `mesh_enqueue_task` for the single-task fallback.',
        ),
        'the difficulty sentence was not updated for batch entries',
    );
});

test('F-1: delegation routing and front-loading name the batch surface', () => {
    const prompt = realCoordinatorPrompt();

    // ★ P4-c: this rule's SUBJECT is "never use local sub-agents" — it names the
    // enqueue surfaces only in passing. It previously listed batch and task as
    // co-equal options ("batch for a multi-step graph, task for one ready task"),
    // which re-flattens the very preference Workflow 3.a states, in a rule the
    // coordinator reads far more often than the workflow. It now orders them.
    assert.ok(
        prompt.includes(
            'must be delegated through `mesh_enqueue_batch` (the default — see Workflow 3.a), falling back to `mesh_enqueue_task` only for a terminal single step',
        ),
        'the no-local-sub-agents routing rule must name batch as the default, not as one of two equal options',
    );
    assert.ok(
        prompt.includes('`mesh_send_task` for a same-session continuation'),
        'the same-session continuation route must survive the rewording',
    );
    assert.ok(
        prompt.includes(
            'Put predecessor-produced data in explicit `inputs_from` bindings and coordinator decisions in gates; never copy untrusted worker output into a new instruction by hand when a binding can preserve provenance.',
        ),
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

    // The prompt must still describe the single tool as usable, not forbidden.
    // ★ P4 sharpened the batch-first trigger; it must NOT have crossed into forbidding
    // the single surface, which would be enforcement smuggled in through wording.
    const prompt = realCoordinatorPrompt();
    assert.ok(
        prompt.includes('is single-task enqueue correct'),
        'the warn phase must keep an explicitly correct single-task path',
    );
    assert.ok(
        prompt.includes('The result goes to the user and nothing follows → `mesh_enqueue_task`'),
        'the single surface must keep a stated case where it is the right answer',
    );
});
