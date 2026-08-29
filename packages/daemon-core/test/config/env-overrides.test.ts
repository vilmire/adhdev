import { describe, expect, it, vi } from 'vitest';
import { applyDaemonEnvOverrides, isSecretLikeEnvKey } from '../../src/config/env-overrides.js';

describe('isSecretLikeEnvKey', () => {
    it('flags common secret/identity key shapes', () => {
        expect(isSecretLikeEnvKey('ADHDEV_API_TOKEN')).toBe(true);
        expect(isSecretLikeEnvKey('SOME_SECRET')).toBe(true);
        expect(isSecretLikeEnvKey('DB_PASSWORD')).toBe(true);
        expect(isSecretLikeEnvKey('DB_PASSWD')).toBe(true);
        expect(isSecretLikeEnvKey('AWS_CREDENTIAL_FILE')).toBe(true);
        expect(isSecretLikeEnvKey('OPENAI_API_KEY')).toBe(true);
        expect(isSecretLikeEnvKey('OPENAI_APIKEY')).toBe(true);
        expect(isSecretLikeEnvKey('TLS_PRIVATE_KEY')).toBe(true);
        expect(isSecretLikeEnvKey('SESSION_COOKIE')).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(isSecretLikeEnvKey('my_secret_value')).toBe(true);
        expect(isSecretLikeEnvKey('MyToken')).toBe(true);
    });

    it('does not flag plain feature-flag-shaped keys', () => {
        expect(isSecretLikeEnvKey('ADHDEV_WORKER_MCP')).toBe(false);
        expect(isSecretLikeEnvKey('ADHDEV_ALLOW_SERVER_API_PROXY')).toBe(false);
        expect(isSecretLikeEnvKey('DEBUG')).toBe(false);
        expect(isSecretLikeEnvKey('NODE_ENV')).toBe(false);
    });
});

describe('applyDaemonEnvOverrides', () => {
    it('applies a config value when process.env has no explicit value', () => {
        const env: NodeJS.ProcessEnv = {};
        const result = applyDaemonEnvOverrides({ ADHDEV_WORKER_MCP: 'on' }, env);

        expect(env.ADHDEV_WORKER_MCP).toBe('on');
        expect(result.applied).toEqual({ ADHDEV_WORKER_MCP: 'on' });
        expect(result.skippedExplicitEnv).toEqual([]);
        expect(result.skippedRejected).toEqual([]);
    });

    it('never overrides an explicit process.env value (explicit env always wins)', () => {
        const env: NodeJS.ProcessEnv = { ADHDEV_WORKER_MCP: 'off' };
        const result = applyDaemonEnvOverrides({ ADHDEV_WORKER_MCP: 'on' }, env);

        expect(env.ADHDEV_WORKER_MCP).toBe('off');
        expect(result.applied).toEqual({});
        expect(result.skippedExplicitEnv).toEqual(['ADHDEV_WORKER_MCP']);
    });

    it('treats an empty-string env value as unset (config fills it in)', () => {
        const env: NodeJS.ProcessEnv = { ADHDEV_WORKER_MCP: '' };
        const result = applyDaemonEnvOverrides({ ADHDEV_WORKER_MCP: 'on' }, env);

        expect(env.ADHDEV_WORKER_MCP).toBe('on');
        expect(result.applied).toEqual({ ADHDEV_WORKER_MCP: 'on' });
    });

    it('rejects secret-shaped keys outright, even with no explicit env set', () => {
        const env: NodeJS.ProcessEnv = {};
        const logFn = vi.fn();
        const result = applyDaemonEnvOverrides({ SOME_API_TOKEN: 'sneaky' }, env, logFn);

        expect(env.SOME_API_TOKEN).toBeUndefined();
        expect(result.applied).toEqual({});
        expect(result.skippedRejected).toEqual(['SOME_API_TOKEN']);
        expect(logFn).toHaveBeenCalledWith(expect.stringContaining('rejected secret-shaped key'));
    });

    it('is fail-open for an unrecognized (non-secret) key: applies it but logs a warning', () => {
        const env: NodeJS.ProcessEnv = {};
        const logFn = vi.fn();
        const result = applyDaemonEnvOverrides({ ADHDEV_SOME_NEW_FLAG: 'beta' }, env, logFn);

        expect(env.ADHDEV_SOME_NEW_FLAG).toBe('beta');
        expect(result.applied).toEqual({ ADHDEV_SOME_NEW_FLAG: 'beta' });
        expect(result.unknownKeys).toEqual(['ADHDEV_SOME_NEW_FLAG']);
        expect(logFn).toHaveBeenCalledWith(expect.stringContaining('applying unrecognized key'));
    });

    it('does not log for a recognized flag key', () => {
        const env: NodeJS.ProcessEnv = {};
        const logFn = vi.fn();
        applyDaemonEnvOverrides({ ADHDEV_WORKER_MCP: 'on' }, env, logFn);

        expect(logFn).not.toHaveBeenCalled();
    });

    it('handles an undefined overrides map as a no-op', () => {
        const env: NodeJS.ProcessEnv = {};
        const result = applyDaemonEnvOverrides(undefined, env);

        expect(result.applied).toEqual({});
        expect(env).toEqual({});
    });

    it('applies multiple keys independently (mixed accept/reject/explicit-win)', () => {
        const env: NodeJS.ProcessEnv = { ADHDEV_WORKER_MCP: 'off' };
        const result = applyDaemonEnvOverrides(
            {
                ADHDEV_WORKER_MCP: 'on', // explicit env wins, stays 'off'
                ADHDEV_FOO_FLAG: 'bar', // applied
                LEAKED_SECRET_TOKEN: 'nope', // rejected
            },
            env,
        );

        expect(env.ADHDEV_WORKER_MCP).toBe('off');
        expect(env.ADHDEV_FOO_FLAG).toBe('bar');
        expect(env.LEAKED_SECRET_TOKEN).toBeUndefined();
        expect(result.applied).toEqual({ ADHDEV_FOO_FLAG: 'bar' });
        expect(result.skippedExplicitEnv).toEqual(['ADHDEV_WORKER_MCP']);
        expect(result.skippedRejected).toEqual(['LEAKED_SECRET_TOKEN']);
    });
});
