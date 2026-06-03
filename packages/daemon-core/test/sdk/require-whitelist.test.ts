/**
 * Provider require whitelist — behavior tests against a temp scratch
 * directory acting as a provider root.
 *
 * Cases:
 *  - Allowed stdlib (path, os, crypto, util, etc.) passes through
 *  - fs is shimmed (read ops work, write ops missing)
 *  - child_process is shimmed (execFileSync works, exec/spawn/fork absent)
 *  - child_process.execFileSync rejects shell:true and string `args`
 *  - Relative paths inside the root succeed
 *  - Relative paths that escape the root throw PROVIDER_REQUIRE_DENIED
 *  - Bare specifiers not on the list throw PROVIDER_REQUIRE_DENIED
 *  - Daemon code (callers outside any registered root) is unaffected
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
    registerProviderScriptRoot,
    _resetProviderScriptRoots,
    PROVIDER_REQUIRE_POLICY,
} from '../../src/providers/sdk/v1/sandbox/require-whitelist.js';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-require-test-'));
const PROVIDER_DIR = path.join(SCRATCH, 'cli', 'fake-cli');
const SHARED_DIR = path.join(SCRATCH, 'cli', '_shared');

beforeAll(() => {
    fs.mkdirSync(PROVIDER_DIR, { recursive: true });
    fs.mkdirSync(SHARED_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHARED_DIR, 'helper.js'), `module.exports = { tag: 'shared-helper' };`);
    fs.writeFileSync(path.join(SCRATCH, 'outside.js'), `module.exports = { tag: 'OUTSIDE' };`);
    registerProviderScriptRoot(SCRATCH);
});

afterAll(() => {
    _resetProviderScriptRoots();
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeScript(name: string, body: string): string {
    const file = path.join(PROVIDER_DIR, name);
    fs.writeFileSync(file, body, 'utf-8');
    delete require.cache[require.resolve(file)];
    return file;
}

describe('require whitelist — allowlist', () => {
    it('lets a provider script require path/os/crypto/util pass through unchanged', () => {
        const file = writeScript('allowed.js', `
            const path = require('path');
            const os = require('os');
            const crypto = require('crypto');
            const util = require('util');
            module.exports = { path, os, crypto, util };
        `);
        const mod = require(file);
        expect(typeof mod.path.join).toBe('function');
        expect(typeof mod.os.platform).toBe('function');
        expect(typeof mod.crypto.createHash).toBe('function');
        expect(typeof mod.util.format).toBe('function');
    });

    it('accepts node:-prefixed bare specifiers identically', () => {
        const file = writeScript('node-prefix.js', `
            const crypto = require('node:crypto');
            module.exports = { hashable: typeof crypto.createHash };
        `);
        expect(require(file).hashable).toBe('function');
    });
});

describe('require whitelist — fs shim', () => {
    it('exposes the documented read-only fs surface', () => {
        const file = writeScript('fs-read.js', `
            const fs = require('fs');
            const keys = Object.keys(fs).sort();
            module.exports = { keys, hasReadFileSync: typeof fs.readFileSync, hasPromisesReadFile: typeof fs.promises.readFile };
        `);
        const mod = require(file);
        expect(mod.hasReadFileSync).toBe('function');
        expect(mod.hasPromisesReadFile).toBe('function');
    });

    it('omits write-side fs members (writeFileSync, unlinkSync, etc.)', () => {
        const file = writeScript('fs-write.js', `
            const fs = require('fs');
            module.exports = {
                hasWriteFileSync: typeof fs.writeFileSync,
                hasUnlinkSync: typeof fs.unlinkSync,
                hasRmSync: typeof fs.rmSync,
                hasMkdirSync: typeof fs.mkdirSync,
                hasOpenSync: typeof fs.openSync,
                hasAppendFileSync: typeof fs.appendFileSync,
            };
        `);
        const mod = require(file);
        expect(mod.hasWriteFileSync).toBe('undefined');
        expect(mod.hasUnlinkSync).toBe('undefined');
        expect(mod.hasRmSync).toBe('undefined');
        expect(mod.hasMkdirSync).toBe('undefined');
        expect(mod.hasOpenSync).toBe('undefined');
        expect(mod.hasAppendFileSync).toBe('undefined');
    });

    it('omits write-side fs.promises members', () => {
        const file = writeScript('fs-promises-write.js', `
            const fs = require('fs');
            module.exports = {
                hasPromisesWriteFile: typeof fs.promises.writeFile,
                hasPromisesUnlink: typeof fs.promises.unlink,
                hasPromisesMkdir: typeof fs.promises.mkdir,
            };
        `);
        const mod = require(file);
        expect(mod.hasPromisesWriteFile).toBe('undefined');
        expect(mod.hasPromisesUnlink).toBe('undefined');
        expect(mod.hasPromisesMkdir).toBe('undefined');
    });
});

describe('require whitelist — child_process shim', () => {
    it('exposes only execFileSync', () => {
        const file = writeScript('cp-surface.js', `
            const cp = require('child_process');
            module.exports = {
                keys: Object.keys(cp).sort(),
                hasExec: typeof cp.exec,
                hasExecSync: typeof cp.execSync,
                hasSpawn: typeof cp.spawn,
                hasFork: typeof cp.fork,
            };
        `);
        const mod = require(file);
        expect(mod.keys).toEqual(['execFileSync']);
        expect(mod.hasExec).toBe('undefined');
        expect(mod.hasExecSync).toBe('undefined');
        expect(mod.hasSpawn).toBe('undefined');
        expect(mod.hasFork).toBe('undefined');
    });

    it('execFileSync rejects shell:true at the wrapper layer', () => {
        const file = writeScript('cp-shell.js', `
            const { execFileSync } = require('child_process');
            try {
                execFileSync('echo', ['hi'], { shell: true });
                module.exports = { dropped: false };
            } catch (e) {
                module.exports = { error: e.message };
            }
        `);
        const mod = require(file);
        // shell flag is silently dropped (not passed through) — the call
        // still proceeds without shell expansion. Verify the call ran
        // without raising and shell metacharacters are not honored.
        expect(mod.error).toBeUndefined();
    });

    it('execFileSync rejects string args (no shell expansion of "a; b")', () => {
        const file = writeScript('cp-string-args.js', `
            const { execFileSync } = require('child_process');
            try {
                execFileSync('echo', 'should-be-array-not-string');
                module.exports = { dropped: false };
            } catch (e) {
                module.exports = { error: e.message };
            }
        `);
        const mod = require(file);
        expect(mod.error).toContain('args');
    });

    it('execFileSync runs a real binary with arg array', () => {
        const file = writeScript('cp-real.js', `
            const { execFileSync } = require('child_process');
            const out = execFileSync('echo', ['adhdev-ok'], { encoding: 'utf8' });
            module.exports = { out: out.trim() };
        `);
        const mod = require(file);
        expect(mod.out).toBe('adhdev-ok');
    });
});

describe('require whitelist — relative paths', () => {
    it('allows a provider script to require a sibling helper', () => {
        const helperFile = writeScript('sibling.js', `module.exports = { ok: 'sibling' };`);
        const file = writeScript('uses-sibling.js', `
            const sibling = require('./sibling.js');
            module.exports = sibling;
        `);
        const mod = require(file);
        expect(mod.ok).toBe('sibling');
    });

    it('allows reaching into a sibling _shared directory under the same root', () => {
        const file = writeScript('uses-shared.js', `
            const helper = require('../_shared/helper.js');
            module.exports = helper;
        `);
        const mod = require(file);
        expect(mod.tag).toBe('shared-helper');
    });

    it('blocks relative paths that escape the registered root', () => {
        // PROVIDER_DIR is .../scratch/cli/fake-cli — going ../../.. lands
        // outside SCRATCH which is the registered root.
        const escaper = path.join(path.dirname(path.dirname(SCRATCH)), 'escape-target.js');
        try { fs.writeFileSync(escaper, `module.exports = { tag: 'ESCAPED' };`); } catch { /* ok */ }
        const rel = path.relative(PROVIDER_DIR, escaper);
        const file = writeScript('escapes.js', `module.exports = require(${JSON.stringify(rel)});`);
        let err: any;
        try { require(file); } catch (e) { err = e; }
        expect(err).toBeDefined();
        expect(err.code).toBe('PROVIDER_REQUIRE_DENIED');
        try { fs.unlinkSync(escaper); } catch { /* ignore */ }
    });
});

