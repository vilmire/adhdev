# Daemon new-work hold

The hold uses drain mode A: stop admitting new assignments, let running work
finish, then report `sealed`. Verified owner dashboard chat and coordinator
notices remain available. Mesh tasks spawned by that chat wait in the queue.
A mesh hold requires an explicit matching mesh ID; an absent ID does not widen
its scope. Session input and session-only restart/resume admission derive that ID
from the target instance's worker or coordinator mesh settings.

The default TTL is 30 minutes. Positive set/extend TTLs are clamped to 1 second
through 4 hours; zero, negative and nonfinite values are refused. The daemon's
S8 lifecycle loop checks every 250 ms, independently of status requests. While
assigned tasks, open attempts, launches, submits or active session turns remain,
it renews in the last third of the TTL (at least a 1-second window). Read-only
admission also keeps the fence closed if a tick arrives after expiry while
renewal budget remains. It does not persist a renewal; the daemon loop does.
Without in-flight work the TTL auto-releases the hold. Unchanged hold files are
cached by mtime, size and inode; cross-process writes invalidate that cache.
Admission before expiry reads only the fence; its drain inventory is lazy.
The daemon/status census reads only assigned and pending queue rows through the
status index, and an inactive daemon tick skips the census entirely.

Automatic renewal has explicit safety caps: six grants or two hours of granted
TTL by default, whichever is exhausted first. Each grant is at most the hold's
TTL and the remaining time budget. At the cap the final expiry remains in force,
even if assigned work is still running. The daemon emits a warning when the cap
is reached and again on capped expiry. Status includes `autoExtendCapReached`,
`autoExtendNotice`, and the final `expiresAt`; capped expiry records
`ttl_expired_auto_extend_cap_reached`. An owner needing a longer drain must
manually extend before that expiry. `autoExtend: false` explicitly disables
renewal on the hold record. A status request cannot disable that owner policy.
A failed lock acquisition or file write is a failed mutation, never a
successful durable hold acknowledgement; retry after resolving the error.

## Cross-process boundary

The hold JSON CAS lock serializes hold writers only. The queue claim's SQLite
transaction reads the hold before its claim UPDATE; it does not acquire that
file lock. Consequently a second process can commit a hold between that read
and UPDATE, allowing a claim that already passed admission to finish. This is
an acknowledged cross-process race, not an atomic freeze across both stores.
Within a daemon both operations are synchronous. Outbound dispatch rechecks the
hold and requests non-force retirement of an accepted claim before requeue,
without charging refusal budgets. Retirement retains the assignment until the
native writer checkpoint confirms quiescence; consumed work stays assigned.
A transport
already admitted before the hold may still run as in-flight work.

A successful set acknowledges the persisted admission fence, not proof that all
processes have drained. Before a handoff, wait for `sealed` and verify the
cooperative maintenance census/ACK evidence. Do not infer a safe handoff from
`held: true` alone, and do not run multiple daemon owners over one config/store
while relying on atomic claim exclusion. Closing that race would require a
shared claim/hold transaction or lock protocol covering every process and claim
path; this change does not introduce such a protocol.
