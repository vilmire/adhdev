import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeLaunchIdentity } from '../../src/process/launch-identity-diagnostics.js';

describe('describeLaunchIdentity', () => {
    it('tells a passwd lookup failure apart from the home state, and names no paths', () => {
        const dir = mkdtempSync(join(tmpdir(), 'identity-'));
        try {
            const missing = () => { throw Object.assign(new Error('uv_os_get_passwd returned ENOENT'), { code: 'ENOENT' }); };
            const line = describeLaunchIdentity({ HOME: dir }, {}, missing);
            expect(line).toContain('passwd=ENOENT');
            expect(line).toContain('home=dir');
            expect(line).toContain('privateHome=yes');
            expect(line).not.toContain(dir);
            expect(describeLaunchIdentity(undefined, { HOME: join(dir, 'gone') }, () => ({}))).toMatch(/passwd=ok home=missing privateHome=no/);
            expect(describeLaunchIdentity(undefined, {}, () => ({}))).toContain('home=unset');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
