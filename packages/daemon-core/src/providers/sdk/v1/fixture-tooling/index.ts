/**
 * Fixture tooling — public surface.
 *
 * Imported by `adhdev provider test` and by daemon-core's CI regression
 * suite. Format types and the replay runner are stable v1.
 */

export type {
  FixtureExpected,
  FixtureAnchor,
  MessageShape,
  AnchorReplayResult,
  FixtureReplayResult,
} from './format.js';

export {
  loadFixtureExpected,
  replayFixture,
  formatReplayReport,
  type CliProviderHandlers,
  type ReplayOptions,
} from './replay.js';
