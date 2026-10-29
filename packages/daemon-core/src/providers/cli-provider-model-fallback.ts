/**
 * cli-provider-model-fallback — make a SILENT model substitution visible.
 *
 * Live 2026-10-29 (antigravity): `agy --model claude-opus-4-6-thinking` does
 * not fail on an unknown model; it prints a one-line TUI warning and runs the
 * default Gemini instead (`model X is not recognized … Using "Gemini 4 Argon
 * (Medium)" instead.`). The launch record said "Opus" while Gemini answered.
 *
 * A provider that has such a warning declares it generically in its manifest
 * (`modelFallbackWarning: { pattern, flags? }`, capture group = the model really
 * in use). While a session is young and a model was requested, the 5 s instance
 * tick scans the rendered screen for it; on a match the actual model is written
 * to the session's launch record (`model.observed` + `model.fallback = true`),
 * which the dashboard chip renders as a warning.
 *
 * Trade-off (owner principle: usefulness first, never silently): this reads the
 * rendered screen on a timer, but only until the first match or SCAN_WINDOW_MS
 * after launch, only for providers that declare the pattern, and only the
 * captured model identifier leaves this function — never screen text.
 */
import type { SessionEventPort } from '../sessions/session-port.js';

/** The warning is printed at TUI start-up; stop looking well after that. */
export const MODEL_FALLBACK_SCAN_WINDOW_MS = 3 * 60 * 1000;

const MAX_MODEL_LENGTH = 120;

/** Collapse hard-wrapped terminal lines so a warning split across rows still matches. */
function flattenScreen(text: string): string {
    return text.replace(/\s+/g, ' ');
}

/**
 * Match the declared pattern against a rendered screen. Returns the model the
 * CLI says it is really running, or null (no match, bad pattern, empty capture).
 */
export function detectModelFallback(
    warning: { pattern: string; flags?: string } | undefined,
    screenText: string,
): string | null {
    if (!warning?.pattern || !screenText) return null;
    let re: RegExp;
    try {
        re = new RegExp(warning.pattern, warning.flags && /^[gimsuy]*$/.test(warning.flags) ? warning.flags : 'i');
    } catch {
        return null;
    }
    const m = re.exec(flattenScreen(screenText));
    if (!m) return null;
    const actual = (m.groups?.actual ?? m[1] ?? '').trim();
    return actual && actual.length <= MAX_MODEL_LENGTH ? actual : null;
}

export interface ModelFallbackHost {
    readonly instanceId: string;
    readonly provider: { modelFallbackWarning?: { pattern: string; flags?: string } };
    readonly lifecyclePort: SessionEventPort | null;
    readonly adapter: { getTerminalScreenSnapshot?(maxBytes?: number): { text: string } | null };
}

interface ScanState { startedAt: number; done: boolean }
const scans = new WeakMap<object, ScanState>();

/**
 * One tick of the scan. Cheap no-op unless the provider declares the pattern, a
 * model was requested (`requestedModel`), and the session is inside its window.
 */
export function scanModelFallback(host: ModelFallbackHost, now: number = Date.now()): boolean {
    const warning = host.provider.modelFallbackWarning;
    const port = host.lifecyclePort;
    if (!warning || !port?.observeLaunchModel) return false;
    if (!port.launchRecord?.(host.instanceId)?.model.requested) return false;
    let state = scans.get(host);
    if (!state) scans.set(host, state = { startedAt: now, done: false });
    if (state.done || now - state.startedAt > MODEL_FALLBACK_SCAN_WINDOW_MS) return false;
    let text = '';
    try {
        text = host.adapter.getTerminalScreenSnapshot?.()?.text ?? '';
    } catch {
        return false;
    }
    const actual = detectModelFallback(warning, text);
    if (!actual) return false;
    state.done = true;
    port.observeLaunchModel(host.instanceId, actual, now, { fallback: true });
    return true;
}
