# Changelog

All notable changes to ADHDev will be documented in this file.

## [0.9.17] - 2026-04-25

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.16] - 2026-04-25

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.15] - 2026-04-25

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.14] - 2026-04-25

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.13] - 2026-04-25

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.12] - 2026-04-25

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.11] - 2026-04-24

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.10] - 2026-04-24

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.9] - 2026-04-24

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.8] - 2026-04-24

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.7] - 2026-04-24

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.6] - 2026-04-24

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.5] - 2026-04-24

### Added
- **web-core**: Added focused regressions covering owner-window scheduling for detached popouts and chunked browser terminal replay under heavy CLI output.

### Fixed
- **terminal-render-web / web-core**: Replayed browser terminal output in bounded chunks so heavy multi-CLI backlogs stop blocking input behind giant xterm writes.
- **terminal-render-web / web-core**: Moved detached popout terminal scheduling, focus, and resize handling onto the popup window/document realm instead of the opener window.
- **daemon-core**: Hardened CLI fresh-session defaults, provider session-id validation, and saved-history persistence behavior for Hermes and related CLI runtimes.

### Changed
- **docs**: Documented the current Safari detached-popout terminal limitation in the self-hosted standalone reference while keeping Chrome/same-window paths as the recommended workaround.

## [0.9.4] - 2026-04-23

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.3] - 2026-04-23

### Added
- 

### Fixed
- 

### Changed
- 
## [0.9.2] - 2026-04-23

### Added
- **web-core**: Added focused regressions for detached popout chrome cleanup and the explicit PTY transport contract used by measured terminal surfaces.

### Fixed
- **terminal-render-web / web-core**: Removed subtle measured-terminal right-edge clipping, exposed horizontal pan when the measured surface really overflows, and kept non-overflow slack intentionally centered in browser layouts.
- **web-core / web-standalone**: Restored standalone browser terminal input by routing PTY writes through an explicit transport contract instead of relying on subscription-shaped `sendData` behavior.
- **web-core**: Deduplicated detached popout headers and hardened detached-window terminal rendering so new-window terminals stay visually fresh.

### Changed
- **web-core / web-cloud / web-standalone**: Split terminal transport responsibilities more explicitly with a dedicated `sendPtyInput` path while preserving cloud direct PTY delivery and standalone command routing.

## [0.9.1] - 2026-04-23

### Added
- **web-core**: Added focused architectural boundary regressions covering daemon-authority notifications, dashboard/root state extraction, hidden-tab/group-layout API boundaries, overlay dialog/history boundaries, and the final command-action/render-hub cleanup seams.

### Fixed
- **daemon-core**: Clear stale CLI approval state so previously actionable approval prompts do not linger after the live runtime state has already moved on.
- **web-core**: Treat live dashboard status as metadata-only and preserve transcript authority on explicit transcript-bearing paths instead of broad frontend merge heuristics.
- **web-core**: Remove browser-local transcript/notification overlays so dashboard unread/read/history/task-complete behavior stays daemon-owned.

### Changed
- **web-core**: Simplified dashboard state boundaries by moving local orchestration/state blobs behind dedicated hooks and reducing `Dashboard.tsx` to composition/wiring-oriented responsibilities.
- **web-core**: Kept `DashboardOverlays` as a thin render hub while grouping props by overlay surface instead of maintaining one large flat prop contract.
## [0.9.0] - 2026-04-23

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.102] - 2026-04-23

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.101] - 2026-04-22

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.100] - 2026-04-22

### Added
- **web-core**: Added a `Reconnect now` action to the disconnected/offline dashboard banner so local and shared dashboard surfaces can retry the server connection without a full page refresh.

### Fixed
- **daemon-core**: Restored Hermes approval gating so waiting approvals stay actionable instead of slipping into an already-running state.
- **terminal-render-web / web-core**: Reduced the default CLI terminal rows again and corrected measured zoom hit-testing so pointer interaction matches the scaled terminal viewport.

### Changed
- README now leads with the concrete self-hosted product value: one local dashboard for IDE and CLI agents with no cloud dependency.
## [0.8.99] - 2026-04-22

### Added
- **daemon-core / web-core**: Added native-backed saved-history indexing and a simpler launch flow so the dashboard can start fresh by default while still offering saved-history continuity when you explicitly choose it.

### Fixed
- **web-core / terminal-render-web**: Scale measured terminal rendering from the actual viewport size so the browser terminal stays aligned after layout changes.

### Changed
- The new-session flow now treats hosted-runtime recovery as a separate interruption path instead of mixing it into ordinary launch.
## [0.8.98] - 2026-04-22

