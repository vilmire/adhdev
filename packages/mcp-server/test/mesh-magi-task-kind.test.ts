import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildMagiTaskPrompt,
    detectQuestionOutputSchemaConflict,
    magiOutputContractFor,
    normalizeMagiTaskKind,
    parseMagiResponseForKind,
    type MagiDesignResponse,
    type MagiRcaResponse,
} from '../src/tools/mesh-tools.js';

// ─── normalizeMagiTaskKind / backward compat ────

test('normalizeMagiTaskKind defaults to claim_audit for missing/invalid input', () => {
    assert.equal(normalizeMagiTaskKind(undefined), 'claim_audit');
    assert.equal(normalizeMagiTaskKind(''), 'claim_audit');
    assert.equal(normalizeMagiTaskKind('nonsense'), 'claim_audit');
    assert.equal(normalizeMagiTaskKind('RCA'), 'rca');
    assert.equal(normalizeMagiTaskKind('design'), 'design');
    assert.equal(normalizeMagiTaskKind('freeform'), 'freeform');
});

// ─── Panel defaultKind resolution priority ──────
// mesh_magi_review resolves the kind as: normalizeMagiTaskKind(explicit ?? panel.defaultKind).
// These assert the `??` precedence collapses to the documented
// args.task_kind > panel.defaultKind > claim_audit order at the normalizer boundary.

test('explicit task_kind wins over a panel defaultKind', () => {
    const explicit = 'design';
    const panelDefaultKind = 'rca';
    assert.equal(normalizeMagiTaskKind(explicit ?? panelDefaultKind), 'design');
});

test('panel defaultKind fills in when no explicit kind is passed', () => {
    const explicit = undefined;
    const panelDefaultKind = 'rca';
    assert.equal(normalizeMagiTaskKind(explicit ?? panelDefaultKind), 'rca');
});

test('claim_audit is the final fallback when neither explicit nor panel default is set', () => {
    const explicit = undefined;
    const panelDefaultKind = undefined;
    assert.equal(normalizeMagiTaskKind(explicit ?? panelDefaultKind), 'claim_audit');
});

// ─── B: one schema per kind, no schema-on-schema ─

test('buildMagiTaskPrompt injects ONLY the selected kind contract', () => {
    const rcaPrompt = buildMagiTaskPrompt({ question: 'why does X fail?', taskKind: 'rca' });
    assert.ok(rcaPrompt.includes('"rootCause"'), 'rca contract present');
    assert.ok(rcaPrompt.includes('"mechanism"'), 'rca contract present');
    // The claim_audit and design contracts must NOT also be embedded.
    assert.ok(!rcaPrompt.includes('"top_findings"'), 'claim_audit contract absent');
    assert.ok(!rcaPrompt.includes('"recommendation"'), 'design contract absent');
    assert.ok(rcaPrompt.includes('Task kind: rca.'));

    const designPrompt = buildMagiTaskPrompt({ question: 'how to structure?', taskKind: 'design' });
    assert.ok(designPrompt.includes('"recommendation"'));
    assert.ok(!designPrompt.includes('"rootCause"'));
    assert.ok(!designPrompt.includes('"claims"'));

    // Default (omitted kind) is the legacy claim_audit contract — backward compatible.
    const defaultPrompt = buildMagiTaskPrompt({ question: 'q' });
    assert.ok(defaultPrompt.includes('"claims"'));
    assert.ok(!defaultPrompt.includes('"rootCause"'));

    const freeformPrompt = buildMagiTaskPrompt({ question: 'q', taskKind: 'freeform' });
    assert.ok(freeformPrompt.includes('No JSON schema is required'));
    assert.ok(!freeformPrompt.includes('"claims"'));
});

test('magiOutputContractFor returns exactly one contract per kind', () => {
    assert.ok(magiOutputContractFor('claim_audit').includes('"claims"'));
    assert.ok(magiOutputContractFor('rca').includes('"rootCause"'));
    assert.ok(magiOutputContractFor('design').includes('"recommendation"'));
    assert.ok(magiOutputContractFor('freeform').includes('natural language'));
});

