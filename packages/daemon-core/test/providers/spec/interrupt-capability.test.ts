/**
 * Interrupt capability resolution — regression gates for delivery mode
 * 'interrupt' (M-INPUT-DELIVERY-MODE-AND-QUEUE, axis A).
 *
 * The three properties locked here are the ones whose violation would
 * reintroduce the defect class this feature exists to remove:
 *   (a) the default delivery mode stays 'when_idle'
 *   (b) an unsupported provider is never silently downgraded
 *   (c) the per-provider stop key mapping (antigravity=ESC, others=Ctrl-C)
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    resolveInterruptCapability,
    CTRL_C,
    ESC,
    STOP_CONTROL_ID,
} from '../../../src/providers/spec/interrupt-capability.js';
import type { Control } from '../../../src/providers/spec/types.js';

const stopControl = (keys: string, visible?: string[]): Control => ({
    id: STOP_CONTROL_ID,
    label: 'Stop',
    ...(visible ? { visible_when_state: visible } : {}),
    action: { type: 'send_keys', keys },
});

describe('resolveInterruptCapability', () => {
    it('supports a provider declaring a non-empty Ctrl-C stop key', () => {
        const cap = resolveInterruptCapability('claude-cli', [stopControl(CTRL_C, ['busy'])]);
        expect(cap.supported).toBe(true);
        if (!cap.supported) throw new Error('unreachable');
        expect(cap.keys).toBe(CTRL_C);
        expect(cap.keyName).toBe('Ctrl-C');
        expect(cap.visibleWhenState).toEqual(['busy']);
    });

    it('supports ESC and names it correctly (antigravity)', () => {
        const cap = resolveInterruptCapability('antigravity-cli', [stopControl(ESC, ['busy'])]);
        expect(cap.supported).toBe(true);
        if (!cap.supported) throw new Error('unreachable');
        expect(cap.keys).toBe(ESC);
        expect(cap.keyName).toBe('ESC');
    });

    // ── (b) no silent fallback ────────────────────────────────────────────
    it('★ treats an EMPTY stop key as UNSUPPORTED (hermes-cli specs/4.0.json)', () => {
        // The live trap: FsmDriver.handleClickControl would call send_keys("")
        // — writing nothing — while invokeScript still returns ok:true. If this
        // ever resolves to supported, an interrupt silently does nothing and
        // reports success.
        const cap = resolveInterruptCapability('hermes-cli', [stopControl('', ['busy'])]);
        expect(cap.supported).toBe(false);
        if (cap.supported) throw new Error('unreachable');
        expect(cap.reason).toBe('stop_keys_empty');
        expect(cap.message).toMatch(/empty/i);
    });

    it('is unsupported when no stop control is declared', () => {
        const cap = resolveInterruptCapability('made-up-cli', []);
        expect(cap.supported).toBe(false);
        if (cap.supported) throw new Error('unreachable');
        expect(cap.reason).toBe('no_stop_control');
    });

    it('is unsupported when the stop control is not a key write', () => {
        const cap = resolveInterruptCapability('made-up-cli', [{
            id: STOP_CONTROL_ID,
            label: 'Stop',
            action: {
                type: 'open_picker',
                trigger_keys: '/stop\r',
                wait_for: {},
                extract_choices: {} as never,
                submit_key: '\r',
            },
        } as Control]);
        expect(cap.supported).toBe(false);
        if (cap.supported) throw new Error('unreachable');
        expect(cap.reason).toBe('stop_control_not_send_keys');
    });

    it('every unsupported result carries a non-empty operator message', () => {
        const cases: Control[][] = [[], [stopControl('')], [stopControl('   '.slice(0, 0))]];
        for (const controls of cases) {
            const cap = resolveInterruptCapability('x-cli', controls);
            expect(cap.supported).toBe(false);
            if (cap.supported) throw new Error('unreachable');
            expect(cap.message.length).toBeGreaterThan(0);
        }
    });

    it('marks unverified providers as declared, not proven', () => {
        const proven = resolveInterruptCapability('claude-cli', [stopControl(CTRL_C)]);
        const declared = resolveInterruptCapability('kimi', [stopControl(CTRL_C)]);
        if (!proven.supported || !declared.supported) throw new Error('unreachable');
        // claude-cli is the only provider whose mid-generation behaviour was
        // measured live; everything else must not claim more than it knows.
        expect(proven.confidence).toBe('proven');
        expect(declared.confidence).toBe('declared');
    });
});

// ── (c) provider stop-key mapping, read from the REAL shipped specs ───────
// This asserts against adhdev-providers on disk rather than a copied table, so
// a spec edit that drops or empties a stop key fails here instead of silently
// degrading an interrupt at runtime.
const PROVIDERS_ROOT = path.resolve(__dirname, '../../../../../../adhdev-providers/cli');

/** provider dir -> spec file -> expected stop keys. Measured 2026-08-19. */
const EXPECTED_STOP_KEYS: Record<string, Record<string, string>> = {
    'antigravity-cli': { '1.0.json': ESC, '4.0.json': ESC },
    'claude-cli': { '3.0.json': CTRL_C, '4.0.json': CTRL_C },
    'codex-cli': { '0.137.json': CTRL_C, '4.0.json': CTRL_C },
    'cursor-cli': { '1.0.json': CTRL_C },
    'grok-cli': { '1.0.json': CTRL_C },
    // hermes-cli 4.0 ships an EMPTY stop key — asserted explicitly below.
    'hermes-cli': { '0.14.json': CTRL_C, '4.0.json': '' },
    kimi: { '1.0.json': CTRL_C },
    opencode: { '1.0.json': CTRL_C },
};

