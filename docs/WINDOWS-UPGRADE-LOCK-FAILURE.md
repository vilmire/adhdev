# Windows self-upgrade failure — root-cause analysis and patch spec

> Target file: `packages/daemon-core/src/commands/upgrade-helper.ts`
> Related guards: `preinstall` in `packages/daemon-cloud/package.json` and `packages/daemon-standalone/package.json`
> Basis: a real-world case (Windows 11, nvm-windows) on 2026-06-23 where the
> `adhdev@0.9.82-rc.357 → rc.358` self-upgrade failed repeatedly.

## TL;DR

The Windows self-upgrade fails when a process **other than** the parent CLI or the
known `session-host-daemon` keeps node-pty's `conpty.node` memory-mapped. The
helper only knows how to stop the single pid in `~/.adhdev/<app>-session-host.pid`,
so any *foreign* holder (here: three orphaned `pty_*probe*.cjs` scripts left in
`%TEMP%`) survives all 3 retries and the install dies with `EBUSY`. Two additional
weaknesses compound it: retry budget is far too small for a never-exiting holder,
and on failure the user gets no actionable message (only a log file). A separate,
independently-confirmed failure mode is the Node-24 `preinstall` guard firing when
the lifecycle-script `node` resolves to an unsupported version on a multi-node
`PATH`.

---

## 1. Context

When the adhdev daemon detects a new version it spawns a detached helper process
(`spawnDetachedDaemonUpgradeHelper`) that runs
`npm install -g adhdev@<target> --prefix <pinned>` (`runDaemonUpgradeHelper`). On
Windows the native addon `node-pty/prebuilds/win32-x64/conpty.node` is
**exclusively locked while memory-mapped, until the holding process fully exits**.
npm **copies** the existing install into a staging directory
(`node_modules/.adhdev-<hash>`) before swapping in the new version, so copying the
locked `conpty.node` fails with `EBUSY`.

The source already contains defenses aimed at this problem:
- `stopSessionHostProcesses()` — kills the pid in `~/.adhdev/<app>-session-host.pid`
  and waits for it to exit (`waitForPidExit`).
- `buildInstallEnvWithNodeOnPath()` — prepends the current node directory to `PATH`
  so lifecycle scripts use the correct node.
- Install retry loop (`maxInstallAttempts = 3` on Windows, backoff `attempt*1500ms`).

**Yet this failure occurs even with all of these defenses in effect.**

## 2. Actual failure timeline (evidence)

`~/.adhdev/daemon-upgrade.log`:

```
[01:52:18] Upgrade helper started for adhdev@0.9.82-rc.358
[01:52:18] Using npm executable: C:\nvm4w\nodejs\node.exe
[01:52:18] Pinned install prefix: C:\Users\<user>\AppData\Local\nvm\v22.14.0
[01:52:18] Waiting for parent pid 38744 to exit
[01:52:21] Skipped locked stale entry (EPERM): ...\.adhdev-dTz6t6GZ — ...conpty.node
[01:52:35] Install attempt 1 hit a file lock (lock); cleaning staging and retrying after backoff
[01:52:57] Install attempt 2 hit a file lock (lock); ...
[01:53:16] Upgrade helper failed: EBUSY ... copyfile '...\adhdev\node_modules\node-pty\prebuilds\win32-x64\conpty.node'
            -> '...\.adhdev-dTz6t6GZ\...\conpty.node'
```
(A second failure with the same pattern occurred at 01:59.)

The **actual lock holders** found by manual diagnosis
(`Get-Process node | %{ $_.Modules | ? ModuleName -match conpty }`):

| PID | CommandLine | Started |
|-----|-------------|---------|
| 56396 | `node %TEMP%\pty_cr_probe.cjs` | 2026-06-21 |
| 37304 | `node %TEMP%\pty_probe_parent.cjs` | 2026-06-21 |
| 34316 | `node %TEMP%\pty_probe2_parent.cjs` | 2026-06-21 |

All three had
`...\AppData\Local\nvm\v22.14.0\node_modules\adhdev\node_modules\node-pty\prebuilds\win32-x64\conpty.node`
loaded and had been **alive for two days.** The lock cleared the moment all three
were killed (`LOCK CLEARED`), and the Node 22 install completed normally.

