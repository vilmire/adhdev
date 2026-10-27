import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionHostServer } from '../src/server.js'

// Real unix sockets. A throwaway child of THIS test binds the socket; SIGKILL
// leaves the socket file behind with no listener (the orphan state).
async function bindInChild(sock: string, accept: 'close' | 'silent'): Promise<ChildProcess> {
  const script = `const net=require('net');const s=net.createServer((c)=>{${accept === 'silent' ? "c.on('data',()=>{})" : 'c.end()'}});`
    + `s.listen(process.argv[1],()=>process.stdout.write('ready'));setInterval(()=>{},1e6)`
  const child = spawn(process.execPath, ['-e', script, sock], { stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve())
    child.once('exit', () => reject(new Error('child exited early')))
  })
  return child
}
const kill = (child: ChildProcess) => new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill('SIGKILL') })

function makeServer(dir: string, pid: 'missing' | 'corrupt' | 'dead') {
  const sock = path.join(dir, 'h.sock'), pidFilePath = path.join(dir, 'h.pid')
  if (pid === 'corrupt') fs.writeFileSync(pidFilePath, 'garbage\n')
  if (pid === 'dead') fs.writeFileSync(pidFilePath, '49152\n')
  const server = new SessionHostServer({
    endpoint: { kind: 'unix', path: sock }, instanceConfigDir: dir, pidFilePath,
    storageRootDir: path.join(dir, 'storage'),
    isPidAlive: () => false, getOwnerBirth: () => null, getSocketOwnerPids: () => [],
  })
  return { sock, server: server as any }
}

for (const pid of ['missing', 'corrupt'] as const) {
  test(`${pid} pidfile + orphan socket (no listener) is reclaimed`, { skip: process.platform === 'win32' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orph-srv-'))
    try {
      const { sock, server } = makeServer(dir, pid)
      await kill(await bindInChild(sock, 'close'))
      assert.equal(fs.lstatSync(sock).isSocket(), true)
      await server.evictPriorEndpointOwners()
      assert.equal(fs.existsSync(sock), false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  for (const accept of ['close', 'silent'] as const) {
    test(`${pid} pidfile + live listener (${accept}) is refused and left intact`, { skip: process.platform === 'win32' }, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orph-srv-'))
      let child: ChildProcess | undefined
      try {
        const { sock, server } = makeServer(dir, pid)
        child = await bindInChild(sock, accept)
        await assert.rejects(server.evictPriorEndpointOwners(), /session_host_prior_owner_socket_unverified/)
        assert.equal(fs.existsSync(sock), true)
        assert.equal(child.exitCode, null)
      } finally { child?.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }) }
    })
  }
}

test('regular file at the endpoint with no pid is never unlinked', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orph-srv-'))
  try {
    const { sock, server } = makeServer(dir, 'missing')
    fs.writeFileSync(sock, 'not a socket')
    await assert.rejects(server.evictPriorEndpointOwners(), /session_host_prior_owner_socket_unverified/)
    assert.equal(fs.readFileSync(sock, 'utf8'), 'not a socket')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('dead pidfile path unchanged: orphan socket with empty owners still unlinks', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orph-srv-'))
  try {
    const { sock, server } = makeServer(dir, 'dead')
    await kill(await bindInChild(sock, 'close'))
    await server.evictPriorEndpointOwners()
    assert.equal(fs.existsSync(sock), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
