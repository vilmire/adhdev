const fs = require('fs');
let content = fs.readFileSync('test/cli-adapters/provider-cli-adapter-send-guard.test.ts', 'utf8');

// Replace resolves.toBeUndefined() with resolves.toEqual({ status: 'queued' }) or resolves.toEqual({ status: 'delivered' })
// We can just run it once, see failures, and manually fix the few that need to be delivered.
content = content.replace(/\.resolves\.toBeUndefined\(\)/g, ".resolves.toEqual({ status: 'queued' })");

fs.writeFileSync('test/cli-adapters/provider-cli-adapter-send-guard.test.ts', content);
