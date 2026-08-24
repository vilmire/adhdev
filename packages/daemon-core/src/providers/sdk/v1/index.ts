/**
 * Provider SDK — v1 surface.
 *
 * Internal consumers (daemon-core) import directly from here.
 * External consumers (provider authors) import from the npm package
 * `@adhdev/provider-types` (Apache 2.0), which is extracted from this
 * source at build time.
 */

export * from './types/cli/index.js';
export * from './types/common/index.js';

// Builders — turn declarative manifest blocks into runtime functions.
export {
  buildDetectStatusFromTui,
  type DetectStatusTuiSpec,
} from './builders/cli/detect-status.js';
export {
  buildParseApprovalFromTui,
  type ModalTuiSpec,
} from './builders/cli/parse-approval.js';
export {
  applyVisibleRegion,
  type VisibleRegionSpec,
} from './builders/cli/visible-region.js';
export {
  buildParseApprovalFromSquash,
  compactText,
  type ApprovalSquashSpec,
} from './builders/cli/parse-approval-squash.js';
export {
  buildParseSessionFromTui,
  normalizeMessageIdentity,
  type ParseSessionTuiSpec,
  type TranscriptPtySpec,
  type SessionIdExtractionSpec,
  type SynthesizedMessage,
  type SynthesizedSession,
} from './builders/cli/parse-session.js';

// ACP builders — declarative stdio session-status detection.
export {
  buildDetectStatusFromAcp,
  type AcpSessionSpec,
  type AcpStatusInput,
  type AcpDetectedStatus,
} from './builders/acp/detect-status.js';

// Fixture tooling — record/replay for provider regression suites.
export {
  loadFixtureExpected,
  replayFixture,
  formatReplayReport,
  type FixtureExpected,
  type FixtureAnchor,
  type MessageShape,
  type AnchorReplayResult,
  type FixtureReplayResult,
  type CliProviderHandlers,
  type ReplayOptions,
} from './fixture-tooling/index.js';

// Static validators — used by `adhdev provider validate` + registry publish.
export {
  analyzeOverrideTaint,
  formatTaintResult,
  type TaintLevel,
  type TaintCategory,
  type TaintFinding,
  type TaintResult,
  validateCliProviderManifest,
  validateAcpProviderManifest,
  formatManifestValidationIssues,
  type ManifestValidationIssue,
  type ManifestValidationResult,
} from './validators/index.js';

// Primitive identifiers — the canonical list.
// Implementations live under ./primitives/ and are wired in by builders.
export const V1_PRIMITIVE_CATALOG = Object.freeze({
  acp: [
    'adhdev:acp/session-protocol@1',
  ],
  tui: [
    'adhdev:tui/prompt-marker@1',
    'adhdev:tui/spinner@1',
    'adhdev:tui/settled-prompt@1',
    'adhdev:tui/assistant-block@1',
    'adhdev:tui/tool-block@1',
    'adhdev:tui/thinking-block@1',
    'adhdev:tui/user-echo@1',
    'adhdev:tui/modal@1',
    'adhdev:tui/modal-as-message@1',
    'adhdev:tui/footer-chrome@1',
    'adhdev:tui/welcome-screen@1',
    'adhdev:tui/visible-region@1',
    'adhdev:tui/cue-ordering@1',
    'adhdev:tui/dispatch-order@1',
    'adhdev:tui/index-finder@1',
    'adhdev:tui/status-downgrade@1',
    'adhdev:tui/approval-stitching@1',
    'adhdev:tui/approval-squash@1',
    'adhdev:tui/media-input@1',
    'adhdev:tui/session-id-extraction@1',
    'adhdev:tui/error-detection@1',
  ],
  nativeHistory: [
    'adhdev:native-history/codex-rollout@1',
    'adhdev:native-history/claude-jsonl@1',
    'adhdev:native-history/anthropic-cli-transcript@1',
    'adhdev:native-history/hermes-session@1',
  ],
  cliCapability: [
    'adhdev:cli/capability-list@1',
    'adhdev:cli/control-state@1',
    'adhdev:cli/capability-action@1',
    'adhdev:cli/control-toggle@1',
    'adhdev:cli/picker-open@1',
    'adhdev:cli/picker-set@1',
  ],
  common: [
    'adhdev:common/setting-boolean@1',
    'adhdev:common/setting-number@1',
    'adhdev:common/setting-string@1',
    'adhdev:common/setting-select@1',
    'adhdev:common/capability-input@1',
    'adhdev:common/capability-output@1',
    'adhdev:common/capability-controls@1',
    'adhdev:common/auth-env-var@1',
    'adhdev:common/auth-cli-command@1',
    'adhdev:common/spawn@1',
    'adhdev:common/timeouts@1',
    'adhdev:common/resume@1',
    'adhdev:common/mesh-coordinator@1',
  ],
  override: [
    'adhdev:override/cli-parse-session@1',
    'adhdev:override/cli-detect-status@1',
    'adhdev:override/cli-parse-approval@1',
    'adhdev:override/cli-parse-output@1',
    'adhdev:override/cli-read-native-history@1',
    'adhdev:override/cli-list-native-history@1',
    'adhdev:override/cli-capability-handler@1',
  ],
} as const);

/** Aggregate flat list — for provider catalog endpoints. */
export const V1_ALL_PRIMITIVES: ReadonlyArray<string> = Object.freeze(
  Object.values(V1_PRIMITIVE_CATALOG).flat(),
);

/** Catalog version label exposed at `registry.adhf.dev/primitives`. */
export const V1_CONTRACT_VERSION = '1.0.0' as const;
