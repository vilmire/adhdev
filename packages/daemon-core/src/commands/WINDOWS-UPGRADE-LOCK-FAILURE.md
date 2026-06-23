# Windows 자동 업그레이드 실패 — 원인 분석 및 패치 명세

> 대상 파일: `oss/packages/daemon-core/src/commands/upgrade-helper.ts`
> 관련 가드: `packages/daemon-cloud/package.json`, `oss/packages/daemon-standalone/package.json` 의 `preinstall`
> 작성 근거: 2026-06-23 실 사용자(Windows 11, nvm-windows) 환경에서 `adhdev@0.9.82-rc.357 → rc.358` 자동 업그레이드가 반복 실패한 실 사례.

## TL;DR (English)

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

## 1. 배경 / Context

adhdev 데몬은 새 버전을 감지하면 detached 헬퍼 프로세스를 띄워
(`spawnDetachedDaemonUpgradeHelper`) `npm install -g adhdev@<target> --prefix <pinned>`
를 실행한다 (`runDaemonUpgradeHelper`). Windows에서는 네이티브 애드온
`node-pty/prebuilds/win32-x64/conpty.node` 가 **메모리 매핑된 채 프로세스가
완전히 종료될 때까지 배타적 잠금**된다. npm은 기존 설치본을 스테이징 디렉터리
(`node_modules/.adhdev-<hash>`)로 **복사**한 뒤 새 버전으로 교체하므로, 잠긴
`conpty.node`를 복사하려다 `EBUSY`로 실패한다.

소스에는 이미 이 문제를 겨냥한 방어가 들어 있다:
- `stopSessionHostProcesses()` — `~/.adhdev/<app>-session-host.pid`의 pid를
  죽이고 종료를 기다림(`waitForPidExit`).
- `buildInstallEnvWithNodeOnPath()` — lifecycle 스크립트가 올바른 node를 쓰도록
  `PATH` 앞에 현재 node 디렉터리를 prepend.
- 설치 재시도 루프 (Windows에서 `maxInstallAttempts = 3`, 백오프 `attempt*1500ms`).

**그런데 이번 실패는 이 방어들이 전부 적용된 상태에서도 발생한다.**

## 2. 실제 실패 타임라인 (증거)

`~/.adhdev/daemon-upgrade.log`:

```
[01:52:18] Upgrade helper started for adhdev@0.9.82-rc.358
[01:52:18] Using npm executable: C:\nvm4w\nodejs\node.exe
[01:52:18] Pinned install prefix: C:\Users\kjs0116\AppData\Local\nvm\v22.14.0
[01:52:18] Waiting for parent pid 38744 to exit
[01:52:21] Skipped locked stale entry (EPERM): ...\.adhdev-dTz6t6GZ — ...conpty.node
[01:52:35] Install attempt 1 hit a file lock (lock); cleaning staging and retrying after backoff
[01:52:57] Install attempt 2 hit a file lock (lock); ...
[01:53:16] Upgrade helper failed: EBUSY ... copyfile '...\adhdev\node_modules\node-pty\prebuilds\win32-x64\conpty.node'
            -> '...\.adhdev-dTz6t6GZ\...\conpty.node'
```
(01:59 에 동일 패턴으로 한 번 더 실패.)

수동 진단으로 밝혀낸 **실제 잠금 보유자** (`Get-Process node | %{ $_.Modules | ? ModuleName -match conpty }`):

| PID | CommandLine | 시작 |
|-----|-------------|------|
| 56396 | `node %TEMP%\pty_cr_probe.cjs` | 2026-06-21 |
| 37304 | `node %TEMP%\pty_probe_parent.cjs` | 2026-06-21 |
| 34316 | `node %TEMP%\pty_probe2_parent.cjs` | 2026-06-21 |

세 프로세스 모두
`...\AppData\Local\nvm\v22.14.0\node_modules\adhdev\node_modules\node-pty\prebuilds\win32-x64\conpty.node`
를 로드한 채 **이틀째 살아 있었다.** 세 개를 종료한 직후 잠금이 풀렸고
(`LOCK CLEARED`), Node 22로 설치가 정상 완료됐다.

> 참고: `pty_*probe*.cjs` 는 현재 adhdev 소스 트리에 존재하지 않는다(grep 결과 0건).
> 즉 개발 중 임시로 `%TEMP%`에 떨군 PTY/ConPTY 진단 스크립트가 고아로 남은 것이다.
> 핵심은 "출처가 무엇이든, **세션 호스트가 아닌 임의의 프로세스가 conpty.node를
> 쥘 수 있다**"는 점이며, 현재 헬퍼는 이를 처리하지 못한다.

## 3. 근본 원인

