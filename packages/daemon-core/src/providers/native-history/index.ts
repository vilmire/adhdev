/**
 * native-history — Daemon-side built-in adapters for CLI provider native history.
 *
 * Each adapter reads conversation history directly from the CLI tool's on-disk
 * storage without shelling out to a provider JS override script.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */

export {
  readSession as readClaudeCliSession,
  listSessions as listClaudeCliSessions,
} from './claude-cli-transcript.js';

export {
  readSession as readCodexCliSession,
  listSessions as listCodexCliSessions,
} from './codex-cli-transcript.js';

export {
  readSession as readAntigravityCliSession,
  listSessions as listAntigravityCliSessions,
} from './antigravity-cli-transcript.js';

export {
  readSession as readHermesCliSession,
  listSessions as listHermesCliSessions,
} from './hermes-cli-transcript.js';

export { createNativeHistoryDispatcher, type ReaderId } from './dispatcher.js';
