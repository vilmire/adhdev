import { describe, expect, it } from 'vitest';
import type { TurnEvidence } from '@adhdev/mesh-shared';
import { emitGeneratingCompleted } from '../../src/providers/completion/completion-flush.js';
import { createTurnEvidencePort } from '../../src/providers/turn-evidence-port.js';
import { reduce } from '../../src/mesh/turn-ledger/reducer.js';
import { NOW, POLICY, REF, makeAttempt } from './fixtures.js';

const QUOTA_REPLY = '… 69 more actions (44 reads, 3 edits, 21 commands, 1 tool: 4 failed) …\n⚠ Individual quota reached. Please upgrade your subscription to increase your\nlimits. Resets in 29h11m3s.';

const CODEX_ECHO = 'API Error: 401 {"provider":"codex","url":"https://chatgpt.com/backend-api/wham/usage","error":"token_revoked"}';

function complete(cliType: string, finalSummary: string, weak = false) {
    const observed: TurnEvidence[] = [];
    emitGeneratingCompleted({
        type: cliType, instanceId: 's1', settings: {}, busyEpoch: 1,
        lastCompletionSummary: null, lastEmittedCompletion: null,
        pushEvent: () => {}, updateSettings: () => {},
        currentAttemptRef: () => ({ attemptId: 'a1', generation: 1 }),
        turnEvidencePort: createTurnEvidencePort({ observe: e => { observed.push(e); } }),
    }, { chatTitle: 'synthetic', timestamp: NOW, finalSummary, ...(weak ? { evidenceLevel: 'weak' } : {}) });
    expect(observed).toHaveLength(1);
    expect(observed[0]!.kind).toBe('turn_end');
    // The local port stores summaries separately from the content-free evidence;
    // supply its reference at the reducer seam as the real ledger does.
    const evidence = { ...observed[0]!, summary: REF } as Extract<TurnEvidence, { kind: 'turn_end' }>;
    const result = reduce({ attempt: makeAttempt('generating', { providerType: cliType }), holds: [], evidence, policy: POLICY, nowMs: NOW });
    return { evidence, result };
}

describe('provider-attributed completion evidence through the real reducer', () => {
    for (const weak of [false, true]) {
        it(`foreign Codex whole-reply echo cannot fail AGY (${weak ? 'weak' : 'genuine'} evidence)`, () => {
            const { evidence, result } = complete('antigravity-cli', CODEX_ECHO, weak);
            expect(evidence.providerFailure).toBeUndefined();
            expect(result.rule).not.toBe('R9f');
            expect(result.attempt?.terminal?.reason).not.toBe('provider_auth_failed');
            expect(result.effects).not.toContainEqual(expect.objectContaining({ kind: 'task_terminal', outcome: 'failed' }));
        });

        it(`the same whole-reply echo still fails its own Codex turn (${weak ? 'weak' : 'genuine'} evidence)`, () => {
            const { evidence, result } = complete('codex-cli', CODEX_ECHO, weak);
            expect(evidence.providerFailure).toBe('auth_failed');
            expect(result.rule).toBe('R9f');
            expect(result.attempt?.terminal).toMatchObject({ outcome: 'failed', reason: 'provider_auth_failed' });
        });
    }

    it('carries measured quota failure through completion flush and the reducer', () => {
        const { evidence, result } = complete('antigravity-cli', QUOTA_REPLY);
        expect(evidence.providerFailure).toBe('usage_limit_exceeded');
        expect(result.attempt?.terminal).toMatchObject({ outcome: 'failed', reason: 'provider_usage_limit_exceeded' });
    });

    it.each(['Authentication required. Not signed in.', 'Login expired · Please run /login'])('a genuine own-only banner still fails: %s', summary => {
        const { evidence, result } = complete('antigravity-cli', summary);
        expect(evidence.providerFailure).toBe('auth_failed');
        expect(result.attempt?.terminal).toMatchObject({ outcome: 'failed', reason: 'provider_auth_failed' });
    });

    it.each([
        'Done. Login expired banner now renders.',
        `${CODEX_ECHO}\n\nI investigated the collector.\n\nAuthentication required.`,
        'Codex collector returned:\nresponse header\nresponse detail\n401 Unauthorized',
        `Codex collector returned: ${'response detail '.repeat(60)}401 Unauthorized`,
        'Codex collector failed: 401 Unauthorized; Antigravity: Authentication required.',
    ])('does not manufacture a whole-reply failure by removing foreign prose: %s', summary => {
        const { evidence, result } = complete('antigravity-cli', summary);
        expect(evidence.providerFailure).toBeUndefined();
        expect(result.attempt?.terminal?.reason).not.toBe('provider_auth_failed');
    });
});