### RC1 — (핵심) 세션 호스트가 아닌 임의의 `conpty.node` 보유자를 못 다룸
`stopSessionHostProcesses()` 는 **딱 하나의 pid**(`<app>-session-host.pid`)만,
그것도 커맨드라인이 `/session-host-daemon/i` 에 매칭될 때만 죽인다
(`isManagedSessionHostPid`, upgrade-helper.ts:278-281, 295-313). 위 probe
프로세스처럼 PID 파일에 없고 커맨드라인도 매칭 안 되는 보유자는 **전혀 감지/정리
대상이 아니다.** 결과적으로 재시도 루프는 매번 같은 `EBUSY`를 다시 맞고 포기한다.

### RC2 — 재시도/백오프가 "절대 안 죽는 보유자"에 무력
`maxInstallAttempts = 3`, 백오프 `attempt*1500ms`(1.5s, 3s) (upgrade-helper.ts:449,469).
2일째 떠 있는 고아 프로세스에는 의미가 없다. 게다가 최종 실패 시 사용자에게
가는 신호는 로그 파일 한 줄(`Upgrade helper failed: ...`)뿐 — **어떤 프로세스가
막고 있는지, 어떻게 복구하는지** 알려주지 않는다.

### RC3 — Node 24 preinstall 가드 ↔ 멀티-node PATH (별도로 재현 확인됨)
`preinstall` 가드(아래)는 Windows에서 lifecycle 스크립트를 실행하는 `node`가
24+ 면 설치를 중단한다:
```jsonc
// packages/daemon-cloud/package.json, oss/packages/daemon-standalone/package.json
"preinstall": "node -e \"... if (win32 && major>=24 && !ADHDEV_BOOTSTRAP && !CI) { process.exit(1) }\""
```
npm은 preinstall을 `cmd /c node -e ...` 로, **PATH에서 찾은 bare `node`**로
실행한다(npm을 띄운 node가 아님). 이 머신은 `C:\Program Files\nodejs`(Node 24)가
nvm node보다 PATH 앞에 있어, 일반 `npm i -g adhdev` 는 이 가드에서 바로 죽는다
(본 사례에서 수동으로 재현됨).

`buildInstallEnvWithNodeOnPath()`(upgrade-helper.ts:185-198)가 `dirname(process.execPath)`
를 PATH 앞에 붙여 이를 완화하지만, **이는 "헬퍼 자신을 실행한 node가 지원 버전"이라는
가정에 의존**한다. 헬퍼가 nvm 심볼릭 링크(`C:\nvm4w\nodejs\node.exe`)로 떴고 그게
현재 Node 24를 가리키면, prepend되는 것도 Node 24라 가드가 그대로 발동한다.
실제 설치 타깃 node는 `--prefix`(v22.14.0)로 이미 고정돼 있는데도 그렇다.

### RC4 — 스테이징/잔여물 누적
잠금이 유지되는 동안 `safeRemoveStaleEntry`는 항상 `EPERM`으로 스킵되어
`.adhdev-<hash>` 스테이징이 **여러 실행에 걸쳐 그대로 쌓인다**. 보유자가 죽은
뒤에 GC하는 경로가 없다. (부수적으로, 헬퍼 밖에서 사용자가 `npm i -g adhdev`를
기본 prefix로 돌리면 `AppData\Roaming\npm`에 **두 번째 깨진 설치본**이 생겨
shadowing 혼란을 유발 — 헬퍼 책임은 아니나 진단 문서엔 남겨둠.)

## 4. 패치 권고

### P1 (필수) — 임의의 네이티브-애드온 보유자 감지·종료
설치 직전(및 각 재시도 전)에, **설치 대상 경로의** `conpty.node`(및
`ghostty-vt.dll`)를 로드 중인 프로세스를 열거해 self/parent를 제외하고 종료한 뒤
종료를 기다린다. 이번에 동작 확인된 PowerShell 패턴:

```powershell
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $_
  try {
    if ($p.Modules | Where-Object { $_.FileName -ieq $targetConptyPath }) { $p.Id }
  } catch {}
}
```
- `stopSessionHostProcesses()` 옆에 `stopForeignNativeAddonHolders(installRoot)`
  형태로 추가. `installCommand.surface.packageRoot` 기준으로 정확한
  `node_modules/node-pty/prebuilds/<plat-arch>/conpty.node` 절대경로를 만들어
  **그 경로를 매핑한 프로세스만** 대상으로 한다(과잉 종료 방지).
- 종료한 pid + commandLine을 `appendUpgradeLog` 로 남긴다(진단성 확보).
- `taskkill /T /F`(기존 `killPid`) 재사용 + `waitForPidExit` 로 매핑 해제 대기.
- 안전장치: 경로 매칭이 모호하면 죽이지 말고 로그만(아래 P2의 사용자 안내로 위임).