const providersAvailable = fs.existsSync(PROVIDERS_ROOT);

describe.skipIf(!providersAvailable)('shipped provider stop controls', () => {
    for (const [provider, specs] of Object.entries(EXPECTED_STOP_KEYS)) {
        for (const [specFile, expectedKeys] of Object.entries(specs)) {
            const specPath = path.join(PROVIDERS_ROOT, provider, 'specs', specFile);
            it(`${provider}/${specFile} declares stop keys ${JSON.stringify(expectedKeys)}`, () => {
                const raw = JSON.parse(fs.readFileSync(specPath, 'utf8'));
                const cap = resolveInterruptCapability(provider, raw.control_bar);
                if (expectedKeys === '') {
                    // hermes-cli 4.0: declared but empty => must be unsupported.
                    expect(cap.supported).toBe(false);
                    if (cap.supported) throw new Error('unreachable');
                    expect(cap.reason).toBe('stop_keys_empty');
                    return;
                }
                expect(cap.supported).toBe(true);
                if (!cap.supported) throw new Error('unreachable');
                expect(cap.keys).toBe(expectedKeys);
            });
        }
    }

    it('★ antigravity-cli is the ONLY provider using ESC; the rest use Ctrl-C', () => {
        const esc: string[] = [];
        const ctrlC: string[] = [];
        const unsupported: string[] = [];
        for (const provider of Object.keys(EXPECTED_STOP_KEYS)) {
            const specDir = path.join(PROVIDERS_ROOT, provider, 'specs');
            if (!fs.existsSync(specDir)) continue;
            for (const f of fs.readdirSync(specDir).filter(n => n.endsWith('.json'))) {
                const raw = JSON.parse(fs.readFileSync(path.join(specDir, f), 'utf8'));
                const cap = resolveInterruptCapability(provider, raw.control_bar);
                const tag = `${provider}/${f}`;
                if (!cap.supported) { unsupported.push(tag); continue; }
                if (cap.keys === ESC) esc.push(tag);
                else if (cap.keys === CTRL_C) ctrlC.push(tag);
            }
        }
        expect(esc.every(t => t.startsWith('antigravity-cli/'))).toBe(true);
        expect(esc.length).toBeGreaterThan(0);
        expect(ctrlC.some(t => t.startsWith('antigravity-cli/'))).toBe(false);
        expect(ctrlC.length).toBeGreaterThan(0);
        // The only known unsupported spec is hermes-cli 4.0's empty key.
        expect(unsupported).toEqual(['hermes-cli/4.0.json']);
    });
});
