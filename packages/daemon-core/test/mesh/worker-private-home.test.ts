import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { materializePrivateHome } from '../../src/mesh/worker-private-home.js';
import { findWorkerPrivateHomeSpec } from '../../src/mesh/worker-home-specs.js';

const spec = findWorkerPrivateHomeSpec('grok-cli')!;

describe('Grok private home safety', () => {
    let root: string;
    let realHome: string;
    let home: string;
    const grok = (name: string) => path.join(realHome, '.grok', name);
    const worker = (name: string) => path.join(home, '.grok', name);
    const prepare = () => materializePrivateHome(spec, { home, realHome, workspace: root });
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-private-test-'));
        realHome = path.join(root, 'owner');
        home = path.join(root, 'worker');
        fs.mkdirSync(path.join(realHome, '.grok', 'bin'), { recursive: true });
        fs.mkdirSync(grok('sessions'));
        fs.writeFileSync(grok('auth.json'), '{"fixture":true}', { mode: 0o600 });
        fs.writeFileSync(grok('config.toml'), '[cli]\nauto_update = true\ninstaller = "internal"\n[models]\ndefault = "grok-4.6"\n');
        fs.writeFileSync(grok('version.json'), '{"version":"fixture"}');
        fs.writeFileSync(grok('bin/keep'), 'real install');
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('shares rotating auth and transcripts, but keeps config and install metadata private', () => {
        prepare();
        expect(fs.readFileSync(worker('config.toml'), 'utf8')).toContain('auto_update = false');
        expect(fs.readFileSync(worker('config.toml'), 'utf8')).toContain('installer = "internal"');
        expect(fs.readFileSync(worker('config.toml'), 'utf8')).toContain('default = "grok-4.6"');
        expect(fs.readFileSync(grok('config.toml'), 'utf8')).toContain('auto_update = true');
        expect(fs.existsSync(worker('bin'))).toBe(false);
        expect(fs.lstatSync(worker('version.json')).isSymbolicLink()).toBe(false);
        fs.writeFileSync(worker('version.json'), 'private version');
        expect(fs.readFileSync(grok('version.json'), 'utf8')).toContain('fixture');
        fs.writeFileSync(grok('auth.json'), '{"fixture":"rotated"}', { mode: 0o600 });
        expect(fs.readFileSync(worker('auth.json'), 'utf8')).toContain('rotated');
        fs.writeFileSync(worker('sessions/message'), 'transcript');
        expect(fs.readFileSync(grok('sessions/message'), 'utf8')).toBe('transcript');
    });

    it.each(['', '[models]\ndefault = "grok-4.6"\n', '["cli"] # updater\n"auto_update" = true\n'])('disables updates with absent or quoted cli settings: %j', (config) => {
        fs.writeFileSync(grok('config.toml'), config);
        prepare();
        expect(fs.readFileSync(worker('config.toml'), 'utf8')).toContain('auto_update = false');
        expect(fs.readFileSync(worker('config.toml'), 'utf8')).not.toContain('auto_update = true');
    });

    it('creates an updater-disabled config even without an owner config', () => {
        fs.unlinkSync(grok('config.toml'));
        prepare();
        expect(fs.readFileSync(worker('config.toml'), 'utf8')).toContain('[cli]\nauto_update = false');
    });

    it('fails closed on ambiguous multiline config', () => {
        fs.writeFileSync(grok('config.toml'), 'text = """\n[cli]\nauto_update = true\n"""\n');
        expect(prepare).toThrow('unsupported_grok_config');
    });

    it('retires stale updater links without deleting or changing the real install', () => {
        fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
        fs.symlinkSync(grok('bin'), worker('bin'), process.platform === 'win32' ? 'junction' : 'dir');
        fs.symlinkSync(grok('version.json'), worker('version.json'));
        fs.symlinkSync(grok('config.toml'), worker('config.toml'));
        prepare();
        prepare();
        expect(fs.readFileSync(grok('bin/keep'), 'utf8')).toBe('real install');
        expect(fs.readFileSync(grok('version.json'), 'utf8')).toContain('fixture');
        expect(fs.readFileSync(grok('config.toml'), 'utf8')).toContain('auto_update = true');
    });

    it('removes a dangling updater link without following it', () => {
        fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
        fs.symlinkSync(path.join(root, 'absent'), worker('bin'));
        prepare();
        expect(() => fs.lstatSync(worker('bin'))).toThrow();
    });

    it('refuses a linked .grok parent before changing the owner tree', () => {
        fs.mkdirSync(home);
        fs.symlinkSync(path.join(realHome, '.grok'), path.join(home, '.grok'), process.platform === 'win32' ? 'junction' : 'dir');
        expect(prepare).toThrow('unsafe_directory');
        expect(fs.readFileSync(grok('bin/keep'), 'utf8')).toBe('real install');
        expect(fs.readFileSync(grok('config.toml'), 'utf8')).toContain('auto_update = true');
    });

    it('refuses a linked private root', () => {
        fs.symlinkSync(realHome, home, process.platform === 'win32' ? 'junction' : 'dir');
        expect(prepare).toThrow('unsafe_directory');
    });

    it('refuses the real home and its Grok install as private roots', () => {
        home = realHome;
        expect(prepare).toThrow('overlaps_real_home');
        home = grok('worker');
        expect(prepare).toThrow('overlaps_real_home');
    });
});
