# Session Model Cutover

## Goal

`ide`, `cli`, `acp`, `extension` 중심 구조를 버리고, daemon-core와 web-core 전체를 `session` 하나의 런타임 모델로 통일한다.

이번 작업은 점진적 마이그레이션이 아니라 컷오버를 전제로 한다.

- 기존 `managedIdes`, `managedClis`, `managedAcps` 제거
- UI는 더 이상 category-specific payload를 직접 해석하지 않음
- command routing은 category 분기가 아니라 capability 분기로 전환
- `extension`은 독립 top-level category가 아니라 IDE에 매달린 session으로 재정의

## Why Current Structure Breaks

현재 공통 계약은 `providers/contracts.ts`에 있지만, 런타임 모델은 3겹으로 갈라져 있다.

1. Provider output contract
- `readChat`, `sendMessage`, `resolveAction` 등은 어느 정도 공통

2. Runtime entity model
- IDE는 CDP page + child extension stream
- CLI는 PTY terminal + synthetic status
- ACP는 structured chat protocol + tool call state

3. Payload / UI model
- `managedIdes`
- `managedClis`
- `managedAcps`
- IDE 안에만 `agentStreams`

결과적으로 공통 출력 위에 category별 lifecycle, identity, status, routing이 다시 갈라진다.

## Cutover Principle

출력 포맷이 이미 많이 공통이므로, provider script를 뜯는 것이 아니라 daemon-core의 중간 모델을 갈아엎는 방식으로 간다.

즉,

- raw provider/runtime state는 남긴다
- external canonical model은 `SessionEntry[]` 하나로 통일한다
- UI와 command layer는 `SessionEntry`만 기준으로 동작한다

## Canonical Runtime Model

```ts
type SessionTransport =
  | 'cdp-page'
  | 'cdp-webview'
  | 'pty'
  | 'acp';

type SessionKind =
  | 'workspace'
  | 'agent';

type SessionStatus =
  | 'starting'
  | 'idle'
  | 'generating'
  | 'waiting_approval'
  | 'error'
  | 'stopped'
  | 'disconnected'
  | 'panel_hidden';

type SessionCapability =
  | 'read_chat'
  | 'send_message'
  | 'new_session'
  | 'list_sessions'
  | 'switch_session'
  | 'resolve_action'
  | 'terminal_io'
  | 'resize_terminal'
  | 'change_model'
  | 'set_mode'
  | 'set_thought_level';

type SessionEntry = {
  id: string;
  parentId: string | null;
  providerType: string;
  providerName: string;
  kind: SessionKind;
  transport: SessionTransport;
  status: SessionStatus;
  workspace: string | null;
  title: string;
  messages: ChatMessage[];
  activeModal: ModalInfo | null;
  inputContent: string;
  model?: string;
  mode?: string;
  autoApprove?: string;
  capabilities: SessionCapability[];
  meta?: Record<string, unknown>;
};
```

## Session Rules By Transport

### 1. IDE main page

IDE window 자체를 session으로 본다.

- `transport = 'cdp-page'`
- `kind = 'workspace'`
- `parentId = null`
- title/workspace/model은 IDE-level state

이 세션은 “부모 컨테이너” 역할이다.

### 2. IDE extension agent

Codex/Cline/Roo 같은 webview agent는 별도 session이다.

- `transport = 'cdp-webview'`
- `kind = 'agent'`
- `parentId = <ide-session-id>`

즉 지금의 `agentStreams`는 top-level payload field가 아니라 그냥 child session 목록이 된다.

### 3. CLI / PTY agent

CLI는 PTY를 쓰더라도 세션 모델에 넣는 데 문제 없다. 핵심은 “터미널 출력 스트림”과 “채팅/상태 추론”을 같은 session의 두 표현으로 보는 것이다.

- `transport = 'pty'`
- `kind = 'agent'`
- `parentId = null`
- `messages`는 parse 가능하면 채움, 없으면 빈 배열이어도 됨

중요한 점:

- PTY는 structured chat이 아니라 terminal-first transport다
- 그렇다고 category를 분리할 이유는 없다
- `capabilities`에 `terminal_io`, `resize_terminal`를 추가해서 차이를 표현하면 충분하다

즉 CLI는 “특수 카테고리”가 아니라 “PTY transport를 가진 agent session”이다.

### 4. ACP agent

ACP는 structured chat transport다.

- `transport = 'acp'`
- `kind = 'agent'`
- `parentId = null`
- tool calls, config options, modes는 `meta` 또는 별도 ACP-specific subfields로 노출

ACP는 세션 모델상으로 CLI와 동등한 agent session이다. transport만 다르다.

## Identity Rules

현재 제일 위험한 부분 중 하나가 `instanceId`, `ideType`, `agentType`, `extensionId`, `managerKey`가 섞여 쓰이는 점이다.

컷오버 후에는 아래 규칙만 허용한다.

- `SessionEntry.id`: 외부 canonical identity
- `parentId`: 계층 관계
- `providerType`: provider definition identity
- `meta.managerKey`: CDP/PTY/ACP 내부 transport key

금지:

- UI가 `instanceIdMap`나 `managerKey`를 직접 해석하는 것
- UI command가 `ideType`와 `agentType`를 조합해서 대상을 유추하는 것

## Capability-First Command Model

현재 `chat-commands.ts`는 `provider.category`를 기준으로 계속 분기한다.

컷오버 후에는 command 대상이 `sessionId` 하나여야 한다.

```ts
executeSessionCommand({
  sessionId,
  command: 'read_chat' | 'send_message' | 'new_session' | 'switch_session' | 'resolve_action',
  args,
})
```

