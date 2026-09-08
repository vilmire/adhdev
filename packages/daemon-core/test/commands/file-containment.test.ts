/**
 * SECURITY regression — path containment for `file_read` / `file_write`.
 *
 * Before the fix `resolveSafePath()` in `src/commands/cdp-commands.ts` only
 * expanded `~`, normalized Windows drive spellings and `path.resolve`d
 * relatives — it applied NO allow-list. `handleFileWrite` then did
 * `mkdirSync(recursive)` + `writeFileSync` at whatever that resolved to, so a
 * path like `../../../tmp/evil` — reachable from any command source, including
 * the peer-controlled P2P `onFileRequest` path in daemon-cloud — created a file
 * anywhere the daemon user could write.
 *
 * INJECTION CHECK: in `cdp-commands.ts`, drop the `confineToAllowedRoots(...)`
 * guard from `handleFileRead`/`handleFileWrite` (i.e. restore
 * `const filePath = resolveSafePath(args?.path);`). The "escapes" tests below go
 * red — the traversal write succeeds and the outside-root file appears on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The containment module reads the allowed roots from config; stub that so the
// test controls the allow-list without touching the user's real ~/.adhdev.
const mockConfig: { workspaces: Array<{ id: string; path: string; addedAt: number }>; defaultWorkspaceId?: string } = {
    workspaces: [],
};
vi.mock('../../src/config/config.js', () => ({
    loadConfig: () => mockConfig,
    getConfigDir: () => path.join(os.tmpdir(), 'adhdev-test-config'),
}));

const { confineToAllowedRoots, getAllowedFileRoots, FILE_ROOTS_ENV } = await import(
    '../../src/commands/file-containment.js'
);

let workspaceRoot: string;
let outsideRoot: string;

beforeEach(() => {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adhdev-containment-'));
    workspaceRoot = path.join(base, 'workspace');
    outsideRoot = path.join(base, 'outside');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    mockConfig.workspaces = [{ id: 'ws1', path: workspaceRoot, addedAt: 1 }];
    delete mockConfig.defaultWorkspaceId;
    delete process.env[FILE_ROOTS_ENV];
});

afterEach(() => {
    delete process.env[FILE_ROOTS_ENV];
});

describe('file containment — allowed roots', () => {
    it('picks up saved workspaces as roots', () => {
        expect(getAllowedFileRoots()).toContain(path.resolve(workspaceRoot));
    });

    it('picks up the ADHDEV_FILE_ROOTS env override', () => {
        process.env[FILE_ROOTS_ENV] = outsideRoot;
        expect(getAllowedFileRoots()).toContain(path.resolve(outsideRoot));
    });

    it('fails CLOSED when no root is configured', () => {
        mockConfig.workspaces = [];
        const result = confineToAllowedRoots(path.join(workspaceRoot, 'a.txt'));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/no allowed workspace root/i);
    });
});

describe('file containment — legitimate paths still work', () => {
    it('allows a file directly inside the workspace', () => {
        const target = path.join(workspaceRoot, 'notes.md');
        const result = confineToAllowedRoots(target);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.path).toBe(path.resolve(target));
    });

    it('allows a nested path inside the workspace', () => {
        const result = confineToAllowedRoots(path.join(workspaceRoot, 'src', 'deep', 'file.ts'));
        expect(result.ok).toBe(true);
    });

    it('allows the workspace root itself', () => {
        expect(confineToAllowedRoots(workspaceRoot).ok).toBe(true);
    });

    it('allows a path that traverses but lands back inside the workspace', () => {
        const result = confineToAllowedRoots(path.join(workspaceRoot, 'src', '..', 'ok.txt'));
        expect(result.ok).toBe(true);
    });

    it('allows an extraRoot supplied by the session context', () => {
        const sessionDir = path.join(outsideRoot, 'session-workspace');
        fs.mkdirSync(sessionDir, { recursive: true });
        expect(confineToAllowedRoots(path.join(sessionDir, 'f.txt'), [sessionDir]).ok).toBe(true);
    });
});

describe('file containment — escapes are refused', () => {
    it('refuses ../../../tmp/evil style traversal out of the workspace', () => {
        const escaped = path.resolve(workspaceRoot, '..', '..', '..', 'tmp', 'evil');
        const result = confineToAllowedRoots(escaped);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/refusing file access outside/i);
    });

    it('refuses a sibling directory outside the workspace', () => {
        expect(confineToAllowedRoots(path.join(outsideRoot, 'evil.txt')).ok).toBe(false);
    });

    it('refuses an absolute path to a sensitive system location', () => {
        const sensitive = process.platform === 'win32'
            ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
            : '/etc/passwd';
        expect(confineToAllowedRoots(sensitive).ok).toBe(false);
    });

    it('refuses a sibling whose name merely shares the root prefix', () => {
        // Path-SEGMENT containment: `<root>-evil` must not count as inside `<root>`.
        expect(confineToAllowedRoots(`${workspaceRoot}-evil`).ok).toBe(false);
    });

    it('refuses a symlink inside the workspace that points outside it', () => {
        const secret = path.join(outsideRoot, 'secret.txt');
        fs.writeFileSync(secret, 'top secret');
        const link = path.join(workspaceRoot, 'link-out');
        try {
            fs.symlinkSync(outsideRoot, link, 'dir');
        } catch {
            return; // symlink creation not permitted (e.g. Windows without privilege)
        }
        const result = confineToAllowedRoots(path.join(link, 'secret.txt'));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/symlink target/i);
    });
});

describe('file containment — end-to-end through the real handlers', () => {
    async function handlers() {
        return await import('../../src/commands/cdp-commands.js');
    }
    // Minimal CommandHelpers stub: the file handlers only touch currentSession/ctx.
    const helpers: any = { currentSession: undefined, ctx: {} };

    it('handleFileWrite refuses to create a file outside the allowed roots', async () => {
        const { handleFileWrite } = await handlers();
        const escaped = path.join(outsideRoot, 'evil.txt');
        const result = await handleFileWrite(helpers, { path: escaped, content: 'pwned' });

        expect(result.success).toBe(false);
        expect(String(result.error)).toMatch(/refusing file access outside/i);
        // The real proof: nothing was created on disk.
        expect(fs.existsSync(escaped)).toBe(false);
    });

    it('handleFileWrite refuses a ../ traversal and creates no directories', async () => {
        const { handleFileWrite } = await handlers();
        const escapedDir = path.join(outsideRoot, 'created-by-traversal');
        const traversal = path.join(workspaceRoot, '..', 'outside', 'created-by-traversal', 'evil.txt');

        const result = await handleFileWrite(helpers, { path: traversal, content: 'pwned' });

        expect(result.success).toBe(false);
        // mkdirSync(recursive) must not have run.
        expect(fs.existsSync(escapedDir)).toBe(false);
    });

    it('handleFileWrite + handleFileRead still work inside the workspace', async () => {
        const { handleFileWrite, handleFileRead } = await handlers();
        const target = path.join(workspaceRoot, 'sub', 'notes.md');

        const write = await handleFileWrite(helpers, { path: target, content: 'hello' });
        expect(write.success).toBe(true);
        expect(fs.readFileSync(target, 'utf-8')).toBe('hello');

        const read = await handleFileRead(helpers, { path: target });
        expect(read.success).toBe(true);
        expect(read.content).toBe('hello');
    });

    it('handleFileRead refuses to read a file outside the allowed roots', async () => {
        const { handleFileRead } = await handlers();
        const secret = path.join(outsideRoot, 'secret.txt');
        fs.writeFileSync(secret, 'top secret');

        const result = await handleFileRead(helpers, { path: secret });

        expect(result.success).toBe(false);
        expect(result.content).toBeUndefined();
    });

    it('file_list keeps free traversal — it backs the workspace picker', async () => {
        // Deliberate scope boundary: file_list/file_list_browse expose directory
        // metadata only and must keep working outside the roots so a user can
        // pick their FIRST workspace. Only read/write content is confined.
        const { handleFileList } = await handlers();
        const result = await handleFileList(helpers, { path: outsideRoot });
        expect(result.success).toBe(true);
    });
});
