import assert from 'node:assert/strict';
import test from 'node:test';

import { collectLiveStatusProbe, extractUpgradeFailureSummary } from '../src/tools/mesh-tools-internal.js';
import { IpcTransport } from '../src/transports/ipc.js';
import { meshStatus } from '../src/tools/mesh-tools.js';

/**
 * mesh_status must surface a failed/rolled-back daemon upgrade.
 *
 * A detached daemon upgrade answers "scheduled" seconds before it actually
 * runs; the real outcome (install / health gate / rollback) lands tens of
 * seconds later with no channel back to the caller. The durable failure notice
 * was always readable via a per-node get_status_metadata probe, but nothing
 * folded it into mesh_status — the surface a coordinator actually watches — so
 * a Windows upgrade that failed and rolled back was reported as a success.
 *
 * The summary is deliberately BOUNDED: mesh_status is a payload-budgeted
 * surface and the raw notice carries a full npm/health trace (lock-holder pids,
 * command lines, recovery commands). Carry the decision fields + a truncated
 * excerpt; leave the body at noticePath/logPath.
 *
 * Deleting the extractor's truncation, or dropping upgradeFailure from the
 * probe, turns these tests red.
 */

const noticeBody = [
  'adhdev adhdev@1.0.38-rc.2 upgrade failed and was rolled back: health gate timed out',
  'Previous version preserved (active prefix: C:\\Users\\me\\.adhdev\\npm-global).',
  'See daemon-upgrade.log for the full install/health trace.',
].join('\n');

const probeResult = {
  success: true,
  status: { instanceId: 'daemon_test' },
  upgradeFailure: {
    noticePath: 'C:\\Users\\me\\.adhdev\\daemon-upgrade-last-error.txt',
    logPath: 'C:\\Users\\me\\.adhdev\\daemon-upgrade.log',
    notice: `[2026-08-07T06:44:14.000Z]\n${noticeBody}`,
    recordedAt: '2026-08-07T06:44:14.000Z',
    ageMs: 3 * 60 * 60 * 1000,
    ageLabel: '3h ago',
    targetVersion: '1.0.38-rc.2',
  },
};

test('extracts the decision fields from a get_status_metadata upgradeFailure', () => {
  const summary = extractUpgradeFailureSummary(probeResult);
  assert.ok(summary);
  assert.equal(summary.recordedAt, '2026-08-07T06:44:14.000Z');
  assert.equal(summary.ageLabel, '3h ago');
  assert.equal(summary.targetVersion, '1.0.38-rc.2');
  assert.equal(summary.noticePath, 'C:\\Users\\me\\.adhdev\\daemon-upgrade-last-error.txt');
  assert.equal(summary.logPath, 'C:\\Users\\me\\.adhdev\\daemon-upgrade.log');
});

test('summary is the first prose line, not the [ISO] header', () => {
  const summary = extractUpgradeFailureSummary(probeResult);
  assert.ok(summary);
  assert.equal(
    summary.summary,
    'adhdev adhdev@1.0.38-rc.2 upgrade failed and was rolled back: health gate timed out',
  );
  assert.ok(!summary.summary.startsWith('['), 'header line must not become the summary');
});

test('summary is truncated so a long npm trace cannot inflate the mesh_status payload', () => {
  const long = 'x'.repeat(5000);
  const summary = extractUpgradeFailureSummary({
    upgradeFailure: {
      noticePath: '/n.txt',
      logPath: '/l.log',
      notice: `[2026-08-07T06:44:14.000Z]\n${long}`,
    },
  });
  assert.ok(summary);
  assert.ok(
    summary.summary.length <= 201,
    `summary must stay bounded, got ${summary.summary.length} chars`,
  );
  assert.ok(summary.summary.endsWith('…'), 'truncation must be marked');
  // Whole-summary payload stays small enough to fold into a budgeted response.
  assert.ok(JSON.stringify(summary).length < 400);
});

test('optional fields are omitted (not null) on a legacy notice without age/target', () => {
  const summary = extractUpgradeFailureSummary({
    upgradeFailure: {
      noticePath: '/n.txt',
      logPath: '/l.log',
      notice: 'upgrade failed',
      recordedAt: null,
      ageLabel: null,
      targetVersion: null,
    },
  });
  assert.ok(summary);
  assert.equal('recordedAt' in summary, false);
  assert.equal('ageLabel' in summary, false);
  assert.equal('targetVersion' in summary, false);
  assert.equal(summary.summary, 'upgrade failed');
});

test('returns undefined when the daemon reports no failed upgrade', () => {
  assert.equal(extractUpgradeFailureSummary({ success: true, upgradeFailure: null }), undefined);
  assert.equal(extractUpgradeFailureSummary({ success: true }), undefined);
  assert.equal(extractUpgradeFailureSummary(undefined), undefined);
});

// The extractor alone is not the fix — the ORIGINAL defect was that the
// mesh_status probe never carried upgradeFailure at all. These pin the wiring:
// one get_status_metadata probe must yield sessions, daemonBuild AND
// upgradeFailure together.
function makeProbeCtx(statusPayload: Record<string, unknown>) {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  transport.meshCommand = async () => statusPayload;
  transport.command = async () => statusPayload;
  return {
    mesh: { id: 'mesh-upgrade-failure', nodes: [] },
    transport,
    localDaemonId: 'daemon-coordinator',
    localMachineId: 'machine-coordinator',
  };
}