### Added
- **session-host**: Exposed a browser-safe defaults entry so web surfaces can consume the shared default sizing/runtime helpers without unsafe imports.

### Fixed
- **terminal-render-web / web-core**: Raised the default CLI terminal height to 48 rows before the later measured-layout follow-up.
- **web-core**: Unified the dashboard new-session CTA copy so the launch affordance is consistent across dashboard entry points.

### Changed
- Continued tightening the shared launch/recovery surface around the dashboard new-session UX.
## [0.8.97] - 2026-04-22

### Added
- 

### Fixed
- **daemon-core**: Guarded CLI auto-approve re-entry so held keys and repeated events no longer spam duplicate approvals.
- **daemon-core / web-core**: Render daemon-owned chat transcripts directly instead of rewriting them again on the frontend, preserving the canonical transcript shape.

### Changed
- **web-core**: Removed now-unused frontend transcript merge helpers after the daemon-owned transcript path became canonical.
## [0.8.96] - 2026-04-22

### Added
- 

### Fixed
- **web-core**: Tightened active-chat merge typing so transcript hydration stays aligned with the daemon-owned session shape.
- **daemon-core**: Restored the full canonical Hermes resume history instead of collapsing recovery into an incomplete conversation view.

### Changed
- 
## [0.8.95] - 2026-04-22

### Added
- 

### Fixed
- 

### Changed
- Version bump only; no OSS runtime behavior changed beyond recording the prior release notes in the changelog.
## [0.8.94] - 2026-04-21

### Added
- Added focused daemon-core regressions covering live Hermes approval recovery: parsed waiting-approval projection, parsed approval resolution before adapter modal sync, and command-layer approval fallback when provider state still reports `generating`.

### Fixed
- **daemon-core**: Align Hermes dangerous-command approval resolution with the live surfaced transcript so `resolve_action` can deny/approve when the approval bubble and actionable buttons are already visible, even before adapter-owned modal state fully catches up.
- **web-core / web-cloud**: Keep explicit chat opens pinned to the latest message instead of reusing stale transcript anchors after hydration.

### Changed
- **daemon-standalone**: Align standalone terminal snapshot flow more closely with cloud by keeping runtime snapshots pull-based instead of seeding hidden panes with unsolicited buffers on websocket connect.

## [Unreleased]

### Fixed
- **daemon-core**: `ProviderLoader` no longer silently adopts a sibling `adhdev-providers/` checkout. Auto-adoption now requires either `ADHDEV_USE_SIBLING_PROVIDERS=1` or a `.adhdev-provider-root` marker file in the candidate directory, restoring the documented default. When adoption fires, the loader writes a one-shot stderr notice per unique sibling path per process.
- **web-core**: Unified the CLI terminal input with the shared `ChatInputBar` so pane heights and send-routing stay aligned with the chat view; streamlined Claude CLI bar controls.
- **web-core**: Clarified dashboard header connection status copy.

### Added
- **daemon-core**: `ProviderSourceConfigSnapshot.userDirSource` reports how the effective provider root was resolved (`explicit` / `sibling-env` / `sibling-marker` / `home-default`); surfaced in `adhdev daemon:status`.

## [0.8.93] - 2026-04-21

### Fixed
- **web-core**: Ignore daemon-only cloud status for session staleness so idle UIs no longer age out while the daemon still has a healthy uplink.

## [0.8.92] - 2026-04-21

### Fixed
- **web-core**: Retry rejected chat-tail subscriptions so transcript hydration recovers from transient relay drops.
- **web-core**: Harden compact chat-tail transcript reconciliation against out-of-order stream updates.
- **daemon-core**: Preserve long Hermes turns in the rolling transcript buffer instead of truncating them mid-thought.

## [0.8.91] - 2026-04-21

### Fixed
- Align cloud status and metadata loading so the dashboard converges on a consistent view after reconnect.
- Reduce cloud transport parity gaps between WS metadata and P2P data channels.
- **daemon-core**: Keep Hermes status aligned with the live transcript and approval state.

## [0.8.90] - 2026-04-21

### Fixed
- Stabilize the Claude CLI adapter lifecycle around spawn/teardown races.
- **web-core**: Emit a full snapshot after chat-tail hydrate so late subscribers render from a complete state.

## [0.8.89] - 2026-04-21

### Fixed
- Stabilize Hermes and Claude CLI runtime handling.

## [0.8.88] - 2026-04-20

### Changed
- Version bump only; no user-visible changes.
## [0.8.87] - 2026-04-20

### Changed
- Re-cut the OSS release after `0.8.86` so the published package set and downstream cloud release chain could converge on a clean `main`-based `v0.8.87` tag without reusing tags.

## [0.8.86] - 2026-04-20

