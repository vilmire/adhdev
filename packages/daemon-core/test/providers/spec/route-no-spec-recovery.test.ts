import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../../../src/track-identity.js';
import { createCliAdapter, formatNoResolvableSpecError } from '../../../src/providers/spec/route.js';

describe('no-resolvable-spec recovery copy', () => {
    it('names the real CLI command and the dashboard stale-badge path', () => {
        const message = formatNoResolvableSpecError('opencode', '/tmp/providers/cli/opencode');
        const cli = `${IDENTITY.binaryName} provider sync-channel`;
        expect(message).toContain(cli);
        expect(message).toContain('no extra arguments');
        expect(message).toContain('stale provider badge');
        expect(message).toContain('Providers tab');
        expect(message).not.toContain('providers sync');
        expect(message).not.toContain('dashboard provider refresh');
    });

    it('createCliAdapter throws that same recovery copy when no spec exists', () => {
        expect(() => createCliAdapter(
            { type: 'opencode' } as any,
            '/tmp',
            [],
            {},
        )).toThrow(formatNoResolvableSpecError('opencode'));
    });
});
