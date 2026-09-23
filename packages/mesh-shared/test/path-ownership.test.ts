import { describe, expect, it } from 'vitest'
import {
    MAX_OWNED_PATHS,
    findOwnershipConflicts,
    normalizeOwnedPaths,
    pathsOverlap,
    touchedFilesOutsideOwnership,
    type OwnedPathsDeclaration,
} from '../src/path-ownership'

function decl(paths: string[]): OwnedPathsDeclaration {
    return normalizeOwnedPaths(paths).declaration
}

describe('normalizeOwnedPaths', () => {
    it('normalizes plain repo-relative paths and strips a leading ./', () => {
        const { declaration, rejected } = normalizeOwnedPaths(['src/foo.ts', './src/bar.ts'])
        expect(declaration.paths).toEqual([
            { path: 'src/foo.ts', subtree: false },
            { path: 'src/bar.ts', subtree: false },
        ])
        expect(rejected).toEqual([])
    })

    it('normalizes win32-style backslash separators to forward slashes', () => {
        const { declaration, rejected } = normalizeOwnedPaths(['src\\mesh\\foo.ts', 'src\\mesh\\**'])
        expect(declaration.paths).toEqual([
            { path: 'src/mesh/foo.ts', subtree: false },
            { path: 'src/mesh', subtree: true },
        ])
        expect(rejected).toEqual([])
    })

    it('treats a trailing /** as a subtree declaration', () => {
        const { declaration } = normalizeOwnedPaths(['src/mesh/**'])
        expect(declaration.paths).toEqual([{ path: 'src/mesh', subtree: true }])
    })

    it('treats a bare directory (no /**) as an exact single-path entry, not a subtree', () => {
        const { declaration } = normalizeOwnedPaths(['src/mesh'])
        expect(declaration.paths).toEqual([{ path: 'src/mesh', subtree: false }])
    })

    it('rejects absolute POSIX paths', () => {
        const { declaration, rejected } = normalizeOwnedPaths(['/etc/passwd'])
        expect(declaration.paths).toEqual([])
        expect(rejected).toEqual([{ input: '/etc/passwd', reason: 'absolute_path' }])
    })

    it('rejects absolute Windows paths (drive letter, both slash styles)', () => {
        const { declaration, rejected } = normalizeOwnedPaths(['C:\\Users\\x\\repo\\src', 'D:/repo/src'])
        expect(declaration.paths).toEqual([])
        expect(rejected.map(r => r.reason)).toEqual(['absolute_path', 'absolute_path'])
    })

    it('rejects a leading ~ (home-relative)', () => {
        const { declaration, rejected } = normalizeOwnedPaths(['~/repo/src'])
        expect(declaration.paths).toEqual([])
        expect(rejected).toEqual([{ input: '~/repo/src', reason: 'absolute_path' }])
    })

    it('rejects any .. segment (no repo escape)', () => {
        const { declaration, rejected } = normalizeOwnedPaths(['../outside', 'src/../../escape'])
        expect(declaration.paths).toEqual([])
        expect(rejected.map(r => r.reason)).toEqual(['parent_traversal', 'parent_traversal'])
    })

    it('rejects unsupported mid-segment glob wildcards (* and ?)', () => {
        const { declaration, rejected } = normalizeOwnedPaths(['src/*.ts', 'src/fi?e.ts'])
        expect(declaration.paths).toEqual([])
        expect(rejected.map(r => r.reason)).toEqual(['unsupported_glob', 'unsupported_glob'])
    })

    it('rejects empty and non-string entries', () => {
        const { declaration, rejected } = normalizeOwnedPaths(['', '   ', 42, null])
        expect(declaration.paths).toEqual([])
        expect(rejected.map(r => r.reason).sort()).toEqual(['empty', 'empty', 'not_a_string', 'not_a_string'])
    })

    it('returns an empty declaration (no rejects) for undefined/null input', () => {
        expect(normalizeOwnedPaths(undefined)).toEqual({ declaration: { paths: [] }, rejected: [] })
        expect(normalizeOwnedPaths(null)).toEqual({ declaration: { paths: [] }, rejected: [] })
    })

    it('rejects a non-array input wholesale', () => {
        const { declaration, rejected } = normalizeOwnedPaths('src/foo.ts')
        expect(declaration.paths).toEqual([])
        expect(rejected).toEqual([{ input: 'src/foo.ts', reason: 'not_an_array' }])
    })

    it('dedups identical entries and upgrades exact-to-subtree on duplicate path', () => {
        const { declaration } = normalizeOwnedPaths(['src/mesh', 'src/mesh/**', 'src/mesh'])
        expect(declaration.paths).toEqual([{ path: 'src/mesh', subtree: true }])
    })

    it('caps at MAX_OWNED_PATHS and reports the overflow as rejected', () => {
        const many = Array.from({ length: MAX_OWNED_PATHS + 5 }, (_, i) => `src/file${i}.ts`)
        const { declaration, rejected } = normalizeOwnedPaths(many)
        expect(declaration.paths.length).toBe(MAX_OWNED_PATHS)
        expect(rejected.filter(r => r.reason === 'over_cap').length).toBe(5)
    })
})

