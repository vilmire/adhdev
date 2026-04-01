# Local Session Host Architecture

## Goal

`adhdev`의 CLI/ACP/interactive shell 세션을 daemon 프로세스와 분리해서, 아래를 product invariant로 만든다.

- daemon 재시작/업그레이드와 무관하게 세션이 유지된다
- 웹 UI, IDE UI, 로컬 터미널 클라이언트가 같은 세션에 attach할 수 있다
- user와 agent가 같은 작업 컨텍스트를 공유할 수 있다
- session restore, scrollback, approval, activity, logs가 하나의 canonical runtime 위에서 동작한다
- macOS / Linux / Windows를 같은 아키텍처로 지원한다

이 문서는 점진적 패치가 아니라 최종 구조를 먼저 고정하기 위한 설계 문서다.

## Terminology

`adhdev`에는 이미 `session`이라는 단어가 여러 층에서 쓰인다. 여기서부터는 아래처럼 구분한다.

- `provider session`
  - daemon이 추적하는 agent/chat/provider 단위
  - 기존 `SessionRegistry`, `targetSessionId` 문맥
- `runtime`
  - `adhdev-sessiond`가 소유하는 PTY/ConPTY 실행 단위
  - attach/detach/scrollback/write ownership의 기준

가능하면 새 runtime layer의 user-facing 문서와 CLI는 `runtime`이라는 단어를 쓴다.

현재 코드상 일부 wire field가 아직 `sessionId`를 쓰더라도, 의미는 `runtimeId`로 읽는다.

## Why Current Structure Fails

현재 CLI 세션은 daemon이 직접 소유한다.

- `DaemonCliManager`가 adapter lifecycle을 직접 관리
- `ProviderCliAdapter`가 `node-pty` child를 daemon 내부에서 직접 spawn
- daemon shutdown 시 `cliManager.shutdownAll()`이 호출되어 세션이 같이 죽음

즉 지금 구조의 문제는 "detached를 안 썼다"가 아니다.

- PTY master를 daemon이 들고 있다
- status parsing도 daemon이 직접 한다
- session registry도 daemon process memory에만 있다

그래서 daemon이 죽으면:

- PTY control path가 끊기고
- output stream이 끊기고
- runtime identity도 사라진다

이건 현재 구조의 필연적인 결과다.

## Hard Requirements

### Runtime

1. 세션은 daemon과 별개로 생존해야 한다
2. daemon은 세션의 owner가 아니라 controller여야 한다
3. PTY / ConPTY ownership은 daemon 밖에 있어야 한다
4. session metadata는 process memory만 믿으면 안 된다

### Product

1. web dashboard에서 세션을 보고 입력할 수 있어야 한다
2. local terminal에서도 같은 세션에 attach 가능해야 한다
3. agent와 user가 같은 세션을 공유할 수 있어야 한다
4. approval / chat / action state가 계속 유지돼야 한다
5. reconnect 후 이전 scrollback을 복원해야 한다

### Cross-platform

1. macOS / Linux / Windows 모두 지원
2. tmux / screen / zellij / WSL 같은 외부 의존은 product invariant가 될 수 없다
3. OS별 UX 차이는 있어도 core runtime model은 같아야 한다

## Non-Goals

1. tmux clone 전체 구현
2. 다중 pane/window UI를 v1의 필수로 두지 않음
3. remote multi-user collaboration policy를 먼저 풀지 않음
4. terminal emulator 자체를 새로 구현하지 않음

즉 필요한 건 "terminal app"이 아니라 "cross-platform session runtime"이다.

## Architecture

세 층으로 분리한다.

```text
+-------------------------------------------------------------+
| User-facing clients                                         |
|                                                             |
|  - Dashboard / IDE page / web terminal                      |
|  - Local terminal client (Ghostty / terminal attach)        |
+----------------------------+--------------------------------+
                             |
                             v
+-------------------------------------------------------------+
| adhdev-daemon (control plane)                               |
|                                                             |
|  - commands / routing / approvals / status aggregation      |
|  - provider orchestration                                   |
|  - UI-facing websocket / HTTP / cloud bridge                |
+----------------------------+--------------------------------+
                             |
                             | local IPC
                             v
+-------------------------------------------------------------+
| adhdev-sessiond (runtime plane)                             |
|                                                             |
|  - PTY / ConPTY ownership                                   |
|  - session registry                                         |
|  - scrollback buffers                                       |
|  - attach / detach / client presence                        |
|  - input lock / write arbitration                           |
|  - process lifecycle                                        |
+----------------------------+--------------------------------+
                             |
                             v
+-------------------------------------------------------------+
| OS processes                                                |
|                                                             |
|  - shell / codex / claude / roo / agent CLIs               |
|  - IDE child shells / interactive tools                     |
+-------------------------------------------------------------+
```

