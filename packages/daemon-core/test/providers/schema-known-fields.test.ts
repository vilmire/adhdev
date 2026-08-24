/**
 * Schema ↔ loader field-list conformance.
 *
 * The v1 JSON schemas (sdk/v1/schemas/{cli,acp}/provider.schema.json) define
 * what a manifest MAY contain; the loader's hand-written
 * KNOWN_PROVIDER_FIELDS allow-list decides what does NOT trip the
 * "Unknown provider field" warning. These drifted silently for months:
 * schema-valid fields (links, source, tui, session, tier, …) warned on every
 * daemon boot for every installed provider that used them.
 *
 * Invariant enforced here: every top-level property a v1 schema allows must
 * be present in KNOWN_PROVIDER_FIELDS. (The reverse is deliberately NOT
 * enforced — KNOWN_PROVIDER_FIELDS also carries legacy v0/IDE/extension
 * fields that the v1 schemas do not describe.)
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_PROVIDER_FIELDS } from '../../src/providers/provider-schema.js';
import cliSchema from '../../src/providers/sdk/v1/schemas/cli/provider.schema.json';
import acpSchema from '../../src/providers/sdk/v1/schemas/acp/provider.schema.json';

function schemaProps(schema: { properties?: Record<string, unknown> }): string[] {
    return Object.keys(schema.properties ?? {});
}

describe('v1 schema properties are known to the loader', () => {
    it('every CLI schema property is in KNOWN_PROVIDER_FIELDS', () => {
        const missing = schemaProps(cliSchema).filter((k) => !KNOWN_PROVIDER_FIELDS.has(k));
        expect(missing).toEqual([]);
    });

    it('every ACP schema property is in KNOWN_PROVIDER_FIELDS', () => {
        const missing = schemaProps(acpSchema).filter((k) => !KNOWN_PROVIDER_FIELDS.has(k));
        expect(missing).toEqual([]);
    });

    it('schemas actually have a meaningful property set (guard against empty parse)', () => {
        expect(schemaProps(cliSchema).length).toBeGreaterThan(30);
        expect(schemaProps(acpSchema).length).toBeGreaterThan(10);
    });
});
