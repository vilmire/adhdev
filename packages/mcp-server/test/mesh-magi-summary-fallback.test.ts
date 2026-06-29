import assert from 'node:assert/strict';
import test from 'node:test';

import {
    collectMagiCandidateTexts,
    parseFirstMagiCandidate,
    parseFirstMagiCandidateWithCompactFallback,
} from '../src/tools/mesh-tools.js';

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

// Fix-A-v2 (collect side). The collect read path calls RAW daemon read_chat (no `compact: true`),
// and the v1 read-chat contract strips the summary carriers Fix A harvests, so the parse was
// structurally inert there. parseFirstMagiCandidateWithCompactFallback re-derives the summary
// locally with the same compactChatPayload() lift and parses candidates from BOTH the raw payload
// (newest bubble body first; roles like `model` that compact's coordinator-visible filter drops)
// AND the compacted payload (surfaces the lifted `summary` for empty-bubble providers).

test('compact-fallback: recovers antigravity empty-bubble + summary-only answer', () => {
    // antigravity shape: the final assistant bubble is empty (_sameAsSummary) and the only copy
    // of the answer is carried in `summary`. Reading the bubble body alone returns ''.
    const payload = {
        status: 'idle',
        messages: [
            { role: 'user', content: 'investigate' },
            { role: 'assistant', content: '', _sameAsSummary: true },
        ],
        summary: VALID,
    };
    const parsed = parseFirstMagiCandidateWithCompactFallback(payload);
    assert.ok(parsed, 'antigravity summary-only answer must be recovered (not unparseable)');
    assert.equal(parsed!.top_findings[0], 'found X');
});

test('compact-fallback: recovers antigravity answer lifted from the final bubble into summary', () => {
    // When the raw payload has no top-level `summary` but the answer is in the final assistant
    // bubble, the compact lift (messageContent(finalAssistant) → summary) surfaces it. Mirrors
    // the daemon compact path so the collect parser sees the same `summary` carrier.
    const payload = {
        status: 'idle',
        messages: [
            { role: 'user', content: 'investigate' },
            { role: 'assistant', content: VALID },
        ],
    };
    const parsed = parseFirstMagiCandidateWithCompactFallback(payload);
    assert.ok(parsed, 'lifted summary must be recovered');
    assert.equal(parsed!.claims[0].claim, 'X holds');
});

test('compact-fallback: claude-shape (JSON in the bubble body) is not regressed', () => {
    const payload = { status: 'idle', messages: [{ role: 'assistant', content: VALID }] };
    const parsed = parseFirstMagiCandidateWithCompactFallback(payload);
    assert.ok(parsed, 'bubble-body answer must still be recovered');
    assert.equal(parsed!.claims[0].stance, 'support');
});

test('compact-fallback: raw candidates win, preserving the premature-collect guard', () => {
    // Earlier non-empty bubble holds the answer; the in-progress final bubble is empty.
    const payload = {
        status: 'generating',
        messages: [
            { role: 'assistant', content: VALID },
            { role: 'assistant', content: '' },
        ],
    };
    const parsed = parseFirstMagiCandidateWithCompactFallback(payload);
    assert.ok(parsed, 'earlier non-empty bubble must be recovered when the final bubble is empty');
});

test('compact-fallback: recovers a `model`-role answer that the compact filter would drop', () => {
    // compactChatPayload's coordinator-visible filter keeps only user/assistant/agent, so a
    // `model`-role bubble is dropped by compact alone. The raw candidate pass rescues it —
    // this is why candidates are gathered from BOTH payloads, not compact-only.
    const payload = { status: 'idle', messages: [{ role: 'model', content: VALID }] };
    const parsed = parseFirstMagiCandidateWithCompactFallback(payload);
    assert.ok(parsed, 'model-role answer must be recovered via the raw candidate pass');
    assert.equal(parsed!.claims[0].claim, 'X holds');
});

test('compact-fallback: still null when no candidate is parseable', () => {
    const payload = { status: 'generating', messages: [{ role: 'assistant', content: 'still thinking…' }] };
    assert.equal(parseFirstMagiCandidateWithCompactFallback(payload), null);
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