### Fixed
- Fixed the standalone font preferences regression in `packages/daemon-standalone/test/standalone-preferences.test.ts` by removing the `.ts` extension import that broke standalone typecheck during release verification.

### Changed
- Reissued the OSS package set as `v0.8.86` after the standalone font-preferences follow-up so downstream cloud verification could consume a clean published build.

## [0.8.85] - 2026-04-20

### Added
- Added standalone-only font preferences across the standalone daemon and dashboard, including saved preferences, settings UI, and regression coverage for custom chat/code/terminal font choices.
- Added startup-restore and session-host transport regressions covering hosted-runtime restore on standalone startup and resume behavior for restored/orphan snapshots.
- Added Claude CLI parser regressions covering long transcript retention, approval surfacing, chopped spinner-prefix cleanup, and exact-answer residue stripping.

### Fixed
- Stabilized Claude and Hermes CLI live session state so tool/progress bubbles, short replies, long replies, and sequential turns commit against the correct transcript instead of stalling in stale `generating` state or dropping prior assistant turns.
- Fixed standalone hosted-session restore by defaulting startup restore on, resuming restored session-host snapshots, and preferring richer committed transcript state over degraded startup parser surfaces.
- Fixed CLI send-guard behavior so non-intervention providers block second-turn sends while parsed status is still generating, while Hermes keeps its immediate idle-commit path for visible settled assistant turns.

### Changed
- Consolidated standalone/session-host recovery semantics around daemon-owned transcript state and provider-script-driven completion detection rather than browser-local or parser-fallback heuristics.

## [0.8.84] - 2026-04-20

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.83] - 2026-04-20

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.82] - 2026-04-20

### Added
- Added focused daemon-core regression coverage for parser crash surfacing, full CLI/ACP transcript retention, unsliced runtime overlay message retention, and pending-event flush behavior across CLI/IDE/extension/ACP providers.
- Added focused web-core regression coverage for hidden-tab persistence keys, mobile dashboard mode settings, larger chat visibility defaults, and daemon-derived dashboard notification overlay reconciliation.

### Fixed
- Fixed shared CLI/ACP chat continuity so parser/read-chat paths no longer silently fall back to stale partial transcripts, recent-50 transcript caps are removed, and ACP message bodies are no longer truncated to 2000 characters.
- Fixed shared provider state surfaces so synthetic runtime messages and pending provider events are no longer silently sliced to 50 entries before live chat state or event flush consumers can see them.

### Changed
- Re-centered dashboard state around daemon-derived conversation/notification truth by tightening hidden-tab identity, notification overlay reduction, and related mobile dashboard mode wiring instead of relying on fragmented local fallback state.
## [0.8.81] - 2026-04-19

### Added
- Added focused web-core regression coverage locking the mobile dashboard warm chat-tail policy so chat-mode phones explicitly disable recent-idle background warming while desktop and workspace-mode keep the default behavior.

### Fixed
- Reduced shared mobile dashboard churn by disabling recent-idle warm chat-tail retention in mobile chat mode, so phones stop background-warming recently idle conversations while active/modal sessions still stay warm.

### Changed
- Split the shared dashboard warm transcript policy by surface: desktop keeps the existing warm-tail defaults, while mobile chat mode now takes the lower-churn path tuned for messenger-style use.

## [0.8.80] - 2026-04-19

### Added
- Added focused regression coverage for optimistic CLI view-mode overrides so dashboard and machine tabs keep the intended mode while transient transport-result loss is reconciled.

### Fixed
- Restored shared warm chat-tail retention for visible conversations so background-open chats recover their recent transcript continuity instead of always restarting cold.
- Fixed shared CLI view-mode UX so lost or late transport results no longer immediately discard optimistic chat/terminal toggles that likely already applied remotely.

### Changed
- Rebalanced dashboard and machine chat-mode wiring around warm-tail retention plus transport-aware CLI mode override reconciliation.

## [0.8.79] - 2026-04-19

### Added
- Added regression coverage for standalone session-host namespace resolution so reserved `adhdev` overrides now exercise the warning-first fallback path instead of only the old hard-error behavior.

### Fixed
- Fixed standalone session-host isolation so explicitly setting `ADHDEV_SESSION_HOST_NAME=adhdev` no longer aborts startup; standalone now falls back to `adhdev-standalone` and surfaces a warning instead of fighting the global daemon namespace.

### Changed
- Exposed richer session-host app-name resolution metadata to shared daemon-core and standalone surfaces so downstream launch/status paths can report whether a namespace came from defaults, an explicit override, or an isolation fallback.

## [0.8.78] - 2026-04-19

