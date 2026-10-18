import { describe, expect, expectTypeOf, it } from 'vitest';
import type { LaunchableProviderCategory, ProviderCategory, ProviderModule } from '../../src/providers/contracts.js';
import { KNOWN_PROVIDER_FIELDS, validateProviderDefinition } from '../../src/providers/provider-schema.js';
import { validateDriverProviderManifest } from '../../src/providers/sdk/v1/validators/manifest.js';
import schema from '../../src/providers/sdk/v1/schemas/driver/provider.schema.json';

const driver = {
  type: 'browser-playwright', name: 'Browser', category: 'driver', providerVersion: '1.0.0', publisher: 'ADHDev',
  compatibility: { driverApi: '^1.0.0' },
  source: { type: 'github', repo: 'adhdev/providers', ref: 'main' },
  runtime: { kind: 'mcp-stdio', command: 'node', args: ['server.js'] },
  actions: [{ id: 'snapshot', tool: 'browser_snapshot', risk: 'read' }],
  resources: [{ key: 'profile', lease: 'session' }], guidance: './guidance/usage.md',
  declaredAccess: { network: ['*'], filesystem: ['workspace'], desktopControl: false },
};

describe('driver provider schema', () => {
  it('accepts driver metadata, including common fields and object compatibility, without warnings', () => {
    expect(validateProviderDefinition(driver)).toEqual({ errors: [], warnings: [] });
    expect(validateDriverProviderManifest(driver)).toEqual({ ok: true, issues: [] });
    expectTypeOf<'driver'>().toExtend<ProviderCategory>();
    expectTypeOf<Extract<LaunchableProviderCategory, 'driver'>>().toEqualTypeOf<never>();
    expectTypeOf<ProviderModule['runtime']>().toExtend<{ kind: 'mcp-stdio' } | undefined>();
  });

  it('recognizes every driver schema field', () => {
    expect(Object.keys(schema.properties).filter(key => !KNOWN_PROVIDER_FIELDS.has(key))).toEqual([]);
  });

  it.each(['runtime', 'actions', 'type', 'name', 'providerVersion'])('requires %s', (key) => {
    const manifest = { ...driver } as Record<string, unknown>;
    delete manifest[key];
    expect(validateProviderDefinition(manifest).errors.join('\n')).toContain(key);
  });

  it.each(['spawn', 'cdpPorts', 'scripts', 'capabilities', 'riskClass'])('forbids %s', (key) => {
    expect(validateProviderDefinition({ ...driver, [key]: {} }).errors.join('\n'))
      .toContain(`unexpected property "${key}"`);
  });

  it.each([
    { runtime: { kind: 'command', command: 'adb' } },
    { runtime: { kind: 'mcp-stdio' } },
    { runtime: { kind: 'mcp-stdio', command: 'node', args: 'server.js' } },
    { actions: [] },
    { actions: [{ id: 'snapshot', tool: 'snapshot', risk: 'unknown' }] },
    { actions: [{ id: 'snapshot', risk: 'read' }] },
    { compatibility: '^1.0.0' },
    { compatibility: [{ ideVersion: '*', scriptDir: 'scripts' }] },
    { declaredAccess: { desktopControl: 'true' } },
  ])('rejects malformed driver fields: %j', (fields) => {
    expect(validateProviderDefinition({ ...driver, ...fields }).errors.length).toBeGreaterThan(0);
  });
});