> Note: `pty_*probe*.cjs` does not exist anywhere in the current adhdev source tree
> (grep returns 0 hits). These are leftover, orphaned PTY/ConPTY diagnostic scripts
> dropped into `%TEMP%` during development. The point is that "**regardless of
> origin, an arbitrary process that is not the session host can hold conpty.node**",
> and the current helper cannot handle that.

## 3. Root causes

### RC1 — (core) cannot handle an arbitrary `conpty.node` holder that is not the session host
`stopSessionHostProcesses()` kills **exactly one pid** (`<app>-session-host.pid`),
and only when its command line matches `/session-host-daemon/i`
(`isManagedSessionHostPid`, upgrade-helper.ts:278-281, 295-313). A holder like the
probe processes above — not in the pid file and not matching the command line — is
**never detected or cleaned up.** As a result the retry loop hits the same `EBUSY`
every time and gives up.

### RC2 — retry/backoff is useless against a "never-exiting" holder
`maxInstallAttempts = 3`, backoff `attempt*1500ms` (1.5s, 3s) (upgrade-helper.ts:449,469).
This is meaningless for a process that has been alive for two days. Moreover, on
final failure the only signal the user gets is a single log line
(`Upgrade helper failed: ...`) — it does **not** say **which process is blocking**
or **how to recover**.

### RC3 — Node 24 preinstall guard vs multi-node PATH (independently reproduced)
The `preinstall` guard (below) aborts the install on Windows when the `node` running
the lifecycle script is 24+:
```jsonc
// packages/daemon-cloud/package.json, packages/daemon-standalone/package.json
"preinstall": "node -e \"... if (win32 && major>=24 && !ADHDEV_BOOTSTRAP && !CI) { process.exit(1) }\""
```
npm runs `preinstall` as `cmd /c node -e ...`, using the **bare `node` found on
PATH** (not the node that launched npm). On this machine
`C:\Program Files\nodejs` (Node 24) is ahead of the nvm node on PATH, so a plain
`npm i -g adhdev` dies at this guard immediately (reproduced manually in this case).

`buildInstallEnvWithNodeOnPath()` (upgrade-helper.ts:185-198) mitigates this by
prepending `dirname(process.execPath)` to PATH, but **this relies on the assumption
that the node running the helper itself is a supported version.** If the helper was
launched via an nvm symlink (`C:\nvm4w\nodejs\node.exe`) that currently points at
Node 24, the prepended node is also Node 24 and the guard still fires — even though
the actual install target node is already pinned via `--prefix` (v22.14.0).

### RC4 — staging/residue accumulation
While the lock is held, `safeRemoveStaleEntry` always skips with `EPERM`, so the
`.adhdev-<hash>` staging dirs **pile up across runs**. There is no path that GCs
them after the holder dies. (As a side effect, if the user runs `npm i -g adhdev`
with the default prefix outside the helper, a **second broken install** appears in
`AppData\Roaming\npm`, causing shadowing confusion — not the helper's fault, but
kept here for the diagnosis record.)

## 4. Patch recommendations

### P1 (required) — detect and kill arbitrary native-addon holders
Immediately before the install (and before each retry), enumerate the processes
that have loaded **the target path's** `conpty.node` (and `ghostty-vt.dll`),
exclude self/parent, kill them, and wait for exit. The PowerShell pattern confirmed
working here:

```powershell
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $_
  try {
    if ($p.Modules | Where-Object { $_.FileName -ieq $targetConptyPath }) { $p.Id }
  } catch {}
}
```
- Add it next to `stopSessionHostProcesses()` as
  `stopForeignNativeAddonHolders(installRoot)`. Build the exact absolute
  `node_modules/node-pty/prebuilds/<plat-arch>/conpty.node` path from
  `installCommand.surface.packageRoot` and target **only processes mapping that
  path** (avoid over-killing).
- Log the killed pid + commandLine via `appendUpgradeLog` (for diagnostics).
- Reuse `taskkill /T /F` (existing `killPid`) + `waitForPidExit` to wait for the
  mapping to release.
