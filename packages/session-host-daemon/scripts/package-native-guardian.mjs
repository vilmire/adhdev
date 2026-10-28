/** Explicit offline release preparation, never an install/postinstall compiler. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, realpathSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { resolve, join, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha = b => createHash('sha256').update(b).digest('hex');
function regular(root, name) {
  const file = resolve(root, name);
  if (!name || isAbsolute(name) || relative(root, file).startsWith('..') || realpathSync(file) !== file || !lstatSync(file).isFile()) throw new Error('guardian_package_path_untrusted');
  return file;
}
export function packageNativeGuardian(root, pins) {
  if (process.platform !== 'darwin') throw new Error('guardian_package_platform_unsupported');
  root = realpathSync(root);
  if (pins.platform !== 'darwin' || pins.arch !== process.arch || !/^[a-f0-9]{40}$/.test(pins.commit ?? '') || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pins.version ?? '')) throw new Error('guardian_package_build_identity_required');
  const packageBytes=readFileSync(regular(root,'package.json'));
  if (JSON.parse(String(packageBytes)).version !== pins.version) throw new Error('guardian_package_version_mismatch');
  const manifest = { packageJsonSha256:sha(packageBytes), schema:1, protocol:2, platform:'darwin', arch:process.arch, version:pins.version, commit:pins.commit, files:{} };
  for (const kind of ['daemon','cli','host']) {
    const entry = pins.files?.[kind]; const file = regular(root, entry?.path);
    const bytes = sha(readFileSync(file));
    if (bytes !== entry.sha256) throw new Error(`guardian_package_${kind}_pin_mismatch`);
    manifest.files[kind] = { path:entry.path, sha256:bytes };
  }
  const compiler = '/usr/bin/cc';
  const node = realpathSync(pins.nodePath);
  if (!/^[a-f0-9]{64}$/.test(pins.nodeSha256 ?? '') || sha(readFileSync(node)) !== pins.nodeSha256) throw new Error('guardian_package_node_pin_mismatch');
  manifest.nodeSha256 = pins.nodeSha256;
  const output = join(root, 'worker-native', `darwin-${process.arch}`);
  if (existsSync(output)) throw new Error('guardian_package_output_already_exists');
  const parent=dirname(output);
  if (existsSync(parent) && (lstatSync(parent).isSymbolicLink() || realpathSync(parent)!==parent)) throw new Error('guardian_package_output_symlink');
  mkdirSync(parent,{recursive:true});
  if (realpathSync(parent)!==parent) throw new Error('guardian_package_output_symlink');
  mkdirSync(output);
  if (realpathSync(output) !== output) throw new Error('guardian_package_output_symlink');
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../native/instance-lock.c');
  manifest.compilerSha256 = sha(readFileSync(compiler));
  manifest.sourceSha256 = sha(readFileSync(source));
  const helper = join(output, 'instance-lock');
  execFileSync(compiler, ['-Wall','-Wextra','-Werror',source,'-o',helper], {stdio:'pipe',env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:output}});
  chmodSync(helper, 0o555);
  const attestation = String(execFileSync(helper, ['--attest'], {stdio:'pipe'})).trim();
  if (attestation !== 'adhdev-host-guardian/2') throw new Error('guardian_package_protocol_mismatch');
  manifest.files.helper = { path:relative(root, helper), sha256:sha(readFileSync(helper)) };
  // Recheck intended payload after compilation; never bind a concurrently replaced build.
  for (const kind of ['daemon','cli','host']) if (sha(readFileSync(regular(root, manifest.files[kind].path))) !== manifest.files[kind].sha256) throw new Error('guardian_package_payload_changed');
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(output, 'manifest.json'), json, {flag:'wx',mode:0o444});
  return {manifest, manifestPath:join(output,'manifest.json'), manifestSha256:sha(json)};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, pinFile] = process.argv.slice(2);
  if (!root || !pinFile) throw new Error('usage: package-native-guardian.mjs PACKAGE_ROOT IMMUTABLE_INPUT_PINS_JSON');
  console.log(JSON.stringify(packageNativeGuardian(root, JSON.parse(readFileSync(pinFile,'utf8')))));
}
