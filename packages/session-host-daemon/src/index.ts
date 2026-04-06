#!/usr/bin/env node

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SessionHostClient,
  formatRuntimeOwner,
  getDefaultSessionHostEndpoint,
  resolveRuntimeRecord,
  type SessionHostEvent,
  type SessionHostRecord,
} from '@adhdev/session-host-core';
import { SessionHostServer } from './server.js';

export { SessionHostServer } from './server.js';
export type { SessionHostServerOptions } from './server.js';

const SESSION_HOST_APP_NAME = process.env.ADHDEV_SESSION_HOST_NAME || 'adhdev';

function getSessionHostPidFile(appName: string): string {
  const dir = path.join(os.homedir(), '.adhdev');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${appName}-session-host.pid`);
}

function writeSessionHostPid(appName: string): void {
  fs.writeFileSync(getSessionHostPidFile(appName), String(process.pid), 'utf8');
}

function removeSessionHostPid(appName: string): void {
  try {
    fs.unlinkSync(getSessionHostPidFile(appName));
  } catch {
    // noop
  }
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const readOnly = rest.includes('--read-only');
  const takeover = rest.includes('--takeover');
  const showAll = rest.includes('--all');
  const positional = rest.filter((arg) => arg !== '--read-only' && arg !== '--takeover' && arg !== '--all');
  return {
    command: command || 'serve',
    positional,
    readOnly,
    takeover,
    showAll,
  };
}

async function runServer(): Promise<void> {
  const server = new SessionHostServer({ appName: SESSION_HOST_APP_NAME });
  writeSessionHostPid(SESSION_HOST_APP_NAME);
  await server.start();

  process.on('SIGINT', async () => {
    await server.stop();
    removeSessionHostPid(SESSION_HOST_APP_NAME);
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.stop();
    removeSessionHostPid(SESSION_HOST_APP_NAME);
    process.exit(0);
  });

  // Fallback: flush persistence on any exit (covers Windows where SIGTERM is unsupported)
  process.on('exit', () => {
    server.flushAllPersistence();
    removeSessionHostPid(SESSION_HOST_APP_NAME);
  });

  // Keep the host alive; IPC transport wiring comes next.
  await new Promise<void>(() => {});
}

async function listRuntimes(showAll = false): Promise<void> {
  const client = new SessionHostClient({ endpoint: getDefaultSessionHostEndpoint(SESSION_HOST_APP_NAME) });
  try {
    const response = await client.request<SessionHostRecord[]>({
      type: 'list_sessions',
      payload: {},
    });
    if (!response.success) {
      throw new Error(response.error || 'Failed to list runtimes');
    }
    const runtimes = (response.result || []).filter((runtime: SessionHostRecord) => showAll || runtime.lifecycle !== 'stopped');
    if (runtimes.length === 0) {
      console.log('No runtimes.');
      return;
    }
    console.log('runtimeKey\tlifecycle\towner\tworkspace\tid\tdisplayName');
    for (const runtime of runtimes) {
      console.log([
        runtime.runtimeKey,
        runtime.lifecycle,
        formatRuntimeOwner(runtime),
        runtime.workspaceLabel,
        runtime.sessionId,
        runtime.displayName,
      ].join('\t'));
    }
  } finally {
    await client.close().catch(() => {});
  }
}

async function attachRuntime(target: string, readOnly = false, takeover = false): Promise<void> {
  const client = new SessionHostClient({ endpoint: getDefaultSessionHostEndpoint(SESSION_HOST_APP_NAME) });
  const clientId = `local-terminal-${process.pid}-${randomUUID().slice(0, 8)}`;
  let lastSeq = 0;
  let restoredRawMode = false;
  let runtimeId = '';
  let localReadOnly = readOnly;

  const cleanup = async () => {
    process.stdout.off('resize', handleResize);
    process.stdin.off('data', handleInput);
    process.stdin.pause();
    if (process.stdin.isTTY && restoredRawMode) {
      process.stdin.setRawMode(false);
    }
    await client.request({
      type: 'release_write',
      payload: {
        sessionId: runtimeId,
        clientId,
      },
    }).catch(() => ({ success: false }));
    await client.request({
      type: 'detach_session',
      payload: {
        sessionId: runtimeId,
        clientId,
      },
    }).catch(() => ({ success: false }));
    await client.close().catch(() => {});
  };

  const handleResize = () => {
    void client.request({
      type: 'resize_session',
      payload: {
        sessionId: runtimeId,
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      },
    }).catch(() => ({ success: false }));
  };

  const sendInputWithTakeover = async (data: string) => {
    let response = await client.request({
      type: 'send_input',
      payload: {
        sessionId: runtimeId,
        clientId,
        data,
      },
    });
    if (!response.success && response.error?.startsWith('Write owned by ')) {
      const ownerResponse = await client.request<SessionHostRecord>({
        type: 'acquire_write',
        payload: {
          sessionId: runtimeId,
          clientId,
          ownerType: 'user',
          force: true,
        },
      });
      if (ownerResponse.success && ownerResponse.result) {
        response = await client.request({
          type: 'send_input',
          payload: {
            sessionId: runtimeId,
            clientId,
            data,
          },
        });
        if (response.success) {
          process.stderr.write(`Took control of ${ownerResponse.result.runtimeKey}.\n`);
        }
      }
    }
    return response;
  };

  const handleInput = (chunk: Buffer) => {
    if (!localReadOnly && chunk.length === 1 && chunk[0] === 0x1d) {
      void cleanup().finally(() => process.exit(0));
      return;
    }
    if (localReadOnly) return;
    void sendInputWithTakeover(chunk.toString('utf8')).catch(() => ({ success: false }));
  };

  try {
    if (readOnly && takeover) {
      throw new Error('Use either --read-only or --takeover, not both');
    }

    const listResponse = await client.request<SessionHostRecord[]>({
      type: 'list_sessions',
      payload: {},
    });
    if (!listResponse.success || !listResponse.result) {
      throw new Error(listResponse.error || 'Failed to list runtimes');
    }
    let runtimeRecord = resolveRuntimeRecord(listResponse.result, target);
    runtimeId = runtimeRecord.sessionId;

    if (runtimeRecord.lifecycle === 'interrupted' && !readOnly) {
      const resumeResponse = await client.request<SessionHostRecord>({
        type: 'resume_session',
        payload: {
          sessionId: runtimeId,
        },
      });
      if (resumeResponse.success && resumeResponse.result) {
        runtimeRecord = resumeResponse.result;
      } else {
        process.stderr.write(
          `Runtime ${runtimeRecord.runtimeKey} could not be resumed automatically: ${resumeResponse.error || 'unknown error'}\n`,
        );
      }
    }

    let effectiveReadOnly = readOnly;
    if (!effectiveReadOnly && runtimeRecord.writeOwner && runtimeRecord.writeOwner.clientId !== clientId && !takeover) {
      process.stderr.write(
        `Runtime ${runtimeRecord.runtimeKey} is currently owned by ${runtimeRecord.writeOwner.clientId}; first input will take control here.\n`,
      );
    }
    localReadOnly = effectiveReadOnly;

    const attachResponse = await client.request<SessionHostRecord>({
      type: 'attach_session',
      payload: {
        sessionId: runtimeId,
        clientId,
        clientType: 'local-terminal',
        readOnly: effectiveReadOnly,
      },
    });
    if (!attachResponse.success) {
      throw new Error(attachResponse.error || `Failed to attach runtime ${runtimeId}`);
    }
    const attachedRecord = attachResponse.result || null;

    if (!effectiveReadOnly && takeover) {
      const ownerResponse = await client.request<SessionHostRecord>({
        type: 'acquire_write',
        payload: {
          sessionId: runtimeId,
          clientId,
          ownerType: 'user',
          force: takeover,
        },
      });
      if (!ownerResponse.success) {
        throw new Error(ownerResponse.error || `Failed to acquire write owner for runtime ${runtimeId}`);
      }
    }

    const snapshotResponse = await client.request<{ seq: number; text: string; truncated: boolean; cols?: number; rows?: number }>({
      type: 'get_snapshot',
      payload: { sessionId: runtimeId },
    });
    if (!snapshotResponse.success) {
      throw new Error(snapshotResponse.error || `Failed to read runtime snapshot ${runtimeId}`);
    }
    lastSeq = snapshotResponse.result?.seq || 0;
    if (snapshotResponse.result?.text) {
      process.stdout.write(snapshotResponse.result.text);
    }
    if (attachedRecord?.lifecycle === 'stopped' || attachedRecord?.lifecycle === 'failed' || attachedRecord?.lifecycle === 'interrupted') {
      process.stderr.write(`Runtime ${attachedRecord.runtimeKey} is already ${attachedRecord.lifecycle}. Detached after snapshot.\n`);
      await cleanup();
      return;
    }

    const stopSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const signalHandlers = stopSignals.map((signal) => {
      const handler = () => {
        void cleanup().finally(() => process.exit(0));
      };
      process.on(signal, handler);
      return { signal, handler };
    });

    const unsubscribe = client.onEvent((event: SessionHostEvent) => {
      if (event.sessionId !== runtimeId) return;
      if (event.type === 'session_output') {
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        process.stdout.write(event.data);
        return;
      }
      if (event.type === 'session_exit') {
        void cleanup().finally(() => {
          for (const { signal, handler } of signalHandlers) {
            process.off(signal, handler);
          }
          unsubscribe();
          process.exit(event.exitCode ?? 0);
        });
      }
    });

    process.stdout.on('resize', handleResize);
    process.stdin.on('data', handleInput);
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      restoredRawMode = true;
    }
    handleResize();
    if (!effectiveReadOnly) {
      process.stderr.write(`Attached to runtime ${attachedRecord?.runtimeKey || runtimeId}. Press Ctrl+] to detach.\n`);
    } else {
      process.stderr.write(`Attached to runtime ${attachedRecord?.runtimeKey || runtimeId} (read-only).\n`);
    }
    await new Promise<void>(() => {});
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

async function main(): Promise<void> {
  const { command, positional, readOnly, takeover, showAll } = parseArgs(process.argv.slice(2));
  if (command === 'serve') {
    await runServer();
    return;
  }
  if (command === 'list') {
    await listRuntimes(showAll);
    return;
  }
  if (command === 'attach') {
    const target = positional[0];
    if (!target) {
      throw new Error('runtime target is required: adhdev-sessiond attach <runtimeId|runtimeKey>');
    }
    await attachRuntime(target, readOnly, takeover);
    return;
  }
  if (command === 'resume') {
    const target = positional[0];
    if (!target) {
      throw new Error('runtime target is required: adhdev-sessiond resume <runtimeId|runtimeKey>');
    }
    const client = new SessionHostClient({ endpoint: getDefaultSessionHostEndpoint(SESSION_HOST_APP_NAME) });
    try {
      const listResponse = await client.request<SessionHostRecord[]>({ type: 'list_sessions', payload: {} });
      if (!listResponse.success || !listResponse.result) {
        throw new Error(listResponse.error || 'Failed to list runtimes');
      }
      const runtimeRecord = resolveRuntimeRecord(listResponse.result, target);
      const resumeResponse = await client.request<SessionHostRecord>({
        type: 'resume_session',
        payload: {
          sessionId: runtimeRecord.sessionId,
        },
      });
      if (!resumeResponse.success || !resumeResponse.result) {
        throw new Error(resumeResponse.error || `Failed to resume runtime ${runtimeRecord.runtimeKey}`);
      }
      console.log(`Resumed ${resumeResponse.result.runtimeKey} (${resumeResponse.result.sessionId})`);
    } finally {
      await client.close().catch(() => {});
    }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  // Prevent native crashes (e.g. node-pty on Windows) from silently killing the server process
  process.on('uncaughtException', (err) => {
    console.error(`[session-host] Uncaught exception: ${err?.message}\n${err?.stack || ''}`);
    // Do not exit — keep the server alive for existing sessions
  });
  process.on('unhandledRejection', (reason: any) => {
    console.error(`[session-host] Unhandled rejection: ${reason?.message || reason}`);
  });

  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
