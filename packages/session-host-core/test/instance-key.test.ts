import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  canonicalizeInstancePath,
  isDefaultInstanceConfigDir,
  resolveInstanceConfigDir,
  resolveSessionHostIpcKey,
} from '../src/instance-key.js'
import { getDefaultSessionHostEndpoint } from '../src/ipc.js'

const IPC_KEY_RE = /^[0-9a-f]{12}$/

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-instance-key-'))
}

test('resolveInstanceConfigDir honors ADHDEV_CONFIG_DIR, trims, and falls back to <home>/.adhdev', () => {
  const home = path.join(makeTempRoot(), 'home')
  assert.equal(resolveInstanceConfigDir({}, home), path.join(home, '.adhdev'))
  assert.equal(resolveInstanceConfigDir({ ADHDEV_CONFIG_DIR: '   ' }, home), path.join(home, '.adhdev'))
  assert.equal(
    resolveInstanceConfigDir({ ADHDEV_CONFIG_DIR: '  /x/.adhdev-preview  ' }, home),
    '/x/.adhdev-preview',
  )
})

test('default instance: empty ipc key and legacy byte-identical endpoints', () => {
  const home = makeTempRoot()
  const configDir = path.join(home, '.adhdev')
  assert.equal(resolveSessionHostIpcKey(configDir, home), '')
  // Explicit override pointing AT the default dir must still be "default".
  assert.equal(isDefaultInstanceConfigDir(configDir + path.sep, home), true)

  const posix = getDefaultSessionHostEndpoint('adhdev', { ipcKey: '', platform: 'linux' })
  assert.deepEqual(posix, {
    kind: 'unix',
    path: path.join(os.tmpdir(), 'adhdev-session-host.sock'),
  })
  const win = getDefaultSessionHostEndpoint('adhdev', { ipcKey: '', platform: 'win32' })
  assert.deepEqual(win, { kind: 'pipe', path: '\\\\.\\pipe\\adhdev-session-host' })
})

test('non-default instances: stable 12-hex key, suffixed endpoints, disjoint between instances', () => {
  const home = makeTempRoot()
  const stableKey = resolveSessionHostIpcKey(path.join(home, '.adhdev'), home)
  const previewKey = resolveSessionHostIpcKey(path.join(home, '.adhdev-preview'), home)
  const customKey = resolveSessionHostIpcKey(path.join(home, 'custom-dir'), home)

  assert.equal(stableKey, '')
  assert.match(previewKey, IPC_KEY_RE)
  assert.match(customKey, IPC_KEY_RE)
  assert.notEqual(previewKey, customKey)

  // Deterministic: same dir → same key across calls.
  assert.equal(resolveSessionHostIpcKey(path.join(home, '.adhdev-preview'), home), previewKey)

  const previewEndpoint = getDefaultSessionHostEndpoint('adhdev-preview', { ipcKey: previewKey, platform: 'linux' })
  const customEndpoint = getDefaultSessionHostEndpoint('adhdev-preview', { ipcKey: customKey, platform: 'linux' })
  const defaultEndpoint = getDefaultSessionHostEndpoint('adhdev-preview', { ipcKey: '', platform: 'linux' })
  assert.equal(
    previewEndpoint.path,
    path.join(os.tmpdir(), `adhdev-preview-session-host-${previewKey}.sock`),
  )
  assert.notEqual(previewEndpoint.path, customEndpoint.path)
  assert.notEqual(previewEndpoint.path, defaultEndpoint.path)

  const winEndpoint = getDefaultSessionHostEndpoint('adhdev-preview', { ipcKey: previewKey, platform: 'win32' })
  assert.equal(winEndpoint.path, `\\\\.\\pipe\\adhdev-preview-session-host-${previewKey}`)
})

test('canonicalization: symlink / trailing slash / dot-segment spellings of one dir share a key', () => {
  const root = makeTempRoot()
  const home = path.join(root, 'home')
  const realDir = path.join(home, '.adhdev-preview')
  fs.mkdirSync(realDir, { recursive: true })
  const linkDir = path.join(root, 'preview-link')
  fs.symlinkSync(realDir, linkDir)

  const base = resolveSessionHostIpcKey(realDir, home)
  assert.equal(resolveSessionHostIpcKey(realDir + path.sep, home), base)
  assert.equal(resolveSessionHostIpcKey(path.join(home, 'x', '..', '.adhdev-preview'), home), base)
  assert.equal(resolveSessionHostIpcKey(linkDir, home), base)
})

test('longest-existing-prefix realpath: key is identical before and after the dir is created', () => {
  // macOS /tmp is itself a symlink (/var → /private/var): a naive
  // realpath-or-raw scheme flips the key once the leaf exists. The
  // longest-existing-prefix walk must keep it stable either way.
  const root = makeTempRoot()
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const missing = path.join(home, '.adhdev-preview')
  const beforeKey = resolveSessionHostIpcKey(missing, home)
  fs.mkdirSync(missing)
  const afterKey = resolveSessionHostIpcKey(missing, home)
  assert.equal(beforeKey, afterKey)
  assert.match(beforeKey, IPC_KEY_RE)
})

test('canonicalizeInstancePath case-folds only on win32', () => {
  const root = makeTempRoot()
  const mixed = path.join(root, 'AbCdEf')
  const posix = canonicalizeInstancePath(mixed, 'linux')
  assert.ok(posix.endsWith('AbCdEf'))
  const win = canonicalizeInstancePath(mixed, 'win32')
  assert.equal(win, win.toLowerCase())
})

test('getDefaultSessionHostEndpoint fails closed on a malformed ipcKey', () => {
  assert.throws(() => getDefaultSessionHostEndpoint('adhdev', { ipcKey: 'not-a-key' }), /Invalid session-host ipcKey/)
  assert.throws(() => getDefaultSessionHostEndpoint('adhdev', { ipcKey: 'abcdef' }), /Invalid session-host ipcKey/)
})