// ─── B: question-embedded schema conflict warning

test('detectQuestionOutputSchemaConflict flags an embedded output schema', () => {
    assert.ok(detectQuestionOutputSchemaConflict('Investigate X. Respond with ONLY a single JSON object: {"claims": []}'));
    assert.ok(detectQuestionOutputSchemaConflict('... output format: {...}'));
    // A clean question with no schema instructions does not warn.
    assert.equal(detectQuestionOutputSchemaConflict('What is the root cause of the deadlock in worker.ts?'), null);
    assert.equal(detectQuestionOutputSchemaConflict(''), null);
});

// ─── kind-aware parsing: claim_audit ─────────────

test('parseMagiResponseForKind(claim_audit) parses the legacy common schema', () => {
    const text = JSON.stringify({
        claims: [{ claim: 'X is the cause', stance: 'support', evidence: ['a.ts:10'], confidence: 0.9 }],
        top_findings: ['f1'],
        open_questions: [],
    });
    const r = parseMagiResponseForKind(text, 'claim_audit');
    assert.equal(r.ok, true);
    assert.equal(r.response!.claims.length, 1);
    assert.equal(r.response!.claims[0].stance, 'support');
});

// ─── kind-aware parsing: rca ─────────────────────

test('parseMagiResponseForKind(rca) parses a claims-LESS rca envelope (previously dropped)', () => {
    const text = JSON.stringify({
        rootCause: 'unnormalized daemon-id raw compare',
        failsAt: 'mesh-crud.ts:120',
        mechanism: 'daemon_mach_ vs mach_ form mismatch routes a duplicate dispatch',
        evidence: ['mesh-crud.ts:120', 'mesh-events-pending.ts:133'],
        fixDirection: 'apply daemonIdsEquivalent at the compare site',
        confidence: 0.8,
    });
    // The OLD common-schema parser hard-required a claims[] array and would drop this.
    // The kind parser accepts it.
    const r = parseMagiResponseForKind(text, 'rca');
    assert.equal(r.ok, true, 'rca envelope without claims[] now parses');
    const payload = r.payload as MagiRcaResponse;
    assert.equal(payload.rootCause, 'unnormalized daemon-id raw compare');
    assert.equal(payload.failsAt, 'mesh-crud.ts:120');
    // Adapted to common schema for synthesis: rootCause → one supporting claim w/ evidence.
    assert.equal(r.response!.claims.length, 1);
    assert.equal(r.response!.claims[0].stance, 'support');
    assert.deepEqual(r.response!.claims[0].evidence, ['mesh-crud.ts:120', 'mesh-events-pending.ts:133']);
});

test('parseMagiResponseForKind(rca) extracts an rca envelope embedded in prose / fence', () => {
    const text = 'Here is my RCA.\n```json\n' + JSON.stringify({
        rootCause: 'race in submit',
        mechanism: 'inject and submit not separated',
        evidence: ['fsm.ts:42'],
        failsAt: 'fsm.ts:42',
        fixDirection: 'echo-gate',
        confidence: 0.7,
    }) + '\n```\nDone.';
    const r = parseMagiResponseForKind(text, 'rca');
    assert.equal(r.ok, true);
    assert.equal((r.payload as MagiRcaResponse).rootCause, 'race in submit');
});

test('parseMagiResponseForKind(rca) fails missing required fields → triggers retry reason', () => {
    const r = parseMagiResponseForKind(JSON.stringify({
        rootCause: 'something',
        // mechanism missing
        evidence: ['a.ts:1'],
    }), 'rca');
    assert.equal(r.ok, false);
    assert.equal(r.failReason, 'missing_required_fields');
});

// ─── kind-aware parsing: design ──────────────────

