import type { LocalTransport } from './local.js';
import type { IpcTransport } from './ipc.js';

export type CommandTransport = LocalTransport | IpcTransport;
