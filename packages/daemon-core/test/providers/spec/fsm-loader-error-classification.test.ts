/**
 * fsm-loader.ts validation for CliSpecV4.error_classification
 * (ERROR-NOT-COMPLETION, 2026-09) — mirrors the startup_dismiss validation
 * coverage in driver-startup-dismiss.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';

function baseSpec(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.error-classification',
        name: 'error classification test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: {},
        states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }],
        transitions: [],
        ...overrides,
    };
}

describe('validateFsmSpec -- error_classification', () => {
    it('accepts a spec with no error_classification (today\'s default for every provider but Kimi)', () => {
        expect(validateFsmSpec(baseSpec({}))).toEqual([]);
    });

    it('accepts a well-formed declaration across all four classes', () => {
        expect(validateFsmSpec(baseSpec({
            error_classification: {
                transport: { patterns: [{ regex: 'connection closed' }], requires: 'no_further_generation' },
                auth: { patterns: [{ regex: 'login expired' }] },
                billing: { patterns: [{ regex: 'subscription expired' }] },
                quota: { patterns: [{ regex: 'usage limit' }], requires: 'provider_failure_envelope' },
            },
        }))).toEqual([]);
    });

    it('rejects an unrecognized class name', () => {
        expect(validateFsmSpec(baseSpec({
            error_classification: { network: { patterns: [{ regex: 'x' }] } },
        }))).toContain('error_classification.network is not a recognized class (expected one of: transport, auth, billing, quota)');
    });

    it('rejects a bucket with an empty/missing patterns array', () => {
        expect(validateFsmSpec(baseSpec({
            error_classification: { auth: { patterns: [] } },
        }))).toContain('error_classification.auth.patterns must be a non-empty array');
        expect(validateFsmSpec(baseSpec({
            error_classification: { auth: {} },
        }))).toContain('error_classification.auth.patterns must be a non-empty array');
    });

    it('rejects a pattern with a missing or non-compiling regex', () => {
        expect(validateFsmSpec(baseSpec({
            error_classification: { auth: { patterns: [{ flags: 'i' }] } },
        }))).toContain('error_classification.auth.patterns[0].regex is required');
        expect(validateFsmSpec(baseSpec({
            error_classification: { auth: { patterns: [{ regex: '(' }] } },
        }))).toContain('error_classification.auth.patterns[0].regex does not compile');
    });

    it('rejects an invalid `requires` value', () => {
        expect(validateFsmSpec(baseSpec({
            error_classification: { transport: { patterns: [{ regex: 'x' }], requires: 'always' } },
        }))).toContain('error_classification.transport.requires must be "no_further_generation" or "provider_failure_envelope" when provided');
    });

    it('rejects error_classification that is not an object', () => {
        expect(validateFsmSpec(baseSpec({ error_classification: 'oops' })))
            .toContain('error_classification must be an object');
        expect(validateFsmSpec(baseSpec({ error_classification: [] })))
            .toContain('error_classification must be an object');
    });
});
