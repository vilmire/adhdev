import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, utimesSync } from 'node:fs';
import { getMeshConfigPath, withRecoveryMeshOwnershipFence, inRecoveryMeshOwnershipFence } from '../../src/config/mesh-config-store.js';

describe('actual cross-process recovery owner fence', () => {
    it('prevents the ordinary config writer unlocked/stale fallback while recovery owns the physical lock', () => {
        const module = resolve('src/config/mesh-config-store.ts');
        const script = `import store from ${JSON.stringify(pathToFileURL(module).href)};
            const {withMeshConfigWriteLock} = store;
            try { withMeshConfigWriteLock(() => { console.log('UNSAFE_CALLBACK'); }); }
            catch (e) { console.log(e.code); }`;
        const result = withRecoveryMeshOwnershipFence(() => {
            expect(inRecoveryMeshOwnershipFence()).toBe(true);
            // Even a stale-looking lock cannot be stolen while the security
            // marker says an exact recovery owns the transaction interval.
            utimesSync(getMeshConfigPath() + '.lock', new Date(0), new Date(0));
            return String(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
                { env: { ...process.env }, windowsHide: true, timeout: 15000 }));
        });
        expect(result).toContain('store_busy'); expect(result).not.toContain('UNSAFE_CALLBACK');
        expect(inRecoveryMeshOwnershipFence()).toBe(false);
        expect(existsSync(getMeshConfigPath() + '.lock')).toBe(false);
    });
});