## Core Principle

`adhdev-daemon`은 session owner가 아니다.

- daemon은 session host에 `create/attach/send/resize/stop`을 요청한다
- session host는 PTY, scrollback, client presence를 관리한다
- daemon은 상태를 투영하고 product logic을 붙인다

이렇게 해야 daemon을 재시작해도 세션이 남는다.

## New Runtime Components

### 1. `adhdev-sessiond`

로컬 백그라운드 프로세스.

역할:

- PTY / ConPTY 생성
- shell / CLI child process spawn
- output ring buffer 유지
- attached client 관리
- input arbitration
- session metadata persistence
- session recovery after daemon restart

금지:

- provider-specific parsing
- dashboard projection
- cloud transport logic

즉 `sessiond`는 도메인-aware가 아니라 runtime-aware여야 한다.

현재 로컬 CLI 엔트리:

- `adhdev-sessiond serve`
- `adhdev-sessiond list`
- `adhdev-sessiond list --all`
- `adhdev-sessiond attach <runtimeId|runtimeKey>`
- `adhdev-sessiond attach <runtimeId|runtimeKey> --read-only`
- `adhdev-sessiond attach <runtimeId|runtimeKey> --takeover`

### 2. `SessionRegistry`

세션의 canonical local truth.

```ts
type SessionHostRecord = {
  sessionId: string;
  runtimeKey: string;
  displayName: string;
  workspaceLabel: string;
  transport: 'pty';
  providerType: string;
  category: 'cli' | 'acp' | 'shell';
  workspace: string;
  launchCommand: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  osPid?: number;
  createdAt: number;
  startedAt?: number;
  lastActivityAt: number;
  lifecycle: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
  writeOwner: null | {
    clientId: string;
    ownerType: 'agent' | 'user';
    acquiredAt: number;
  };
  attachedClients: {
    clientId: string;
    type: 'daemon' | 'web' | 'local-terminal';
    readOnly: boolean;
    attachedAt: number;
    lastSeenAt: number;
  }[];
  buffer: {
    scrollbackBytes: number;
    snapshotSeq: number;
  };
  meta: Record<string, unknown>;
};
```

### 3. `SessionBuffer`

tmux급 이점 중 핵심은 scrollback이다.

필수 기능:

- ring buffer
- VT text snapshot
- raw output chunk sequence
- 마지막 known rows/cols

v1 규칙:

- raw chunks와 rendered text snapshot 둘 다 유지
- web은 snapshot + incremental chunks로 복구
- daemon은 snapshot 기반으로 parsing 시작 가능

### 4. `AttachManager`

여러 클라이언트가 같은 세션에 붙을 수 있어야 한다.

클라이언트 종류:

- daemon
- dashboard / IDE page
- local terminal client
- future cloud bridge

각 attach는 capability를 가진다.

```ts
type AttachCapability = {
  read: boolean;
  write: boolean;
  resize: boolean;
  control: boolean;
};
```

## IPC Contract

daemon과 `sessiond`는 local IPC로 통신한다.

후보:

- Unix domain socket / Windows named pipe

HTTP는 가능하지만 기본 IPC로는 덜 적합하다. 지속 connection / streaming / backpressure / auth 모두 별도로 얹어야 한다.

권장:

- request/response command channel
- event stream channel

### Request examples

```ts
type SessionHostRequest =
  | { type: 'create_session'; payload: CreateSessionPayload }
  | { type: 'attach_session'; payload: AttachSessionPayload }
  | { type: 'detach_session'; payload: DetachSessionPayload }
  | { type: 'send_input'; payload: SendInputPayload }
  | { type: 'resize_session'; payload: ResizePayload }
  | { type: 'signal_session'; payload: SignalPayload }
  | { type: 'list_sessions'; payload?: {} }
  | { type: 'get_snapshot'; payload: { sessionId: string; sinceSeq?: number } }
  | { type: 'acquire_write'; payload: AcquireWritePayload }
  | { type: 'release_write'; payload: ReleaseWritePayload }
  | { type: 'stop_session'; payload: { sessionId: string } };
```

### Event examples

```ts
type SessionHostEvent =
  | { type: 'session_started'; sessionId: string; pid?: number }
  | { type: 'session_output'; sessionId: string; seq: number; data: string }
  | { type: 'session_exit'; sessionId: string; exitCode: number | null }
  | { type: 'session_resized'; sessionId: string; cols: number; rows: number }
  | { type: 'write_owner_changed'; sessionId: string; owner: WriteOwner | null }
  | { type: 'client_attached'; sessionId: string; clientId: string }
  | { type: 'client_detached'; sessionId: string; clientId: string };
```

## Session Identity Rules

세션 identity는 host가 발급한다.

