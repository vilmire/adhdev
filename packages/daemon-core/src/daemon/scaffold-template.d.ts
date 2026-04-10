/**
 * Provider scaffold template generator
 * Generates provider.json + scripts/ directory structure (Antigravity pattern).
 *
 * New pattern:
 *   - Scripts WITHOUT params: self-invoking IIFE — (() => { ... })()
 *   - Scripts WITH params: function expression — (params) => { ... }
 *     Router invokes: `(${script})(${JSON.stringify(params)})`
 *   - Each function is a separate .js file in scripts/<version>/
 *   - scripts.js router loads + invokes individual files
 */
export interface ScaffoldOptions {
    cdpPorts?: [number, number];
    cli?: string;
    processName?: string;
    installPath?: string;
    binary?: string;
    extensionId?: string;
    version?: string;
    osPaths?: Record<string, string[]>;
    processNames?: Record<string, string>;
}
export interface ScaffoldResult {
    'provider.json': string;
    files?: Record<string, string>;
}
export declare function generateTemplate(type: string, name: string, category: string, opts?: ScaffoldOptions): string;
/**
 * Generate provider.json + per-function script files.
 * Returns a map of relative paths -> file contents.
 */
export declare function generateFiles(type: string, name: string, category: string, opts?: ScaffoldOptions): ScaffoldResult;
