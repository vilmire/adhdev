import { afterAll, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Private trust root with synthetic patterns only; never read real private data. */
export function useSyntheticPublicPushPatterns() {
  let root: string
  const previous = process.env.ADHDEV_PRIVATE_ROOT
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'synthetic-pattern-root-'))
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/vilmire/adhdev-cloud.git'])
    mkdirSync(join(root, '.adhdev'))
    writeFileSync(join(root, '.adhdev/public-push-patterns.json'), JSON.stringify({
      ownerNames: ['fixture-owner'], knownHosts: ['FixtureHostZ', 'FleetFixtureZ'], blockedText: ['synthetic-private-token'],
    }))
    process.env.ADHDEV_PRIVATE_ROOT = root
  })
  afterAll(() => {
    if (previous === undefined) delete process.env.ADHDEV_PRIVATE_ROOT
    else process.env.ADHDEV_PRIVATE_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  })
}
