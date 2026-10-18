import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/** Local package schemas only; neither traversal nor remote $ref resolution is allowed. */
export async function readDriverInputSchema(cwd: string, schemaPath: string): Promise<Record<string, unknown> | null> {
    try {
        const root = await realpath(cwd);
        const file = await realpath(resolve(root, schemaPath));
        const rel = relative(root, file);
        if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) return null;
        const schema = JSON.parse(await readFile(file, 'utf8'));
        return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : null;
    } catch { return null; }
}
export async function validateDriverArgs(cwd: string, schemaPath: string | undefined, args: unknown): Promise<boolean> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    if (!schemaPath) return true;
    try {
        const schema = await readDriverInputSchema(cwd, schemaPath);
        if (!schema) return false;
        const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
        addFormats(ajv);
        return ajv.compile(schema)(args) === true;
    } catch { return false; }
}
