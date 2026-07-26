const fs = require('fs');
let dts = fs.readFileSync('src/cli-adapter-types.d.ts', 'utf8');
dts = dts.replace(/sendMessage\(text: string, options\?: \{ force\?: boolean; meshTaskId\?: string \}\): Promise<void>;/g, "sendMessage(text: string, options?: { force?: boolean; meshTaskId?: string }): Promise<{ status: 'queued' | 'delivered' } | void>;");
dts = dts.replace(/forceSendMessage\?\(text: string, meshTaskId\?: string\): Promise<void>;/g, "forceSendMessage?(text: string, meshTaskId?: string): Promise<{ status: 'queued' | 'delivered' } | void>;");
fs.writeFileSync('src/cli-adapter-types.d.ts', dts);

let ts = fs.readFileSync('src/cli-adapter-types.ts', 'utf8');
ts = ts.replace(/sendMessage\(text: string, options\?: \{ force\?: boolean; meshTaskId\?: string \}\): Promise<void>;/g, "sendMessage(text: string, options?: { force?: boolean; meshTaskId?: string }): Promise<{ status: 'queued' | 'delivered' } | void>;");
ts = ts.replace(/forceSendMessage\?\(text: string, meshTaskId\?: string\): Promise<void>;/g, "forceSendMessage?(text: string, meshTaskId?: string): Promise<{ status: 'queued' | 'delivered' } | void>;");
fs.writeFileSync('src/cli-adapter-types.ts', ts);

let spec = fs.readFileSync('src/providers/spec/cli-adapter.ts', 'utf8');
spec = spec.replace(/async sendMessage\(text: string\): Promise<void> \{/g, "async sendMessage(text: string): Promise<{ status: 'queued' | 'delivered' } | void> {");
fs.writeFileSync('src/providers/spec/cli-adapter.ts', spec);
