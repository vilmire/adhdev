/** G1a driver manifest contract, matching the vendored v1 JSON schema. */
export interface DriverManifest {
  type: string;
  name: string;
  category: 'driver';
  providerVersion: string;
  publisher?: string;
  source?: { type: 'github'; repo: string; ref: string; subdir?: string };
  compatibility?: { driverApi?: string };
  runtime: {
    kind: 'mcp-stdio';
    command: string;
    args?: string[];
    platforms?: Array<'win32' | 'darwin' | 'linux'>;
    startupTimeoutMs?: number;
    idleStopMs?: number;
  };
  actions: Array<{
    id: string;
    tool: string;
    risk: 'read' | 'write' | 'destructive';
    inputSchema?: string;
  }>;
  resources?: Array<{ key: string; lease: 'session' }>;
  guidance?: string;
  declaredAccess?: {
    network?: string[];
    filesystem?: string[];
    desktopControl?: boolean;
  };
}