- Safety: if the path match is ambiguous, do not kill — just log (defer to the user
  guidance in P2).

### P2 (required) — recoverable failure signal
On final failure (or if killing the holder fails), leave not just a log but a
**user-visible message**: the blocking pid/commandLine list plus a copy-pasteable
manual recovery command
(`Stop-Process -Id ... ; <pinned-node> <npm-cli> install -g adhdev@<v> --prefix <prefix>`).
Also make the retry budget realistic (e.g. after actively clearing holders, 1–2
attempts suffice): switch to a "clean → verify → install" order and reduce reliance
on blind backoff.

### P3 (recommended) — harden the interaction with the Node guard
Also set **`ADHDEV_BOOTSTRAP=1`** in the install env built by
`buildInstallEnvWithNodeOnPath()`. On the self-upgrade path the actual runtime node
is already pinned/verified via `--prefix`, so bypassing the lifecycle guard purely
by PATH order is fragile. More robustly: if the major of `process.execPath` is
outside the supported range (e.g. 22), explicitly locate a supported node under
`installPrefix` and use it for both the npm invocation and the lifecycle scripts.
> Caution: do not weaken the guard itself. Keep the guard for the "user manual
> install" case and apply the bootstrap bypass **only on the automatic helper path**.

### P4 (recommended) — add a staging GC point
After confirming all holders are gone, run `cleanupStaleGlobalInstallDirs` once
more, and if possible also do a one-shot GC at **normal CLI startup** (lock-free
state) to clean up accumulated `.adhdev-<hash>` dirs.

## 5. Files to change

- `packages/daemon-core/src/commands/upgrade-helper.ts` — core of P1–P4.
  - New `stopForeignNativeAddonHolders()` (P1), called right after
    `stopSessionHostProcesses` in the `runDaemonUpgradeHelper` flow.
  - Final failure message / budget adjustment (P2): the install loop in
    `runDaemonUpgradeHelper` + the catch in `maybeRunDaemonUpgradeHelperFromEnv`.
  - Inject `ADHDEV_BOOTSTRAP` into the install env (P3): `buildInstallEnvWithNodeOnPath`.
- (The guard needs no change — bypassing it via env on the automatic path is P3.)

## 6. Verification

1. **Reproduction fixture:** add a "a process that is **not** the session host is
   mapping the target `conpty.node`" case to
   `packages/daemon-core/test/commands/daemon-upgrade-runtime-version.test.ts`.
   Unit-test that P1 includes that holder in its detect/kill set.
2. **Manual E2E (Windows):**
   - Start a dummy node process that loads the target install's `conpty.node`.
   - Trigger a self-upgrade from an older version.
   - Expect: the helper logs and kills the dummy holder → install succeeds, no
     residual staging.
   - With failure injected (dummy cannot be killed): confirm the user is shown the
     pid/commandLine + manual recovery command.
3. **Regression:** confirm that with `buildInstallEnvWithNodeOnPath` +
   `ADHDEV_BOOTSTRAP`, the preinstall guard passes on the automatic path even when
   Node 24 is ahead on PATH.

## 7. Appendix — commands that actually worked for manual recovery in this case

```powershell
# 1) Identify conpty.node holders
Get-Process node | ? { try { $_.Modules | ? ModuleName -match 'conpty' } catch {} } | % Id
# 2) Kill the holders (34316,37304,56396 in this case)
Stop-Process -Id 34316,37304,56396 -Force
# 3) Install with the pinned node (22) + correct prefix (Node22 first on PATH → passes the preinstall guard)
$pfx="C:\Users\<user>\AppData\Local\nvm\v22.14.0"; $env:PATH="$pfx;$env:PATH"
& "$pfx\node.exe" "$pfx\node_modules\npm\bin\npm-cli.js" install -g adhdev@0.9.82-rc.358 --prefix $pfx
# 4) Clean up residual staging / wrong-prefix install
Remove-Item -Recurse -Force "$pfx\node_modules\.adhdev-*" -EA SilentlyContinue
Remove-Item -Recurse -Force "$env:APPDATA\npm\node_modules\adhdev" -EA SilentlyContinue
```
