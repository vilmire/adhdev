/** Call from vi.hoisted BEFORE importing consumers. No session-host imports. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
export function createSessionHostIsolation() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'held-observer-isolation-')));
    const priorConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function(){throw new Error('test_native_session_host_connect_forbidden');} as typeof net.Socket.prototype.connect;
    // Any Node subprocess inherits the same fatal native-connect fence before imports.
    const preload = path.join(root,'deny-native-connect.cjs');
    fs.writeFileSync(preload,"require('node:net').Socket.prototype.connect = function(){throw new Error('test_native_session_host_connect_forbidden');}; require('node:module').syncBuiltinESMExports();\n");
    const priorNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${priorNodeOptions || ''} --require=${JSON.stringify(preload)}`;
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
        net.Socket.prototype.connect = priorConnect;
        if (priorNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS=priorNodeOptions;
        if (prior.config === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR=prior.config;
        if (prior.name === undefined) delete process.env.ADHDEV_SESSION_HOST_NAME; else process.env.ADHDEV_SESSION_HOST_NAME=prior.name;
        fs.rmSync(root,{recursive:true,force:true});
    }};
}