- `sessionId`: host-level canonical identity
- `runtimeKey`: 사람이 attach/list에서 쓰는 stable local handle
- daemon/runtime/session model 모두 이 값을 canonical target으로 사용

금지:

- `cliType + dir`를 identity처럼 쓰기
- daemon restart 후 새 instance key를 session identity로 오인하기

세션과 provider type은 다르다.

- 하나의 provider type으로 여러 세션이 동시에 가능
- 하나의 workspace에서도 여러 세션이 동시에 가능

## Attach Model

### Read attach

누구나 여러 개 붙을 수 있다.

- web dashboard
- IDE page
- daemon parser
- local terminal viewer

### Write attach

write는 arbitration이 필요하다.

권장 기본값:

- 동시 write 허용 안 함
- single write owner
- write owner 변경 시 이벤트 broadcast
- local terminal attach는 기본적으로 owner를 뺏지 않음
- owner가 이미 있으면 read-only attach로 열고, `--takeover`일 때만 명시적으로 owner를 가져감

### Ownership states

```ts
type WriteOwner =
  | { mode: 'agent'; clientId: string }
  | { mode: 'user'; clientId: string }
  | { mode: 'shared'; clientIds: string[] };
```

v1 기본은 `agent` / `user` 두 모드만 둔다.

`shared`는 나중에 열 수 있지만 기본으로 두지 않는다. 충돌이 너무 많다.

## Local Terminal Integration

유저가 Ghostty 같은 로컬 터미널에서 세션을 직접 봐야 한다면, Ghostty 자체를 session substrate로 쓰는 게 아니라 attach target으로 쓴다.

즉:

- Ghostty = local client
- sessiond = runtime substrate

필요한 건 `adhdev attach <session-id>` 같은 로컬 attach command다.

예:

```bash
adhdev attach 8d3d4e6b-...
```

이 command는:

- session host에 attach
- stdout/stdin/resize 연결
- local terminal을 one client로 등록

이렇게 하면 Ghostty, iTerm2, Terminal.app, Windows Terminal 모두 클라이언트가 될 수 있다.

## Why Not External Multiplexers

tmux/screen/zellij/WSL 같은 외부 substrate는 product invariant가 될 수 없다.

이유:

1. Windows 기본 지원이 부족하거나 불완전
2. 설치 의존이 생김
3. adhdev session metadata와 lifecycle을 우리가 직접 통제할 수 없다
4. approval / parser / chat projection을 붙이기 어렵다

즉 외부 multiplexer는 optional integration일 수는 있어도 core runtime은 될 수 없다.

## Why Not "Just Detached Spawn"

detached child만 띄우는 건 충분하지 않다.

- daemon이 PTY master를 잃음
- scrollback 복구가 안 됨
- resize / input / output attach가 끊김
- orphan process cleanup가 어려움
- UI는 여전히 session identity를 잃음

detached spawn은 persistence가 아니라 orphaning에 가깝다.

## Persistence Model

`sessiond`는 메모리만 믿지 않는다.

저장 대상:

- session registry
- launch metadata
- write owner
- last rows/cols
- scrollback snapshot pointer
- process state

저장 방식:

- append-only event log + compact snapshot

예:

```text
~/.adhdev/session-host/
  sessions/
    <session-id>/
      meta.json
      buffer.log
      snapshot.json
      lock.json
```

원칙:

- crash recovery 가능
- daemon restart 후 즉시 list_sessions 가능
- sessiond 자체 restart 후도 최소한 registry + scrollback snapshot 복구 가능
- host restart 시 살아 있던 runtime은 자동 재attach 대신 `failed + snapshot restored` 상태로 복구

## Status Projection

daemon은 session host raw state를 canonical `SessionEntry`로 투영한다.

PTY session이라고 해서 특별 category로 취급하지 않는다.

- `transport = 'pty'`
- `kind = 'agent' | 'workspace'`

중요한 점:

- session host는 raw terminal runtime
- daemon은 product-facing session projection

즉 parsing responsibility는 daemon/provider layer에 둔다.

## Approval / Chat / Parser Integration

현재 provider adapters가 PTY output에서:

- generating
- waiting_approval
- messages
- tool calls

를 추론한다.

이 구조는 유지할 수 있다. 다만 입력/출력 source만 바뀐다.

현재:

- provider adapter owns PTY

새 구조:

- provider parser attaches to host session stream

즉 provider layer는 더 이상 PTY process owner가 아니라:

- session consumer
- parser
- command emitter

가 된다.

## Multi-window / Multi-pane

tmux급 이점 중 multi-window/pane은 중요하지만 core는 아니다.

v1에서 중요한 것은:

- multi-attach
- reconnect
- scrollback
- write handoff

