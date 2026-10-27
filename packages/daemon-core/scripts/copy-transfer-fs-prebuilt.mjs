#!/usr/bin/env node
// Copies the committed transfer-fs native prebuilts (and nothing else) into <destDir>/prebuilt so a
// bundled daemon (daemon-cloud / daemon-standalone) finds them next to its dist. Usage:
//   node copy-transfer-fs-prebuilt.mjs <destDir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../src/transfer-fs/native/prebuilt');
const dest = path.resolve(process.argv[2] ?? '', 'prebuilt');
if (!process.argv[2]) throw new Error('usage: copy-transfer-fs-prebuilt.mjs <destDir>');
if (!fs.existsSync(src)) throw new Error(`transfer-fs prebuilt dir missing: ${src}`);
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const count = fs.readdirSync(dest).filter((d) => fs.existsSync(path.join(dest, d, 'transfer_fs_node.node'))).length;
if (count === 0) throw new Error('no transfer_fs_node.node copied');
console.log(`[transfer-fs] copied ${count} prebuilt triplet(s) -> ${dest}`);
