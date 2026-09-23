import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'
import { readMeshDirectDispatchFlag, withMeshDirectDispatch } from '../../src/commands/command-args.js'

// D-prep: the `_meshDirectDispatch` forwarding-loop guard has ONE reader
// (readMeshDirectDispatchFlag) and ONE writer (withMeshDirectDispatch), both
// in commands/command-args.ts. A hand-written `_meshDirectDispatch: true`
// literal or an inline `args?._meshDirectDispatch` read elsewhere is the
// untyped drift this closes (9 read sites + 10 write sites before).

const here = dirname(fileURLToPath(import.meta.url))
const daemonCoreSrc = join(here, '../../src')
const cloudSrc = join(here, '../../../../../packages/daemon-cloud/src')

function tsFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) out.push(...tsFiles(path))
        else if (name.endsWith('.ts')) out.push(path)
    }
    return out
}

describe('_meshDirectDispatch — one reader, one writer', () => {
    it('the writer copies args, applies extra, sets the flag; the reader recognises exactly that', () => {
        const args = { cmd: 'x', meshId: 'm1' }
        const forwarded = withMeshDirectDispatch(args, { workspace: '/w' })
        expect(forwarded).toEqual({ cmd: 'x', meshId: 'm1', workspace: '/w', _meshDirectDispatch: true })
        expect(args).toEqual({ cmd: 'x', meshId: 'm1' })
        expect(readMeshDirectDispatchFlag(forwarded)).toBe(true)
        expect(readMeshDirectDispatchFlag(args)).toBe(false)
        expect(withMeshDirectDispatch(null)).toEqual({ _meshDirectDispatch: true })
        expect(readMeshDirectDispatchFlag({ _meshDirectDispatch: 'true' })).toBe(false)
    })

    it('no source outside command-args.ts writes the literal or reads the field inline (daemon-core + cloud)', () => {
        const files = [...tsFiles(daemonCoreSrc), ...tsFiles(cloudSrc)]
        expect(files.length).toBeGreaterThan(500)
        const offenders: string[] = []
        for (const file of files) {
            if (file.endsWith(join('commands', 'command-args.ts'))) continue
            const lines = readFileSync(file, 'utf8').split('\n')
            lines.forEach((line, i) => {
                const code = line.replace(/\/\/.*$/, '')
                if (/_meshDirectDispatch\s*:\s*true/.test(code) || /\?\.\s*_meshDirectDispatch\b|\._meshDirectDispatch\b/.test(code)) {
                    offenders.push(`${relative(join(here, '../../../../..'), file)}:${i + 1}`)
                }
            })
        }
        expect(offenders).toEqual([])
    })
})
