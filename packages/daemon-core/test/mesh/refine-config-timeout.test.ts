import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { MESH_REFINE_CONFIG_SCHEMA, normalizeMeshCommandConfig, validateMeshRefineConfig } from '../../src/mesh/refine-config.js';
import { validateMeshWorktreeBootstrapConfig } from '../../src/mesh/worktree-bootstrap-config.js';

const schemaValid = new Ajv2020().compile(MESH_REFINE_CONFIG_SCHEMA);
const entry = { command: 'npm', args: ['run', 'test:scripts'], category: 'test', cwd: '.', outputLimitBytes: 2048, env: { CI: '1' }, scopes: ['daemon'] };

describe('validation-only command timeout budget', () => {
    it.each([
        [999, false, false], [1000, true, true], [600000, true, true],
        [600001, true, false], [1800000, true, false], [1800001, false, false],
    ])('timeout %i: validation=%s bootstrap=%s', (timeoutMs, validationValid, bootstrapValid) => {
        for (const [key, valid] of [['commands', validationValid], ['bootstrapCommands', bootstrapValid]] as const) {
            const config = { version: 1, validation: { [key]: [{ ...entry, timeoutMs }] } };
            const result = validateMeshRefineConfig(config);
            expect(result.valid).toBe(valid);
            expect(schemaValid(config)).toBe(valid);
            expect(result.rejectedCommands).toHaveLength(valid ? 0 : 1);
            expect(result[key]).toHaveLength(valid ? 1 : 0);
            if (valid) expect(result[key][0]).toMatchObject({ ...entry, timeoutMs });
        }
        const bootstrap = validateMeshWorktreeBootstrapConfig({ version: 1, commands: [{ ...entry, timeoutMs }] });
        expect(bootstrap.valid).toBe(bootstrapValid);
        expect(bootstrap.rejectedCommands).toHaveLength(bootstrapValid ? 0 : 1);
        expect(!!normalizeMeshCommandConfig({ ...entry, timeoutMs }, 'test').command).toBe(bootstrapValid);
    });

    it('leaves omitted timeouts unset in both command classes and the shared helper', () => {
        const result = validateMeshRefineConfig({ version: 1, validation: { commands: [entry], bootstrapCommands: [entry] } });
        expect(result.valid).toBe(true);
        expect(result.commands[0].timeoutMs).toBeUndefined();
        expect(result.bootstrapCommands[0].timeoutMs).toBeUndefined();
        expect(normalizeMeshCommandConfig(entry, 'test').command?.timeoutMs).toBeUndefined();
    });

    it.each([
        { command: 'npm;pwd' }, { args: [1] }, { args: ['bad\narg'] }, { cwd: 1 },
        { outputLimitBytes: 1023 }, { outputLimitBytes: 1048577 }, { env: { CI: 1 } }, { scopes: ['invalid'] },
        { timeoutMs: Number.NaN }, { timeoutMs: Infinity }, { timeoutMs: '1800000' },
    ])('preserves command checks with the larger validation budget: %j', invalid => {
        for (const key of ['commands', 'bootstrapCommands']) {
            const result = validateMeshRefineConfig({ version: 1, validation: { [key]: [{ ...entry, timeoutMs: 600000, ...invalid }] } });
            expect(result.valid).toBe(false);
            expect(result.rejectedCommands).toHaveLength(1);
        }
    });

    it.each([{ version: 2 }, { validation: { bootstrap: 'invalid' } }, { allowAutoPublishSubmoduleMainCommits: 'yes' }, { validation: { commands: {} } }])('preserves top-level checks: %j', invalid => {
        expect(validateMeshRefineConfig({ version: 1, validation: { commands: [{ ...entry, timeoutMs: 1800000 }] }, ...invalid }).valid).toBe(false);
    });
});
