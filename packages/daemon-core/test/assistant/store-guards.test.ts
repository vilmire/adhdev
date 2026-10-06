import { describe, expect, it } from 'vitest';
import { classifyWriteOrigin, detectCredential, mustStage } from '../../src/assistant/store-guards.js';

/**
 * Assistant store write guards (design 2026-10-07-assistant-layer.md §4.10.2
 * checks 4–5). Fixture "secrets" are synthetic strings built at runtime so no
 * real-looking token literal sits in the repo.
 */

const rep = (s: string, n: number) => s.repeat(n);

describe('detectCredential — one positive per prefix/pattern', () => {
    const cases: Array<[string, string, string]> = [
        ['adk_ API key', `token adk_${rep('a1B2', 6)} here`, 'adhdev_token'],
        ['adm_ machine secret', `adm_${rep('Zz9', 5)}`, 'adhdev_token'],
        ['shr_ share token', `link shr_${rep('q7', 6)}`, 'adhdev_token'],
        ['JWT shape', `eyJhbGciOi.${rep('eyJzdWIi', 2)}.${rep('sig_x', 3)}`, 'jwt'],
        ['sk- key', `OPENAI=sk-${rep('Ab3', 8)}`, 'openai_style_key'],
        ['ghp_ token', `ghp_${rep('Xy7', 8)}`, 'github_token'],
        ['github_pat_', `github_pat_${rep('11AB', 6)}`, 'github_pat'],
        ['xoxb- slack bot', `xoxb-${rep('1234-', 3)}abc`, 'slack_token'],
        ['xoxp- slack user', `xoxp-${rep('98', 6)}`, 'slack_token'],
        ['AKIA aws key', `AKIA${rep('IOSF', 4)}`, 'aws_access_key'],
        ['PEM header', `-----BEGIN ${'OPENSSH PRIVATE KEY'}-----`, 'pem_header'],
        ['32+ hex run', `sha ${rep('deadbeef', 4)}`, 'long_hex'],
        ['32+ base64 run', `key ${rep('Qm9vYXJ7', 5)}+/`, 'long_base64'],
    ];
    for (const [name, text, id] of cases) {
        it(`rejects ${name}`, () => {
            expect(detectCredential(text)).toBe(id);
        });
    }
});

describe('detectCredential — false-positive negatives (must NOT reject)', () => {
    const ok = [
        'Windows machines spawn git slowly; run target test files only',
        'reports in concise Korean DONE/BLOCKED',
        'the adk_ prefix is an API key; adm_ is a machine secret',
        'task-runner and disk-usage-monitoring-tool are fine', // sk- inside a word
        'version 1.0.60 and rc.62 and a.b.c dotted names',
        'path oss/packages/daemon-core/src/assistant/memory/memory-store.ts',
        'short sha 15f69854b and uuid 550e8400-e29b-41d4-a716-446655440000',
        'identifier MeshRuntimeStoreClaimAutoLaunchHandlerFactory',
        'snake_case_identifier_with_many_parts_v2_final_really',
        'AKIA alone is just letters',
        '한국어 메모: 프리뷰 배포는 Mac에서만',
    ];
    for (const text of ok) {
        it(`accepts: ${text.slice(0, 40)}`, () => {
            expect(detectCredential(text)).toBeNull();
        });
    }
});

describe('classifyWriteOrigin / mustStage', () => {
    it('after a human input → human (applied)', () => {
        expect(classifyWriteOrigin(['relay', 'human'])).toBe('human');
        expect(mustStage('human')).toBe(false);
    });
    it('relay / progress / stall / restart note / first-run after the last human → relay (staged)', () => {
        for (const src of ['relay', 'progress', 'stall', 'restart_note', 'first_run'] as const) {
            expect(classifyWriteOrigin(['human', src])).toBe('relay');
        }
        expect(mustStage('relay')).toBe(true);
    });
    it('a human steer after a relay still counts as human only if nothing non-human follows', () => {
        expect(classifyWriteOrigin(['human', 'relay', 'human'])).toBe('human');
        expect(classifyWriteOrigin(['human', 'relay', 'human', 'relay'])).toBe('relay');
    });
    it('no human input at all is staged (fail-closed)', () => {
        expect(classifyWriteOrigin([])).toBe('relay');
        expect(classifyWriteOrigin(['first_run'])).toBe('relay');
    });
    it('the review turn applies directly (journaled as review)', () => {
        expect(classifyWriteOrigin(['human', 'relay', 'review'])).toBe('review');
        expect(mustStage('review')).toBe(false);
        expect(mustStage('owner')).toBe(false);
    });
});
