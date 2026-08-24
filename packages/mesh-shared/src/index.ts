/**
 * @adhdev/mesh-shared — pure, dependency-free mesh/git status normalizers shared
 * by daemon-core (standalone / local IPC) and web-core (cloud / P2P transit).
 *
 * This package exists to kill a recurring bug class: the cloud and standalone
 * transports each used to carry their own hand-synced copy of these normalizers,
 * and they drifted (cloud would strip/reshape fields, the web filter would drop
 * entries the standalone path kept). Both cores now import this single source of
 * truth. It MUST stay a pure leaf — types + pure functions on plain JS objects,
 * no Node/DOM APIs, no git exec, no transport, and an empty dependency set.
 */

export * from './json'
export * from './types'
export * from './git-normalize'
export * from './session-normalize'
export * from './node-normalize'
export * from './node-facts'
export * from './workspace-normalize'
export * from './daemon-normalize'
export * from './git-summarize'
export * from './magi'
export * from './brain-routing'
export * from './slot-proposal'
export * from './interpolation'
export * from './mesh-tool-names'
export * from './mesh-status-probe'
export * from './rpc-chunking'
export * from './semver-compare'
export * from './ws-protocol'
