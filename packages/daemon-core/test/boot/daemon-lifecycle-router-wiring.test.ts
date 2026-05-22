import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('daemon lifecycle command router wiring', () => {
  it('passes mesh P2P command dispatch into DaemonCommandRouter for browser-facing mesh_status truth', () => {
    const source = readFileSync(join(process.cwd(), 'src/boot/daemon-lifecycle.ts'), 'utf-8')
    const routerConstruction = source.match(/const router = new DaemonCommandRouter\(\{([\s\S]*?)\n    \}\);/)

    expect(routerConstruction?.[1]).toContain('getMeshPeerConnectionStatus: config.getMeshPeerConnectionStatus')
    expect(routerConstruction?.[1]).toContain('dispatchMeshCommand: config.dispatchMeshCommand')
  })
})
