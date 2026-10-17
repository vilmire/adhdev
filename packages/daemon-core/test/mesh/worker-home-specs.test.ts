import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { findWorkerPrivateHomeSpec } from '../../src/mesh/worker-home-specs.js';

describe('Grok home imports', () => {
    it('never links the updater install or version file into the real home', () => {
        const spec = findWorkerPrivateHomeSpec('grok-cli')!;
        expect(spec.imports.find(entry => entry.relativePath === path.join('.grok', 'bin'))).toBeUndefined();
        expect(spec.imports.find(entry => entry.relativePath === path.join('.grok', 'version.json'))?.mode).toBe('copy');
        expect(spec.imports.find(entry => entry.relativePath === path.join('.grok', 'config.toml'))?.mode).toBe('copy');
        expect(spec.imports.find(entry => entry.relativePath === path.join('.grok', 'auth.json'))).toMatchObject({ mode: 'symlink', required: true, requireOwnerOnly: true });
    });
});