### Added
- Added focused web-core regression coverage for larger CLI-like chat-tail hydration windows, truncated-tail cursor recovery, dashboard chat-controls visibility preferences, and command-log filtering for low-value transcript-read noise.

### Fixed
- Fixed shared dashboard chat continuity so active CLI-heavy conversations no longer get stuck looking like a tiny recent tail after refresh or tail-only live resubscribe updates, and trimmed daemon command-log churn from `read_chat` / `mark_session_seen` spam.

### Changed
- Made the shared chat controls bar opt-in behind a persisted visibility toggle, removed dashboard-level warm transcript subscriptions that were adding background load, and clarified standalone auth/runtime/local-API surfaces across the OSS docs.

## [0.8.77] - 2026-04-18

### Added
- Added regression coverage for recovery-snapshot hot-session filtering, including live-snapshot runtime metadata propagation and fallback classification when explicit session-host surface kinds are missing.

### Fixed
- Fixed shared chat-tail hot polling so stopped recovery snapshots no longer stay in the active/finalizing flush set while recently updated live and ordinary inactive hosted runtimes still receive the expected completion-tail grace window.

### Changed
- Threaded session-host runtime lifecycle and recovery metadata through the shared live status/session entry surface so standalone and cloud flush classification can make liveness-aware decisions.

## [0.8.76] - 2026-04-18

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.75] - 2026-04-17

### Added
- Added focused regression coverage ensuring shared web-core/web-cloud terminal surfaces no longer expose PTY resize helper paths while the resize flow is intentionally disabled.

### Fixed
- Fixed the shared browser terminal surface so compatibility stubs, standalone connection managers, and the shared `CliTerminal` wrapper stop advertising resize callbacks that no longer have a supported transport path.

### Changed
- Finished the temporary PTY resize shutdown by removing the remaining shared resize helper surface from web consumers instead of only dropping the daemon-side envelope handler.

## [0.8.74] - 2026-04-17

### Added
- Added regression coverage for saved-history pagination, legacy provider control-result bridging, Claude Code VS Code IDE-level control routing, CLI send guards, and shared dashboard saved-history load-state helpers.

### Fixed
- Fixed saved-history pagination so older messages page backward correctly without duplicating the recent live tail, and modal reopen flows stop needlessly reloading the same saved transcript.
- Fixed shared chat send UX so blocked or failed sends keep the draft, approval-gated sessions report inline guidance instead of transcript spam, and intervention-friendly CLI providers can explicitly accept mid-generation input.
- Fixed shared provider control routing so Claude Code VS Code can fall back to IDE-level model/mode controls without misrouting session-scoped usage requests, while legacy model/mode payloads normalize into typed control results.

### Changed
- Tightened shared dashboard/chat state around saved-history hydration, truncated-message duplicate detection, optimistic local user echoes, and scroll-restore signatures during live transcript refreshes.

## [0.8.73] - 2026-04-17

### Fixed
- Fixed the new shared subscription-update cursor type so downstream cloud verification no longer sees `knownMessageCount`/`lastMessageSignature`/`tailLimit` as optional after importing the daemon-core helper surfaces.
- Fixed shared browser builds by exposing chat-signature helpers through a dedicated browser-safe daemon-core subpath and updating web-core to stop importing the full Node-oriented root entry for message signature hashing.

### Changed
- Added a dedicated `@adhdev/daemon-core/chat/chat-signatures` export path and follow-up release wiring so browser consumers can keep using the shared chat signature helper without pulling the full daemon-core runtime bundle.

## [0.8.72] - 2026-04-17

### Added
- Added shared daemon-core regression coverage for transport subscription update preparation, including cursor refresh-on-noop behavior and normalized modal duplicate suppression across runtimes.
- Added web-core regression coverage for notification label/preview fallback selection so messenger inbox cards keep using the shared display contract.

### Fixed
- Fixed cloud and standalone transport parity so `session.chat_tail` and `session.modal` updates now share the same daemon-core payload preparation, modal sanitization, delivery-signature gating, and cursor/sequence mutation rules.
- Fixed dashboard notification/inbox display fallback drift so title/preview selection uses shared web-core selectors instead of diverging inline chains.

### Changed
- Extracted shared `daemon-core` subscription update helpers under `src/chat/` and tightened web-core notification display helpers around a single selector contract.

## [0.8.71] - 2026-04-17

### Added
- Added regression coverage for chat scroll snapshot fingerprinting and seeded-transcript preservation when live chat-tail refreshes only return a recent slice.

### Fixed
- Fixed shared dashboard chat continuity so incoming assistant updates no longer restore stale viewport snapshots or replace the active conversation with an older-looking recent-tail transcript.

