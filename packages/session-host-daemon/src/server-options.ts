import type { SessionHostEndpoint } from '@adhdev/session-host-core';
import type { HostUpgradeBinding } from './upgrade-lease.js';
import type { SessionHostReplacementProvenance } from './prior-host-identity.js';

export interface SessionHostServerOptions {
  /** Boot-pipe key only; no request/config-file enrollment. */
  recoveryOwnerPublicKey?: string;
  /** Actual parent identity, supplied by trusted boot wiring, never query args. */
  workerDaemonId?: string;
  endpoint?: SessionHostEndpoint;
  /** Opt-in pinned native binding; absent hosts cannot attest an upgrade idle lease. */
  upgradeBinding?: HostUpgradeBinding;
  appName?: string;
  /** Explicit session-host state root (runtime records + tombstones). */
  storageRootDir?: string;
  /** Instance config directory used to verify single matching --instance-config-key on prior owners. */
  instanceConfigDir?: string;
  /** Optional pidfile path checked before unlinking/rebinding a unix socket endpoint. */
  pidFilePath?: string;
  /** Exclusive host lock dir; defaults to `<pidFilePath>.lock`. No pidfile and no path = no lock. */
  instanceLockPath?: string;
  /** Keep the instance lock through stop() so only process death releases it (the CLI host sets this). */
  holdInstanceLockUntilExit?: boolean;
  /** Optional predicate override for testing whether a prior pid is alive. */
  isPidAlive?: (pid: number) => boolean;
  /** Optional predicate override for testing whether a prior pid is a managed session-host. */
  isManagedOwnerPid?: (pid: number) => boolean;
  /** Unsupported legacy replacement context; ordinary startup rejects its presence. */
  replacementProvenance?: SessionHostReplacementProvenance | (() => SessionHostReplacementProvenance | undefined);
  /** Optional native birth probe override (`ps -o lstart=`). */
  getOwnerBirth?: (pid: number) => string | null;
  /** Optional unix socket owner PID probe override (`lsof -t`). */
  getSocketOwnerPids?: (endpointPath: string) => number[] | null;
  /** Cancellation is checked after blocking reads and before startup effects. */
  isCancelled?: () => boolean;
  /** Optional process command-line probe override (`ps -o args=`). */
  readOwnerArgs?: (pid: number) => string | null;
  /** Legacy option retained for source compatibility; automatic live eviction is unsupported. */
  evictGraceMs?: number;
}
