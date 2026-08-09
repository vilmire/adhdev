import { describe, expect, it } from 'vitest';
import {
    createStartupDismissState,
    decideStartupDismiss,
    normalizeStartupDismissConfig,
    recordStartupDismiss,
} from '../../src/cli-adapters/startup-dismiss.js';

// OPENCODE-UPDATE-MODAL: spec-driven boot-prompt dismissal. The decision must be
// bounded by construction — window, attempt cap, per-snapshot dedupe — and fail
// closed on malformed spec input (never types keys on a bad regex).

const CONFIG = normalizeStartupDismissConfig({
    patterns: [{ regex: 'Update Available|Would you like to\\s+update', flags: 'i' }],
    key: '',
});

const UPDATE_SCREEN = 'Update Available    esc\n\nA new release v1.18.15 is available. Would you like to update now?\n  Ask   Skip   Confirm';
const NORMAL_SCREEN = 'opencode ready\n> ';
const SPAWN = 1_000_000;

describe('normalizeStartupDismissConfig', () => {
    it('accepts a valid declaration and rejects incomplete ones', () => {
        expect(CONFIG).not.toBeNull();
        expect(normalizeStartupDismissConfig(undefined)).toBeNull();
        expect(normalizeStartupDismissConfig({ key: '', patterns: [] })).toBeNull();
        expect(normalizeStartupDismissConfig({ patterns: [{ regex: 'x' }] })).toBeNull(); // no key
        expect(normalizeStartupDismissConfig({ key: '\x1b', patterns: [{ regex: 'x' }] })).not.toBeNull(); // key + patterns present
    });
});

describe('decideStartupDismiss', () => {
    it('fires on a matching boot screen inside the spawn window', () => {
        const state = createStartupDismissState();
        const verdict = decideStartupDismiss(CONFIG, state, UPDATE_SCREEN, SPAWN, SPAWN + 2_000);
        expect(verdict.dismiss).toBe(true);
        expect(verdict.matchedPattern).toContain('Update Available');
    });

    it('never fires on a non-matching screen, outside the window, or with no config', () => {
        const state = createStartupDismissState();
        expect(decideStartupDismiss(CONFIG, state, NORMAL_SCREEN, SPAWN, SPAWN + 2_000).dismiss).toBe(false);
        expect(decideStartupDismiss(CONFIG, state, UPDATE_SCREEN, SPAWN, SPAWN + 60_000).dismiss).toBe(false);
        expect(decideStartupDismiss(null, state, UPDATE_SCREEN, SPAWN, SPAWN + 2_000).dismiss).toBe(false);
        expect(decideStartupDismiss(CONFIG, state, UPDATE_SCREEN, 0, SPAWN + 2_000).dismiss).toBe(false);
    });

    it('dedupes per snapshot and caps attempts (no key-spam loop)', () => {
        const state = createStartupDismissState();
        expect(decideStartupDismiss(CONFIG, state, UPDATE_SCREEN, SPAWN, SPAWN + 1_000).dismiss).toBe(true);
        recordStartupDismiss(state, UPDATE_SCREEN);
        // Same snapshot again (prompt survived the key) — no immediate retry.
        expect(decideStartupDismiss(CONFIG, state, UPDATE_SCREEN, SPAWN, SPAWN + 1_500).dismiss).toBe(false);
        // A repaint (snapshot changed) may retry — up to the cap.
        const repaint1 = UPDATE_SCREEN + ' ';
        expect(decideStartupDismiss(CONFIG, state, repaint1, SPAWN, SPAWN + 2_000).dismiss).toBe(true);
        recordStartupDismiss(state, repaint1);
        const repaint2 = UPDATE_SCREEN + '  ';
        expect(decideStartupDismiss(CONFIG, state, repaint2, SPAWN, SPAWN + 2_500).dismiss).toBe(true);
        recordStartupDismiss(state, repaint2);
        // Attempt cap (default 3) reached.
        const repaint3 = UPDATE_SCREEN + '   ';
        expect(decideStartupDismiss(CONFIG, state, repaint3, SPAWN, SPAWN + 3_000).dismiss).toBe(false);
    });

    it('fails closed on a malformed regex', () => {
        const bad = normalizeStartupDismissConfig({ key: '', patterns: [{ regex: '([' }] });
        const state = createStartupDismissState();
        expect(decideStartupDismiss(bad, state, UPDATE_SCREEN, SPAWN, SPAWN + 1_000).dismiss).toBe(false);
    });
});