pane/window abstraction은 host가 아니라 UI layer에서 먼저 다뤄도 된다.

즉 host는 session graph만 제공하고:

- group
- pane layout
- split

은 web/desktop shell이 담당해도 된다.

## Security Model

로컬 IPC라도 trust boundary는 있다.

필수:

- per-user local-only socket/pipe
- random auth token or OS user-bound permissions
- attach request provenance (`daemon`, `web`, `local-terminal`)
- write acquisition audit

웹 standalone이 session host에 직접 붙는 경우에도:

- daemon-signed attach token
또는
- same-user local credential

이 필요하다.

## Failure Model

### daemon crash / restart

원하는 결과:

- session host alive
- session alive
- daemon restart 후 reattach
- UI reconnect 후 state restore

### session host crash

원하는 결과:

- registry/snapshot 복구
- 살아 있는 child 재attach 시도
- 실패 시 stopped/failed marking

### terminal client disconnect

원하는 결과:

- session 유지
- write owner가 user였다면 release 또는 grace timeout 후 agent reclaim

### UI tab close

원하는 결과:

- read attach만 끊김
- session은 유지
- screenshot/stream/polling도 session visibility 기준으로 줄임

## Windows Notes

Windows 때문에 설계를 단순화해야 한다.

- tmux 전제 금지
- Unix-only PTY tricks 금지
- `node-pty` + ConPTY를 canonical backend로 본다
- IPC는 named pipe 지원 필수

Windows에서 중요한 건 "동작 동일성"이지 "구현 동일성"이 아니다.

즉 내부 backend는 달라도 외부 contract는 같아야 한다.

## Recommended Stack

### Core runtime

- `node-pty`
- Unix domain socket / Windows named pipe
- JSON-RPC or framed message protocol

### Web terminal

- `xterm.js`

### Local attach client

- `adhdev attach`
- stdio bridge

### Optional future native embedding

- Ghostty/libghostty는 local terminal UI나 native embedding 후보일 수 있지만, core runtime substitute는 아니다

## File-Level Plan

### New packages

- `packages/session-host-core`
  - registry
  - buffer
  - IPC protocol
  - attach manager
  - write lock manager

- `packages/session-host-daemon`
  - actual local background process entry
  - platform bootstrap
  - persistence

### daemon-core changes

- `commands/cli-manager.ts`
  - PTY ownership 제거
  - host RPC client로 변경

- provider CLI/ACP runtime
  - host stream consumer / parser 역할로 축소

- status builder
  - host session metadata를 projection input으로 수용

### web-core changes

- terminal session view는 `targetSessionId` 기준 attach
- user terminal input과 agent input ownership 상태 표시
- session restore / reconnect UI 추가

## Cutover Strategy

이번 구조는 partial patch보다 cutover가 낫다.

최소한 아래는 같이 바뀌어야 한다.

1. CLI/ACP launch ownership
2. session registry source of truth
3. stop/restart semantics
4. status projection source
5. web terminal attach path

다만 product rollout은 feature flag로 막을 수 있다.

- old runtime
- session-host runtime

을 병행할 수는 있지만, core ownership model은 섞지 않는 게 맞다.

## V1 Product Scope

v1에서 반드시 되는 것:

1. CLI/ACP session daemon-independent persistence
2. daemon restart after reattach
3. dashboard/web terminal read/write attach
4. local `adhdev attach`
5. single write owner
6. scrollback restore
7. session list / reconnect / stop

v1에서 보류 가능한 것:

1. shared concurrent typing
2. pane/window graph
3. remote team multi-user collaboration
4. advanced replay/time-travel
5. session migration across machines

## Success Criteria

아래가 되면 아키텍처가 맞게 잡힌 것이다.

1. `adhdev-standalone`을 재시작해도 Codex/Claude CLI 세션이 유지된다
2. dashboard에서 세션을 다시 열면 이전 출력이 그대로 보인다
3. Ghostty 같은 로컬 터미널에서도 같은 세션에 attach 가능하다
4. user가 write owner를 가져가면 agent input이 멈춘다
5. user가 release하면 agent가 다시 이어서 작업 가능하다
6. Windows에서도 같은 개념으로 동작한다

## Decision

`adhdev`는 외부 terminal multiplexer를 runtime invariant로 두지 않는다.

대신 cross-platform local session host를 자체 런타임으로 도입한다.

이 session host가 제공해야 하는 핵심은 tmux와 동일한 도구명이 아니라, tmux급의 다음 이점이다.

- persistence
- attach/detach
- shared visibility
- scrollback
- lifecycle separation
- session identity

이 문서의 방향이 고정되면, 이후 구현은 `daemon owns PTY` 구조를 유지한 채 덧대는 방식이 아니라 `session host owns PTY` 구조로 바로 전환해야 한다.
