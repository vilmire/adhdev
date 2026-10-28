import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { sweepTempManifest } from '../../../../scripts/test-tmp-guard.mjs'

// The run-level sweep deletes paths read from a file, so it must refuse anything
// that is not a direct, non-symlink, randomised-name child of the temp dir.
describe('tmp guard manifest sweep safety', () => {
  it('removes a legit entry but skips outside-tmp, symlink, non-random and relative lines', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tmpguard-sweep-'))
    const outside = fs.mkdtempSync(path.join(work, 'outside-'))   // not a direct child of tmpdir
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'tmpguard-victim-'))
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'x')
    const link = path.join(os.tmpdir(), `tmpguard-link-${process.pid}${Date.now() % 100000}`)
    fs.symlinkSync(victim, link)
    const plain = path.join(os.tmpdir(), 'tmpguard-plain')          // shared-name shape
    fs.mkdirSync(plain, { recursive: true })
    const legit = fs.mkdtempSync(path.join(os.tmpdir(), 'tmpguard-legit-'))
    const manifest = path.join(work, 'm.list')
    fs.writeFileSync(manifest, [outside, link, plain, 'relative-dir-abc123', legit].join('\n') + '\n')
    try {
      expect(sweepTempManifest(manifest)).toBe(1)
      expect(fs.existsSync(legit)).toBe(false)
      expect(fs.existsSync(outside)).toBe(true)
      expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true)
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
      expect(fs.existsSync(plain)).toBe(true)
      expect(fs.existsSync(manifest)).toBe(false)
    } finally {
      fs.rmSync(link, { force: true })
      fs.rmSync(plain, { recursive: true, force: true })
      fs.rmSync(victim, { recursive: true, force: true })
      fs.rmSync(work, { recursive: true, force: true })
    }
  })

  it('refuses a symlinked manifest', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tmpguard-sweep-'))
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'tmpguard-target-'))
    const real = path.join(work, 'real.list')
    fs.writeFileSync(real, target + '\n')
    const m = path.join(work, 'link.list')
    fs.symlinkSync(real, m)
    try {
      expect(sweepTempManifest(m)).toBe(0)
      expect(fs.existsSync(target)).toBe(true)
    } finally {
      fs.rmSync(target, { recursive: true, force: true })
      fs.rmSync(work, { recursive: true, force: true })
    }
  })
})
