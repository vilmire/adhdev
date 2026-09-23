import { describe, expect, it } from 'vitest';
import { isRouterInternalArgKey, stripRouterInternalArgs } from '../../src/commands/router-internal-args.js';

describe('stripRouterInternalArgs', () => {
    it('drops only underscore-prefixed keys and returns a shallow copy', () => {
        const args = { v: 1, meshId: 'mesh_x', _interactionId: 'ix_1', _other: true, nested: { _keep: 1 } };
        const out = stripRouterInternalArgs(args);
        expect(out).toEqual({ v: 1, meshId: 'mesh_x', nested: { _keep: 1 } });
        expect(out).not.toBe(args);
        expect(args._interactionId).toBe('ix_1');
    });
    it('passes non-objects and arrays through untouched', () => {
        expect(stripRouterInternalArgs(null)).toBeNull();
        expect(stripRouterInternalArgs('x')).toBe('x');
        const arr = [{ _a: 1 }];
        expect(stripRouterInternalArgs(arr)).toBe(arr);
    });
    it('isRouterInternalArgKey follows the underscore convention', () => {
        expect(isRouterInternalArgKey('_interactionId')).toBe(true);
        expect(isRouterInternalArgKey('meshId')).toBe(false);
    });
});
