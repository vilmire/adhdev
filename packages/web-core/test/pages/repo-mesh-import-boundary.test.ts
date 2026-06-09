import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('RepoMesh import boundaries', () => {
  it('does not self-import the @adhdev/web-core package barrel from inside web-core', () => {
    const source = readSource('pages/RepoMesh.tsx')

    expect(source).not.toContain("from '@adhdev/web-core'")
    expect(source).not.toContain("from '../utils/mesh-visualization'")
  })

  it('standalone context imports extractRepoMeshStatus directly from repo-mesh-status (not from barrel)', () => {
    const source = readSource('context/StandaloneRepoMeshProvider.tsx')

    expect(source).toContain("from '../utils/repo-mesh-status'")
    expect(source).not.toContain("from '@adhdev/web-core'")
    expect(source).not.toContain("from '../utils/mesh-visualization'")
  })
})
