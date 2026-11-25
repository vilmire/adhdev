/** Internal admission guard. No payload, preview or partial success escapes this boundary. */
import { runInNewContext } from 'node:vm';
import { TextDecoder } from 'node:util';
import { inspectCredentialContent } from '../logging/credential-redactor.js';
import { ARTIFACT_SECRET_CONTENT_PATTERNS } from '../logging/artifact-content-patterns.js';

// Separate from the 1GiB physical retention budget and unchanged 4MiB artifact unit.
// Larger logical inputs remain private until a bounded complete scanner can handle them.
export const STAGE_DIFF_SCAN_BYTES = 8 * 1024 * 1024;
export class StageDiffScanBlocked extends Error {
    constructor(readonly code: string) { super(code); }
}
export function assertStageDiffContent(bytes: Buffer): void {
    if (bytes.length > STAGE_DIFF_SCAN_BYTES) throw new StageDiffScanBlocked('review_diff_scan_budget_exceeded');
    try {
        // A VM deadline interrupts the synchronous scanner, including its imported callback/regexes.
        // The bounded input and shrinking percent/base64 transforms bound retained allocations;
        // recursion and total decode operations retain the existing fail-closed budgets.
        const result = runInNewContext('scan()', { scan: () => {
            if ((bytes[0] === 0x1f && bytes[1] === 0x8b) || (bytes[0] === 0x50 && bytes[1] === 0x4b)
                || (bytes[0] === 0x78 && ((bytes[0] * 256 + bytes[1]!) % 31 === 0))) throw new StageDiffScanBlocked('review_diff_scan_encoding_unsupported');
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            // The existing scanner does not interpret JS/JSON unicode/hex escapes or compression.
            // Such inputs cannot be certified as completely decoded by this bounded route.
            if (text.includes('GIT binary patch') || /\\(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2})/.test(text)) throw new StageDiffScanBlocked('review_diff_scan_encoding_unsupported');
            return inspectCredentialContent(text, ARTIFACT_SECRET_CONTENT_PATTERNS, true);
        } }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as { blocked: boolean; exhausted: boolean };
        if (!result || typeof result.blocked !== 'boolean' || typeof result.exhausted !== 'boolean') throw new StageDiffScanBlocked('review_diff_scan_incomplete');
        if (result.exhausted) throw new StageDiffScanBlocked('review_diff_scan_incomplete');
        if (result.blocked) throw new StageDiffScanBlocked('secret_file_refused');
    } catch (e) {
        if (e instanceof StageDiffScanBlocked) throw e;
        throw new StageDiffScanBlocked((e as { code?: string })?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
            ? 'review_diff_scan_timeout' : 'review_diff_scan_incomplete');
    }
}
