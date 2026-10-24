import { afterEach, beforeEach, vi } from 'vitest'

type DiskFixture = 'healthy' | 'critical'
const disk = vi.hoisted(() => ({ fixture: undefined as DiskFixture | undefined }))

// Keep the real preflight, including its classification, logging and refusal.
// Only these importing suites replace the capacity measurement; other fs APIs
// and the dedicated disk-space-preflight tests retain their own fixtures.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    statfsSync: (path: string) => {
      // Force the unconfigured baseline low for the scoped regression command:
      // ADHDEV_TEST_MANAGED_HOST_DISK=critical npx vitest run test/session-host/managed-host
      const fixture = disk.fixture ?? (
        process.env.ADHDEV_TEST_MANAGED_HOST_DISK === 'critical' ? 'critical' : undefined
      )
      if (!fixture) return actual.statfsSync(path)
      const GiB = 1024 ** 3
      const freeBytes = (fixture === 'healthy' ? 20 : 0.5) * GiB
      return {
        bsize: 4096,
        blocks: 100 * GiB / 4096,
        bavail: freeBytes / 4096,
        bfree: freeBytes / 4096,
        files: 0,
        ffree: 0,
        type: 0,
      }
    },
  }
})

export function setManagedHostDisk(fixture: DiskFixture): void {
  disk.fixture = fixture
}

/** Each behavior test gets healthy capacity, even when the baseline is low. */
export function useHealthyManagedHostDisk(): void {
  beforeEach(() => setManagedHostDisk('healthy'))
  afterEach(() => { disk.fixture = undefined })
}
