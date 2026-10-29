import { afterAll, beforeAll } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'

// Quote generated script paths independently of shell metacharacters or spaces.
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"

let endpointFile: string
let transportLogFile: string
// Record only operation names, never URL/userinfo or payloads.
export const syntheticPushTransportCalls = () => readFileSync(transportLogFile, 'utf8')
const endpoints: Array<{ cwd: string; url: string; local: string }> = []
export function bindPushDestination(repo: string, local: string, key = 'oss', remote = 'origin', url?: string) {
  const name = { root: 'adhdev-cloud', oss: 'adhdev', 'adhdev-providers': 'adhdev-providers', 'homebrew-adhdev': 'homebrew-adhdev' }[key]
  const destination = url || `https://github.com/vilmire/${name}.git`
  const cwd = realpathSync(repo)
  for (let i = endpoints.length - 1; i >= 0; i--) if (endpoints[i].cwd === cwd && endpoints[i].url === destination) endpoints.splice(i, 1)
  endpoints.push({ cwd, url: destination, local })
  writeFileSync(endpointFile, JSON.stringify(endpoints))
  execFileSync('git', ['-C', repo, 'config', `remote.${remote}.pushurl`, destination])
  return destination
}

/** Committed synthetic patterns pinned out of band; no real private data. */
export function useSyntheticPublicPushPatterns(repositories?: Record<string, 'public' | 'private'>) {
  let root: string
  const previous = { root: process.env.ADHDEV_PRIVATE_ROOT, digest: process.env.ADHDEV_PUBLIC_PUSH_PATTERNS_SHA256, path: process.env.PATH }
  beforeAll(() => {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    root = mkdtempSync(join(tmpdir(), 'synthetic-pattern-root-'))
    execFileSync(realGit, ['init', '-q', root])
    execFileSync(realGit, ['-C', root, 'remote', 'add', 'origin', 'https://github.com/vilmire/adhdev-cloud.git'])
    mkdirSync(join(root, '.adhdev'))
    const blob = JSON.stringify({ ownerNames: ['fixture-owner'], knownHosts: ['FixtureHostZ', 'FleetFixtureZ'], blockedText: ['synthetic-private-token'], ...(repositories ? { repositories } : {}) })
    writeFileSync(join(root, '.adhdev/public-push-patterns.json'), blob)
    execFileSync(realGit, ['-C', root, 'add', '.adhdev'])
    execFileSync(realGit, ['-C', root, 'commit', '-qm', 'Synthetic pattern fixture'], { env: { ...process.env, GIT_AUTHOR_NAME: 'vilmire', GIT_AUTHOR_EMAIL: 'vilmire@users.noreply.github.com', GIT_COMMITTER_NAME: 'vilmire', GIT_COMMITTER_EMAIL: 'vilmire@users.noreply.github.com' } })
    process.env.ADHDEV_PRIVATE_ROOT = root
    process.env.ADHDEV_PUBLIC_PUSH_PATTERNS_SHA256 = createHash('sha256').update(blob).digest('hex')
    endpointFile = join(root, 'endpoints.json'); writeFileSync(endpointFile, '[]')
    transportLogFile = join(root, 'transport.log'); writeFileSync(transportLogFile, '')
    // Test-only transport: URLs/config and guard decisions stay real. Only the
    // network operation is served by local bare Git repositories, never GitHub.
    const shim = `#!${process.execPath}
const {spawnSync,execFileSync}=require('node:child_process');
const fs=require('node:fs'); const path=require('node:path');
const real=${JSON.stringify(realGit)}, args=process.argv.slice(2);
let cwd=process.cwd(); for(let i=0;i<args.length;i++) if(args[i]==='-C') cwd=path.resolve(cwd,args[++i]);
try { cwd=fs.realpathSync(cwd); } catch {}
const records=JSON.parse(fs.readFileSync(${JSON.stringify(endpointFile)},'utf8')).filter(e=>e.cwd===cwd);
const net=args.find(a=>['push','fetch','ls-remote','clone'].includes(a));
if(net && !args.includes('--get-url')) {
 fs.appendFileSync(${JSON.stringify(transportLogFile)},net+'\\n');
 const i=args.indexOf(net); let candidates=args.slice(i+1).filter(a=>/^(https?|ssh|git):\\/\\//.test(a)||/^[^/]+@[^:]+:/.test(a));
 if(!candidates.length) {
  const tail=args.slice(i+1).filter(a=>!a.startsWith('-')); const remote=tail[0]||'origin';
  try { candidates=execFileSync(real,['-C',cwd,'remote','get-url',...(net==='push'?['--push']:[]),'--all',remote],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split('\\n'); } catch {}
 }
 for(const url of candidates) if(/^(https?|ssh|git):\\/\\//.test(url)&&!records.some(e=>e.url===url)) { process.stderr.write('Unmapped synthetic network destination refused\\n'); process.exit(1); }
 for(const e of records) args.unshift('-c','url.'+e.local+'.insteadOf='+e.url);
 args.unshift('-c','protocol.file.allow=always');
}
const result=spawnSync(real,args,{stdio:'inherit',env:process.env});
if(result.error) throw result.error; process.exit(result.status??1);
`
    const networkShim = join(root, 'git-network.cjs')
    writeFileSync(networkShim, shim, { mode: 0o755 })
    // Local Git must not pay for a Node startup, map read and extra child on
    // every object/config lookup. Preserve the original network interception.
    const dispatcher = process.platform === 'win32' ? shim : `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    push|fetch|ls-remote|clone) exec ${shellQuote(process.execPath)} ${shellQuote(networkShim)} "$@" ;;
  esac
done
exec ${shellQuote(realGit)} "$@"
`
    writeFileSync(join(root, 'git'), dispatcher, { mode: 0o755 })
    process.env.PATH = root + delimiter + previous.path
  })
  afterAll(() => {
    for (const [key, value] of Object.entries({ ADHDEV_PRIVATE_ROOT: previous.root, ADHDEV_PUBLIC_PUSH_PATTERNS_SHA256: previous.digest, PATH: previous.path })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    endpoints.length = 0
    rmSync(root, { recursive: true, force: true })
  })
}
