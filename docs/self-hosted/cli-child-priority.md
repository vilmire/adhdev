# CLI child scheduling at saturation

Agent PTYs are lowered immediately after native spawn in
`packages/daemon-core/src/cli-adapters/pty-transport.ts` and
`packages/session-host-daemon/src/runtime.ts`. This covers agy, claude, codex
and other providers using either PTY transport. Hosted lowering is limited to
`cli`/`acp` agent categories; user `shell` sessions and unknown categories retain
their existing priority. `hiddenSpawnCli` is the explicit
equivalent for stdio workloads. Generic `hiddenSpawn`/exec helpers retain their
existing priority: git, version probes, daemon/session-host startup, and a future
P2P signal worker must not acquire the workload policy.

The session-host remains normal priority because it owns IPC, terminal parsing
and snapshots. Lowering it would also delay daemon control requests. There is
no concurrency limit, CPU quota, daemon priority increase, or elevated operation.

**Scope gap:** the existing Codex app-server stdio spawn in
`packages/daemon-core/src/providers/codex-app-server/transport.ts:26` remains
unchanged because this task explicitly excludes `providers/` work in flight.
Its follow-up should substitute the explicit workload helper (preserving the
stdio stream types), without changing version probes or other provider helpers.

## Mechanisms and options

The policy lives in `packages/session-host-core/src/cli-child-priority.ts`,
shared by the direct and hosted transports. POSIX adds the named
`CLI_CHILD_NICE_INCREMENT = 10` to inherited niceness, capped at 19. Windows
uses `os.constants.priority.PRIORITY_BELOW_NORMAL`, as required by the
[Node priority API](https://nodejs.org/api/os.html#ossetprioritypid-priority).

`node-pty` has no priority creation hook. `os.setPriority` runs immediately when
spawn returns, before other work or listener setup. There is a real, unbounded
spawn-to-setPriority race: under starvation the parent can be descheduled, and
an early fork can inherit the old priority. Descendants created after adjustment
inherit nice; early descendants are not retroactively adjusted. The measured
process trees below verify the successful path, not the absence of that race.

- Default: nice +10 on POSIX / BelowNormal on Windows.
- `ADHDEV_CLI_CHILD_NICE=0`: disables **both** priority policies. Set in the
  daemon environment or the individual workload launch environment.
- `ADHDEV_CLI_CHILD_SCHEDULING=darwin-bg`: on macOS, additionally applies
  `/usr/sbin/taskpolicy -b -p <workload-pid>` using an asynchronous hidden helper.
  This helper itself runs at normal priority, never blocks the host, and targets
  only the saved workload PID. Helper startup adds another race before BG takes
  effect. Background scheduling also throttles I/O, so this is opt-in.

Permission failures, exited children and helper errors never invalidate a launch.
The first scheduling failure per policy instance logs at info level, subsequent
failures remain silent. The native hidden-spawn primitive was moved from
daemon-core into `session-host-core/src/process/hidden-spawn.ts` and reused by
both packages; the total number of raw production spawn calls did not increase.

## Reproduction and measurements

Run these separately, from `oss/packages/daemon-core`:

```sh
ADHDEV_CLI_PRIORITY_LOAD=1 npx vitest run test/cli-adapters/cli-child-priority.load.test.ts
ADHDEV_CLI_PRIORITY_LOAD=1 ADHDEV_CLI_CHILD_NICE=0 npx vitest run test/cli-adapters/cli-child-priority.load.test.ts
ADHDEV_CLI_PRIORITY_LOAD=1 npx vitest run test/cli-adapters/cli-child-priority-inheritance.load.test.ts
```

The load test is opt-in even in the default suite. Each mode runs K=logical-core
count pure `for(;;){}` Node hogs through **the production NodePtyTransportFactory**,
plus one idle CLI heartbeat probe. The normal-priority parent does 4ms CPU work
per 10ms tick and measures `monitorEventLoopDelay` for 10 seconds per mode.
There is no reduction of K or worker load between modes. Only saved child PIDs
are killed, individually; no process-name or process-group kills are used.

Mac measurements, 2026-10-18, macOS 26.6.2, Node 22.17.0, K=10:

| Passing production-path run (16:39:38) | Parent p50 ms | Parent p99 ms | Probe heartbeat p99 ms | Heartbeats |
| --- | ---: | ---: | ---: | ---: |
| none | 11.125 | 41.452 | 226.443 | 50 |
| nice +10 | 10.985 | 29.180 | 224.166 | 50 |
| nice +10 + darwin-bg | 10.863 | 17.859 | 529.431 | 39 |

Output: **1 test passed**. Nice improved p99 by 29.6%; BG improved it by 56.9%
versus none (38.8% versus nice). Parent NI was 0 throughout; all 11 children
were NI 0 for none and NI 10 for both lowered modes. BG passed the explicit
probe checks (>20 heartbeats and p99 gap <2s). Recommendation: keep nice as the
baseline and expose BG only as the named option. These measurements cover CPU
saturation and small terminal writes, not representative bulk provider I/O.

This is an environment-sensitive diagnostic, not a deterministic CI benchmark.
Earlier runs failed the nice 20% threshold, including p99 30.540/28.148 ms and
28.770/43.188 ms (none/nice). An earlier chunked-hog prototype measured
112.198/103.547 ms and timed out waiting for BG startup; a subsequent prototype
run reached BG p99 18.137 ms. The final harness uses pure infinite-loop hogs and
a separate probe. Do not erase these negative observations or claim a universal
latency guarantee from the passing run.

A repeat of the final harness (16:42:11) **failed** the nice latency assertion:

| Latest enabled run | Parent p50 ms | Parent p99 ms | Probe heartbeat p99 ms |
| --- | ---: | ---: | ---: |
| none | 11.002 | 30.130 | 220.641 |
| nice +10 | 10.994 | 31.965 | 214.518 |
| nice +10 + darwin-bg | 10.830 | 16.876 | 208.850 |

All OS-priority checks and BG latency/responsiveness assertions passed. **The
requested reliable nice-only >=20% p99 improvement is not established on this
machine.** A previous opt-out run even falsely passed the timing-only test
(none/nice-labelled p99 89.981/23.986 ms, both actually NI 0), demonstrating
external-load confounding. The harness now also asserts actual child niceness
and unchanged parent priority, so a disabled implementation cannot hide behind
random timing improvement. This is a policy invariant, not fabricated timing
evidence. An earlier opt-out run failed the lag assertion with p99
50.332/52.265 ms; the final opt-out run is recorded below.

| Final opt-out run (16:43:04) | Parent p50 ms | Parent p99 ms |
| --- | ---: | ---: |
| none | 11.026 | 42.435 |
| nice-labelled, disabled | 10.953 | 33.440 |
| BG-labelled, disabled | 11.002 | 41.419 |

Output: **1 test failed, 3 failed assertions**: both child-niceness invariants
(all 11 children were NI 0, expected NI 10) and the BG p99 improvement assertion.
The nice-labelled latency happened to pass despite disabling lowering; this is
why the OS-policy invariant is essential. Parent NI remained 0 in all modes.
This demonstrates that the final test rejects a disabled implementation, while
also documenting that timing alone is insufficient for causal proof here.

## Inheritance evidence

The inheritance test compiles a sleeping Go helper and uses a controlled agent
fixture, **not an authenticated live agy session**. Representative actual output
from `ps -o pid,ppid,ni,command -p <saved-pids>`:

```text
  PID  PPID NI COMMAND
61095 61092  0 node .../vitest/dist/workers/forks.js
61123 61095 10 /bin/sh -c "$@" & wait cli-priority-shell node --import tsx .../agy-fixture.mjs
61124 61123 10 node --import tsx .../agy-fixture.mjs
61125 61124 10 node -e setInterval(()=>{},1000)
61126 61124 10 .../go-helper
```

The test asserts every descendant's niceness and that the parent stayed normal.
It passed. No live CLI session was inspected for mutation or reprioritized.

## Windows MainPC follow-up task

1. Use an unelevated account and a separate test config directory/IPC endpoint.
   Do not restart or attach to existing daemon sessions. Record Windows, Node
   and node-pty versions, core count, daemon PID and session-host PID.
2. Exercise both actual transports: hosted `PtySessionRuntime.start` and direct
   `NodePtyTransportFactory.spawn`. Save each returned PID and correlate it with
   `Get-CimInstance Win32_Process` (`ProcessId`, `ParentProcessId`, `CommandLine`).
   Verify the PID identifies the workload, rather than conhost/OpenConsole or a
   transient ConPTY helper. Include a native `.exe` and an npm `.cmd` shim.
3. Read `(Get-Process -Id <pid>).PriorityClass` after readiness. The workload must
   be `BelowNormal`. Start shell -> agent fixture -> Node/native-helper trees;
   verify every relevant descendant, including ones forked immediately at
   startup and later during a command. Test realistic agy/claude/codex trees in
   newly created disposable sessions. Record any child explicitly resetting its
   priority and quantify the spawn-to-adjustment inheritance race.
4. Daemon, session-host IPC owner, any P2P signal worker, and short version/git
   helpers must remain `Normal`, before and during workload launch. Confirm
   hosted `shell` sessions also remain `Normal`, normal IPC snapshots/input/
   resize/exit handling, and no console-window flash.
5. Repeat with `ADHDEV_CLI_CHILD_NICE=0` in the isolated launch environment:
   workloads and descendants should remain `Normal`. The Darwin option must be
   inert on Windows; verify no taskpolicy process is attempted.
6. Port/run the same K-core saturation harness through real ConPTY, all K hogs
   unchanged for ~10s per mode. Record p50/p99 parent lag, workload readiness,
   interactive response and CPU utilization, with default lowering and opt-out.
   Check the >=20% p99 assertion and its opt-out failure; report adverse runs.
7. Check an already-exited PID and simulated EACCES/EPERM/ESRCH: the agent launch
   result survives, only one info message is emitted per policy instance, and
   PID 0/missing PID never targets the parent. Kill only the fixture PIDs saved
   by the harness, in descendant-before-parent order. Preserve logs and the
   process tree with their measured priority classes.

Real ConPTY inheritance is unverified on this Mac; mocked Windows unit coverage
does not substitute for this task.

## Related verification

From `oss/packages/daemon-core`, the related checks cover **64 tests across
6 files** (63 unit/spawn checks and the real inheritance test):

```sh
ADHDEV_CLI_PRIORITY_LOAD=1 npx vitest run \
  test/cli-adapters/cli-child-priority.test.ts \
  test/cli-adapters/cli-child-priority-spawns.test.ts \
  test/cli-adapters/pty-transport-load-retry.test.ts \
  test/session-host/managed-host-node-pin.test.ts \
  test/cli-adapters/cli-child-priority-inheritance.load.test.ts \
  test/commands/cooperative-maintenance.test.ts
```

The saturation file is deliberately run separately, as shown above. The latest
enabled run had 1 failing test (nice latency); the intentional opt-out run had
1 failing test (3 soft assertions). Both outcomes are part of the evidence.
`check:windows-hide`, `check:boundaries`, `check:shape-guards`, `check:file-sizes`
and both session-host package typechecks passed.

The maintenance fixture's synthetic PID 1 spawn explicitly opts out, just as the
native-load retry fixture does, so no mocked PID reaches the real scheduler.
Hosted scope cases verify CLI/ACP lowering and shell/unknown-category exclusion.