describe('pathsOverlap', () => {
    it('is false when either side is empty (opt-in only)', () => {
        expect(pathsOverlap(decl([]), decl(['src/foo.ts']))).toBe(false)
        expect(pathsOverlap(decl(['src/foo.ts']), decl([]))).toBe(false)
        expect(pathsOverlap(decl([]), decl([]))).toBe(false)
    })

    it('is true for an exact path match', () => {
        expect(pathsOverlap(decl(['src/foo.ts']), decl(['src/foo.ts']))).toBe(true)
    })

    it('is false for disjoint exact paths', () => {
        expect(pathsOverlap(decl(['src/foo.ts']), decl(['src/bar.ts']))).toBe(false)
    })

    it('is true when a subtree declaration contains the other exact path', () => {
        expect(pathsOverlap(decl(['src/mesh/**']), decl(['src/mesh/foo.ts']))).toBe(true)
        expect(pathsOverlap(decl(['src/mesh/foo.ts']), decl(['src/mesh/**']))).toBe(true)
    })

    it('is false when a bare directory (no **) does not overlap a file nested under it', () => {
        // 'src/mesh' with no /** owns only the literal node named src/mesh, not its contents.
        expect(pathsOverlap(decl(['src/mesh']), decl(['src/mesh/foo.ts']))).toBe(false)
    })

    it('is true when two subtree declarations nest one inside the other', () => {
        expect(pathsOverlap(decl(['src/**']), decl(['src/mesh/**']))).toBe(true)
    })

    it('is false for sibling directories, even both declared as subtrees', () => {
        expect(pathsOverlap(decl(['src/mesh/**']), decl(['src/web/**']))).toBe(false)
    })

    it('does not false-positive on a path that merely shares a string prefix without a separator boundary', () => {
        // 'src/mesh' as a subtree must not "contain" 'src/mesh-other/foo.ts'.
        expect(pathsOverlap(decl(['src/mesh/**']), decl(['src/mesh-other/foo.ts']))).toBe(false)
    })
})

describe('findOwnershipConflicts', () => {
    it('returns no conflicts when the candidate declaration is empty', () => {
        expect(findOwnershipConflicts(decl([]), [{ taskId: 't1', paths: decl(['src/foo.ts']) }])).toEqual([])
    })

    it('ignores in-flight entries with an empty declaration', () => {
        expect(findOwnershipConflicts(decl(['src/foo.ts']), [{ taskId: 't1', paths: decl([]) }])).toEqual([])
    })

    it('names the owning task id and the overlapping path for a single conflict', () => {
        const conflicts = findOwnershipConflicts(decl(['src/foo.ts']), [
            { taskId: 't1', paths: decl(['src/foo.ts']) },
        ])
        expect(conflicts).toEqual([{ taskId: 't1', overlappingPaths: ['src/foo.ts'] }])
    })

    it('reports every conflicting in-flight task, not just the first', () => {
        const conflicts = findOwnershipConflicts(decl(['src/mesh/**']), [
            { taskId: 't1', paths: decl(['src/mesh/foo.ts']) },
            { taskId: 't2', paths: decl(['src/other.ts']) },
            { taskId: 't3', paths: decl(['src/mesh/bar.ts']) },
        ])
        expect(conflicts.map(c => c.taskId)).toEqual(['t1', 't3'])
    })

    it('non-overlapping declarations on the same node produce zero conflicts', () => {
        const conflicts = findOwnershipConflicts(decl(['src/a.ts']), [
            { taskId: 't1', paths: decl(['src/b.ts']) },
        ])
        expect(conflicts).toEqual([])
    })
})

describe('touchedFilesOutsideOwnership', () => {
    it('reports no undeclared touches when every touched file matches the declaration', () => {
        const result = touchedFilesOutsideOwnership(['src/foo.ts', 'src/mesh/bar.ts'], decl(['src/foo.ts', 'src/mesh/**']))
        expect(result.undeclaredTouched).toEqual([])
    })

    it('reports a touched file outside every declared entry', () => {
        const result = touchedFilesOutsideOwnership(['src/foo.ts', 'src/unrelated.ts'], decl(['src/foo.ts']))
        expect(result.undeclaredTouched).toEqual(['src/unrelated.ts'])
    })

    it('treats an unparseable touched-file entry (e.g. absolute path) as undeclared rather than dropping it', () => {
        const result = touchedFilesOutsideOwnership(['/abs/outside.ts'], decl(['src/foo.ts']))
        expect(result.undeclaredTouched).toEqual(['/abs/outside.ts'])
    })

    it('lists declared entries that no touched file matched as unusedDeclarations, informational only', () => {
        const result = touchedFilesOutsideOwnership(['src/foo.ts'], decl(['src/foo.ts', 'src/bar.ts']))
        expect(result.undeclaredTouched).toEqual([])
        expect(result.unusedDeclarations).toEqual(['src/bar.ts'])
    })

    it('empty declaration means everything touched is undeclared (opt-in only — no ownership means no coverage)', () => {
        const result = touchedFilesOutsideOwnership(['src/foo.ts'], decl([]))
        expect(result.undeclaredTouched).toEqual(['src/foo.ts'])
    })

    it('empty touched list against a real declaration reports nothing undeclared', () => {
        const result = touchedFilesOutsideOwnership([], decl(['src/foo.ts']))
        expect(result.undeclaredTouched).toEqual([])
        expect(result.unusedDeclarations).toEqual(['src/foo.ts'])
    })
})