### Changed
- Hydrated live dashboard chat state from the active conversation before chat-tail refreshes and gated scroll restoration on message fingerprint matches.

## [0.8.70] - 2026-04-17

### Added
- Added regression coverage for extension provider-session surfacing, runtime unread marker reuse across session-id churn, explicit panel-open support, and hosted CLI busy-send guards.

### Fixed
- Fixed shared extension/agent-stream unread plumbing so provider-backed sessions keep a stable `providerSessionId` through status snapshots, read markers, and resumed-runtime notification dedupe instead of resurrecting unread/task-complete state.
- Fixed hosted CLI send behavior so busy PTY runtimes fail explicitly instead of silently dropping follow-up prompts while a previous response is still in progress.

### Changed
- Split shared stream-session actions into explicit passive session selection vs panel-opening capabilities and exposed the richer session capability metadata to dashboard surfaces.
## [0.8.69] - 2026-04-16

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.67] - 2026-04-16

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.66] - 2026-04-16

### Added
- Added fail-closed provider contract guards for structured input capability checks, canonical `read_chat` payload validation, and regression coverage around CLI/ACP send paths and timestamp-only transcript updates.

### Fixed
- Fixed shared provider/runtime plumbing so unsupported CLI and ACP inputs now fail explicitly instead of silently degrading, and invalid control result/read-chat payloads stop at the contract boundary instead of being normalized from legacy shapes.
- Fixed shared mobile/dashboard conversation state so sparse live session snapshots preserve chat mode and timestamp-only assistant completions still invalidate inbox/conversation recency correctly.

### Changed
- Formalized provider schema requirements around explicit `capabilities` metadata and typed control results, and tightened the shared runtime to prefer canonical provider output contracts over legacy fallback shapes.

## [0.8.65] - 2026-04-16

### Fixed
- Fixed the upstream provider read-chat contract regression test so CI runners without a populated `~/.adhdev/providers/.upstream` cache skip the environment-specific checks instead of failing the entire release pipeline.

### Changed
- Tightened the shared status snapshot timing fallback so timestamp-only assistant messages still contribute to completion markers and hot-session recency when `receivedAt` is absent.

## [0.8.64] - 2026-04-16

### Added
- Added regression coverage for ACP rich message-kind surfacing, upstream read-chat kind contracts, dashboard CLI conversation refresh/view-mode overrides, hot-session chat-tail classification, and timestamp-only status snapshot fallbacks.

### Fixed
- Fixed shared daemon/web chat plumbing so richer `thought`, `tool`, and `terminal` messages survive ACP and IDE-stream normalization paths instead of collapsing back into generic assistant output.
- Fixed standalone/cloud CLI chat-tail delivery so very short completions stay hot long enough to publish their final assistant reply, even when runtime snapshots only provide `timestamp` instead of `receivedAt`.
- Fixed dashboard CLI continuity so completed replies refresh in-place and explicit chat-mode overrides are not dropped on transient null server-mode updates.

### Changed
- Tightened shared status snapshot timing and dashboard conversation cache signatures around actual last-message content/time instead of relying only on coarse status transitions.

## [0.8.63] - 2026-04-16

### Fixed
- Fixed the shared web-core status-transform typing so merged session `activeChat` state always normalizes to `null` instead of leaking `undefined`, unblocking downstream cloud/web builds during release verification.

### Changed
- Followed up the `v0.8.62` standalone CLI/dashboard fixes with a release-compatibility patch so the same shared surfaces build cleanly in downstream cloud consumers.

## [0.8.62] - 2026-04-16

### Added
- Added focused regression coverage for Hermes CLI waiting-state parsing, standalone compact session control metadata, CLI view-mode overrides, and dashboard conversation refresh invalidation.

### Fixed
- Fixed Hermes CLI turn completion handling so waiting-state providers keep long-running responses open until detectStatus truly settles and parse/detect scripts can see `isWaitingForResponse`.
- Fixed shared standalone/dashboard CLI conversations so top-level CLI and ACP sessions preserve controls/chat metadata and completed replies appear in chat view without requiring a terminal/chat toggle refresh.

### Changed
- Tightened shared standalone status merging and dashboard conversation caching so live session snapshots preserve richer active-chat state more reliably.

## [0.8.61] - 2026-04-15

### Added
- Added shared chat-message normalization/builders plus provider-effect persistence helpers so richer semantic kinds can be emitted and preserved consistently across daemon-core provider categories.
- Added regression coverage for chat-message normalization, CLI fallback message shaping, provider-effect persistence, command-output rendering, and live chat-cache refresh behavior.

