import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { invalidateConfigFieldMemos } from '../../src/config/config.js';
import { defaultWorkspaceLabel } from '../../src/config/workspaces.js';
import {
    handleWorkspaceAdd,
    handleWorkspaceList,
    handleWorkspaceSetLabel,
} from '../../src/commands/workspace-commands.js';

let tempDir = '';
let workspaceDir = '';
let savedConfigDir: string | undefined;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-ws-set-label-cfg-'));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-ws-set-label-ws-'));
    savedConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tempDir;
    invalidateConfigFieldMemos();
});

afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = savedConfigDir;
    invalidateConfigFieldMemos();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    tempDir = '';
    workspaceDir = '';
});

describe('handleWorkspaceSetLabel', () => {
    it('round-trips add → set_label → list so the stored label changes', () => {
        const added = handleWorkspaceAdd({ path: workspaceDir });
        expect(added.success, String(added.error)).toBe(true);

        const set = handleWorkspaceSetLabel({ path: workspaceDir, label: 'Mesh Lab' });
        expect(set.success, String(set.error)).toBe(true);
        expect((set.entry as { label?: string } | undefined)?.label).toBe('Mesh Lab');

        const listed = handleWorkspaceList();
        expect(listed.success).toBe(true);
        const rows = (listed.workspaces || []) as Array<{ path: string; label?: string }>;
        const row = rows.find((w) => path.resolve(w.path) === path.resolve(workspaceDir));
        expect(row?.label).toBe('Mesh Lab');
    });

    it('empty label resets to the folder basename across a fresh list', () => {
        expect(handleWorkspaceAdd({ path: workspaceDir }).success).toBe(true);
        expect(handleWorkspaceSetLabel({ path: workspaceDir, label: 'Custom' }).success).toBe(true);
        expect(handleWorkspaceSetLabel({ path: workspaceDir, label: '' }).success).toBe(true);

        const listed = handleWorkspaceList();
        const rows = (listed.workspaces || []) as Array<{ path: string; label?: string }>;
        const row = rows.find((w) => path.resolve(w.path) === path.resolve(workspaceDir));
        expect(row?.label).toBe(defaultWorkspaceLabel(workspaceDir));
    });

    it('unknown path is a harmless error (config unchanged)', () => {
        expect(handleWorkspaceAdd({ path: workspaceDir }).success).toBe(true);
        const before = handleWorkspaceList();
        const result = handleWorkspaceSetLabel({ path: path.join(workspaceDir, 'missing'), label: 'Nope' });
        expect(result.success).toBe(false);
        expect(result.error).toBe('Workspace not found');
        expect(handleWorkspaceList().workspaces).toEqual(before.workspaces);
    });

    it('requires path', () => {
        expect(handleWorkspaceSetLabel({ label: 'X' })).toEqual({ success: false, error: 'path required' });
    });

    it('handler.ts registers workspace_set_label', () => {
        const src = readFileSync(
            fileURLToPath(new URL('../../src/commands/handler.ts', import.meta.url)),
            'utf8',
        );
        expect(src).toMatch(/case 'workspace_set_label':\s*return WorkspaceCmd\.handleWorkspaceSetLabel\(args\)/);
    });
});