test('parseMagiResponseForKind(design) parses a claims-less design envelope', () => {
    const text = JSON.stringify({
        recommendation: 'split mesh-tools.ts into domain modules',
        rationale: 'the file is 105KB and mixes concerns',
        alternatives: ['leave as-is', 'extract only magi'],
        tradeoffs: ['more files', 'clearer ownership'],
        risks: ['import cycles'],
        evidence: ['mesh-tools.ts:1'],
        confidence: 0.6,
    });
    const r = parseMagiResponseForKind(text, 'design');
    assert.equal(r.ok, true);
    const payload = r.payload as MagiDesignResponse;
    assert.equal(payload.recommendation, 'split mesh-tools.ts into domain modules');
    // risks adapt to open_questions; rationale/alternatives/tradeoffs to top_findings.
    assert.ok(r.response!.open_questions.some(q => q.includes('import cycles')));
    assert.ok(r.response!.top_findings.some(f => f.includes('the file is 105KB')));
});

// ─── D: empty evidence[] fails (retry trigger) ───

test('parseMagiResponseForKind(rca) with empty evidence[] fails validation (D-rule)', () => {
    const r = parseMagiResponseForKind(JSON.stringify({
        rootCause: 'x',
        mechanism: 'y',
        evidence: [],
        confidence: 0.9,
    }), 'rca');
    assert.equal(r.ok, false);
    assert.equal(r.failReason, 'empty_evidence');
});

test('parseMagiResponseForKind(design) with empty evidence[] fails validation (D-rule)', () => {
    const r = parseMagiResponseForKind(JSON.stringify({
        recommendation: 'x',
        rationale: 'y',
        evidence: [],
    }), 'design');
    assert.equal(r.ok, false);
    assert.equal(r.failReason, 'empty_evidence');
});

// ─── freeform passes with no schema / no evidence ─

test('parseMagiResponseForKind(freeform) accepts any non-empty natural-language text', () => {
    const r = parseMagiResponseForKind('The deadlock comes from the lock ordering in the queue.', 'freeform');
    assert.equal(r.ok, true);
    assert.equal((r.payload as { text: string }).text, 'The deadlock comes from the lock ordering in the queue.');
    // empty text is the only freeform failure.
    assert.equal(parseMagiResponseForKind('   ', 'freeform').ok, false);
});

// ─── antigravity-shape fusion recovered for design ─

test('parseMagiResponseForKind(design) recovers an antigravity-fused envelope (question + claims + escaped JSON)', () => {
    // antigravity symptom: it fuses the question-envelope and the output contract, nesting
    // an escaped JSON string inside a top_findings array. The real design payload object is
    // still present as a balanced JSON object in the text — the kind parser extracts it.
    const fused = [
        'I will answer the question.',
        JSON.stringify({
            // a claims-fused wrapper the OLD parser would have locked onto and mis-shaped
            claims: ['see below'],
            top_findings: ['{\\"recommendation\\": \\"ignore me, I am escaped\\"}'],
        }),
        'But the structured answer is:',
        JSON.stringify({
            recommendation: 'adopt task_kind schemas',
            rationale: 'removes the schema-on-schema collision',
            alternatives: ['keep single schema'],
            tradeoffs: ['more parser branches'],
            risks: ['kind drift'],
            evidence: ['mesh-tools-magi.ts:647'],
            confidence: 0.85,
        }),
    ].join('\n\n');
    const r = parseMagiResponseForKind(fused, 'design');
    assert.equal(r.ok, true, 'design payload recovered from the fused output');
    assert.equal((r.payload as MagiDesignResponse).recommendation, 'adopt task_kind schemas');
    assert.deepEqual((r.payload as MagiDesignResponse).evidence, ['mesh-tools-magi.ts:647']);
});

test('parseMagiResponseForKind(rca) returns no_parseable_output for non-JSON', () => {
    const r = parseMagiResponseForKind('just prose, no json at all', 'rca');
    assert.equal(r.ok, false);
    assert.equal(r.failReason, 'no_parseable_output');
});