### Fixed
- Fixed CLI/IDE/extension/ACP runtime plumbing so richer message kinds such as `tool`, `terminal`, `thought`, and `system` are no longer collapsed during runtime merge/persistence paths.
- Fixed shared dashboard command-output/chat surfaces so fuller tool/terminal output and fresher live conversation copies survive cache merges and render without unintended clipping.

### Changed
- Unified shared daemon-core/web-core message-kind handling around reusable builders and richer effect-bubble metadata instead of ad-hoc per-provider literals.

## [0.8.60] - 2026-04-15

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.59] - 2026-04-15

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.58] - 2026-04-14

### Added
- Added richer saved-history continuity helpers across shared web surfaces, including selected-session summaries, recent-launch saved-history cues, compact recent-use timestamps, text/workspace/model filters, sort controls, and resume-ready-only filtering.
- Added first-class shared utilities and regression coverage for saved-history filtering/state, recent-launch presentation, and wrapped workspace-browse responses.

### Fixed
- Fixed hosted web CLI terminal input routing by accepting the actual session target id consistently across PTY input and resize paths.
- Fixed workspace browsing in cloud-backed launch flows by unwrapping wrapped command-envelope responses before reading directory entries.

### Changed
- Refined shared dashboard/machine/mobile continuity UX so saved-history search/filter/sort state persists across reopen flows within the same scope and normal resume paths stay subtle but easier to scan.
## [0.8.57] - 2026-04-14

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.56] - 2026-04-14

### Fixed
- Kept the standalone/published runtime surface coherent by using `runtimeTarget`-style targeting and clearer attach vs recover behavior for hosted runtime commands.

### Changed
- Made ordinary CLI launches fresh by default while keeping saved-history resume and hosted runtime recovery explicit.
- Unified runtime, dashboard, and machine wording around `Start fresh`, `Resume saved history`, `Recover hosted runtime`, and `Saved History`.
## [0.8.55] - 2026-04-14

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.54] - 2026-04-14

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.53] - 2026-04-14

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.52] - 2026-04-13

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.51] - 2026-04-13

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.50] - 2026-04-13

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.49] - 2026-04-13

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.48] - 2026-04-13

### Added
- Added Hermes CLI provider control confirmations and session-reset handling so dashboard actions can safely trigger `new`, `retry`, and `undo`-style commands.

### Fixed
- Preserved CLI provider session metadata and cleared dashboard transcript state correctly when providers signal a fresh session.

## [0.8.47] - 2026-04-12

### Fixed
- Stabilized Claude Code VS Code webview targeting and preserved more live session control metadata across status refreshes.

### Changed
- Refreshed OSS and standalone documentation to match the current self-hosted runtime, session-host, mux, and local API surfaces.

## [0.8.46] - 2026-04-12

### Changed
- Refined dockview workspace controls and recovery behavior so dashboard layouts restore more cleanly after panel and reconnect churn.
## [0.8.45] - 2026-04-12

### Changed
- Version-only release to keep published OSS packages aligned. No standalone surface changes landed in this tag.
## [0.8.44] - 2026-04-12

### Fixed
- Narrowed dockview popout window typing to prevent popout-specific web-core regressions in dashboard and standalone builds.
## [0.8.43] - 2026-04-12

### Changed
- Refined dockview popout behavior, layout persistence, and related dashboard workspace interactions.
## [0.8.42] - 2026-04-12

### Changed
- Version-only release to keep published OSS packages aligned. No standalone surface changes landed in this tag.
## [0.8.41] - 2026-04-12

### Added
- Dashboard and standalone surfaces now enforce the version update policy and expose version update state more consistently.
## [0.8.40] - 2026-04-12

### Changed
- Version-only release to keep published OSS packages aligned. No standalone surface changes landed in this tag.
## [0.8.39] - 2026-04-11

### Changed
- Version-only release to keep published OSS packages aligned. No standalone surface changes landed in this tag.
## [0.8.38] - 2026-04-11

### Added
- Live last-message previews in dashboard conversation lists.
- CDP multi-window handling in `daemon-core` plus the Claude Code VS Code catalog entry used by the launcher inventory.
## [0.8.37] - 2026-04-11

### Changed
- Version-only release to keep published OSS packages aligned. No standalone surface changes landed in this tag.
## [0.8.36] - 2026-04-11

### Fixed
- Improved completed-state contrast in mobile inbox views.

### Changed
- Backfilled recent changelog entries.
- Reverted an experimental builtin vendor provider-loader fallback before release, so this version does not introduce a new fallback contract.
## [0.8.35] - 2026-04-10

