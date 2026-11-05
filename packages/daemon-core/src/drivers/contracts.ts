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
    /** Names of parent environment variables explicitly approved for inheritance. */
    env?: string[];
    platforms?: Array<'win32' | 'darwin' | 'linux'>;
    startupTimeoutMs?: number;
    idleStopMs?: number;
    /** Per tool-call timeout (1000..600000). Overrides the managed-process default. */
    requestTimeoutMs?: number;
  };
  actions: Array<{
    id: string;
    tool: string;
    risk: 'read' | 'write' | 'destructive';
    inputSchema?: string;
    /** Declared grants[] id the owner must have enabled before this action runs. */
    grant?: string;
    /** Default true. false = the action neither takes nor checks the resources lease. */
    lease?: boolean;
  }>;
  /** Owner-controlled permissions (checkboxes), default off. */
  grants?: Array<{ id: string; title: string; description?: string }>;
  resources?: Array<{ key: string; lease: 'session' }>;
  guidance?: string;
  declaredAccess?: {
    network?: string[];
    filesystem?: string[];
    desktopControl?: boolean;
  };
}
