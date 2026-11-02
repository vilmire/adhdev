import { describe, expect, it } from 'vitest';
import { HANDOFF_CANARY_PROMPT, describeCanaryContract, runTargetCanary, type RegisteredCanaryProvider } from '../../../src/mesh/host-handoff/target-canary.js';

function registered(script: string): RegisteredCanaryProvider {
    return { type: 'fixture-cli', spawn: { command: process.execPath }, hostHandoffCanary: { version: 1,
        privateContextDisabled: true, toolsDisabled: true,
        args: ['-e', script, '{{prompt}}', '{{maxTurns}}', '{{maxOutputTokens}}', '{{model}}', '{{thinkingLevel}}'] } };
}

describe.skipIf(process.platform === 'win32')('target-local bounded authentication/start canary', () => {
    it('uses fresh config/workspace, exact selection, fixed input and budgets, strips live ADHDev credentials and proves exit', async () => {
        const provider = registered(`const fs=require('node:fs');
            const args=process.argv.slice(1);
            const good=args[0]===${JSON.stringify(HANDOFF_CANARY_PROMPT)}&&args[1]==='1'&&args[2]==='32'&&args[3]==='chosen-model'&&args[4]==='chosen-thinking'
                &&process.cwd()!==process.env.ADHDEV_CONFIG_DIR&&fs.readdirSync(process.cwd()).length===0
                &&fs.readdirSync(process.env.ADHDEV_CONFIG_DIR).length===0&&!process.env.ADHDEV_MCP_SESSION_CREDENTIAL;
            process.stdout.write(good?'ADHDEV_HANDOFF_READY':'BAD');`);
        const evidence = await runTargetCanary(provider, { provider: 'fixture-cli', model: 'chosen-model', thinkingLevel: 'chosen-thinking' },
            { env: { ...process.env, ADHDEV_CONFIG_DIR: '/must-not-use', ADHDEV_MCP_SESSION_CREDENTIAL: 'fixture-secret' } });
        expect(evidence).toMatchObject({ ok: true, terminated: true, maxTurns: 1, maxOutputTokens: 32 });
        expect(JSON.stringify(evidence)).not.toContain('fixture-secret');
    });

    it('refuses missing isolation/budget contract and a mismatched provider before spawn', async () => {
        expect(await runTargetCanary({ type: 'fixture-cli', spawn: { command: process.execPath } }, { provider: 'fixture-cli' }))
            .toMatchObject({ ok: false, terminated: true, code: 'canary_contract_unsupported', detail: 'canary_contract_unsupported: missing_declaration:fixture-cli' });
        expect(await runTargetCanary(registered('process.exit(99)'), { provider: 'different-provider' }))
            .toMatchObject({ ok: false, code: 'canary_contract_unsupported', detail: 'canary_contract_unsupported: provider_mismatch' });
        const missingToken = registered('process.exit(99)');
        missingToken.hostHandoffCanary = { ...missingToken.hostHandoffCanary!, args: ['{{prompt}}', '{{maxTurns}}', '{{model}}'] };
        expect(describeCanaryContract(missingToken, { provider: 'fixture-cli', model: 'chosen-model' })).toBe('canary_contract_unsupported: missing_max_output_tokens_binding');
        expect(await runTargetCanary(missingToken, { provider: 'fixture-cli', model: 'chosen-model' }))
            .toMatchObject({ ok: false, code: 'canary_contract_unsupported', detail: 'canary_contract_unsupported: missing_max_output_tokens_binding' });
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
