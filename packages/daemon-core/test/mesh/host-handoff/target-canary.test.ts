import { describe, expect, it } from 'vitest';
import { HANDOFF_CANARY_PROMPT, describeCanaryContract, runTargetCanary, type RegisteredCanaryProvider } from '../../../src/mesh/host-handoff/target-canary.js';

const hostBound = { version: 1 as const, enforcement: 'host' as const, hostTimeoutMs: 15_000 as const, hostMaxOutputBytes: 16 * 1024 as const,
    nativeTurnCap: false as const, nativeOutputTokenCap: false as const, privateContextDisabled: true as const, toolsDisabled: true as const };

function registered(script: string, extra: Partial<NonNullable<RegisteredCanaryProvider['hostHandoffCanary']>> = {}): RegisteredCanaryProvider {
    return { type: 'fixture-cli', spawn: { command: process.execPath }, hostHandoffCanary: { ...hostBound,
        args: ['-e', script, '{{prompt}}'], ...extra } };
}

describe.skipIf(process.platform === 'win32')('target-local bounded authentication/start canary', () => {
    it('uses fresh config/workspace, exact selection, fixed input and host bounds, strips live ADHDev credentials and proves exit', async () => {
        const script = `const fs=require('node:fs');
            const args=process.argv.slice(1);
            const good=args[0]==='chosen-thinking'&&args[1]===${JSON.stringify(HANDOFF_CANARY_PROMPT)}&&args[2]==='chosen-model'
                &&process.cwd()!==process.env.ADHDEV_CONFIG_DIR&&fs.readdirSync(process.cwd()).length===0
                &&fs.readdirSync(process.env.ADHDEV_CONFIG_DIR).length===0&&!process.env.ADHDEV_MCP_SESSION_CREDENTIAL;
            process.stdout.write(good?'ADHDEV_HANDOFF_READY':'BAD');`;
        const provider = registered(script, { args: ['-e', script, '{{prompt}}', '{{model}}'], thinkingArgs: ['{{thinkingLevel}}'] });
        const evidence = await runTargetCanary(provider, { provider: 'fixture-cli', model: 'chosen-model', thinkingLevel: 'chosen-thinking' },
            { env: { ...process.env, ADHDEV_CONFIG_DIR: '/must-not-use', ADHDEV_MCP_SESSION_CREDENTIAL: 'fixture-secret' } });
        expect(evidence).toMatchObject({ ok: true, terminated: true, enforcement: 'host', hostTimeoutMs: 15_000, hostMaxOutputBytes: 16 * 1024, nativeTurnCap: false, nativeOutputTokenCap: false });
        expect(evidence).not.toHaveProperty('maxTurns');
        expect(evidence).not.toHaveProperty('maxOutputTokens');
        expect(JSON.stringify(evidence)).not.toContain('fixture-secret');
    });

    it('omits thinking when it is absent and does not pass an empty effort', async () => {
        const script = `const args=process.argv.slice(1);
            const good=args.length===2&&args[0]===${JSON.stringify(HANDOFF_CANARY_PROMPT)}&&args[1]==='gpt-6.1-sol'&&!args.includes('');
            process.stdout.write(good?'ADHDEV_HANDOFF_READY':'BAD');`;
        const provider = registered(script, { args: ['-e', script, '{{prompt}}', '{{model}}'], thinkingArgs: ['model_reasoning_effort={{thinkingLevel}}'] });
        const evidence = await runTargetCanary(provider, { provider: 'fixture-cli', model: 'gpt-6.1-sol' });
        expect(evidence.ok).toBe(true);
        expect(evidence.selection.thinkingLevel).toBeUndefined();
    });

    it('refuses missing isolation/budget contract and a mismatched provider before spawn', async () => {
        expect(await runTargetCanary({ type: 'fixture-cli', spawn: { command: process.execPath } }, { provider: 'fixture-cli' }))
            .toMatchObject({ ok: false, terminated: true, code: 'canary_contract_unsupported', detail: 'canary_contract_unsupported: missing_declaration:fixture-cli' });
        expect(await runTargetCanary(registered('process.exit(99)'), { provider: 'different-provider' }))
            .toMatchObject({ ok: false, code: 'canary_contract_unsupported', detail: 'canary_contract_unsupported: provider_mismatch' });
        const placeholder = registered('process.exit(99)');
        placeholder.hostHandoffCanary = { ...placeholder.hostHandoffCanary!, args: ['{{prompt}}', '{{maxTurns}}', '{{model}}'] };
        expect(describeCanaryContract(placeholder, { provider: 'fixture-cli', model: 'chosen-model' })).toBe('canary_contract_unsupported: native_cap_placeholder');
        expect(await runTargetCanary(placeholder, { provider: 'fixture-cli', model: 'chosen-model' }))
            .toMatchObject({ ok: false, code: 'canary_contract_unsupported', detail: 'canary_contract_unsupported: native_cap_placeholder' });
        expect(describeCanaryContract(registered('process.exit(99)', { args: ['{{prompt}}', '{{model}}'] }), { provider: 'fixture-cli' })).toBe('canary_contract_unsupported: missing_model_selection');
    });

    it('fails closed on timeout after terminating only its private process group', async () => {
        expect(await runTargetCanary(registered('setInterval(()=>{},100)'), { provider: 'fixture-cli' }, { timeoutMs: 20 }))
            .toMatchObject({ ok: false, terminated: true, code: 'canary_timeout' });
    });

    it('rejects excessive output and nonmatching/auth-failed replies without retaining private output', async () => {
        expect(await runTargetCanary(registered("process.stdout.write('x'.repeat(20000));setInterval(()=>{},100)"), { provider: 'fixture-cli' }))
            .toMatchObject({ ok: false, terminated: true, code: 'canary_output_limit' });
        const failed = await runTargetCanary(registered("process.stdout.write('private-auth-failure');process.exit(1)"), { provider: 'fixture-cli' });
        expect(failed).toMatchObject({ ok: false, terminated: true, code: 'canary_failed' });
        expect(JSON.stringify(failed)).not.toContain('private-auth-failure');
    });

    it('kills descendants in its private process group after the root exits and refuses readiness', async () => {
        const provider = registered("require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'}).unref();process.stdout.write('ADHDEV_HANDOFF_READY')");
        expect(await runTargetCanary(provider, { provider: 'fixture-cli' }))
            .toMatchObject({ ok: false, terminated: true, code: 'canary_descendants' });
    });
});
