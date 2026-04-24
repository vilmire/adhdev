import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('cloud css import boundary', () => {
  it('loads shared design-system css through the web-core package export instead of a monorepo source path', () => {
    const cloudCss = fs.readFileSync(
      path.join(import.meta.dirname, '../../../../../packages/web-cloud/src/index.css'),
      'utf8',
    )

    expect(cloudCss).toContain("@import '@adhdev/web-core/index.css';")
    expect(cloudCss).not.toContain("@import '../../../oss/packages/web-core/src/index.css';")
  })
})
