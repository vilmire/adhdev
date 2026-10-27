import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { materializePrivateHome } from '../../src/mesh/worker-private-home.js';
import { findWorkerPrivateHomeSpec } from '../../src/mesh/worker-home-specs.js';

const spec = findWorkerPrivateHomeSpec('antigravity-cli')!;
const REL = path.join('.gemini', 'antigravity-cli', 'settings.json');
const ONB = path.join('.gemini', 'antigravity-cli', 'cache', 'onboarding.json');

describe('antigravity private HOME managed copies', () => {
    let root: string;
    let realHome: string;
    let home: string;
    const real = (rel: string) => path.join(realHome, rel);
    const priv = (rel: string) => path.join(home, rel);
    const prepare = () => materializePrivateHome(spec, { home, realHome, workspace: root });
    const realSnapshot = () => {
        const out: Record<string, string> = {};
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p); else out[p] = fs.readFileSync(p, 'utf8') + fs.statSync(p).mtimeMs;
            }
        };
        walk(realHome);
        return out;
    };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-managed-copy-'));
        realHome = path.join(root, 'owner');
        home = path.join(root, 'private');
        fs.mkdirSync(path.dirname(real(REL)), { recursive: true });
        fs.mkdirSync(path.dirname(real(ONB)), { recursive: true });
        fs.writeFileSync(real(REL), '{"model":"a"}', { mode: 0o600 });
        fs.writeFileSync(real(ONB), '{"done":true}');
        const tok = real(path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token'));
        fs.writeFileSync(tok, 'tok', { mode: 0o600 });
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('keeps an in-session persisted permission across relaunch', () => {
        prepare();
        fs.writeFileSync(priv(REL), '{"model":"a","allow":["Bash(ls)"]}');
        prepare();
        expect(fs.readFileSync(priv(REL), 'utf8')).toContain('Bash(ls)');
    });

    it('keeps the modified copy even when the source also changed', () => {
        prepare();
        fs.writeFileSync(priv(REL), '{"model":"a","allow":["x"]}');
        fs.writeFileSync(real(REL), '{"model":"b"}', { mode: 0o600 });
        prepare();
        expect(fs.readFileSync(priv(REL), 'utf8')).toContain('"allow"');
    });

    it('refreshes an unmodified copy when the source changed', () => {
        prepare();
        fs.writeFileSync(real(REL), '{"model":"b"}', { mode: 0o600 });
        prepare();
        expect(fs.readFileSync(priv(REL), 'utf8')).toBe('{"model":"b"}');
    });

    it('removes an unmodified copy when the source is deleted', () => {
        prepare();
        fs.rmSync(real(REL));
        prepare();
        expect(fs.existsSync(priv(REL))).toBe(false);
    });

    it('keeps a modified copy when the source is deleted', () => {
        prepare();
        fs.writeFileSync(priv(REL), '{"allow":["x"]}');
        fs.rmSync(real(REL));
        prepare();
        expect(fs.readFileSync(priv(REL), 'utf8')).toContain('allow');
    });

    it('never writes the real HOME', () => {
        const before = realSnapshot();
        prepare();
        fs.writeFileSync(priv(REL), '{"allow":["x"]}');
        fs.rmSync(real(ONB));
        const mid = realSnapshot();
        prepare();
        expect(realSnapshot()).toEqual(mid);
        expect(Object.keys(mid).length).toBe(Object.keys(before).length - 1);
        expect(fs.readFileSync(real(REL), 'utf8')).toBe('{"model":"a"}');
    });
});
