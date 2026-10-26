import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'adhdev-session-host-test-'));
process.env.ADHDEV_CONFIG_DIR = root;
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
