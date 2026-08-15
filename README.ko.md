[English](README.md) | [한국어](README.ko.md)

# ADHDev

**한 저장소 위의 코딩 에이전트 열 개 — 서로 밟지 않게, 브라우저와 폰에서.**

[![GitHub stars](https://img.shields.io/github/stars/vilmire/adhdev?style=social)](https://github.com/vilmire/adhdev/stargazers)
[![npm](https://img.shields.io/npm/v/adhdev?label=npm%20i%20-g%20adhdev)](https://www.npmjs.com/package/adhdev)
[![npm standalone](https://img.shields.io/npm/v/@adhdev/daemon-standalone?label=%40adhdev%2Fdaemon-standalone)](https://www.npmjs.com/package/@adhdev/daemon-standalone)
[![CI](https://github.com/vilmire/adhdev/actions/workflows/ci.yml/badge.svg)](https://github.com/vilmire/adhdev/actions)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

AI 코딩 에이전트는 이제 장시간 실행되는 백그라운드 워커가 되었습니다. ADHDev는 그것들을 위한 컨트롤 플레인입니다. 웹 또는 모바일 대시보드에서 — Claude Code, Codex, Kimi, Cursor CLI, Antigravity CLI를 나란히, 모든 머신에 걸쳐 — 에이전트 세션을 실행·감시·승인·조종하고, 완료된 작업을 `main`에 머지하는 무인 파이프라인에 수렴을 맡기세요.

**충돌 없는 병렬 에이전트.** 모든 태스크는 자기만의 git 워크트리에서 돌고, Refinery가 검증을 통과한 작업을 fast-forward로 착지시킵니다 — 머지 데이 숙취 없이.

웹사이트: **[adhf.dev](https://adhf.dev)** · 문서: **[docs.adhf.dev](https://docs.adhf.dev)**

<p align="center">
  <img src="docs/assets/readme/landing-command-center-demo-poster.jpg" alt="ADHDev 데스크탑 대시보드 — 채팅·터미널 뷰 전환, 패널 플로팅, 워크스페이스 분할" width="100%" />
</p>

**루프는 이렇습니다:** 채팅으로 태스크를 설명 → 코디네이터가 접수·태깅·큐잉 → 놀고 있는 머신이 새 워크트리로 가져감 → 레포 자체의 게이트가 판정 → `main`에 ff-머지, 워크트리 정리. 승인이 필요할 때만 폰이 울립니다.

이 저장소 자체가 그렇게 만들어집니다. 최근 `main` 커밋의 약 3분의 1이 `Auto-merge via Refinery` 커밋입니다 — 믿지 말고 직접 세어보세요: `git log --oneline -60 | grep -c "via Refinery"`.

---

## ADHDev를 쓰는 이유

### 🌐 웹 우선 제어
에이전트는 로컬에서 실행되고, 당신은 어디서든 조종합니다. 대시보드는 진짜 컨트롤 서피스입니다 — 활성 세션을 검사하고, 채팅·터미널 상태를 읽고, 작업을 승인 또는 중단하고, 적절한 히스토리를 다시 열고, 브라우저나 휴대폰에서 다음 지시를 보냅니다. 터미널을 붙잡고 기다릴 필요가 없습니다. 승인 알림에는 실행하려는 명령 원문이 그대로 실립니다 — `rm -rf build/` 승인과 `git push --force` 승인은 다른 반응 속도를 받아야 하니까요 (폰 푸시는 클라우드 에디션 기능).

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="docs/assets/readme/landing-desktop-detail.jpg" alt="ADHDev 데스크탑 세션 상세 뷰 — 채팅·코드·터미널 상태를 함께 표시" width="100%" />
    </td>
    <td width="50%" align="center" valign="top">
      <img src="docs/assets/readme/landing-mobile-notification-demo-poster.jpg" alt="ADHDev 완료 알림 데모 — 실행 중인 세션에 언제 돌아올지 알려주는 화면" width="100%" />
    </td>
  </tr>
</table>

### 🕸️ Repo Mesh — 진정한 멀티머신 병렬성
의존성이 있는 태스크를 큐에 넣고 코디네이터가 여유 용량을 가진 노드(노트북, 데스크탑, 빌드 서버)에 자동으로 디스패치하게 두세요. 이것은 한 호스트에 SSH로 접속하는 방식이 **아닌**, P2P 메시 위의 진정한 멀티머신 오케스트레이션입니다. 각 태스크는 별도의 워크트리에서 실행되므로 에이전트들이 서로를 방해하지 않습니다. 메시 엔진과 Refinery는 이 레포에 포함되어 있으며, 크로스-머신 디스패치는 클라우드 에디션에서 실행됩니다.

메시는 하나의 git 저장소에 바인딩되며, 원래 사람이 손으로 조율해야 했던 구성요소들을 소유합니다:

| | |
| --- | --- |
| **태스크 큐** | pull 기반. `pending → assigned → completed/failed`, `depends_on` 순서 지정과 재시도. idle 노드가 스스로 작업을 가져가므로 어긋날 push 스케줄러가 없습니다. |
| **미션** | 여러 태스크를 묶는 목표 단위. 재시작된 코디네이터가 전부 다시 큐에 넣는 대신 이어받습니다. |
| **워크트리 노드** | 병렬 태스크당 격리된 브랜치 체크아웃. 작업 디스패치 전에 자동 부트스트랩(install, 네이티브 리빌드, gitignore된 빌드 산출물)이 끝납니다. |
| **append-only 원장** | 모든 디스패치·완료·실패·스톨·체크포인트를 JSONL 이벤트로. 사후에 "실제로 무슨 일이 있었나"에 답할 수 있는 감사 기록입니다. |
| **운영 노트** | 런타임에 기록한 교훈(provider 특이사항, 복구 절차)이 이후 모든 코디네이터 프롬프트에 주입됩니다. 지식이 그것을 배운 세션보다 오래 삽니다. |
| **라이브 상태 프롬프트** | 코디네이터의 시스템 프롬프트는 정적 텍스트가 아닙니다 — launch 시점의 라이브 메시 상태(노드 헬스, 진행 중 미션, 최근 실패, 누적 노트)를 렌더한 것이고, 런타임 이벤트는 폴링 대신 세션에 직접 주입됩니다. |
| **난이도 라우팅** | 쉬운 작업은 저가 모델, 어려운 작업은 고가 모델 + deep thinking으로 — 노드 능력별로. 토큰 비용이 태스크 수가 아니라 난이도에 비례합니다. |

<p align="center">
  <img src="docs/assets/readme/landing-mesh-observability.jpg" alt="ADHDev 메시 관측 보드 — 레포의 원장·태스크 큐·활성 세션·노드·리파인 잡을 표시" width="100%" />
</p>

### ⚡ 설계 기반 비동기 — 한 곳에 대화
당신은 한 곳에 대화합니다. 코디네이터가 모든 워커와 머신을 비동기로 오케스트레이션합니다 — 코디네이터가 이벤트를 기다리고, 당신은 기다릴 필요가 없습니다. 각 에이전트 창 앞에 앉아 완료 여부를 확인할 필요 없이, 단일 코디네이터에 작업을 넘기면 모든 워커를 병렬로 구동하고 완료·승인·상태 이벤트가 실제로 도착할 때만 반응합니다 — 폴링도, 블로킹 대기도 없습니다. 당신에게는 하나의 대화, 그 아래엔 논블로킹 이벤트 루프.

### 🚢 Refinery — `main`에 무인 착지
병렬성은 작업이 실제로 머지될 때만 효과가 있습니다. Refinery는 완료된 태스크를 레포 자체의 검증 게이트·패치 동등성 검사·서브모듈 인식 fast-forward 머지·자동 워크트리 정리로 수렴합니다 — 무인으로. 에이전트가 완료하면, Refinery가 착지시킵니다. 위 메시 보드가 전체 파이프라인을 실시간으로 보여줍니다: 원장의 `DIRECT FAST FORWARD` 항목이 착지 완료된 태스크이고, `REFINE JOBS`가 진행 중인 수렴을 추적합니다.

### 🧩 서브모듈 인식 수렴 — 실제 모노레포에서 작동
병렬 워크트리와 무인 머지는 git 서브모듈이 등장하는 순간 취약해집니다. ADHDev는 이 케이스를 정면으로 다룹니다 — 이 프로젝트 자체가 서브모듈 모노레포(루트 레포 + AGPL 엔진 + 프로바이더 카탈로그를 서브모듈로)이며, 매일 이 메시와 Refinery를 도그푸딩합니다. Refinery는 수렴 중 서브모듈을 일급 시민으로 처리합니다:

- **도달 가능성 게이트** — 루트 브랜치가 `main`에 착지하기 전, 참조된 서브모듈 커밋이 서브모듈의 `origin/main`에서 도달 가능한지 검증합니다. 불가능하면 해당 커밋이 게시될 때까지 태스크를 차단 상태로 유지합니다.
- **패치 동등성 감지** — 서브모듈 커밋이 리베이스되거나 스쿼시되어 SHA가 바뀐 경우에도, Refinery는 *내용*이 이미 착지했는지 판단하여 이중 머지나 잘못된 다이버전스 플래그를 방지합니다.
- **원자적 포인터 범프** — 서브모듈 포인터 범프는 루트 변경과 함께 수렴하여, 무인 머지 중 루트가 깨지거나 댕글링 서브모듈 커밋을 가리키는 일이 없습니다.

### 🔺 MAGI — 교차 검증 결과
MAGI — Multi-Agent Ground-truth Insight. 네, 에반게리온 레퍼런스가 먼저였고 약자는 나중에 열심히 껴맞췄습니다. 읽기 전용 조사(버그 RCA, 설계 리뷰, 감사)를 여러 독립 에이전트에 동시에 던지고, 그들이 **어디서 갈리는지**를 읽습니다.

전제는 **높은 합의가 곧 정답은 아니라는 것**입니다. 같은 모델에 같은 프롬프트와 같은 컨텍스트를 주면 같은 환각이 나옵니다. 그래서 MAGI는 질문을 서로 다른 머신 *그리고* 서로 다른 provider에 fan-out하고, 출처가 실제로 얼마나 독립적이었는지로 합의에 가중을 둡니다:

- 답변은 **agreed / contested / dissent / singleton / source-coupled**로 분류됩니다 — 같은 provider나 같은 머신을 공유하는 리플리카끼리의 합의는 공유 환각 의심으로 **할인**되며, 두 번 세지 않습니다.
- 주 출력은 판정이 아니라 **`needs_verification` 목록**입니다 — 마찰이 곧 결과물입니다.
- 독립성은 희망이 아니라 강제입니다: 진짜 독립적인 타깃이 2개 미만이면 조용히 격하되지 않고 에러가 납니다. 리플리카는 읽기 전용이라 교차검증이 레포에 쓰기를 할 수 없습니다.

이 프로젝트의 실제 사례: 단일 RCA가 자신 있게 "코드 변경 불필요"로 결론냈던 것을, 독립 교차검증이 2층 복합 버그로 뒤집었습니다.

<p align="center">
  <img src="docs/assets/readme/landing-magi-synthesis.jpg" alt="ADHDev MAGI 종합 뷰 — 코디네이터가 독립적인 3개 에이전트 리플리카를 조정하여 합의된 것·이견이 있는 것·검증이 필요한 주장을 표시" width="100%" />
</p>

### 🔐 P2P 전송 (신뢰, 페이월 아님)
채팅·명령·스크린샷·원격 입력은 암호화된 WebRTC 데이터 채널을 통해 대시보드와 데몬 사이에서 직접 이동합니다. 서버는 시그널링과 경량 메타데이터만 처리합니다 — 작업 데이터는 다른 사람의 서버에 저장되지 않습니다. 이것은 설계의 신뢰 속성이며, 업셀이 아닙니다.

<p align="center">
  <img src="docs/assets/readme/landing-mobile-resume-demo-poster.jpg" alt="ADHDev 모바일 재개 플로우 — 폰에서 저장된 세션을 다시 여는 화면" width="320" />
</p>

---

## 어떻게 동작하는가

ADHDev는 에이전트를 대체하거나 직접 spawn하지 않습니다 — **이미 머신에 설치된 에이전트에 붙어서** 제어 표면을 제공합니다.

```
   브라우저 / 폰
         │  채팅, 명령, 스크린샷, 원격 입력
         ▼
   ┌───────────────┐        PTY          ┌──────────────────────┐
   │     데몬      │────────────────────▶│ Claude Code, Codex,  │
   │  (내 머신)    │◀────────────────────│ Cursor CLI, …        │
   │               │        CDP          ├──────────────────────┤
   │  · providers  │────────────────────▶│ Cursor, VS Code,     │
   │  · 세션       │                     │ Antigravity, …       │
   │  · 메시 + 큐  │       stdio (ACP)   ├──────────────────────┤
   │  · Refinery   │────────────────────▶│ Goose, Qwen, …       │
   └───────────────┘                     └──────────────────────┘
         │
         └── git 워크트리 ── 병렬 태스크당 격리된 체크아웃 1개
```

- **데몬이 통합을 소유합니다.** provider 4종 카테고리: `cli`(PTY), `ide`(Chrome DevTools Protocol), `extension`(CDP webview), `acp`(stdio 기반 Agent Client Protocol).
- **장수 런타임은 별도 프로세스입니다.** `adhdev-sessiond`가 PTY를 소유하므로 CLI 세션이 데몬 재시작·업그레이드를 견딥니다.
- **셀프호스트는 데몬과 직결**됩니다 — `localhost:3847`의 HTTP + WebSocket. 클라우드 에디션에서는 같은 데이터가 브라우저↔데몬 WebRTC 데이터채널을 타고, 서버는 시그널링만 합니다.

### 태스크를 큐에 넣으면 무슨 일이 일어나는가

```
mesh_enqueue_task  →  SQLite 큐 (pending)
                   →  idle 노드가 claim (assigned)
                   →  워커 에이전트가 자기 git 워크트리에서 실행
                   →  completed / failed  →  append-only 원장
                   →  Refinery: 레포 자체 게이트 → 패치 동등성 → ff-only 머지 → 정리
```

나머지 전부를 결정하는 네 가지 성질:

1. **코디네이터는 라우팅만 하고 구현하지 않습니다.** 코드를 직접 읽고 고치는 대신 메시 툴을 오케스트레이션하므로 컨텍스트가 작게 유지되고, 소유권이 데몬 재시작을 견딥니다.
2. **아무것도 폴링하지 않습니다.** reconcile 루프가 완료·승인·refine 이벤트를 코디네이터 세션에 주입합니다. 이벤트를 기다릴 뿐, 상태를 반복 조회하지 않습니다.
3. **증거는 git이고, 에이전트의 말이 아닙니다.** "완료"는 워커의 자기보고가 아니라 실제 git 상태와 커밋 체크포인트로 검증됩니다.
4. **애매하면 파이프라인이 멈춥니다.** Refinery는 force-push를 절대 하지 않고, 판단할 수 없는 것은 머지하지 않고 사람에게 넘깁니다.

> 더 깊이: [Repo Mesh 개발자 가이드](docs/repo-mesh/DEVELOPER.md) · [session-host](docs/self-hosted/session-host.md)

---

## 설치

**요구사항:** Node.js 22.x(아래 Windows 참고), git, 그리고 이미 설치·인증된 코딩 에이전트 최소 1개 — ADHDev는 이미 쓰고 있는 CLI를 구동합니다.

**권장 — `adhdev` CLI:**

```bash
npm install -g adhdev
adhdev standalone
```

**`http://localhost:3847`**을 여세요.

**standalone 패키지로 직접 셀프호스트:**

```bash
npm install -g @adhdev/daemon-standalone
adhdev-standalone
```

모든 것이 로컬 데몬으로 머신에서 실행되며 내장 대시보드가 포함됩니다 — standalone 경로에는 클라우드 계정이 필요하지 않습니다.

유용한 플래그:

```bash
adhdev standalone --host          # 동일 LAN의 다른 기기 접근 허용
adhdev standalone --port 8080     # 커스텀 포트
adhdev standalone --token mysecret # 스크립트/운영자 접근을 위한 토큰 인증
adhdev standalone --no-open       # 브라우저 자동 열기 비활성화
```

Standalone은 기본적으로 localhost 전용입니다. LAN 접근을 위해 `0.0.0.0`에 바인딩하는 경우, 토큰 인증이나 대시보드 비밀번호가 설정되지 않으면 대시보드가 경고를 표시합니다.

> **Windows 참고:** Windows + Node.js 24+는 현재 일반 시작/설치 경로에서 차단됩니다. Node.js 22.x 또는 문서에 설명된 PowerShell 설치 경로를 사용하세요.

정규 셀프호스트 문서:

- [셀프호스트 설정](docs/self-hosted/setup.md)
- [셀프호스트 구성](docs/self-hosted/configuration.md)
- [셀프호스트 로컬 API](docs/self-hosted/local-api.md)

### 처음 5분

1. **데몬 실행** — `adhdev standalone` 후 `http://localhost:3847` 열기. 대시보드가 이 머신에 설치된 에이전트를 자동 감지합니다.
2. **세션 시작.** provider(예: Claude Code)와 작업 디렉토리를 골라 시작하세요. 채팅으로 지시하거나 원시 터미널로 지켜볼 수 있고, 둘 사이를 토글합니다.
3. **작업을 보내고 자리를 비우세요.** 에이전트가 권한 요청에 걸리면, 보고 있지 않은 터미널을 막는 대신 대시보드 activity inbox에 승인 항목으로 올라옵니다. (그 승인을 폰 푸시로 받는 것은 클라우드 기능입니다.)
4. **설명으로 부족하면 스크린샷을 채팅에 붙여넣으세요** — 에이전트 컨텍스트로 바로 들어갑니다.
5. **머신 한 대로 메시를 시험해보세요.** `/mesh`에서 레포에 바인딩된 메시를 만들고 워크트리 노드를 clone한 뒤 태스크를 큐에 넣고 원장을 보세요: 디스패치 → 완료 → Refinery → `main`으로 fast-forward. 여기까지 전부 셀프호스트로 동작하며, **두 번째 머신**으로 넘어갈 때만 클라우드 에디션이 필요합니다.

막히면 [셀프호스트 설정 가이드](docs/self-hosted/setup.md)가 포트·LAN 노출·provider 감지 문제를 다룹니다.

---

## 지원 에이전트

ADHDev는 네 가지 프로바이더 카테고리를 통해 코딩 에이전트와 통신합니다 — `ide` (CDP), `extension` (CDP 웹뷰), `cli` (PTY), `acp` (stdio를 통한 Agent Client Protocol).

**CLI 에이전트** (PTY 구동, 대시보드에서 실행·제어):

| 에이전트 | 프로바이더 |
| --- | --- |
| Claude Code | `cli/claude-cli` |
| Codex CLI | `cli/codex-cli` |
| Cursor Agent | `cli/cursor-cli` |
| Google Antigravity CLI | `cli/antigravity-cli` |
| Hermes Agent | `cli/hermes-cli` |
| Kimi Code | `cli/kimi` |
| Opencode | `cli/opencode` |

**IDE** (Chrome DevTools Protocol 경유): Cursor, Google Antigravity, VS Code, VSCodium, Kiro, Windsurf, Trae, PearAI.

**IDE 익스텐션** (CDP 웹뷰): Claude Code (VS Code), Codex, Cline, Roo Code.

**ACP 에이전트** (stdio, Agent Client Protocol): 32개 내장 어댑터 — Gemini CLI, Qwen Code, Goose, GitHub Copilot, Cursor (ACP), Claude Agent, Codex CLI, Kimi CLI, Cline, Kilo, Junie, OpenHands 등.

> **내장 ≠ 검증됨.** ADHDev는 광범위한 인벤토리를 제공합니다. 카탈로그에 있다는 것은 통합이 존재한다는 의미이지, 엔드-투-엔드로 검증되었다는 의미가 아닙니다. 지원 수준은 다양합니다. 라이브 정책을 참조하세요:
>
> - [지원 프로바이더](https://docs.adhf.dev/reference/supported-providers)
> - [지원 IDE](https://docs.adhf.dev/reference/supported-ides)
> - [호환성 및 주의사항](https://docs.adhf.dev/guide/compatibility)

ADHDev는 에이전트의 API 키를 **관리하지 않습니다** — 각 도구가 자체 인증을 처리합니다. ADHDev는 설치 상태를 감지하고 오류를 표시합니다.

### 직접 에이전트 추가하기

provider는 포크해야 하는 코드가 아니라 데이터입니다. provider는 버전이 있는 매니페스트(`provider.v1.json`)와, 도구를 감지하고·실행하고·출력을 채팅 턴으로 파싱하고·승인 프롬프트를 인식하는 방법을 기술한 스크립트로 구성됩니다. `~/.adhdev/providers/`에 넣으면 대시보드가 집어갑니다 — 같은 이름의 내장 provider보다 사용자 오버라이드가 우선하므로, 릴리스를 기다리지 않고 깨진 파서를 로컬에서 고칠 수 있습니다.

- 이 레포의 `web-devconsole`은 라이브 세션에 대고 provider 스크립트를 작성·테스트하는 Monaco 기반 에디터입니다.
- 검증 티어는 명시적입니다: **Verified / Partial / Unverified**. "내장"은 통합이 존재한다는 뜻일 뿐입니다.
- 가이드: [Provider SDK](https://docs.adhf.dev/guide/provider-sdk) · [Provider 가이드](https://docs.adhf.dev/guide/providers)

카탈로그에 없는 에이전트를 동작시켰다면, 그것이 이 레포에 가장 유용한 기여입니다.

---

## Star 히스토리

[![Star History Chart](https://api.star-history.com/svg?repos=vilmire/adhdev&type=Date)](https://star-history.com/#vilmire/adhdev&Date)

---

## 커뮤니티

- 💬 **Discord** — <!-- COMMUNITY: Discord invite link (pending, see LAUNCH-ASSETS-PREP) --> _(초대 링크 곧 공개)_
- 🐛 [Issues](https://github.com/vilmire/adhdev/issues)
- 🤝 [기여하기](CONTRIBUTING.md)
- 📋 [변경 로그](CHANGELOG.md)

---

## 이 레포에 포함된 것

이것은 오픈소스 셀프호스트 에디션(AGPL-3.0)입니다. 호스팅 클라우드 운영은 이 레포에 포함되지 않습니다. 셀프호스트는 세 가지 로컬 레이어로 구성됩니다:

1. `daemon-standalone`은 로컬 HTTP/WebSocket 서버를 제공하고 웹 UI를 서빙합니다.
2. `daemon-core`는 IDE, CLI, 익스텐션, ACP 통합을 관리합니다.
3. `session-host-daemon` (`adhdev-sessiond`)은 데몬 재시작 후에도 CLI 세션이 살아남을 수 있도록 장기 PTY 런타임을 소유합니다.

| 경로 | 목적 |
| --- | --- |
| `packages/daemon-core` | 공유 엔진: 프로바이더, CDP, 명령 라우팅, 세션/런타임 상태 |
| `packages/daemon-standalone` | 로컬 HTTP/WS 서버 및 번들 standalone UI |
| `packages/web-core` | 공유 React 페이지, 컴포넌트, 훅, 전송 추상화 |
| `packages/web-standalone` | Standalone 대시보드 앱 |
| `packages/web-devconsole` | 프로바이더/개발 진단 UI |
| `packages/session-host-core` | 세션 호스트 프로토콜, 클라이언트, 레지스트리, 링 버퍼, 레이블 |
| `packages/session-host-daemon` | 장기 PTY 런타임 소유 프로세스 |
| `packages/terminal-mux-*` | 로컬 터미널 멀티플렉서 스택 |
| `packages/terminal-render-web` | 브라우저 사이드 터미널 렌더링 지원 |
| `packages/ghostty-vt-node` | 런타임/멀티플렉서 레이어에서 사용하는 Ghostty VT 바인딩 |

### Standalone API 서피스

- `GET /api/v1/status` — sessions[] 배열이 신뢰의 근거
- `POST /api/v1/command`
- `GET /api/v1/runtime/:sessionId/snapshot`
- `GET /api/v1/runtime/:sessionId/events`
- `GET /api/v1/mux/:workspace/state`
- `POST /api/v1/mux/:workspace/control`
- `ws://localhost:3847/ws`

레퍼런스: [docs/openapi.yml](docs/openapi.yml) · [셀프호스트 API 문서](docs/self-hosted/local-api.md)

---

## 소스에서 개발

```bash
git clone https://github.com/vilmire/adhdev.git
cd adhdev
npm install
npm run build
npm run dev
```

유용한 워크스페이스 스크립트:

```bash
npm run dev:daemon
npm run dev:web
npm run dev -w packages/web-devconsole
```

---

## OSS vs 클라우드

엔진은 오픈소스입니다. 클라우드가 더하는 것은 **도달 계층** — 계정, 2대 이상의 머신, 인터넷 너머 원격 접속, 푸시입니다.

| | OSS (셀프호스트) | 클라우드 ([adhf.dev](https://adhf.dev)) |
| --- | :--: | :--: |
| 대시보드 | `localhost:3847` | `adhf.dev`, 모든 브라우저·폰 |
| 계정 필요 | ❌ 인증 없음 | OAuth (GitHub / Google) |
| 머신 수 | **1대** | 플랜별 1 / 2 / 5대 |
| 도달 범위 | localhost, `--host`로 LAN까지 | **어디서든** (P2P WebRTC + 막힌 네트워크용 TURN) |
| 모든 provider (CLI / IDE / extension / ACP) | ✅ | ✅ |
| Repo Mesh·Refinery·MAGI·워크트리 노드 | ✅ **단일 머신 메시는 완전히 로컬 동작** | ✅ |
| **머신 간** 메시 | ❌ (머신 간 릴레이 없음) | ✅ |
| 푸시 알림 (승인 / 완료 / 에러) | ❌ | ✅ |
| 호스팅 REST API + API 키 | ❌ (로컬 API만) | ✅ |
| 가격 | 무료, 쿼터 없음 | Free / Pro / Ultra |

머신 한 대만 쓰고 자기 네트워크 안에 머문다면 셀프호스트가 제품 전부입니다 — 기능 제한도, 쿼터도 없습니다. 클라우드는 두 번째 머신을 붙이거나 집 밖에서 에이전트에 접근하려는 순간을 위해 존재합니다.

---

## 라이선스

AGPL-3.0-or-later. [LICENSE](LICENSE)를 참조하세요.
