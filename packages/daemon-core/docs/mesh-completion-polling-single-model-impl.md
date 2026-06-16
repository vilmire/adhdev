# Mesh 완료-인지 폴링 단일모델 — 구현 반영 (unresolved-delegate durable forward)

선행 설계: base node `docs/refactoring/2026-06-16-mesh-completion-polling-single-model.md`
(이 워크트리엔 설계 원문이 없으므로, 아래는 **실제 구현한 변경**만 기록한다. 설계 전문 재작성 아님.)

브랜치: `fix/autoapprove-relay-wipe-and-polling-residual` (1단계 autoApprove 보존 fix 위에 이어짐).

---

## 구현 반영 — push 유지 + durable 재시도 (설계 §2.1의 게이트 결정 결과)

### 결정 배경 (설계 게이트 §2.1 전제 / §4 리스크 2)

설계는 unresolved-delegate 완료를 "워커 로컬 큐 적재 → 코디 PHASE 1 pull 회수"로 전환하길 선호하되,
**전제**로 "unresolved 워커 데몬 큐가 코디 PHASE 1 pull 순회에 잡혀야 한다"를 최대 리스크 게이트로 명시했다.

코드 확인 결과 이 전제는 **충족 불가**:

- 코디의 유일한 원격 pull인 `pullRemoteNodeQueues`(`mesh-reconcile-loop.ts`)는 **`mesh.nodes`만 순회**한다.
- unresolved-delegate 워커는 정의상 코디 mesh의 **멤버가 아니다**(`resolveWorkerDelegateRouting` → `mesh_unresolved`,
  로컬 mesh 레코드 없음). 따라서 어떤 `mesh.node`에도 대응되지 않아 **PHASE 1 pull로 영영 회수 불가**.
- 코디가 비멤버 데몬을 pull하는 다른 경로(데몬 레지스트리 등)는 없다.

→ 설계의 "큐 적재→코디 pull" 방향은 이 케이스에 **구조적으로 막힘**. 비멤버 워커에 대한 **유일한 도달 경로는
워커→코디로의 directed push**(`mesh_forward_event`)다. 그래서 push를 **제거하지 않는다**. 대신 1회 fire-and-forget
push가 전송 실패 시 `delivery_unroutable`로 완료를 영영 유실하던 것을 **durable(at-least-once)** 로 만든다.

### 변경 1 — `forwardUnresolvedDelegateEvent`를 durable push로 (`mesh-events-coordinator.ts`)

- push 전에 완료이벤트를 **워커 로컬 영속 outbox에 적재**(아래 변경 3). 그 후 best-effort 즉시 push.
- 즉시 push가 ack(`success !== false`)되면 outbox 행을 **acked(drained=1)** 표시 → 재전송 안 함.
- 즉시 push가 실패/거부면 outbox 행을 **남겨둠** → reconcile 틱이 재시도.
- 즉 1회성 fire-and-forget → **at-least-once 재시도**. 단일 P2P 실패로 완료가 유실되지 않는다.

### 변경 2 — reconcile PHASE 0 재시도 드레이너 (`mesh-reconcile-loop.ts`)

- `runMeshReconcileTick` 시작에 **PHASE 0** 추가(cloud, `dispatchMeshCommand` 존재 시).
- `retryUnresolvedDelegateForwards`: 만료 정리 → outbox **peek**(드레인 아님) → 각 항목 push →
  ack 시에만 drained 표시, 실패/거부 시 다음 틱 재시도.
- 재시도 주기 = 기존 reconcile 틱(기본 4s, `MESH_RECONCILE_INTERVAL_MS` 1s~60s 오버라이드).
- PHASE 1(mesh.nodes pull) / PHASE 2(라이브 CLI inject)는 **무변경**.

### 변경 3 — 워커측 durable outbox (`mesh-unresolved-forward-outbox.ts`, 신규)

기존 mesh 이벤트 영속 인프라(`mesh_pending_events` SQLite 테이블)를 **재사용**. 새 평행 메커니즘 만들지 않음.

- 예약 합성 mesh id `__unresolved_forward_outbox__` 네임스페이스 하에 적재(실 mesh 큐와 충돌 불가).
  코디별 스코핑은 기존 `coordinator_daemon_id` 컬럼 사용 → 한 워커가 여러 코디로 forward 가능.
- **멱등키**: `${coordinatorDaemonId}::${buildPendingEventFingerprint(...)}` + 테이블의
  `UNIQUE(mesh_id, fingerprint)` 인덱스 + `INSERT OR IGNORE` → 같은 완료 재발사 시 1행만 적재.
- **수신측 dedup**: 코디의 `handleMeshForwardEvent` → `injectMeshSystemMessage` →
  `queuePendingMeshCoordinatorEvent`가 자기 fingerprint로 재dedup → 즉시 push와 재시도 push가
  중복 도달해도 무해.
- **무한 누적 방지**: `queuedAt` 기준 **max age 30분** 만료(`expireStaleUnresolvedDelegateForwards`).
  코디가 영구 도달 불가면 30분 후 drop하며 fail-loud warn 로그. 만료=진짜 유실이라 silent 아님.

신규 store 헬퍼(`mesh-runtime-store.ts`): `markPendingEventsDrainedById`(ack),
`deletePendingEventsById`(만료). 둘 다 id 타게팅.

### approval 경로 영향 (설계 §5 충돌점)

`agent:waiting_approval`은 `MESH_FORCE_INJECT_EVENTS`에 포함돼 완료와 같은 큐→force-inject 경로를 공유한다.
본 변경은 **`isMeshCoordinatorEvent`/`injectMeshSystemMessage`의 큐 적재 진입점이나 force-inject 집합을 건드리지
않는다** — 새 outbox는 `isDelegate=false`(unresolved) 분기에서만 동작하는 별도 경로다. 따라서 approval(및 1단계
autoApprove 보존)과 충돌 없음. resolved-delegate 완료/승인은 기존 큐 경로 그대로.

---

## 단일 큐-pull 모델에서의 예외 (명시)

> **비멤버 워커는 코디 pull 대상이 아니라, push 유지 + durable 재시도가 유일 도달 경로다.**

resolved-delegate 완료(워커가 코디 mesh 멤버)는 설계대로 큐 적재→코디 PHASE 1 pull/도구 드레인의 단일 모델을 탄다.
unresolved-delegate 완료(비멤버 원격 워커)만 이 예외 — 단, push가 이제 영속 outbox 백킹 + 틱 재시도라 단일
P2P 실패에 silent-drop되지 않으므로, "완료는 어떤 데몬의 영속 스토어에 기록되고 유실되지 않는다"는 단일모델의
신뢰 불변식 자체는 보존된다.
