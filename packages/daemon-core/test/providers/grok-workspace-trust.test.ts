/**
 * Coverage for grok-workspace-trust — the pre-spawn hook that appends grok's
 * folder-trust entry so the first-run "Do you trust the contents of this
 * directory?" TUI prompt never appears.
 *
 * grok only raises that prompt for folders carrying repo-local config
 * (.mcp.json / .grok/lsp.json / hooks), and the prompt renders no numbered
 * radio rows — so the spec can detect it but has no way to answer it, and the
 * session strands. The entry format asserted here was captured live from grok
 * 1.0.4 by answering the real prompt and diffing the store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyGrokWorkspaceTrust, __test__ } from '../../src/providers/grok-workspace-trust.js';

const { hasTrustEntry, escapeTomlKey, isOverBroadRoot } = __test__;

describe('applyGrokWorkspaceTrust', () => {
    let grokHome: string;
    let workspace: string;
    const env = () => ({ ...process.env, GROK_HOME: grokHome });
    const storePath = () => path.join(grokHome, 'trusted_folders.toml');
    const real = () => fs.realpathSync(workspace);

    beforeEach(() => {
        grokHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-ws-'));
    });

    afterEach(() => {
        fs.rmSync(grokHome, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('writes the exact entry shape grok itself persists', () => {
        const registered = applyGrokWorkspaceTrust(workspace, env());
        expect(registered).toBe(real());

        const contents = fs.readFileSync(storePath(), 'utf8');
        expect(contents).toContain(`[folders."${real()}"]`);
        expect(contents).toMatch(/^trusted = true$/m);
        expect(contents).toMatch(/^decided_at = \d{10}$/m);
    });

    it('records the realpath, not the symlinked path grok was launched with', () => {
        // grok canonicalizes before keying the store (/tmp/x -> /private/tmp/x
        // on macOS), so an entry under the non-real path would never match.
        const link = path.join(os.tmpdir(), `grok-link-${Date.now()}`);
        fs.symlinkSync(workspace, link);
        try {
            expect(applyGrokWorkspaceTrust(link, env())).toBe(real());
            expect(fs.readFileSync(storePath(), 'utf8')).toContain(`[folders."${real()}"]`);
        } finally {
            fs.rmSync(link, { force: true });
        }
    });

    it('is idempotent — a second call adds no duplicate entry', () => {
        expect(applyGrokWorkspaceTrust(workspace, env())).toBe(real());
        const first = fs.readFileSync(storePath(), 'utf8');

        expect(applyGrokWorkspaceTrust(workspace, env())).toBeNull();
        expect(fs.readFileSync(storePath(), 'utf8')).toBe(first);
    });

    it('preserves pre-existing entries when appending', () => {
        fs.writeFileSync(
            storePath(),
            '[folders."/private/tmp/someone-elses-project"]\ntrusted = true\ndecided_at = 1786765860\n',
            'utf8',
        );
        applyGrokWorkspaceTrust(workspace, env());

        const contents = fs.readFileSync(storePath(), 'utf8');
        expect(contents).toContain('[folders."/private/tmp/someone-elses-project"]');
        expect(contents).toContain(`[folders."${real()}"]`);
    });

    it('separates the appended entry when the store lacks a trailing newline', () => {
        fs.writeFileSync(storePath(), '[folders."/private/tmp/prior"]\ntrusted = true', 'utf8');
        applyGrokWorkspaceTrust(workspace, env());

        const contents = fs.readFileSync(storePath(), 'utf8');
        expect(contents).not.toMatch(/trusted = true\[folders/);
        expect(hasTrustEntry(contents, real())).toBe(true);
    });

    it('never flips an explicit distrust decision back to trusted', () => {
        fs.writeFileSync(
            storePath(),
            `[folders."${real()}"]\ntrusted = false\ndecided_at = 1786765860\n`,
            'utf8',
        );
        expect(applyGrokWorkspaceTrust(workspace, env())).toBeNull();

        const contents = fs.readFileSync(storePath(), 'utf8');
        expect(contents).toContain('trusted = false');
        expect(contents).not.toContain('trusted = true');
    });

    it('registers only the launched directory — never a parent', () => {
        const child = path.join(workspace, 'nested');
        fs.mkdirSync(child);
        applyGrokWorkspaceTrust(child, env());

        const contents = fs.readFileSync(storePath(), 'utf8');
        expect(contents).toContain(`[folders."${fs.realpathSync(child)}"]`);
        expect(hasTrustEntry(contents, real())).toBe(false);
    });

    it('refuses over-broad roots grok would itself reject', () => {
        expect(applyGrokWorkspaceTrust('/', env())).toBeNull();
        expect(applyGrokWorkspaceTrust(os.homedir(), env())).toBeNull();
        expect(fs.existsSync(storePath())).toBe(false);
    });

    it('creates the grok home directory when it does not exist yet', () => {
        fs.rmSync(grokHome, { recursive: true, force: true });
        expect(applyGrokWorkspaceTrust(workspace, env())).toBe(real());
        expect(fs.readFileSync(storePath(), 'utf8')).toContain(`[folders."${real()}"]`);
    });

    it('swallows failures rather than blocking launch', () => {
        // Store path occupied by a directory -> append throws EISDIR.
        fs.mkdirSync(storePath(), { recursive: true });
        expect(() => applyGrokWorkspaceTrust(workspace, env())).not.toThrow();
        expect(applyGrokWorkspaceTrust(workspace, env())).toBeNull();
    });
});

describe('helpers', () => {
    it('matches a trust entry only on an exact path key', () => {
        const store = '[folders."/private/tmp/ws"]\ntrusted = true\n';
        expect(hasTrustEntry(store, '/private/tmp/ws')).toBe(true);
        // A prefix sibling must not count as trusted.
        expect(hasTrustEntry(store, '/private/tmp/ws-other')).toBe(false);
        expect(hasTrustEntry(store, '/private/tmp')).toBe(false);
    });

    it('escapes quotes and backslashes in the TOML key', () => {
        expect(escapeTomlKey('/tmp/we"ird\\path')).toBe('/tmp/we\\"ird\\\\path');
    });

    it('treats the filesystem root, home, and relative paths as over-broad', () => {
        expect(isOverBroadRoot('/')).toBe(true);
        expect(isOverBroadRoot('relative/path')).toBe(true);
        expect(isOverBroadRoot(fs.realpathSync(os.homedir()))).toBe(true);
        expect(isOverBroadRoot('/private/tmp/a-real-project')).toBe(false);
    });
});
