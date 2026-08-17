/**
 * Minimal spec fixture for tests that construct CliProviderInstance with a
 * mock provider. Since the legacy ProviderCliAdapter was deleted
 * (2026-08-17), createCliAdapter fails closed when a provider has no
 * resolvable spec — instance-level tests that exercise behavior ABOVE the
 * adapter attach this throwaway spec so construction succeeds on the
 * SpecCliAdapter path.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MINIMAL_SPEC = {
    $schema: 'adhdev:cli/spec@4',
    id: 'test-minimal',
    name: 'Test Minimal',
    binary: '/bin/true',
    send_message: { submit_key: '\r' },
    sections: {},
    states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }],
    transitions: [],
};

let cachedSpecPath: string | null = null;

/** Path to a shared minimal spec.json (written once per test process). */
export function minimalSpecPath(): string {
    if (!cachedSpecPath) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-spec-'));
        cachedSpecPath = path.join(dir, 'spec.json');
        fs.writeFileSync(cachedSpecPath, JSON.stringify(MINIMAL_SPEC));
    }
    return cachedSpecPath;
}

/** Return `provider` with `_resolvedSpecPath` stamped so spec routing succeeds. */
export function withMinimalSpec<T extends Record<string, unknown>>(provider: T): T & { _resolvedSpecPath: string } {
    return { ...provider, _resolvedSpecPath: minimalSpecPath() };
}