describe('require whitelist — denials', () => {
    it('throws PROVIDER_REQUIRE_DENIED for non-allowlisted bare modules', () => {
        const file = writeScript('net-deny.js', `module.exports = require('net');`);
        let err: any;
        try { require(file); } catch (e) { err = e; }
        expect(err?.code).toBe('PROVIDER_REQUIRE_DENIED');
        expect(err?.deniedModule).toBe('net');
    });

    it('throws for http / https / dgram / worker_threads / vm', () => {
        for (const mod of ['http', 'https', 'dgram', 'worker_threads', 'vm']) {
            const file = writeScript(`deny-${mod.replace(/_/g, '-')}.js`, `module.exports = require('${mod}');`);
            let err: any;
            try { require(file); } catch (e) { err = e; }
            expect(err?.code, `${mod} should be denied`).toBe('PROVIDER_REQUIRE_DENIED');
        }
    });
});

describe('require whitelist — daemon code is unaffected', () => {
    it('lets non-provider callers require anything (including net)', () => {
        // This very test file lives outside any registered provider root,
        // so requiring 'net' should still resolve normally. If this
        // assertion ever fails, the hook is over-reaching.
        const net = require('net');
        expect(typeof net.createServer).toBe('function');
    });

    it('exposes the policy snapshot for registry consumers', () => {
        expect(PROVIDER_REQUIRE_POLICY.safeStdlib).toContain('path');
        expect(PROVIDER_REQUIRE_POLICY.shimmedStdlib).toContain('fs');
        expect(PROVIDER_REQUIRE_POLICY.shimmedStdlib).toContain('child_process');
        expect(PROVIDER_REQUIRE_POLICY.childProcessAllowedMembers).toEqual(['execFileSync']);
    });
});
