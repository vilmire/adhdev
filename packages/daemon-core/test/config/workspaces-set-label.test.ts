import { describe, expect, it } from 'vitest';
import type { ADHDevConfig } from '../../src/config/config.js';
import {
    defaultWorkspaceLabel,
    setWorkspaceLabel,
    WORKSPACE_LABEL_MAX_LENGTH,
} from '../../src/config/workspaces.js';

function configWith(path: string, label = 'old-label'): ADHDevConfig {
    return {
        workspaces: [{
            id: 'ws-1',
            path,
            label,
            addedAt: 1,
        }],
    } as ADHDevConfig;
}

describe('setWorkspaceLabel', () => {
    const path = '/tmp/adhdev-ws-label-alpha';

    it('sets a custom label on the matching workspace', () => {
        const result = setWorkspaceLabel(configWith(path), path, 'Alpha Box');
        expect('error' in result).toBe(false);
        if ('error' in result) return;
        expect(result.entry.label).toBe('Alpha Box');
        expect(result.config.workspaces?.[0]?.label).toBe('Alpha Box');
        expect(result.config.workspaces?.[0]?.id).toBe('ws-1');
    });

    it('resets empty / undefined labels to the folder basename', () => {
        const basename = defaultWorkspaceLabel(path);
        for (const raw of ['', '   ', undefined, null]) {
            const result = setWorkspaceLabel(configWith(path, 'Custom'), path, raw as string | undefined);
            expect('error' in result, String(raw)).toBe(false);
            if ('error' in result) return;
            expect(result.entry.label, String(raw)).toBe(basename);
        }
    });

    it('caps labels at 64 characters', () => {
        const result = setWorkspaceLabel(configWith(path), path, 'a'.repeat(80));
        expect('error' in result).toBe(false);
        if ('error' in result) return;
        expect(result.entry.label).toBe('a'.repeat(WORKSPACE_LABEL_MAX_LENGTH));
        expect(result.entry.label?.length).toBe(64);
    });

    it('strips C0 and DEL control characters', () => {
        const result = setWorkspaceLabel(configWith(path), path, 'he\nllo\u0007wo\u007Frld');
        expect('error' in result).toBe(false);
        if ('error' in result) return;
        expect(result.entry.label).toBe('helloworld');
    });

    it('trims surrounding whitespace after stripping controls', () => {
        const result = setWorkspaceLabel(configWith(path), path, '  \nTeam Box\t ');
        expect('error' in result).toBe(false);
        if ('error' in result) return;
        expect(result.entry.label).toBe('Team Box');
    });

    it('returns an error and does not mutate config for an unknown path', () => {
        const original = configWith(path, 'keep-me');
        const snapshot = JSON.stringify(original.workspaces);
        const result = setWorkspaceLabel(original, '/tmp/does-not-exist-workspace', 'Nope');
        expect(result).toEqual({ error: 'Workspace not found' });
        expect(JSON.stringify(original.workspaces)).toBe(snapshot);
        expect(original.workspaces?.[0]?.label).toBe('keep-me');
    });

    it('returns Path required for a blank path', () => {
        expect(setWorkspaceLabel(configWith(path), '   ', 'X')).toEqual({ error: 'Path required' });
    });
});