const probeNode = {
  id: 'node-remote',
  workspace: '/remote/repo',
  repoRoot: '/remote/repo',
  daemonId: 'daemon_mach_remote',
  machineId: 'machine-remote',
  userOverrides: {},
  policy: {},
  sessions: [],
};

test('collectLiveStatusProbe carries upgradeFailure out of the status probe', async () => {
  const ctx = makeProbeCtx(probeResult);
  const probe = await collectLiveStatusProbe(ctx as any, probeNode as any);
  assert.ok(probe.upgradeFailure, 'mesh_status probe must surface the failed upgrade');
  assert.equal(probe.upgradeFailure.targetVersion, '1.0.38-rc.2');
  assert.equal(probe.upgradeFailure.ageLabel, '3h ago');
});

test('collectLiveStatusProbe omits upgradeFailure when no upgrade failed', async () => {
  const ctx = makeProbeCtx({ success: true, status: {}, upgradeFailure: null });
  const probe = await collectLiveStatusProbe(ctx as any, probeNode as any);
  assert.equal(probe.upgradeFailure, undefined);
});

test('reads through a wrapped command payload, like extractDaemonBuildInfo does', () => {
  const summary = extractUpgradeFailureSummary({
    success: true,
    result: {
      success: true,
      upgradeFailure: {
        noticePath: '/n.txt',
        logPath: '/l.log',
        notice: '[2026-08-07T06:44:14.000Z]\nrolled back',
        targetVersion: '1.0.38-rc.2',
      },
    },
  });
  assert.ok(summary, 'must unwrap the relayed command payload');
  assert.equal(summary.summary, 'rolled back');
  assert.equal(summary.targetVersion, '1.0.38-rc.2');
});

// End-to-end through meshStatus(): the aggregate a coordinator actually reads.
function buildStatusCtx(upgradeFailure: unknown) {
  const mesh = {
    id: 'mesh-upgradefail', name: 'Mesh', repoIdentity: 'vilmire/adhdev',
    policy: { schedulingStrategy: 'least_loaded' },
    coordinator: {},
    defaultBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [
      { id: 'node-a', workspace: '/a', repoRoot: '/a', daemonId: 'daemon-A', machineId: 'machine-A', userOverrides: {}, policy: { providerPriority: ['claude-cli'] } },
      // Second node on the SAME daemon: the probe is daemon-wide, so the fold
      // must record the failure ONCE, not once per node.
      { id: 'node-a2', workspace: '/a2', repoRoot: '/a2', daemonId: 'daemon-A', machineId: 'machine-A', userOverrides: {}, policy: { providerPriority: ['claude-cli'] } },
    ],
  };
  const cleanGit = { isGitRepo: true, isDirty: false, branch: 'main', headCommit: 'abc', ahead: 0, behind: 0, submodules: [] };
  const responder = (command: string) => {
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] }, upgradeFailure };
    if (command === 'git_status') return { success: true, status: cleanGit };
    return { success: true };
  };
  const transport: any = {};
  transport.command = async (c: string) => responder(c);
  transport.meshCommand = async (_d: string, c: string) => responder(c);
  return { mesh, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-A', coordinatorHostname: 'h' };
}

test('mesh_status surfaces daemonUpgradeFailures + a warning when a daemon rolled back', async () => {
  const ctx = buildStatusCtx(probeResult.upgradeFailure);
  const res = JSON.parse(await meshStatus(ctx as any));

  assert.ok(res.daemonUpgradeFailures, 'the failed upgrade must reach the mesh_status surface');
  const entry = res.daemonUpgradeFailures['daemon-A'];
  assert.ok(entry, 'keyed by daemonId, like daemonBuilds');
  assert.equal(entry.targetVersion, '1.0.38-rc.2');
  assert.equal(entry.ageLabel, '3h ago');
  assert.ok(entry.noticePath, 'points at the full notice');
  // The warning must tell a coordinator that a prior "success" was only a schedule ack.
  assert.match(res.daemonUpgradeFailureWarning, /SCHEDULED|PREVIOUS version/);
});

test('mesh_status folds the failure once per daemonId, not once per node', async () => {
  const ctx = buildStatusCtx(probeResult.upgradeFailure);
  const res = JSON.parse(await meshStatus(ctx as any));
  assert.equal(Object.keys(res.daemonUpgradeFailures).length, 1);
});

test('mesh_status omits the field entirely when no upgrade failed', async () => {
  const ctx = buildStatusCtx(null);
  const res = JSON.parse(await meshStatus(ctx as any));
  assert.equal(res.daemonUpgradeFailures, undefined);
  assert.equal(res.daemonUpgradeFailureWarning, undefined);
});

test('mesh_status payload impact stays small (bounded summary, folded per daemon)', async () => {
  const withFailure = JSON.parse(await meshStatus(buildStatusCtx({
    ...probeResult.upgradeFailure,
    // A realistically long notice: full npm trace with lock-holder pids.
    notice: `[2026-08-07T06:44:14.000Z]\n${'trace line with pids and command lines '.repeat(200)}`,
  }) as any));
  const without = JSON.parse(await meshStatus(buildStatusCtx(null) as any));
  const delta = JSON.stringify(withFailure).length - JSON.stringify(without).length;
  // The warning prose dominates; the per-daemon entry must stay bounded even
  // when the underlying notice is thousands of chars.
  assert.ok(delta < 1200, `mesh_status must not balloon on a failed upgrade, grew ${delta} bytes`);
  assert.ok(JSON.stringify(withFailure.daemonUpgradeFailures).length < 500);
});
