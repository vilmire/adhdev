/**
 * Manifest validators — runtime JSON Schema check for v1 provider manifests.
 *
 * The schemas live under `schemas/{category}/provider.schema.json` and are
 * the authoritative contract for what a v1 manifest may contain. Daemon
 * code that loads a manifest at install or boot time runs it through
 * `validateCliProviderManifest()` first; failures are reported back to
 * the caller with structured paths so manifest authors can locate the
 * offending field without guessing.
 *
 * Validation lives in the SDK layer (not in provider-loader) so dashboards,
 * registry workers, and the marketplace publish flow can all reuse the
 * same code path and produce identical error messages.
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import cliProviderSchema from '../schemas/cli/provider.schema.json';

export interface ManifestValidationIssue {
    /** JSON Pointer-style path into the manifest. Empty string for the root. */
    path: string;
    /** Schema-keyword that failed. */
    keyword: string;
    /** Human-readable explanation. */
    message: string;
    /** Allowed values when the failure is an `enum` / `const` / `additionalProperties`. */
    allowed?: unknown;
}

export interface ManifestValidationResult {
    ok: boolean;
    issues: ManifestValidationIssue[];
}

let _ajv: Ajv2020 | null = null;
let _cliValidator: ValidateFunction | null = null;

function getAjv(): Ajv2020 {
    if (_ajv) return _ajv;
    // strict=false because the schema authors freely use schema-level
    // `description`/`examples` fields that ajv would otherwise warn about.
    // allErrors=true so a single validation run reports every problem at
    // once instead of bailing on the first — that's what makes the
    // structured-error output usable for manifest authors.
    _ajv = new Ajv2020({
        strict: false,
        allErrors: true,
        allowUnionTypes: true,
    });
    addFormats(_ajv);
    return _ajv;
}

function getCliValidator(): ValidateFunction {
    if (_cliValidator) return _cliValidator;
    _cliValidator = getAjv().compile(cliProviderSchema as unknown as object);
    return _cliValidator;
}

function formatIssue(err: ErrorObject): ManifestValidationIssue {
    const path = err.instancePath || '';
    const params = err.params as Record<string, unknown>;
    let message = err.message || 'validation failed';
    let allowed: unknown;

    if (err.keyword === 'additionalProperties') {
        const extra = params.additionalProperty;
        message = `unexpected property "${extra}"`;
    } else if (err.keyword === 'required') {
        message = `missing required property "${params.missingProperty}"`;
    } else if (err.keyword === 'enum') {
        allowed = params.allowedValues;
        message = `must be one of ${JSON.stringify(allowed)}`;
    } else if (err.keyword === 'const') {
        allowed = params.allowedValue;
        message = `must equal ${JSON.stringify(allowed)}`;
    } else if (err.keyword === 'type') {
        message = `must be ${params.type}`;
    }

    return { path, keyword: err.keyword, message, ...(allowed !== undefined ? { allowed } : {}) };
}

/**
 * Validate a CLI provider.v1.json manifest. Returns `{ ok: true, issues: [] }`
 * on success and `{ ok: false, issues: [...] }` on failure with each issue
 * pointing at the offending field. Never throws — manifest parse errors
 * should be caught by the caller before this is called.
 */
export function validateCliProviderManifest(manifest: unknown): ManifestValidationResult {
    const validator = getCliValidator();
    const ok = validator(manifest) as boolean;
    if (ok) return { ok: true, issues: [] };
    const issues = (validator.errors || []).map(formatIssue);
    return { ok: false, issues };
}

/**
 * Render a list of validation issues as a single multi-line string,
 * suitable for log lines or daemon command error fields.
 */
export function formatManifestValidationIssues(issues: ManifestValidationIssue[]): string {
    return issues
        .map((issue) => {
            const where = issue.path || '<root>';
            return `  - ${where}: ${issue.message} (${issue.keyword})`;
        })
        .join('\n');
}
