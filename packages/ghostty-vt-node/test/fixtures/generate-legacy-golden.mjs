#!/usr/bin/env node
// Regenerates legacy-golden.json from whatever binary index.js loads. Point it
// at the binary whose output is the reference, e.g.
//   ADHDEV_GHOSTTY_VT_PREBUILT_DIR=/path/to/old/prebuilt node test/fixtures/generate-legacy-golden.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEGACY_CASES, runLegacyCase } from './legacy-cases.mjs';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const binding = createRequire(import.meta.url)(join(fixtureDir, '..', '..', 'index.js'));
const golden = {
    generatedBy: `api level ${binding.bindingInfo?.apiLevel ?? 1}, ${process.platform}-${process.arch}, node ${process.version}`,
    cases: Object.fromEntries(LEGACY_CASES.map((testCase) => [testCase.name, runLegacyCase(binding, testCase)])),
};
writeFileSync(join(fixtureDir, 'legacy-golden.json'), `${JSON.stringify(golden, null, 2)}\n`);
console.log(`wrote ${LEGACY_CASES.length} cases (${golden.generatedBy})`);
