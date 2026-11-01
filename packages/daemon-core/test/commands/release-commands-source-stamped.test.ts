import { describe, expect, it } from 'vitest';
import { COMMAND_SOURCE_STAMPED } from '../../src/commands/command-args.js';
import { meshReleaseHandlers } from '../../src/commands/high-family/mesh-release-commands.js';

describe('release commands read the router-stamped source', () => {
    it('every release command is in COMMAND_SOURCE_STAMPED (otherwise the owner is classified as unknown)', () => {
        const names = Object.keys(meshReleaseHandlers as Record<string, unknown>);
        expect(names.length).toBe(5);
        for (const name of names) expect(COMMAND_SOURCE_STAMPED.has(name), name).toBe(true);
    });
});
