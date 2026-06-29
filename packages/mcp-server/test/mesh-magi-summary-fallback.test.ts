import assert from 'node:assert/strict';
import test from 'node:test';

import { collectMagiCandidateTexts, parseFirstMagiCandidate } from '../src/tools/mesh-tools.js';

// Fix A (summary fallback + premature-collect guard, parse side). A MAGI replica's structured
// JSON answer does not always live in the last assistant transcript bubble:
//   1. The premature-collect symptom — an EMPTY in-progress final bubble; the real answer is
//      in an earlier assistant bubble.
//   2. antigravity-cli — the answer is carried in a `summary` field while the transcript bubble
//      body is empty (_sameAsSummary). Reading only the last bubble returns '' and the answer
//      is never parsed.
// parseFirstMagiCandidate walks every assistant bubble + every summary carrier (per-message
// and payload-level), newest-first, and parses the first that yields a valid MAGI response.

const VALID = JSON.stringify({
    claims: [{ claim: 'X holds', stance: 'support', evidence: ['a.ts:1'], confidence: 0.8 }],
    top_findings: ['found X'],
    open_questions: [],
});

test('parses an EARLIER assistant bubble when the final bubble is empty (premature-collect guard)', () => {
    const payload = {
        messages: [
            { role: 'user', content: 'investigate' },
            { role: 'assistant', content: VALID },
            // Mid-turn empty final bubble — the premature-collect trap.
            { role: 'assistant', content: '' },
        ],
    };
    const parsed = parseFirstMagiCandidate(payload);
    assert.ok(parsed, 'should parse the earlier non-empty assistant bubble');
    assert.equal(parsed!.claims[0].claim, 'X holds');
});

test('falls back to a payload-level summary when the bubble body is empty (antigravity)', () => {
    const payload = {
        // antigravity: transcript bubble emptied (_sameAsSummary) and the answer is in summary.
        messages: [{ role: 'assistant', content: '', _sameAsSummary: true }],
        summary: VALID,
    };
    const parsed = parseFirstMagiCandidate(payload);
    assert.ok(parsed, 'should fall back to payload.summary');
    assert.equal(parsed!.top_findings[0], 'found X');
});

test('falls back to a per-message summary field when the bubble body is empty', () => {
    const payload = {
        messages: [{ role: 'assistant', content: '', summary: VALID }],
    };
    const parsed = parseFirstMagiCandidate(payload);
    assert.ok(parsed, 'should fall back to the message-level summary');
});

test('still parses the normal case (answer in the last assistant bubble)', () => {
    const payload = { messages: [{ role: 'assistant', content: VALID }] };
    const parsed = parseFirstMagiCandidate(payload);
    assert.ok(parsed);
    assert.equal(parsed!.claims[0].stance, 'support');
});

test('returns null when no candidate is parseable (re-wait/unparseable is the caller\'s job)', () => {
    const payload = { messages: [{ role: 'assistant', content: 'still thinking…' }], summary: '' };
    assert.equal(parseFirstMagiCandidate(payload), null);
});

test('collectMagiCandidateTexts is newest-first, deduped, and drops empties', () => {
    const payload = {
        messages: [
            { role: 'assistant', content: 'first' },
            { role: 'assistant', content: '' },
            { role: 'assistant', content: 'second' },
        ],
        summary: 'second', // duplicate of a bubble → deduped
        finalSummary: 'tail',
    };
    const candidates = collectMagiCandidateTexts(payload);
    assert.deepEqual(candidates, ['second', 'first', 'tail']);
});
