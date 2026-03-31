# Cloud Session Handoff

## Context

`adhdev-cloud`는 이 OSS 레포를 서브모듈로 가져다 쓰고 있다.

이번 컷오버로 OSS 쪽 canonical runtime/output model은 더 이상 `managedIdes`, `managedClis`, `managedAcps`가 아니라 `sessions[]`다.

cloud/P2P 레이어는 이 변경을 전제로 붙어야 한다.

## Canonical Contract

### 1. Status payload

cloud relay, P2P merge, browser client는 모두 아래를 canonical로 본다.

- `StatusReportPayload.sessions`
- `SessionEntry.id`
- `SessionEntry.parentId`
- `SessionEntry.transport`
- `SessionEntry.kind`

세션 transport 의미:

- `cdp-page`: IDE workspace session
- `cdp-webview`: IDE child agent session
- `pty`: CLI session
- `acp`: ACP session

### 2. Event payload

`status_event`는 이제 `targetSessionId`를 canonical target으로 본다.

필수 규칙:

- UI bubble target은 `targetSessionId`
- toast click target은 `targetSessionId`
- approval action target도 `targetSessionId`
- `ideId`는 route resolution 보조값일 뿐 canonical target이 아님

현재 OSS daemon-core는 provider event fanout 시 아래를 보장한다.

- `instanceId`
- `targetSessionId`
- `providerType`
- `providerCategory`

cloud relay는 이 값을 지우거나 legacy key로 치환하면 안 된다.

### 3. Command envelope

frontend → cloud → daemon command는 `targetSessionId` 기준으로 라우팅해야 한다.

예시:

```json
{
  "type": "send_chat",
  "payload": {
    "targetSessionId": "18d2bd01-b4ca-4015-9e26-e9b9d1d053a7",
    "message": "hello"
  }
}
```

허용되는 route id:

- daemon transport 주소
- machine id / daemon id

canonical payload target:

- `targetSessionId`

즉 cloud bridge는 daemon/machine transport target과 session runtime target을 분리해서 다뤄야 한다.

## What Was Removed

cloud 쪽에서 아래 구조를 계속 기대하면 안 된다.

- `managedIdes`
- `managedClis`
- `managedAcps`
- `_targetInstance`
- `agent_stream_*` command family
- `ideId:agentType` 조합으로 extension tab target 만들기
- `:cli:`, `:acp:`, `:ide:` 문자열 파싱으로 target 추론하기

이 레거시는 OSS 쪽에서 이미 제거됐다.

## What Cloud Must Do

### 1. Relay `sessions[]` without reshaping

server WS relay, daemon status cache, P2P merge layer는 `sessions[]`를 그대로 유지해야 한다.

금지:

- `sessions[]`를 다시 `ides/clis/acps`로 쪼개기
- child session을 parent IDE 안의 ad-hoc field로 재구성하기

허용:

- UI convenience projection을 따로 만들되 원본은 반드시 `sessions[]` 유지

### 2. Preserve `targetSessionId` on events

`status_event` relay/web push/service worker payload에서 아래 필드는 그대로 전달해야 한다.

- `targetSessionId`
- `ideId` if present
- `providerType`
- `providerCategory`
- `modalButtons`
- `modalMessage`

특히 approval notification action payload는 `targetSessionId`를 잃으면 안 된다.

## Service Worker / Push Rules

브라우저 알림 action payload는 아래 규약을 따라야 한다.

```json
{
  "type": "notification_action",
  "action": "approve",
  "targetSessionId": "<session-id>",
  "ideId": "<route-id-if-available>",
  "targetKey": "<optional same as session-id>"
}
```

우선순위:

1. `targetSessionId`
2. `targetKey`
3. `ideId`

cloud PWA/service worker는 최소한 `targetSessionId`를 실어야 한다.

## Deep Link Rules

Dashboard `?activeTab=`는 이제 다음을 모두 허용한다.

- `sessionId`
- route `ideId`
- `tabKey`
- `ideType`
- `agentType`

cloud에서 dashboard deep link를 만들 때는 `sessionId`를 우선 사용하면 된다.

예:

- `/dashboard?activeTab=<session-id>`

## P2P Merge Rules

cloud/browser merge layer는 세션 identity를 절대 새로 만들면 안 된다.

규칙:

- 동일 세션 판정 기준은 `session.id`
- child 관계 기준은 `parentId`
- freshness compare는 세션 단위로 한다
- compact payload가 richer payload를 덮어쓰면 안 된다

특히 `cdp-webview` child session은 독립 session으로 유지해야 한다.

금지:

- parent IDE에 child session message/state를 덮어쓰기
- child session을 route-string으로 다시 합성하기

## Minimal Cloud Checklist

`adhdev-cloud`에서 이 OSS 서브모듈 업데이트 후 확인할 항목:

1. status cache/schema가 `sessions[]`를 그대로 저장하는지
2. websocket relay가 `status_event.targetSessionId`를 보존하는지
3. push/service worker notification action payload에 `targetSessionId`가 들어가는지
4. dashboard deep link 생성 시 `sessionId`를 쓰는지
5. P2P merge key가 `session.id`인지
6. legacy `managed*` 필드에 대한 접근이 없는지
7. command bridge가 `_targetInstance` 없이 `targetSessionId`로만 daemon에 보내는지

## Quick Validation Commands

cloud 레포에서 이 서브모듈 버전 반영 후 최소 확인:

1. dashboard가 받는 status payload에 `sessions`만 있는지
2. Codex approval event payload에 `targetSessionId`가 있는지
3. push action 클릭 시 `resolve_action` payload에 `targetSessionId`가 들어가는지
4. `/dashboard?activeTab=<child-session-id>`로 child session 탭이 열리는지

## Intentional Split

canonical target과 transport target은 다르다.

- transport target: daemon/machine/route id
- runtime target: `targetSessionId`

cloud 레이어는 이 둘을 섞지 말아야 한다.

이 원칙만 지키면 relay, P2P, push, browser state merge 모두 같은 세션 모델로 붙는다.
