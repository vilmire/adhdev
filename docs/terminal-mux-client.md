# Terminal Mux Client Architecture

## Goal

`adhdev-sessiond` 위에 붙는 유저용 terminal client를 만든다.

이 client는 외부 터미널 앱 launcher가 아니라, `libghostty`를 terminal
substrate로 직접 사용하는 `adhdev` 자체 클라이언트의 코어가 된다.

즉 역할은:

- session host runtime attach
- scrollback/snapshot 복원
- pane split / focus / close
- user write takeover / release
- runtime event 반영

## Why This Exists

이전까지의 구현은 두 층으로 나뉘어 있었다.

- `adhdev-sessiond`: runtime plane
- web/dashboard: 관찰/제어 plane

하지만 사용자가 기대한 것은 web preview가 아니라:

- 별도 terminal client
- tmux급 작업 공간
- user와 agent가 같은 runtime을 공유

따라서 별도 client core가 필요하다.

## Current Package

- [packages/terminal-mux-core](../packages/terminal-mux-core)
- [packages/terminal-mux-cli](../packages/terminal-mux-cli)

이 패키지는 다음 두 가지를 묶는다.

1. `SessionHostMuxClient`
   - `@adhdev/session-host-core` IPC를 사용해서 runtime list/attach/snapshot/send/resize/takeover를 처리
2. `GhosttyTerminalSurface`
   - `@adhdev/ghostty-vt-node`를 직접 사용해서 각 pane의 terminal state를 유지

`terminal-mux-cli`는 이 코어 위에 올라가는 첫 번째 shell이다.

사용자 관점의 계층은 이제:

- session
- window
- pane

웹에서는 이 용어를 그대로 노출하지 않는다. 웹 표면에서는 다음처럼 번역한다.

- session → workspace
- window → tab
- pane → split

`runtime`은 pane 뒤에 붙는 내부 attach target으로 취급하며, 기본 UI의 1급 개념으로 올리지 않는다.

이다.

내부적으로는 기존 `workspace` persistence를 그대로 쓰되, 저장 이름을
`session--w--window` 규칙으로 그룹핑해서 session/window 계층을 만든다.

- `adhmux list`
- `adhmux sessions`
- `adhmux workspaces`
- `adhmux windows -t <session>`
- `adhmux rename-workspace <from> <to>`
- `adhmux delete-workspace <name>`
- `adhmux ls`
- `adhmux new-session -s <name> <runtimeKey...>`
- `adhmux attach-session -t <name>`
- `adhmux rename-session -t <from> <to>`
- `adhmux kill-session -t <name>`
- `adhmux has-session -t <name>`
- `adhmux new-window -t <session> [-n <window>] <runtimeKey...>`
- `adhmux select-window -t <session> <window>`
- `adhmux rename-window -t <session> <from> <to>`
- `adhmux kill-window -t <session> <window>`
- `adhmux snapshot <runtimeKey>`
- `adhmux open --workspace <name> [runtimeKey...]`

현재 `adhmux open`은:

- focused pane 직접 입력 전달
- `Ctrl+B` prefix 제어
- write takeover/release
- workspace 저장/복구
- numbered runtime chooser
- pane activity indicator / bell
- runtime split prompt fallback
- live control socket

까지 제공한다.

현재 제약:

- pane은 기본적으로 서로 다른 runtime을 여는 쪽이 맞다
- 같은 runtime을 두 pane에 중복 attach할 수는 있지만, PTY size는 runtime 단위라 geometry가 충돌한다
- 따라서 같은 runtime 다중 뷰는 메인 모델이 아니다
- 기본 모델은 `runtime당 primary terminal view 1개`이며, split은 다른 runtime 또는 다른 작업 단위를 여는 데 쓴다

현재 shell key model:

