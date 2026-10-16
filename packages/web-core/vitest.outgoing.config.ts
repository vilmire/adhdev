import { defineConfig } from 'vitest/config'
import base from './vitest.responsive.config'
import { outgoingContractFixture } from '../daemon-core/test/helpers/outgoing-contract-fixture'
const fixtures = new Map<string, ReturnType<typeof outgoingContractFixture>>()
export default defineConfig({
    ...base,
    test: { ...base.test,
        include: ['test-browser/components/outgoing-contract.browser.test.tsx'],
        browser: { ...base.test?.browser,
            commands: {
                outgoingContract: async (_context, request: any) => {
                    if (request.action === 'init') {
                        const fixture = outgoingContractFixture(request.sessionId, request.confirmed !== false)
                        if (request.immediate) fixture.idle()
                        if (request.authorized) fixture.authorizeAction()
                        fixtures.set(request.sessionId, fixture)
                        return {}
                    }
                    const f = fixtures.get(request.sessionId)!
                    if (request.action === 'submit') {
                        return f.submitHandler(request.message)
                    }
                    if (request.action === 'authorize') { f.authorizeAction(); return {} }
                    if (request.action === 'drain') {
                        f.drain()
                        const deadline = Date.now() + 3000
                        while (f.writes.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
                    }
                    if (request.action === 'ack') { f.acknowledge(); await new Promise(r => setTimeout(r, 0)) }
                    if (request.action === 'restart') f.restartService()
                    if (request.action === 'close') { f.close(); fixtures.delete(request.sessionId); return {} }
                    return { receipts: f.receipts(request.ids || []), messages: f.wire(true), writes: f.writes.length }
                },
            },
        },
    },
})