### Fixed
- Remote dialog now keeps the tab you selected instead of snapping back to the preferred agent tab when conversations refresh.
- CLI and ACP dashboard sends no longer stack a web pending bubble on top of daemon-side optimistic user turns.
- CLI chat sends now commit the user turn only after the submit boundary is actually crossed, avoiding false "sent" states when the prompt was only typed but not submitted.
- Duplicate P2P `p2p_ready`/`connected` churn no longer fan out repeated full status reports to peers and the server.

### Changed
- Server compact session payloads now use an explicit typed schema and stop forwarding transient UI/control metadata that is only needed on the P2P path.
- Shared dashboard chrome and dialog surfaces now consistently use the SVG icon set instead of mixed emoji/text close affordances.
## [0.8.34] - 2026-04-10

### Fixed
- Mobile machine and inbox surfaces no longer show `Connected` until the P2P session is actually connected.
- CLI terminal-mode conversations hide the chat send bar instead of exposing chat input in terminal-only views.
- Dashboard guide access remains available from the lower-right corner after the initial hint collapses.

### Changed
- Polished dashboard and standalone shell presentation, including notification bulk toggles, remote dialog behavior, and capabilities page removal from the standalone surface.
## [0.8.33] - 2026-04-10

### Added
- Added initial Vitest coverage for `daemon-core` and `web-core`, covering state store, recent activity, provider loader settings, compact status transforms, dashboard message utilities, and mobile/dashboard helper contracts.

### Fixed
- Release preflight now catches downstream cloud integration regressions before the cloud version bump step.

### Changed
- Tightened `daemon-core` and `web-core` typing across provider loading, command routing, compact daemon status handling, and dashboard conversation/presenter layers.
## [0.8.32] - 2026-04-10

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.31] - 2026-04-10

### Added
- 

### Fixed
- 

### Changed
- 
## [Unreleased]

### Changed
- Removed internal-only design notes from the public OSS docs set and normalized the remaining web-core UI copy/comments to English.

## [0.8.30] - 2026-04-10

### Fixed
- Auto-approve now works consistently across ACP, IDE, CLI, and extension-backed approval flows, with silent auto-approval history bubbles instead of approval alerts when auto-approve is enabled.
- Approval polling no longer surfaces transient `waiting_approval` UI states when the action was auto-approved immediately.

### Changed
- Enabled auto-approve by default for provider settings and added provider-specific positive-action hint matching so each provider can customize approval button selection priority.
## [0.8.29] - 2026-04-10

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.28] - 2026-04-09

### Added
- `adhdev service install / uninstall / status` — register the daemon as an OS-level auto-start service (macOS LaunchAgent, Windows Startup folder).
- Session host duplicate prune actions exposed through the daemon control plane.

### Fixed
- Codex extension session switching now works against the Recent tasks history view; `list_sessions` and `switch_session` flows validated.
- Codex CLI promoted to `partial` after validating fresh launch, live send/read, saved-session resume, daemon-restart reconnect, and stop.

### Changed
- Removed legacy `AccentColor` configuration field from daemon settings in favor of the existing CSS custom-property theme system.
## [0.8.27] - 2026-04-09

### Fixed
- Added the remaining mobile dashboard chat and launch-confirm updates that were left out of the `0.8.26` release.
- Surface reconnecting and connecting states in the mobile inbox and expose optional model/CLI argument inputs in the launch confirm dialog.

## [0.8.26] - 2026-04-09

### Fixed
- Standardized provider `sendMessage` payloads around `params.message` while preserving legacy string fallback for older routers.
- Hardened daemon provider-script dispatch so legacy IDE providers no longer leak `[object Object]` when receiving object params.
- Fixed terminal mux and mobile dashboard typing regressions that were blocking the OSS release build.

## [0.8.25] - 2026-04-09

### Fixed
- Reconcile live IDE and extension runtime sessions back into the daemon session registry so Codex child sessions recover without relying on a full daemon restart.
- Hard-fail session-scoped extension commands when `targetSessionId` is stale instead of falling back to string-based route guesses.
- Prefer active extension stream conversations over empty native IDE tabs in the dashboard so Codex chats open on the conversation that actually has messages.

## [0.8.24] - 2026-04-08

### Fixed
- Removed the xterm canvas fallback dependency from `terminal-render-web` so release builds no longer depend on the incompatible `@xterm/addon-canvas` + xterm 5 pairing.

## [0.8.23] - 2026-04-08

### Added
- Provider-driven controls, control values, effects, and notification routing for CLI/IDE/extension providers.
- CLI saved-session resume flow from both the machine page and the dashboard new-session dialog.
- Config-only terminal sizing escape hatch via `terminalSizingMode: "fit"` while keeping the dashboard GUI locked to the measured default.