- normal mode: 입력은 focused pane으로 바로 전달
- prefix mode: `Ctrl+B`
- split:
  - `Ctrl+B %` vertical chooser
  - `Ctrl+B "` horizontal chooser
  - `Ctrl+B c` focused pane runtime 교체
  - chooser에서 `1-9` 선택, `/`로 manual runtime key 입력
- control:
  - `Ctrl+B [` copy-mode
  - `Ctrl+B /` focused pane search
  - `Ctrl+B y` focused pane clipboard copy
  - `Ctrl+B n` next pane
  - `Ctrl+B z` zoom/unzoom focused pane
  - `Ctrl+B H/J/K/L` focused pane resize
  - `Ctrl+B =` layout rebalance
  - `Ctrl+B t` takeover
  - `Ctrl+B r` release
  - `Ctrl+B x` close pane
  - `Ctrl+B s` save workspace
  - `Ctrl+B d` detach

copy-mode:

- `j/k` line down/up
- `d/u` half-page down/up
- `g/G` top/bottom
- `n/N` next/prev search result
- `y` copy focused pane text
- `enter` or `esc` exit

tmux-style command surface:

- `adhmux ls`
- `adhmux sessions`
- `adhmux windows -t <session>`
- `adhmux new-session -s <name> <runtimeKey...>`
- `adhmux attach-session -t <name>`
- `adhmux rename-session -t <from> <to>`
- `adhmux kill-session -t <name>`
- `adhmux has-session -t <name>`
- `adhmux new-window -t <session> [-n <window>] <runtimeKey...>`
- `adhmux select-window -t <session> <window>`
- `adhmux rename-window -t <session> <from> <to>`
- `adhmux kill-window -t <session> <window>`

headless control surface:

- `adhmux list-panes -t <name>`
- `adhmux capture-pane -t <name> [-p paneIndex|paneId]`
- `adhmux copy-pane -t <name> [-p paneIndex|paneId] [--clipboard] [--output <path>]`
- `adhmux search-pane -t <name> [-p paneIndex|paneId] <query>`
- `adhmux select-pane -t <name> -p <paneIndex|paneId>`
- `adhmux replace-pane -t <name> [-p paneIndex|paneId] <runtimeKey>`
- `adhmux split-window -t <name> [-h|-v] <runtimeKey>`
- `adhmux resize-pane -t <name> [-p paneIndex|paneId] -L|-R|-U|-D [amount]`
- `adhmux select-layout -t <name> even`
- `adhmux zoom-pane -t <name> [-p paneIndex|paneId]`
- `adhmux tree [--json]`
- `adhmux state -t <name> [--json]`
- `adhmux socket-info -t <name> [--json]`
- `adhmux control -t <name> <requestType> [payload-json]`
- `adhmux kill-pane -t <name> -p <paneIndex|paneId>`
- `adhmux send-keys -t <name> [-p paneIndex|paneId] <text>`

현재 headless control 명령은 workspace가 실제로 열려 있으면 저장 파일을 다시 복원하지 않고,
해당 `adhmux open` 프로세스의 live control socket을 먼저 사용한다. 즉 `split-window`,
`zoom-pane`, `send-keys`, `capture-pane` 같은 명령이 실행 중인 mux를 직접 조작한다.

## Scope

이 패키지는 아직 UI toolkit이 아니다.

포함:

- pane/workspace layout model
- runtime → pane binding
- libghostty-backed terminal state
- session host event projection

불포함:

- native window
- GPU rendering widget
- macOS/Windows/Linux launcher
- 최종 desktop shell

즉 현재는:

- reusable terminal mux core
- minimal terminal shell

까지 있고, 아직 최종 desktop client는 아니다.

## Next Layer

다음 단계는 이 코어를 실제 client shell에 붙이는 것이다.

후보:

- Tauri/Electron shell
- Swift/GTK native shell
- Ghostling-style minimal native app

그 shell은 이 패키지의:

- `SessionHostMuxClient`
- `GhosttyTerminalSurface`

를 사용해 window/pane UI만 올리면 된다.
