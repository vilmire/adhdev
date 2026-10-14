/** Call from vi.hoisted BEFORE importing consumers. No session-host imports. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
export function createSessionHostIsolation() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'held-observer-isolation-')));
    const prior = {config:process.env.ADHDEV_CONFIG_DIR,name:process.env.ADHDEV_SESSION_HOST_NAME};
    process.env.ADHDEV_CONFIG_DIR = root;
    process.env.ADHDEV_SESSION_HOST_NAME = `test-held-${path.basename(root)}`;
    const endpoint = {kind:'unix' as const,path:path.join(root,'nonexistent.sock')};
    const endpoints = new Set([endpoint.path]);
    return {root,endpoint,endpointFor(name:string) {
        if (!/^[a-z0-9-]+$/.test(name)) throw new Error('test_endpoint_name_invalid');
        const value={kind:'unix' as const,path:path.join(root,`nonexistent-${name}.sock`)};endpoints.add(value.path);return value;
    },assertEndpoint(value: unknown) {
        const actual = value as typeof endpoint;
        if (!actual || !endpoints.has(actual.path) || fs.existsSync(actual.path) || /(?:^|\/)adhdev(?:-preview)?-session-host\.sock$/.test(actual.path)) throw new Error('test_live_session_host_endpoint_refused');
    },cleanup() {
        if (prior.config === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR=prior.config;
        if (prior.name === undefined) delete process.env.ADHDEV_SESSION_HOST_NAME; else process.env.ADHDEV_SESSION_HOST_NAME=prior.name;
        fs.rmSync(root,{recursive:true,force:true});
    }};
}
