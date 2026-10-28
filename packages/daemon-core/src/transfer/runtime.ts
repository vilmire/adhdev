/** Process-wide engine handle. Hosts that can transfer call {@link configureProjectTransfer} at boot. */
import { ProjectTransferEngine, ensureBaseDir, type TransferHostPorts } from './engine.js';

let engine: ProjectTransferEngine | null = null;
let sweepTimer: NodeJS.Timeout | undefined;

export function configureProjectTransfer(ports: TransferHostPorts): ProjectTransferEngine {
  if (engine) { engine.shutdown(); clearInterval(sweepTimer); }
  ensureBaseDir(ports.baseDir);
  engine = new ProjectTransferEngine(ports);
  sweepTimer = setInterval(() => engine?.sweep(), 60_000);
  sweepTimer.unref?.();
  return engine;
}

export function getProjectTransferEngine(): ProjectTransferEngine | null {
  return engine;
}

export function resetProjectTransferForTest(): void {
  engine?.shutdown();
  clearInterval(sweepTimer);
  engine = null;
}
