import { describe, expect, it } from 'vitest'

import {
    LAUNCH_CATEGORY_LABELS,
    type LaunchCategoryKind,
} from '../../../src/components/dashboard/launch-category-labels'

describe('LaunchCategorySelector category chip labels', () => {
    it('labels the three launch categories CLI / IDE / ACP', () => {
        // The new-session dialog builds one Category chip per kind from this map,
        // in [cli, ide, acp] order.
        const kinds: LaunchCategoryKind[] = ['cli', 'ide', 'acp']
        expect(kinds.map(kind => LAUNCH_CATEGORY_LABELS[kind])).toEqual(['CLI', 'IDE', 'ACP'])
    })

    it('labels the ide category "IDE", not the mislabelled "Workspace"', () => {
        // Regression: the 'ide' category chip must not reuse the unrelated
        // workspace/mesh launch-mode label (that collision was the bug).
        expect(LAUNCH_CATEGORY_LABELS.ide).toBe('IDE')
        expect(Object.values(LAUNCH_CATEGORY_LABELS)).not.toContain('Workspace')
    })
})
