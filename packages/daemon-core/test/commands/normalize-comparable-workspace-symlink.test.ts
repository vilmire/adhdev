/**
 * KIMI-NATIVE-WORKSPACE-SYMLINK-ALIAS — the native-history workspace-safety
 * gate (workspace_from_sidecar) compared workspaces with a LEXICAL path.resolve.
 * On macOS `/tmp` is a symlink to `/private/tmp`; kimi's state.json workDir is
 * stored realpath'd (`/private/tmp/…`) while the ADHDev session workspace can be
 * passed as `/tmp/…`, so the lexical comparison MISMATCHED → the read was marked
 * unsafe → it fell back to the PTY parser (extra think bubble / pseudo-collapse).
 *
 * The fix canonicalizes both sides via realpath (throw-safe fallback to lexical
 * for paths that don't exist). These tests prove:
 *   (a) a symlinked-alias workspace now MATCHES the realpath'd on-disk workDir,
 *   (b) two genuinely-different workspaces still DON'T match (fail-closed
 *       cross-workspace safety preserved),
 *   (c) a non-existent path does not throw — it falls back to the lexical value.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __normalizeComparableWorkspaceForTest as norm } from '../../src/commands/chat-commands-read.js';

let tmpRoot = '';
let realDir = '';
let linkDir = '';

beforeEach(() => {
    // A real directory + a symlink pointing at it, to emulate the /tmp ↔
    // /private/tmp aliasing without depending on the host's /tmp layout.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-symlink-'));
    realDir = path.join(tmpRoot, 'real-workspace');
    fs.mkdirSync(realDir, { recursive: true });
    linkDir = path.join(tmpRoot, 'link-workspace');
    fs.symlinkSync(realDir, linkDir);
});

afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('normalizeComparableWorkspace symlink-safety', () => {
    it('canonicalizes a symlinked-alias path to match the real target (native selects)', () => {
        // The session workspace is the symlink; the on-disk workDir is the real
        // (realpath'd) target — the exact /tmp ↔ /private/tmp shape.
        const viaLink = norm(linkDir);
        const viaReal = norm(realDir);
        expect(viaLink).toBe(viaReal);
        // And it resolves to the real target, not the symlink path.
        expect(viaLink).toBe(fs.realpathSync(realDir));
    });

    it('still fails closed for two genuinely different workspaces (safety preserved)', () => {
        const otherReal = path.join(tmpRoot, 'other-workspace');
        fs.mkdirSync(otherReal, { recursive: true });
        expect(norm(linkDir)).not.toBe(norm(otherReal));
        expect(norm(realDir)).not.toBe(norm(otherReal));
    });

    it('falls back to the lexical value for a non-existent path without throwing', () => {
        const ghost = path.join(tmpRoot, 'does', 'not', 'exist');
        let result = '';
        expect(() => { result = norm(ghost); }).not.toThrow();
        // realpath throws on a missing path → lexical resolve is returned.
        expect(result).toBe(path.resolve(ghost));
    });

    it('returns empty string for empty/non-string input (unchanged contract)', () => {
        expect(norm('')).toBe('');
        expect(norm('   ')).toBe('');
        expect(norm(undefined)).toBe('');
        expect(norm(null)).toBe('');
        expect(norm(42)).toBe('');
    });
});