### P2 (필수) — 복구 가능한 실패 신호
최종 실패 시(또는 보유자 종료 실패 시) 로그뿐 아니라 **사용자에게 보이는 메시지**를
남긴다: 막고 있는 pid/commandLine 목록 + 그대로 붙여넣어 복구할 수 있는 수동 명령
(`Stop-Process -Id ... ; <pinned-node> <npm-cli> install -g adhdev@<v> --prefix <prefix>`).
재시도 예산도 현실화(예: 보유자 능동 정리 후 1~2회면 충분하므로, "정리 → 확인 →
설치" 순서로 바꾸고 맹목적 백오프 의존을 줄인다).

### P3 (권장) — Node 가드와의 상호작용 견고화
`buildInstallEnvWithNodeOnPath()` 가 만드는 install env에 **`ADHDEV_BOOTSTRAP=1`
을 함께 설정**한다. 자동 업그레이드 경로에서는 실제 런타임 node가 `--prefix`로
이미 고정/검증돼 있으므로, lifecycle 가드를 PATH 순서에만 의존해 우회하는 것은
취약하다. 더 견고하게는: `process.execPath`의 major가 지원 범위(예: 22) 밖이면
`installPrefix` 기준으로 지원되는 node를 명시적으로 찾아 npm 실행과 lifecycle
스크립트 양쪽에 쓰도록 한다.
> 주의: 가드 자체를 약화시키지 말 것. 가드는 "사용자 수동 설치"를 막는 용도로
> 유지하고, **자동 헬퍼 경로에서만** bootstrap 우회를 적용한다.

### P4 (권장) — 스테이징 GC 시점 추가
보유자가 모두 사라진 것을 확인한 뒤 `cleanupStaleGlobalInstallDirs` 를 한 번 더
돌리고, 가능하면 **CLI 정상 기동 시점**(잠금 없는 상태)에도 1회 GC를 수행해
누적된 `.adhdev-<hash>` 를 청소한다.

## 5. 변경 대상 파일

- `oss/packages/daemon-core/src/commands/upgrade-helper.ts` — P1~P4 핵심.
  - 신규 `stopForeignNativeAddonHolders()` (P1), `runDaemonUpgradeHelper` 흐름에
    `stopSessionHostProcesses` 직후 호출.
  - 최종 실패 메시지/예산 조정 (P2): `runDaemonUpgradeHelper` 의 설치 루프 +
    `maybeRunDaemonUpgradeHelperFromEnv` 의 catch.
  - install env에 `ADHDEV_BOOTSTRAP` 주입 (P3): `buildInstallEnvWithNodeOnPath`.
- (가드는 변경 불필요 — 자동 경로에서 env로 우회하는 것이 P3.)

## 6. 검증

1. **재현 픽스처:** `oss/packages/daemon-core/test/commands/daemon-upgrade-runtime-version.test.ts`
   에 "세션 호스트가 **아닌** 프로세스가 대상 `conpty.node`를 매핑 중" 케이스 추가.
   P1이 그 holder를 감지·종료 대상에 포함하는지 단위 테스트.
2. **수동 E2E (Windows):**
   - 대상 설치본의 `conpty.node`를 로드하는 더미 node 프로세스를 띄워 둔다.
   - 구버전에서 자동 업그레이드를 트리거.
   - 기대: 헬퍼가 더미 holder를 로그에 남기고 종료 → 설치 성공, 잔여 staging 없음.
   - 실패 주입(더미를 못 죽이게)했을 때: 사용자에게 pid/commandLine + 수동 복구
     명령이 표시되는지 확인.
3. **회귀:** `buildInstallEnvWithNodeOnPath` + `ADHDEV_BOOTSTRAP` 조합에서
   Node 24가 PATH 앞에 있어도 preinstall 가드가 자동 경로에선 통과하는지 확인.

## 7. 부록 — 이번 사례 수동 복구에 실제로 통한 명령

```powershell
# 1) conpty.node 보유자 식별
Get-Process node | ? { try { $_.Modules | ? ModuleName -match 'conpty' } catch {} } | % Id
# 2) 보유자 종료 (이번엔 34316,37304,56396)
Stop-Process -Id 34316,37304,56396 -Force
# 3) 고정 node(22) + 올바른 prefix로 설치 (PATH 앞에 Node22 → preinstall 가드 통과)
$pfx="C:\Users\kjs0116\AppData\Local\nvm\v22.14.0"; $env:PATH="$pfx;$env:PATH"
& "$pfx\node.exe" "$pfx\node_modules\npm\bin\npm-cli.js" install -g adhdev@0.9.82-rc.358 --prefix $pfx
# 4) 잔여 스테이징/엉뚱한 prefix 설치본 정리
Remove-Item -Recurse -Force "$pfx\node_modules\.adhdev-*" -EA SilentlyContinue
Remove-Item -Recurse -Force "$env:APPDATA\npm\node_modules\adhdev" -EA SilentlyContinue
```
