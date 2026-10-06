import { summarizeGitShape } from '@adhdev/mesh-shared';

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

export function summarizeMeshCommandArgs(command: string, args: Record<string, unknown>): Record<string, unknown> {
  if (command === 'git_status') {
    return {
      workspace: typeof args.workspace === 'string' ? args.workspace : null,
      refreshUpstream: args.refreshUpstream === true,
      includeSubmodules: args.includeSubmodules === true,
    };
  }
  if (command === 'fast_forward_mesh_node') {
    return {
      meshId: typeof args.meshId === 'string' ? args.meshId : null,
      nodeId: typeof args.nodeId === 'string' ? args.nodeId : null,
      workspace: typeof args.workspace === 'string' ? args.workspace : null,
      mode: args.mode === 'push' ? 'push' : 'merge',
      branch: typeof args.branch === 'string' ? args.branch : null,
      execute: args.execute === true,
      dryRun: args.dryRun === true,
      updateSubmodules: args.updateSubmodules === true,
      pushSubmodules: args.pushSubmodules === true,
    };
  }
  if (command === 'mesh_status' || command === 'get_mesh') {
    const inlineMesh = asRecord(args.inlineMesh);
    const inlineNodes = Array.isArray(inlineMesh.nodes) ? inlineMesh.nodes : [];
    return {
      meshId: typeof args.meshId === 'string' ? args.meshId : null,
      requireDirectPeerTruth: args.requireDirectPeerTruth === true,
      refresh: args.refresh === true,
      inlineMeshNodes: inlineNodes.length,
    };
  }
  return { keys: Object.keys(args).sort() };
}

export function summarizeMeshCommandGitResult(result: unknown): Record<string, unknown> | null {
  // Envelope unwrap is transport-specific (cloud wraps the daemon payload under
  // result / result.status), so it stays here. The git-shape projection itself is
  // shared with the standalone path via @adhdev/mesh-shared summarizeGitShape.
  const envelope = asRecord(result);
  const nestedResult = asRecord(envelope.result);
  const status = Object.keys(asRecord(envelope.status)).length
    ? asRecord(envelope.status)
    : Object.keys(asRecord(nestedResult.status)).length
      ? asRecord(nestedResult.status)
      : Object.keys(envelope).length
        ? envelope
        : {};
  return summarizeGitShape(status);
}

export function summarizeMeshCommandResult(command: string, result: unknown): Record<string, unknown> | null {
  if (command === 'git_status') return summarizeMeshCommandGitResult(result);
  const record = asRecord(result);
  if (command === 'mesh_status') {
    const nodes = Array.isArray(record.nodes) ? record.nodes : [];
    return {
      success: record.success,
      meshId: record.meshId ?? null,
      sourceOfTruth: record.sourceOfTruth ?? null,
      nodeCount: nodes.length,
      nodes: nodes.map((node: any) => ({
        nodeId: node?.nodeId ?? node?.id ?? null,
        daemonId: node?.daemonId ?? null,
        workspace: node?.workspace ?? node?.git?.workspace ?? null,
        health: node?.health ?? null,
        gitProbePending: node?.gitProbePending === true,
        git: summarizeMeshCommandGitResult({ status: node?.git }),
      })),
    };
  }
  return null;
}