Command router는 다음만 알아야 한다.

1. `sessionId -> SessionRuntimeHandle`
2. 해당 세션의 transport
3. 해당 세션의 capabilities

실제 구현은 transport adapter가 맡는다.

- CDP page adapter
- CDP webview adapter
- PTY adapter
- ACP adapter

즉 category switch가 아니라 transport dispatch가 되어야 한다.

## New Internal Layer

daemon-core에 아래 계층을 추가한다.

### SessionRegistry

모든 실행 중 세션의 단일 truth source.

역할:

- session create/update/remove
- parent-child relationship 관리
- runtime handle 저장
- status event source 통합

### SessionRuntimeHandle

transport별 런타임 핸들.

```ts
type SessionRuntimeHandle = {
  transport: 'cdp-page' | 'cdp-webview' | 'pty' | 'acp';
  readChat(): Promise<ReadChatResult>;
  sendMessage?(text: string): Promise<void>;
  newSession?(): Promise<void>;
  listSessions?(): Promise<ListSessionsResult>;
  switchSession?(id: string): Promise<void>;
  resolveAction?(action: 'approve' | 'reject'): Promise<void>;
  writeRaw?(data: string): Promise<void>;
  resize?(cols: number, rows: number): Promise<void>;
};
```

### SessionProjection

transport/runtime state를 `SessionEntry`로 투영하는 계층.

이 레이어만 UI payload를 만든다.

## Hard Cut Scope

이번 컷오버에서 같이 삭제해야 하는 것:

- `ManagedIdeEntry`
- `ManagedCliEntry`
- `ManagedAcpEntry`
- `ManagedAgentStream`
- `managedIdes`
- `managedClis`
- `managedAcps`
- IDE 내부 전용 `agentStreams` payload
- `provider.category` 기반 chat command routing

## Files That Must Change Together

### daemon-core

- `shared-types.ts`
- `status/builders.ts`
- `status/snapshot.ts`
- `status/reporter.ts`
- `commands/chat-commands.ts`
- `commands/router.ts`
- `commands/handler.ts`
- `commands/cli-manager.ts`
- `cdp/setup.ts`
- `agent-stream/*`
- `providers/*-provider-instance.ts`

### web-core / web-standalone

- `BaseDaemonContext.tsx`
- `status-transform.ts`
- `daemon-utils.ts`
- `buildConversations.ts`
- `Dashboard*`
- `IDE.tsx`
- `Machines.tsx`
- `AgentStreamPanel.tsx`
- browser notification hooks

## PTY-Specific Decisions

CLI는 컷오버 때 가장 쉽게 망가질 수 있으므로 아래 결정을 먼저 고정한다.

1. PTY raw stream은 유지한다
- terminal panel은 계속 필요하다

2. PTY session도 `messages`를 갖는다
- parse 가능하면 채운다
- parse 실패해도 세션 자체는 정상으로 본다

3. PTY는 terminal-first capability를 가진다
- `terminal_io`
- `resize_terminal`

4. `mode: 'terminal'` 같은 CLI 전용 shape는 제거한다
- 세션의 transport/capabilities로 표현한다

5. PTY status debounce 로직은 SessionRuntimeHandle 내부로 이동한다
- 지금 `CliProviderInstance`에 박혀 있는 generating debounce는 transport adapter concern이다

## ACP-Specific Decisions

ACP는 structured protocol이므로 오히려 CLI보다 세션 모델에 더 잘 맞는다.

결정:

- tool calls는 `messages[].toolCalls`와 `meta.activeToolCalls`로 유지
- config options / modes는 `meta.configOptions`, `meta.availableModes`로 이동
- `ManagedAcpEntry` 전용 필드는 없앤다

## Event Model

현재도 이벤트명과 상태명이 섞여 흔들린다.

컷오버 후 이벤트는 `session:*` 네임스페이스로 통일한다.

- `session:generating_started`
- `session:generating_completed`
- `session:waiting_approval`
- `session:stopped`
- `session:disconnected`
- `session:long_generating`

이벤트 payload에는 반드시 `sessionId`가 들어가야 한다.

## Recommended Execution Order

이번 작업은 호환 계층 없이 한 번에 자른다.

1. 새 `SessionEntry`, `SessionRegistry`, `SessionRuntimeHandle` 타입 추가
2. provider instance / agent stream / cli/acp runtime를 session runtime handle로 재구성
3. status payload를 `sessions[]` 하나로 교체
4. command routing을 `sessionId` 기반으로 교체
5. web-core를 `sessions[]`만 소비하도록 교체
6. 기존 `managed*`와 category-specific 해석 제거

## Done Criteria

아래가 동시에 만족되면 컷오버 완료다.

- daemon status payload에 `sessions[]`만 존재
- UI에 `managedIdes`, `managedClis`, `managedAcps` 참조가 없음
- `chat-commands.ts`에 `provider.category` 기반 분기가 없음
- extension session이 top-level child session으로 보임
- CLI PTY session이 같은 UI 모델에서 정상 표시/입력/리사이즈됨
- ACP session이 동일한 세션 모델에서 표시되고 config 조작 가능
- stale IDE/window cleanup이 `session` 단위로 동작함

## Non-Goals

- provider script 자체를 전면 재작성하는 것
- CLI parsing quality를 이번 컷오버에서 완벽히 올리는 것
- ACP rich content UX를 이번 컷오버에서 완전히 새로 만드는 것

이번 작업의 목적은 “지원 대상별 예외 구조 제거”다. 기능 확장은 그 다음이다.