### Fixed
- Standalone empty-state copy and machine-registration gating so install guidance only appears when no machines are registered.
- macOS Cursor launch/restart handling and process detection for standalone daemon IDE launch.
- Claude CLI parsing, startup state handling, generating hold behavior, restart transcript restore, and timestamp ordering for persisted chat history.
- Terminal renderer module loading so the xterm-based terminal initializes correctly under Vite dev/HMR.

### Changed
- Replaced `ghostty-web` with xterm.js-based terminal rendering with WebGL and DOM fallback paths.
- Made dashboard terminal sizing daemon-authoritative by default and removed frontend transcript re-parsing from chat rendering.
- Simplified CLI transcript rendering so providers own parsing and the web renderer only decides presentation from explicit metadata.

## [0.8.22] - 2026-04-08

### Added
- 

### Fixed
- 

### Changed
- 

## [0.8.21] - 2026-04-08

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.20] - 2026-04-08

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.19] - 2026-04-08

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.16] - 2026-04-08

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.15] - 2026-04-07

### Fixed
- **Windows CLI Isolation** — Lazy-load `node-pty` only when the local PTY backend is actually used, so session-host based CLI launches do not pull the native PTY module into the daemon process on Windows/Node 24.
- **Mobile PWA Header Insets** — Removed duplicate top safe-area padding on mobile chat and machine detail screens when running in standalone/PWA mode.

### Changed
- **Windows Node 24+ Standalone Guard** — Treat Windows + Node.js 24+ as unsupported for standalone install/startup until the PTY/session-host path is stable there.

## [0.8.14] - 2026-04-07

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.13] - 2026-04-07

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.12] - 2026-04-07

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.11] - 2026-04-07

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.10] - 2026-04-07

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.9] - 2026-04-07

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.8] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.7] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.6] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.5] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.4] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.3] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.2] - 2026-04-06

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.1] - 2026-04-05

### Added
- 

### Fixed
- 

### Changed
- 
## [0.8.0] - 2026-04-05

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.46] - 2026-04-05

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.45] - 2026-04-04

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.44] - 2026-04-04

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.43] - 2026-04-04

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.42] - 2026-04-04

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.41] - 2026-04-04

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.40] - 2026-04-04

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.39] - 2026-04-03

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.38] - 2026-04-03

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.37] - 2026-04-03

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.36] - 2026-04-03

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.35] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.34] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.33] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.32] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.31] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.30] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.29] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.28] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.27] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.26] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.25] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.24] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.23] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.22] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.21] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.17] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.16] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.15] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.14] - 2026-04-02

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.6] - 2026-04-01

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.5] - 2026-04-01

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.4] - 2026-04-01

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.3] - 2026-04-01

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.2] - 2026-03-31

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.1] - 2026-03-31

### Added
- 

### Fixed
- 

### Changed
- 
## [0.7.0] - 2026-03-31

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.79] - 2026-03-31

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.77] - 2026-03-31

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.76] - 2026-03-31

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.75] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.74] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.73] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.72] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.71] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.70] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.69] - 2026-03-30

### Added
- 

### Fixed
- 

### Changed
- 
## [0.6.68] - 2026-03-30

### Added
- `scripts/version-bump.sh` — OSS-first version bump workflow
- Automated npm publish via CI on `v*` tags (daemon-core + daemon-standalone)

### Fixed
- Multi-window CDP detection: use `target.id` for stable manager keys
- Periodic scan no longer skips IDEs with existing connections (finds new windows)
- Extension settings now resolve correctly for multi-window manager keys

### Changed
- Provider loader: stable upstream directory independent of custom provider path
- DevServer: auto-load PROVIDER_GUIDE.md and CDP_SELECTOR_GUIDE.md for auto-implement
- Standalone daemon: enable provider hot-reload in `--dev` mode

## [0.6.67] - 2026-03-30

### Changed
- Replaced emoji icons with monochrome SVG components across settings and notification UI
- Updated `ToggleRow` to accept `ReactNode` labels for SVG icon support

### Fixed
- CI shebang verification for daemon-standalone build

## [0.6.66] - 2026-03-29

### Added
- ACP provider settings system with runtime hot-reload
- Provider clone/fix modals for machine detail page
- Version mismatch banner with one-click upgrade on dashboard
- `--help` flag support for daemon-standalone CLI

### Changed
- Improved agent stream polling with configurable intervals
- Enhanced status reporting with delta updates and heartbeat caching

## [0.6.65] - 2026-03-28

### Added
- Interactive terminal view with xterm.js for CLI agents
- Split-pane editor groups (up to 4 groups) with drag-to-resize
- Browser notification system with per-category toggles
- Sound effects for agent completion and approval events

### Fixed
- Dashboard routing for non-CLI agent types
- TUI artifact cleaning for chat history display
