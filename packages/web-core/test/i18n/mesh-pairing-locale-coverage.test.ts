// The "Connect another machine" pairing card shipped with only its inline Korean
// defaults (MESH_PAIRING_COPY) and no `mesh.pairing.*` keys in any catalog, so
// every user — English, Japanese, Chinese, Spanish — saw the card in Korean
// (found 2026-10-28 while documenting self-hosted pairing). Every copy key must
// exist, non-empty, in every supported language.
import { describe, expect, it } from 'vitest'
import { SUPPORTED_LANGUAGES } from '../../src/i18n/languages'
import { MESH_PAIRING_COPY } from '../../src/components/MeshGraph/MeshMachinePairingCard'

const KEYS = Object.keys(MESH_PAIRING_COPY)

async function loadPairing(locale: string): Promise<Record<string, unknown> | undefined> {
    const common = (await import(`../../src/i18n/locales/${locale}/common.json`)).default as {
        mesh?: { pairing?: Record<string, unknown> }
    }
    return common.mesh?.pairing
}

describe('mesh pairing card copy is translated in every supported language', () => {
    for (const locale of SUPPORTED_LANGUAGES) {
        it(`${locale} has every mesh.pairing key`, async () => {
            const pairing = (await loadPairing(locale)) ?? {}
            const missing = KEYS.filter((key) => typeof pairing[key] !== 'string' || (pairing[key] as string).trim() === '')
            expect(missing).toEqual([])
        })
    }

    it('English is not just the Korean default copied over', async () => {
        const en = (await loadPairing('en')) ?? {}
        expect(en.title).not.toBe(MESH_PAIRING_COPY.title)
    })
})
