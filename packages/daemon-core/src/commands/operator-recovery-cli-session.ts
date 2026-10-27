import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isNondelegatedLocalOwnerIngress, issueTrustedOwnerIngressProof, applyRouterCommandIngressProvenance } from './command-args.js';

/** A verified owner explicitly delegates ONE exact local recovery exchange to
 * their CLI. This is neither the normal daemon IPC nor a stored owner token. */
export async function createRecoveryCliSession(ownerArgs: unknown,
    dispatch: (args: Record<string, unknown>) => Promise<unknown>, verifyEpoch: () => boolean) {
    const current = () => isNondelegatedLocalOwnerIngress(ownerArgs) && verifyEpoch();
    if (!current()) throw new Error('recovery_nondelegated_local_owner_required');
    const token = randomBytes(32).toString('hex');
    const deadline = performance.now() + 30_000;
    let uses = 0;
    let revoked = false;
    const server = createServer(async (req, res) => {
        const refuse = (status: number) => { res.writeHead(status); res.end(JSON.stringify({ success: false, code: 'operator_recovery_refused' })); };
        let valid = false;
        try { valid = !revoked && current() && performance.now() < deadline; } catch { /* fail closed */ }
        if (!valid) { revoked = true; refuse(403); return; }
        if (req.method !== 'POST' || req.url !== '/api/v1/command' || req.headers.origin || req.headers['x-adhdev-mcp']) { refuse(403); return; }
        const raw = req.headers.cookie;
        const expected = `adhdev_operator_recovery=${token}`;
        if (typeof raw !== 'string' || Buffer.byteLength(raw) !== Buffer.byteLength(expected) ||
            !timingSafeEqual(Buffer.from(raw), Buffer.from(expected))) { refuse(401); return; }
        if (uses >= 2) { refuse(403); return; }
        // Reserve synchronously; concurrent bodies cannot reuse the budget.
        uses++;
        try {
            const chunks: Buffer[] = []; let bytes = 0;
            for await (const chunk of req) {
                const b = Buffer.from(chunk); bytes += b.length;
                if (bytes > 16_384) throw new Error('recovery_cli_body_limit');
                chunks.push(b);
            }
            if (!current() || performance.now() >= deadline) throw new Error('recovery_cli_revoked');
            const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (command.type !== 'operator_recovery' || !command.payload || typeof command.payload !== 'object' ||
                Array.isArray(command.payload) || !['enroll','execute','fence','revoke'].includes(command.payload.action)) {
                throw new Error('recovery_cli_exact_operation_required');
            }
            // This dedicated operation capability expires with its original
            // owner channel AND loopback lease, including in-flight queries.
            const scoped = issueTrustedOwnerIngressProof({ source: 'standalone', ownerVerified: true,
                nondelegatedLocalOwner: true,
                verifyCurrent: () => !revoked && current() && performance.now() < deadline });
            if (!scoped) throw new Error('recovery_cli_revoked');
            const args = command.payload;
            applyRouterCommandIngressProvenance({}, args, 'standalone', undefined, { ownerProof: scoped }, false, 'operator_recovery');
            const result = await dispatch(args);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(result));
        } catch { refuse(403); }
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1000;
    const timer = setTimeout(() => { revoked = true; server.close(); server.closeAllConnections(); }, 30_000);
    timer.unref();
    server.unref();
    try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const address = server.address();
        if (!address || typeof address === 'string' || !current()) throw new Error('recovery_cli_owner_or_listener_unavailable');
        return { url: `http://127.0.0.1:${address.port}`, cookie: `adhdev_operator_recovery=${token}`, expiresInMs: 30_000, maxRequests: 2 };
    } catch (error) { clearTimeout(timer); revoked = true; server.close(); throw error; }
}
