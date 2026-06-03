#!/usr/bin/env node
import { validateCliProviderManifest, formatManifestValidationIssues } from '../packages/daemon-core/dist/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const providers = ['claude-cli', 'codex-cli', 'antigravity-cli', 'hermes-cli'];
let failed = 0;
for (const p of providers) {
    const f = path.join('..', 'adhdev-providers', 'cli', p, 'provider.v1.json');
    if (!fs.existsSync(f)) { console.log(`${p}: no manifest`); continue; }
    const m = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const r = validateCliProviderManifest(m);
    if (r.ok) console.log(`✓ ${p}: schema-valid`);
    else {
        console.log(`✗ ${p}: ${r.issues.length} issues`);
        console.log(formatManifestValidationIssues(r.issues));
        failed++;
    }
}

console.log('---bad manifest test---');
const bad = { type: 'INVALID_CASE', name: 'Bad', category: 'cli', binary: 'x', spawn: { command: 'x' }, extraGarbage: true };
const rb = validateCliProviderManifest(bad);
console.log('ok:', rb.ok);
if (!rb.ok) console.log(formatManifestValidationIssues(rb.issues));

process.exit(failed > 0 ? 1 : 0);
