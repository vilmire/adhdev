#!/usr/bin/env node
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/index.ts
import { randomUUID as randomUUID2 } from "crypto";
import * as fs9 from "fs";
import * as path8 from "path";
import {
  SessionHostClient,
  formatRuntimeOwner,
  getDefaultSessionHostEndpoint as getDefaultSessionHostEndpoint2,
  resolveAttachableRuntimeRecord,
  resolveInstanceConfigDir as resolveInstanceConfigDir4,
  resolveRuntimeRecord,
  resolveSessionHostIpcKey
} from "@adhdev/session-host-core";

// src/guardian-artifact.ts
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
var sha = (b) => createHash("sha256").update(b).digest("hex");
function resolveGuardianArtifact(pins) {
  if (process.platform !== "darwin") throw new Error("guardian_artifact_platform_unsupported");
  const root = fs.realpathSync(pins.packageRoot);
  const regular = (file) => {
    if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error("guardian_artifact_path_untrusted");
    return file;
  };
  const manifestPath = regular(pins.manifestPath);
  if (path.relative(root, manifestPath).startsWith("..")) throw new Error("guardian_artifact_manifest_escape");
  const bytes = fs.readFileSync(manifestPath);
  if (!/^[a-f0-9]{64}$/.test(pins.manifestSha256) || sha(bytes) !== pins.manifestSha256) throw new Error("guardian_artifact_manifest_pin_mismatch");
  const m = JSON.parse(String(bytes));
  if (m.schema !== 1 || m.protocol !== 1 || m.platform !== "darwin" || m.arch !== process.arch || m.version !== pins.version || m.commit !== pins.commit) throw new Error("guardian_artifact_build_mismatch");
  const packageBytes = fs.readFileSync(regular(path.join(root, "package.json")));
  if (sha(packageBytes) !== m.packageJsonSha256 || JSON.parse(String(packageBytes)).version !== pins.version) throw new Error("guardian_artifact_package_version_mismatch");
  const expected = { daemon: pins.daemonEntryPath, cli: pins.cliEntryPath, host: pins.hostEntryPath };
  for (const kind of ["daemon", "cli", "host", "helper"]) {
    const entry = m.files?.[kind];
    if (typeof entry?.path !== "string" || path.isAbsolute(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) throw new Error("guardian_artifact_entry_untrusted");
    const file = path.resolve(root, entry.path);
    if (path.relative(root, file).startsWith("..") || kind !== "helper" && file !== expected[kind] || sha(fs.readFileSync(regular(file))) !== entry.sha256) throw new Error("guardian_artifact_payload_pin_mismatch");
  }
  if (sha(fs.readFileSync(regular(pins.nodePath))) !== m.nodeSha256) throw new Error("guardian_artifact_node_pin_mismatch");
  const helperStat = fs.lstatSync(path.resolve(root, m.files.helper.path));
  if (helperStat.mode & 146) throw new Error("guardian_artifact_helper_writable");
  return { helperFileIdentity: JSON.stringify([helperStat.dev, helperStat.ino, helperStat.uid, helperStat.mode, helperStat.size]), helperPath: path.resolve(root, m.files.helper.path), helperSha256: m.files.helper.sha256, stateDir: pins.stateDir, helperProtocol: 1 };
}

// src/server.ts
import { execFileSync as execFileSync2 } from "child_process";
import { EventEmitter } from "events";
import * as fs7 from "fs";
import * as net from "net";
import * as path7 from "path";
import {
  SessionHostRegistry,
  classifyTermination,
  createLineParser,
  createResponseEnvelope,
  getDefaultSessionHostEndpoint,
  validateSessionHostEndpoint,
  isTerminalRecord
} from "@adhdev/session-host-core";

// src/runtime.ts
import * as fs2 from "fs";
import * as os from "os";
import * as pty from "node-pty";
import {
  sanitizeSpawnEnv,
  ensureNodePtySpawnHelperPermissions,
  resolveSessionHostCols,
  resolveSessionHostRows,
  spawnCliChild
} from "@adhdev/session-host-core";
var terminalMirrorFactory;
var terminalMirrorWarning = null;
var terminalMirrorBackendLogged = false;
ensureNodePtySpawnHelperPermissions((msg) => console.log(`[session-host] ${msg}`));
function logTerminalMirrorBackend(message, level = "info") {
  if (terminalMirrorBackendLogged) return;
  terminalMirrorBackendLogged = true;
  const prefix = "[session-host]";
  if (level === "warn") console.warn(`${prefix} ${message}`);
  else console.log(`${prefix} ${message}`);
}
var buildRuntimeEnv = sanitizeSpawnEnv;
function computeTerminalQueryTail(buffer) {
  const prefixes = ["\x1B[6n", "\x1B[?6n"];
  const maxLength = prefixes.reduce((n, value) => Math.max(n, value.length), 0) - 1;
  const start = Math.max(0, buffer.length - maxLength);
  for (let i = start; i < buffer.length; i++) {
    const suffix = buffer.slice(i);
    if (prefixes.some((pattern) => suffix.length < pattern.length && pattern.startsWith(suffix))) {
      return suffix;
    }
  }
  return "";
}
function formatXtermViewportPlain(terminal, rows) {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY || 0);
  const end = Math.max(start, Math.min(buffer.length || 0, start + Math.max(1, rows | 0)));
  const lines = [];
  for (let i = start; i < end; i++) {
    const line = buffer.getLine(i);
    const raw = line ? line.translateToString(false) : "";
    lines.push(raw.replace(/\s+$/, ""));
  }
  let first = 0;
  let last = lines.length;
  while (first < last && !lines[first]?.trim()) first++;
  while (last > first && !lines[last - 1]?.trim()) last--;
  return lines.slice(first, last).join("\r\n");
}
function createXtermSerializeAddon(terminal) {
  try {
    const mod = __require("@xterm/addon-serialize");
    const SerializeAddon = mod.SerializeAddon || mod.default?.SerializeAddon || mod.default;
    if (!SerializeAddon) return null;
    const addon = new SerializeAddon();
    terminal.loadAddon(addon);
    return addon;
  } catch {
    return null;
  }
}
function formatCursorRestore(terminal, rows) {
  const buffer = terminal.buffer.active;
  const row = Math.max(0, Math.min(Math.max(0, rows | 0) - 1, buffer.cursorY || 0));
  const col = Math.max(0, buffer.cursorX || 0);
  return `\x1B[${row + 1};${col + 1}H`;
}
function serializeXtermViewport(terminal, serializer, rows) {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY || 0);
  const end = Math.max(start, Math.min(Math.max(0, buffer.length || 0) - 1, start + Math.max(1, rows | 0) - 1));
  if (end < start) return "";
  const viewport = serializer.serialize({
    range: { start, end },
    excludeModes: true
  });
  return `${viewport}${formatCursorRestore(terminal, rows)}`;
}
function createXtermMirror(options) {
  const mod = __require("@xterm/xterm");
  const Terminal = mod.Terminal || mod.default?.Terminal || mod.default;
  if (!Terminal) {
    throw new Error("@xterm/xterm Terminal export not found");
  }
  let currentRows = Math.max(1, options.rows | 0);
  const terminal = new Terminal({
    cols: Math.max(1, options.cols | 0),
    rows: currentRows,
    scrollback: Math.max(0, options.scrollback | 0)
  });
  const serializer = createXtermSerializeAddon(terminal);
  return {
    write(data, onProcessed) {
      if (!data) {
        onProcessed?.();
        return;
      }
      terminal.write(typeof data === "string" ? data : Buffer.from(data).toString("utf8"), onProcessed);
    },
    resize(cols, rows) {
      currentRows = Math.max(1, rows | 0);
      terminal.resize(Math.max(1, cols | 0), currentRows);
    },
    formatVT() {
      if (serializer) return serializeXtermViewport(terminal, serializer, currentRows);
      return formatXtermViewportPlain(terminal, currentRows);
    },
    formatPlainText() {
      return formatXtermViewportPlain(terminal, currentRows).replace(/\r\n/g, "\n");
    },
    getCursorPosition() {
      const buffer = terminal.buffer.active;
      return {
        col: Math.max(0, buffer.cursorX || 0),
        row: Math.max(0, buffer.cursorY || 0)
      };
    },
    dispose() {
      serializer?.dispose();
      terminal.dispose();
    }
  };
}
function normalizeGhosttyBinding(mod) {
  const raw = mod?.default?.createTerminal ? mod.default : mod?.createTerminal ? mod : null;
  if (!raw) return null;
  return {
    createTerminal(options) {
      const handle = raw.createTerminal(options);
      const viewportSnapshot = createXtermMirror(options);
      return {
        write(data, onProcessed) {
          handle.write(data);
          viewportSnapshot.write(data, onProcessed);
        },
        resize(cols, rows) {
          handle.resize(cols, rows);
          viewportSnapshot.resize(cols, rows);
        },
        formatVT() {
          return viewportSnapshot.formatVT();
        },
        formatPlainText() {
          return viewportSnapshot.formatPlainText();
        },
        getCursorPosition() {
          if (typeof handle.getCursorPosition === "function") return handle.getCursorPosition();
          return viewportSnapshot.getCursorPosition();
        },
        dispose() {
          handle.dispose();
          viewportSnapshot.dispose();
        }
      };
    }
  };
}
function getTerminalMirrorFactory() {
  if (terminalMirrorFactory) return terminalMirrorFactory;
  if (terminalMirrorFactory === null) {
    throw new Error(terminalMirrorWarning || "No terminal mirror backend available");
  }
  try {
    const ghosttyMod = __require("@adhdev/ghostty-vt-node");
    const binding = normalizeGhosttyBinding(ghosttyMod);
    if (!binding) {
      throw new Error("@adhdev/ghostty-vt-node does not export createTerminal()");
    }
    terminalMirrorFactory = (options) => binding.createTerminal(options);
    logTerminalMirrorBackend("terminal mirror backend=ghostty-vt");
    return terminalMirrorFactory;
  } catch (ghosttyError) {
    try {
      terminalMirrorFactory = createXtermMirror;
      terminalMirrorWarning = `Ghostty VT unavailable; falling back to xterm mirror (${ghosttyError?.message || String(ghosttyError)})`;
      logTerminalMirrorBackend(terminalMirrorWarning, "warn");
      return terminalMirrorFactory;
    } catch (xtermError) {
      terminalMirrorFactory = null;
      terminalMirrorWarning = `No terminal mirror backend available (ghostty: ${ghosttyError?.message || String(ghosttyError)}; xterm: ${xtermError?.message || String(xtermError)})`;
      logTerminalMirrorBackend(terminalMirrorWarning, "warn");
      throw new Error(terminalMirrorWarning);
    }
  }
}
var PtySessionRuntime = class {
  sessionId;
  payload;
  cols;
  rows;
  ptyProcess = null;
  screenMirror = null;
  pendingQueryScanTail = "";
  terminalModeScanTail = "";
  altScreen = false;
  pasteMode = false;
  scrollRegion;
  onDataCallback;
  onExitCallback;
  /** Count of screenMirror.write() calls whose completion callback has not fired yet. */
  pendingWriteCount = 0;
  /** Resolved (and cleared) once pendingWriteCount reaches 0. See flushPendingWrites(). */
  snapshotWaiters = [];
  constructor(options) {
    this.sessionId = options.sessionId;
    this.payload = options.payload;
    this.cols = resolveSessionHostCols(options.payload.cols);
    this.rows = resolveSessionHostRows(options.payload.rows);
    this.scrollRegion = { top: 0, bot: this.rows - 1 };
    this.onDataCallback = options.onData;
    this.onExitCallback = options.onExit;
  }
  start() {
    if (this.ptyProcess) return this.ptyProcess.pid;
    const command = this.payload.launchCommand.command;
    const args = this.payload.launchCommand.args || [];
    const env = buildRuntimeEnv(process.env, this.payload.launchCommand.env);
    let cwd = this.payload.workspace || process.cwd();
    if (cwd) {
      try {
        const stat2 = fs2.statSync(cwd);
        if (!stat2.isDirectory()) cwd = os.homedir();
      } catch {
        cwd = os.homedir();
      }
    }
    const spawnRuntime = () => pty.spawn(command, args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd,
      env
    });
    this.ptyProcess = this.payload.category === "cli" || this.payload.category === "acp" ? spawnCliChild(spawnRuntime, env) : spawnRuntime();
    this.screenMirror = getTerminalMirrorFactory()({
      cols: this.cols,
      rows: this.rows,
      scrollback: 32768
    });
    this.ptyProcess.onData((data) => {
      this.trackTerminalModes(data);
      this.onDataCallback(data);
      this.pendingWriteCount += 1;
      this.screenMirror?.write(data, () => {
        this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1);
        this.respondToTerminalQueries(data);
        this.flushSnapshotWaiters();
      });
    });
    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.ptyProcess = null;
      this.screenMirror?.dispose();
      this.screenMirror = null;
      this.pendingQueryScanTail = "";
      this.terminalModeScanTail = "";
      this.pendingWriteCount = 0;
      this.flushSnapshotWaiters();
      this.onExitCallback(
        typeof exitCode === "number" ? exitCode : null,
        typeof signal === "number" ? signal : null
      );
    });
    return this.ptyProcess.pid;
  }
  write(data) {
    if (!this.ptyProcess) throw new Error(`Session not running: ${this.sessionId}`);
    this.ptyProcess.write(data);
  }
  resize(cols, rows) {
    if (!this.ptyProcess) throw new Error(`Session not running: ${this.sessionId}`);
    this.ptyProcess.resize(cols, rows);
    this.cols = Math.max(1, cols | 0);
    this.rows = Math.max(1, rows | 0);
    this.scrollRegion = {
      top: Math.min(this.scrollRegion.top, this.rows - 1),
      bot: Math.min(Math.max(this.scrollRegion.top, this.scrollRegion.bot), this.rows - 1)
    };
    this.screenMirror?.resize(cols, rows);
  }
  stop(signal) {
    if (!this.ptyProcess) return;
    if (signal) this.ptyProcess.kill(signal);
    else this.ptyProcess.kill();
  }
  sendSignal(signal) {
    if (!this.ptyProcess) throw new Error(`Session not running: ${this.sessionId}`);
    const normalized = String(signal || "").trim().toUpperCase();
    if (!normalized) throw new Error("signal is required");
    try {
      process.kill(this.ptyProcess.pid, normalized);
    } catch {
      if (normalized === "SIGTERM" || normalized === "SIGKILL") {
        this.ptyProcess.kill();
        return;
      }
      throw new Error(`Unsupported signal for runtime ${this.sessionId}: ${normalized}`);
    }
  }
  /**
   * Resolves once every screenMirror.write() call made so far has had its
   * completion callback fire (i.e. the xterm mirror's WriteBuffer has fully
   * parsed all currently-queued PTY chunks). Callers that read the mirror's
   * text/cursor state — getSnapshotText(), getTerminalSnapshot() — must await
   * this first, otherwise they can observe a buffer missing the most recently
   * written chunk (stale/incomplete text, not corrupted text: see
   * TerminalMirrorHandle's `write` doc for why the read races the write).
   */
  flushPendingWrites() {
    if (this.pendingWriteCount <= 0) return Promise.resolve();
    return new Promise((resolve4) => {
      this.snapshotWaiters.push(resolve4);
    });
  }
  flushSnapshotWaiters() {
    if (this.pendingWriteCount > 0 || this.snapshotWaiters.length === 0) return;
    const waiters = this.snapshotWaiters;
    this.snapshotWaiters = [];
    for (const resolve4 of waiters) resolve4();
  }
  async getSnapshotText() {
    await this.flushPendingWrites();
    return this.screenMirror?.formatVT() || "";
  }
  /**
   * Best-effort, non-flushing read of the same text as getSnapshotText(),
   * for callers that persist periodically in the background (persistNow) and
   * must stay synchronous rather than awaiting in-flight PTY writes. A
   * restore-on-restart read of this can be briefly behind the live viewport
   * by at most one already-queued chunk; that trade-off is acceptable for a
   * background persistence snapshot but not for an interactive get_snapshot
   * request, which should use getSnapshotText() instead.
   */
  getSnapshotTextSync() {
    return this.screenMirror?.formatVT() || "";
  }
  async getTerminalSnapshot() {
    if (!this.ptyProcess || !this.screenMirror) {
      throw new Error(`Session not running: ${this.sessionId}`);
    }
    await this.flushPendingWrites();
    if (!this.ptyProcess || !this.screenMirror) {
      throw new Error(`Session not running: ${this.sessionId}`);
    }
    const cursor = this.screenMirror.getCursorPosition();
    return {
      text: this.screenMirror.formatPlainText(),
      state: {
        cursor: {
          row: Math.max(0, cursor.row | 0),
          col: Math.max(0, cursor.col | 0)
        },
        altScreen: this.altScreen,
        pasteMode: this.pasteMode,
        rawMode: true,
        scrollRegion: { ...this.scrollRegion },
        cols: this.cols,
        rows: this.rows
      }
    };
  }
  trackTerminalModes(data) {
    if (!data) return;
    const combined = this.terminalModeScanTail + data;
    const privateMode = /\x1b\[\?([0-9;]*)([hl])/g;
    let privateMatch;
    while ((privateMatch = privateMode.exec(combined)) !== null) {
      const enabled = privateMatch[2] === "h";
      for (const mode of privateMatch[1].split(";")) {
        if (mode === "47" || mode === "1047" || mode === "1049") this.altScreen = enabled;
        if (mode === "2004") this.pasteMode = enabled;
      }
    }
    const scrollRegion = /\x1b\[(\d*)(?:;(\d*))?r/g;
    let scrollMatch;
    while ((scrollMatch = scrollRegion.exec(combined)) !== null) {
      const top = scrollMatch[1] ? Number.parseInt(scrollMatch[1], 10) - 1 : 0;
      const bot = scrollMatch[2] ? Number.parseInt(scrollMatch[2], 10) - 1 : this.rows - 1;
      this.scrollRegion = {
        top: Math.max(0, Math.min(this.rows - 1, top)),
        bot: Math.max(0, Math.min(this.rows - 1, bot))
      };
      if (this.scrollRegion.bot < this.scrollRegion.top) {
        this.scrollRegion = { top: 0, bot: this.rows - 1 };
      }
    }
    const lastEscape = combined.lastIndexOf("\x1B");
    this.terminalModeScanTail = lastEscape >= 0 && combined.length - lastEscape < 64 ? combined.slice(lastEscape) : "";
  }
  respondToTerminalQueries(data) {
    if (!this.ptyProcess || !this.screenMirror || !data) return;
    const combined = this.pendingQueryScanTail + data;
    const regex = /\x1b\[(\?)?6n/g;
    let match;
    while ((match = regex.exec(combined)) !== null) {
      const cursor = this.screenMirror.getCursorPosition();
      const row = Math.max(1, (cursor.row | 0) + 1);
      const col = Math.max(1, (cursor.col | 0) + 1);
      const response = match[1] ? `\x1B[?${row};${col}R` : `\x1B[${row};${col}R`;
      this.ptyProcess.write(response);
    }
    this.pendingQueryScanTail = computeTerminalQueryTail(combined);
  }
};

// src/upgrade-lease.ts
import * as fs3 from "fs";
import * as path2 from "path";
import { createHash as createHash2, randomUUID } from "crypto";
import { execFileSync, spawn as spawn2 } from "child_process";
var digest = (value) => createHash2("sha256").update(value).digest("hex");
var HostUpgradeLease = class {
  constructor(binding, endpoint) {
    this.binding = binding;
    this.endpoint = endpoint;
    if (process.platform !== "darwin") throw new Error("native_host_upgrade_platform_unproved");
    this.journal = path2.join(binding.stateDir, "upgrade-lease.json");
    this.state = { schema: 1, endpoint, epoch: 0, held: false, owner: null, tokenHash: null };
  }
  bootId = randomUUID();
  child = null;
  state;
  healthy = false;
  poisoned = false;
  journal;
  async start() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) throw new Error("native_host_binding_already_started");
    fs3.mkdirSync(this.binding.stateDir, { recursive: true, mode: 448 });
    const dir = fs3.lstatSync(this.binding.stateDir);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || dir.mode & 63) {
      throw new Error("native_host_state_directory_untrusted");
    }
    if (this.binding.helperFileIdentity && this.fileIdentity() !== this.binding.helperFileIdentity) throw new Error("native_host_helper_file_identity_changed");
    if (fs3.realpathSync(this.binding.helperPath) !== this.binding.helperPath || digest(fs3.readFileSync(this.binding.helperPath)) !== this.binding.helperSha256) {
      throw new Error("native_host_helper_pin_mismatch");
    }
    if (this.binding.helperProtocol === 1 && String(execFileSync(this.binding.helperPath, ["--attest"], { stdio: "pipe", windowsHide: true })).trim() !== "adhdev-host-guardian/1") throw new Error("native_host_helper_protocol_mismatch");
    if (this.binding.helperFileIdentity && this.fileIdentity() !== this.binding.helperFileIdentity) throw new Error("native_host_helper_file_identity_changed");
    const lockPath = path2.join(this.binding.stateDir, "instance.lock");
    const priorLock = fs3.existsSync(lockPath);
    const child = spawn2(this.binding.helperPath, [lockPath], { stdio: "pipe", windowsHide: true });
    this.child = child;
    child.on("exit", () => {
      this.healthy = false;
    });
    child.on("error", () => {
      this.healthy = false;
    });
    await new Promise((resolve4, reject) => {
      const timer = setTimeout(() => {
        child.stdin.end();
        reject(new Error("native_host_lock_timeout"));
      }, 3e3);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("native_host_instance_locked"));
      });
      child.stdout.once("data", (data) => {
        clearTimeout(timer);
        if (String(data) !== "LOCKED\n") {
          child.stdin.end();
          reject(new Error("native_host_lock_protocol"));
          return;
        }
        this.healthy = true;
        resolve4();
      });
    });
    try {
      if (this.binding.helperFileIdentity && (this.fileIdentity() !== this.binding.helperFileIdentity || digest(fs3.readFileSync(this.binding.helperPath)) !== this.binding.helperSha256)) throw new Error("native_host_helper_file_identity_changed");
      if (fs3.existsSync(this.journal)) {
        const stat2 = fs3.lstatSync(this.journal);
        if (!stat2.isFile() || stat2.isSymbolicLink() || stat2.uid !== process.getuid?.() || stat2.mode & 63) throw new Error("native_host_lease_untrusted");
        const value = JSON.parse(fs3.readFileSync(this.journal, "utf8"));
        if (value.schema !== 1 || value.endpoint !== this.endpoint || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || typeof value.held !== "boolean" || (value.held ? typeof value.owner !== "string" || typeof value.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(value.tokenHash) : value.owner !== null || value.tokenHash !== null)) throw new Error("native_host_lease_corrupt");
        this.state = value;
      } else {
        if (priorLock) throw new Error("native_host_lease_journal_missing");
        this.persist(this.state);
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  fileIdentity() {
    const s = fs3.lstatSync(this.binding.helperPath);
    return JSON.stringify([s.dev, s.ino, s.uid, s.mode, s.size]);
  }
  persist(value) {
    const tmp = `${this.journal}.${randomUUID()}.tmp`;
    try {
      const fd = fs3.openSync(tmp, "wx", 384);
      try {
        fs3.writeFileSync(fd, JSON.stringify(value));
        fs3.fsyncSync(fd);
      } finally {
        fs3.closeSync(fd);
      }
      fs3.renameSync(tmp, this.journal);
      const dir = fs3.openSync(this.binding.stateDir, "r");
      try {
        fs3.fsyncSync(dir);
      } finally {
        fs3.closeSync(dir);
      }
      this.state = value;
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }
  assertHealthy() {
    if (this.binding.helperFileIdentity && this.fileIdentity() !== this.binding.helperFileIdentity) throw new Error("native_host_helper_file_identity_changed");
    if (!this.healthy || this.child?.exitCode !== null || this.child?.signalCode !== null || this.poisoned) throw new Error("native_host_lock_or_storage_unavailable");
  }
  assertMutable() {
    this.assertHealthy();
    if (this.state.held) throw new Error("native_host_idle_lease_held");
  }
  /** Explicit negative capability from the pinned native helper. Older helpers
   * may not implement the probe: timeout/error remains UNKNOWN to the caller. */
  recoveryCoverage() {
    this.assertHealthy();
    if (digest(fs3.readFileSync(this.binding.helperPath)) !== this.binding.helperSha256) throw new Error("native_host_helper_pin_mismatch");
    const raw = String(execFileSync(this.binding.helperPath, ["--recovery-coverage-v1"], {
      stdio: "pipe",
      timeout: 1e3,
      maxBuffer: 1024,
      windowsHide: true
    }));
    const value = JSON.parse(raw);
    this.assertHealthy();
    if (value.protocol !== 1 || value.verdict !== "UNKNOWN" || value.reason !== "historical_native_attribution_unavailable") {
      throw new Error("native_host_recovery_coverage_unsupported");
    }
    return { protocol: 1, verdict: "UNKNOWN", reason: value.reason };
  }
  proof() {
    this.assertHealthy();
    return { bootId: this.bootId, pid: process.pid, endpoint: this.endpoint, epoch: this.state.epoch, held: this.state.held, owner: this.state.owner };
  }
  validate(request) {
    this.assertHealthy();
    if (request.bootId !== this.bootId || request.epoch !== this.state.epoch || !Number.isSafeInteger(request.epoch) || typeof request.owner !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(request.owner) || typeof request.token !== "string" || !/^[a-f0-9]{64}$/.test(request.token)) throw new Error("native_host_lease_identity_mismatch");
  }
  acquire(request, idle) {
    this.validate(request);
    if (this.state.held) {
      if (this.state.owner !== request.owner || this.state.tokenHash !== digest(request.token)) throw new Error("native_host_lease_owned");
      return this.proof();
    }
    if (!idle) throw new Error("native_host_not_proven_idle");
    this.persist({ ...this.state, held: true, owner: request.owner, tokenHash: digest(request.token) });
    return this.proof();
  }
  release(request) {
    this.validate(request);
    if (!this.state.held || this.state.owner !== request.owner || this.state.tokenHash !== digest(request.token)) throw new Error("native_host_lease_owned");
    this.persist({ ...this.state, epoch: this.state.epoch + 1, held: false, owner: null, tokenHash: null });
    return this.proof();
  }
  async close() {
    this.healthy = false;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve4) => {
      child.once("exit", () => resolve4());
      child.stdin.end();
    });
  }
};

// src/storage.ts
import * as fs4 from "fs";
import * as path3 from "path";
import { resolveInstanceConfigDir, assertTestStorageIsolated } from "@adhdev/session-host-core";
var SessionHostStorage = class {
  rootDir;
  runtimesDir;
  tombstonesDir;
  constructor(options = {}) {
    const appName = options.appName || "adhdev";
    this.rootDir = options.rootDir || path3.join(resolveInstanceConfigDir(process.env), "session-host", appName);
    assertTestStorageIsolated(this.rootDir);
    this.runtimesDir = path3.join(this.rootDir, "runtimes");
    this.tombstonesDir = path3.join(this.rootDir, "tombstones");
  }
  /** Unknown/corrupt recovery files also veto idle admission; reads names only. */
  hasRuntimeEntries() {
    if (!fs4.existsSync(this.runtimesDir)) return false;
    const stat2 = fs4.lstatSync(this.runtimesDir);
    if (!stat2.isDirectory() || stat2.isSymbolicLink()) throw new Error("native_host_runtime_storage_untrusted");
    return fs4.readdirSync(this.runtimesDir).length > 0;
  }
  loadAll() {
    if (!fs4.existsSync(this.runtimesDir)) return [];
    const entries = fs4.readdirSync(this.runtimesDir, { withFileTypes: true });
    const states = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const fullPath = path3.join(this.runtimesDir, entry.name);
      try {
        const parsed = JSON.parse(fs4.readFileSync(fullPath, "utf8"));
        if (parsed?.record?.sessionId) {
          states.push(parsed);
        }
      } catch {
      }
    }
    return states.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  save(record, snapshot) {
    fs4.mkdirSync(this.runtimesDir, { recursive: true });
    const filePath = path3.join(this.runtimesDir, `${record.sessionId}.json`);
    const payload = {
      record,
      snapshot,
      updatedAt: Date.now()
    };
    fs4.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  }
  remove(sessionId) {
    const filePath = path3.join(this.runtimesDir, `${sessionId}.json`);
    try {
      fs4.unlinkSync(filePath);
    } catch {
    }
  }
  /**
   * Persist a compact termination tombstone. Kept in a separate directory from
   * live runtimes so it survives the post-exit cleanup of the runtime file and
   * remains inspectable for post-mortem diagnostics.
   */
  saveTombstone(sessionId, termination) {
    fs4.mkdirSync(this.tombstonesDir, { recursive: true });
    const filePath = path3.join(this.tombstonesDir, `${sessionId}.json`);
    const payload = {
      sessionId,
      termination,
      updatedAt: Date.now()
    };
    fs4.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  }
  loadTombstone(sessionId) {
    const filePath = path3.join(this.tombstonesDir, `${sessionId}.json`);
    try {
      const parsed = JSON.parse(fs4.readFileSync(filePath, "utf8"));
      return parsed?.sessionId ? parsed : null;
    } catch {
      return null;
    }
  }
  loadAllTombstones() {
    if (!fs4.existsSync(this.tombstonesDir)) return [];
    const entries = fs4.readdirSync(this.tombstonesDir, { withFileTypes: true });
    const states = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const fullPath = path3.join(this.tombstonesDir, entry.name);
      try {
        const parsed = JSON.parse(fs4.readFileSync(fullPath, "utf8"));
        if (parsed?.sessionId) states.push(parsed);
      } catch {
      }
    }
    return states.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  removeTombstone(sessionId) {
    const filePath = path3.join(this.tombstonesDir, `${sessionId}.json`);
    try {
      fs4.unlinkSync(filePath);
    } catch {
    }
  }
};

// src/operator-recovery-fence.ts
import * as fs5 from "fs";
import * as path4 from "path";
import { createHash as createHash3 } from "crypto";
import {
  OPERATOR_RECOVERY_TARGET as target,
  recoveryTargetBytes
} from "@adhdev/session-host-core";
var digest2 = (s) => createHash3("sha256").update(s).digest("hex");
var containsTarget = (payload) => {
  const text = JSON.stringify(payload);
  return text.includes(target.sessionId) || text.includes(target.providerSessionId);
};
var OperatorRecoveryFence = class {
  constructor(root) {
    this.root = root;
    this.file = path4.join(root, "operator-recovery-v1.json");
  }
  file;
  observedDigest = null;
  inFlight = 0;
  poisoned = false;
  assertLaunchAllowed(payload) {
    if (containsTarget(payload)) throw new Error("operator_recovery_fenced");
    if (this.observedDigest) this.witness();
  }
  enterLaunch(payload) {
    this.assertLaunchAllowed(payload);
    this.inFlight++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.inFlight--;
      }
    };
  }
  install(owner, grant, binding, assertNativeExclusion, targetRuntimePresent) {
    owner.assertGrant(grant);
    assertNativeExclusion();
    if (this.inFlight !== 0 || targetRuntimePresent()) throw new Error("operator_recovery_launch_in_flight");
    if (binding.namespace !== target.namespace || binding.workerDaemonId !== target.workerDaemonId || !binding.hostBootId || !binding.endpoint.endsWith(`adhdev-preview-session-host-${target.namespace}.sock`)) {
      throw new Error("operator_recovery_host_binding");
    }
    const state = {
      protocol: 1,
      target: recoveryTargetBytes,
      installedHostBootId: binding.hostBootId,
      namespace: binding.namespace
    };
    const bytes = JSON.stringify(state);
    fs5.mkdirSync(this.root, { recursive: true, mode: 448 });
    const directory = fs5.lstatSync(this.root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || directory.mode & 63) throw new Error("operator_recovery_storage_untrusted");
    owner.consume(grant);
    try {
      const fd = fs5.openSync(this.file, "wx", 384);
      try {
        fs5.writeFileSync(fd, bytes);
        fs5.fsyncSync(fd);
      } finally {
        fs5.closeSync(fd);
      }
      const dir = fs5.openSync(this.root, "r");
      try {
        fs5.fsyncSync(dir);
      } finally {
        fs5.closeSync(dir);
      }
      this.observedDigest = digest2(bytes);
      return this.observedDigest;
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }
  witness(expectedDigest) {
    if (this.poisoned || this.inFlight) throw new Error("operator_recovery_fence_unknown");
    const stat2 = fs5.lstatSync(this.file);
    if (!stat2.isFile() || stat2.isSymbolicLink() || stat2.nlink !== 1 || stat2.uid !== process.getuid?.() || stat2.mode & 63) throw new Error("operator_recovery_storage_untrusted");
    const bytes = fs5.readFileSync(this.file, "utf8");
    const hash = digest2(bytes);
    const state = JSON.parse(bytes);
    const pinned = expectedDigest ?? this.observedDigest;
    if (!pinned || hash !== pinned || state.protocol !== 1 || state.target !== recoveryTargetBytes || state.namespace !== target.namespace || !state.installedHostBootId) throw new Error("operator_recovery_fence_rollback");
    this.observedDigest = hash;
    return { digest: hash, installedHostBootId: state.installedHostBootId };
  }
};

// src/server.ts
import { resolveInstanceConfigDir as resolveInstanceConfigDir3 } from "@adhdev/session-host-core";

// src/prior-host-identity.ts
import { createHash as createHash4 } from "crypto";
import * as fs6 from "fs";
import * as path5 from "path";
import { resolveInstanceConfigDir as resolveInstanceConfigDir2 } from "@adhdev/session-host-core";
var INSTANCE_ARG_PREFIX = "--instance-config-key=";
function sessionHostInstanceArg(configDir) {
  const canonical = resolveInstanceConfigDir2({ ADHDEV_CONFIG_DIR: configDir });
  const digest3 = createHash4("sha256").update(canonical).digest("hex");
  return `${INSTANCE_ARG_PREFIX}${digest3}`;
}
function isManagedSessionHostCommandLine(commandLine, configDir) {
  if (!commandLine) return false;
  const tokens = [];
  const tokenRegex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = tokenRegex.exec(commandLine)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  if (tokens.length === 0) return false;
  const instanceTokens = tokens.filter((token) => token.startsWith(INSTANCE_ARG_PREFIX));
  const matchesInstanceArg = () => {
    if (instanceTokens.length !== 1) return false;
    if (configDir !== void 0) {
      return instanceTokens[0] === sessionHostInstanceArg(configDir);
    }
    return /^--instance-config-key=[0-9a-f]{64}$/.test(instanceTokens[0]);
  };
  const execBase = path5.basename(tokens[0].replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");
  if (execBase === "adhdev-sessiond") {
    const subcommand2 = tokens[1]?.toLowerCase();
    if (subcommand2 && subcommand2 !== "serve" && !subcommand2.startsWith("-")) return false;
    return configDir !== void 0 || instanceTokens.length > 0 ? matchesInstanceArg() : true;
  }
  if (execBase !== "node") return false;
  const valueFlags = /* @__PURE__ */ new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--conditions", "-C"]);
  let idx = 1;
  while (idx < tokens.length) {
    const token = tokens[idx];
    if (token === "--") {
      idx += 1;
      break;
    }
    if (token === "-e" || token === "--eval" || token === "-p" || token === "--print") {
      return false;
    }
    if (valueFlags.has(token)) {
      idx += 2;
      continue;
    }
    if (token.startsWith("-")) {
      idx += 1;
      continue;
    }
    break;
  }
  const scriptToken = tokens[idx];
  if (!scriptToken) return false;
  const normalizedScript = scriptToken.replace(/\\/g, "/").toLowerCase();
  const isSessionHostEntry = normalizedScript.endsWith("/session-host-daemon/dist/index.js") || normalizedScript.endsWith("/session-host-daemon/dist/index.mjs") || normalizedScript.endsWith("/session-host-daemon/index.js") || normalizedScript.endsWith("/session-host-daemon/src/index.ts") || path5.basename(normalizedScript) === "adhdev-sessiond";
  if (!isSessionHostEntry) return false;
  const subcommand = tokens[idx + 1]?.toLowerCase();
  if (subcommand && subcommand !== "serve" && !subcommand.startsWith("-")) return false;
  return matchesInstanceArg();
}
function readVerifiedReplacementProvenance(options) {
  const now = options.nowMs ? options.nowMs() : Date.now();
  const provenanceFile = options.provenanceFile ?? options.provenanceFilePath;
  try {
    if (!provenanceFile || !fs6.existsSync(provenanceFile)) return void 0;
    const stat2 = fs6.lstatSync(provenanceFile);
    if (!stat2.isFile() || stat2.isSymbolicLink() || stat2.nlink !== 1 || (stat2.mode & 63) !== 0) {
      return void 0;
    }
    if (typeof process.getuid === "function" && stat2.uid !== process.getuid()) {
      return void 0;
    }
    const parsed = JSON.parse(fs6.readFileSync(provenanceFile, "utf8"));
    if (!parsed || parsed.schemaVersion !== 1 && parsed.schema !== 1) return void 0;
    if (options.appName !== void 0 && parsed.appName !== void 0 && parsed.appName !== options.appName) {
      return void 0;
    }
    const canonicalDir = resolveInstanceConfigDir2({ ADHDEV_CONFIG_DIR: options.instanceConfigDir });
    if (typeof parsed.instanceConfigDir !== "string" || resolveInstanceConfigDir2({ ADHDEV_CONFIG_DIR: parsed.instanceConfigDir }) !== canonicalDir) {
      return void 0;
    }
    if (fs6.existsSync(canonicalDir)) {
      const provenanceFiles = fs6.readdirSync(canonicalDir).filter((entry) => entry.endsWith("-session-host-replacement.json"));
      if (provenanceFiles.length > 1) return void 0;
    }
    const expectedKey = sessionHostInstanceArg(canonicalDir);
    if (parsed.instanceConfigKey !== expectedKey) return void 0;
    const canonicalEndpointDir = fs6.existsSync(path5.dirname(options.endpointPath)) ? fs6.realpathSync(path5.dirname(options.endpointPath)) : path5.resolve(path5.dirname(options.endpointPath));
    const canonicalEndpointPath = path5.join(canonicalEndpointDir, path5.basename(options.endpointPath));
    const parsedEndpointDir = typeof parsed.endpointPath === "string" && fs6.existsSync(path5.dirname(parsed.endpointPath)) ? fs6.realpathSync(path5.dirname(parsed.endpointPath)) : typeof parsed.endpointPath === "string" ? path5.resolve(path5.dirname(parsed.endpointPath)) : "";
    const parsedEndpointPath = typeof parsed.endpointPath === "string" ? path5.join(parsedEndpointDir, path5.basename(parsed.endpointPath)) : "";
    if (parsedEndpointPath !== canonicalEndpointPath) return void 0;
    if (typeof parsed.expectedPid !== "number" || !Number.isFinite(parsed.expectedPid) || parsed.expectedPid <= 0) {
      return void 0;
    }
    const trimmedBirth = typeof parsed.expectedBirth === "string" ? parsed.expectedBirth.trim() : "";
    if (!trimmedBirth || trimmedBirth.toLowerCase() === "win32" || trimmedBirth.toLowerCase() === "unknown") {
      return void 0;
    }
    if (typeof parsed.expectedBootId !== "string" || !parsed.expectedBootId.trim()) {
      return void 0;
    }
    if (typeof parsed.expectedEpoch !== "number" || !Number.isFinite(parsed.expectedEpoch) || parsed.expectedEpoch < 0) {
      return void 0;
    }
    if (typeof parsed.expectedOwner !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(parsed.expectedOwner.trim())) {
      return void 0;
    }
    if (parsed.activeRuntimeCount !== 0) {
      return void 0;
    }
    const issuedAtMs = parsed.issuedAtMs ?? parsed.issuedAt;
    if (typeof issuedAtMs !== "number" || !Number.isFinite(issuedAtMs) || now - issuedAtMs > 6e4 || issuedAtMs - now > 5e3) {
      return void 0;
    }
    let expectedEndpointInode;
    if (parsed.expectedEndpointInode !== null && parsed.expectedEndpointInode !== void 0) {
      if (typeof parsed.expectedEndpointInode !== "string" || !/^\d+$/.test(parsed.expectedEndpointInode)) {
        return void 0;
      }
      expectedEndpointInode = BigInt(parsed.expectedEndpointInode);
    }
    const effectiveLeaseStateDir = options.leaseStateDir ?? path5.join(canonicalDir, "session-host");
    if (effectiveLeaseStateDir) {
      const leaseFile = path5.join(effectiveLeaseStateDir, "upgrade-lease.json");
      if (!fs6.existsSync(leaseFile)) return void 0;
      if (fs6.existsSync(leaseFile)) {
        const leaseStat = fs6.lstatSync(leaseFile);
        if (!leaseStat.isFile() || leaseStat.isSymbolicLink() || leaseStat.nlink !== 1 || (leaseStat.mode & 63) !== 0) {
          return void 0;
        }
        if (typeof process.getuid === "function" && leaseStat.uid !== process.getuid()) {
          return void 0;
        }
        const lease = JSON.parse(fs6.readFileSync(leaseFile, "utf8"));
        const leaseEndpointDir = typeof lease.endpoint === "string" && fs6.existsSync(path5.dirname(lease.endpoint)) ? fs6.realpathSync(path5.dirname(lease.endpoint)) : typeof lease.endpoint === "string" ? path5.resolve(path5.dirname(lease.endpoint)) : "";
        const leaseEndpointPath = typeof lease.endpoint === "string" ? path5.join(leaseEndpointDir, path5.basename(lease.endpoint)) : "";
        if (lease.schema !== 1 || lease.held !== true || leaseEndpointPath !== canonicalEndpointPath || lease.epoch !== parsed.expectedEpoch || lease.owner !== parsed.expectedOwner || typeof lease.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(lease.tokenHash)) {
          return void 0;
        }
        if (lease.bootId !== void 0 && lease.bootId !== parsed.expectedBootId) {
          return void 0;
        }
        if (lease.pid !== void 0 && lease.pid !== parsed.expectedPid) {
          return void 0;
        }
        if (lease.expiresAt !== void 0 && (typeof lease.expiresAt !== "number" || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= now)) {
          return void 0;
        }
        if (!parsed.expectedTokenHash || parsed.expectedTokenHash !== lease.tokenHash) {
          return void 0;
        }
      }
    }
    return {
      expectedPid: parsed.expectedPid,
      expectedBirth: trimmedBirth,
      instanceConfigDir: canonicalDir,
      instanceConfigKey: expectedKey,
      expectedEndpointInode,
      expectedBootId: parsed.expectedBootId.trim(),
      expectedEpoch: parsed.expectedEpoch,
      expectedOwner: parsed.expectedOwner.trim(),
      expectedTokenHash: parsed.expectedTokenHash ?? void 0,
      activeRuntimeCount: 0,
      isCancelled: options.skipDynamicWrap ? void 0 : () => readVerifiedReplacementProvenance({
        ...options,
        skipDynamicWrap: true
      }) === void 0
    };
  } catch {
    return void 0;
  }
}

// src/session-diagnostics.ts
import * as path6 from "path";
import {
  SESSION_HOST_SUPPORTED_REQUEST_TYPES
} from "@adhdev/session-host-core";
var MAX_RECENT_DIAGNOSTICS = 200;
function resolveHostEntryPath() {
  const entry = process.argv[1];
  if (typeof entry !== "string" || !entry.trim()) return void 0;
  try {
    return path6.resolve(entry);
  } catch {
    return entry;
  }
}
function pushRecent(bucket, entry, max = MAX_RECENT_DIAGNOSTICS) {
  bucket.push(entry);
  if (bucket.length > max) {
    bucket.splice(0, bucket.length - max);
  }
}
function getSessionHostRecoveryLabel(record) {
  const recoveryState = typeof record.meta?.runtimeRecoveryState === "string" ? String(record.meta.runtimeRecoveryState).trim() : "";
  if (!recoveryState) return null;
  if (recoveryState === "auto_resumed") return "restored after restart";
  if (recoveryState === "resume_failed") return "restore failed";
  if (recoveryState === "host_restart_interrupted") return "host restart interrupted";
  if (recoveryState === "orphan_snapshot") return "snapshot recovered";
  return recoveryState.replace(/_/g, " ");
}
function getSessionSurfaceKind(record) {
  if (["starting", "running", "stopping", "interrupted"].includes(record.lifecycle)) {
    return "live_runtime";
  }
  if ((record.lifecycle === "stopped" || record.lifecycle === "failed") && (record.meta?.restoredFromStorage === true || getSessionHostRecoveryLabel(record))) {
    return "recovery_snapshot";
  }
  return "inactive_record";
}
function annotateSessionSurface(record) {
  return {
    ...record,
    surfaceKind: getSessionSurfaceKind(record)
  };
}
function sanitizeDiagnosticsRecord(record) {
  return {
    ...record,
    launchCommand: {
      command: record.launchCommand.command,
      args: Array.isArray(record.launchCommand.args) ? [...record.launchCommand.args] : []
    }
  };
}
function buildHostDiagnostics(params) {
  const limit = Math.max(1, Math.min(200, Number(params.payload?.limit) || 50));
  const allSessions = params.payload?.includeSessions === false ? void 0 : params.sessions.map((record) => annotateSessionSurface(record)).map((record) => sanitizeDiagnosticsRecord(record));
  const liveRuntimes = allSessions?.filter((record) => record.surfaceKind === "live_runtime");
  const recoverySnapshots = allSessions?.filter((record) => record.surfaceKind === "recovery_snapshot").slice(0, limit);
  const inactiveRecords = allSessions?.filter((record) => record.surfaceKind === "inactive_record").slice(0, limit);
  const sessions = allSessions ? [
    ...liveRuntimes || [],
    ...recoverySnapshots || [],
    ...inactiveRecords || []
  ] : void 0;
  return {
    hostStartedAt: params.hostStartedAt,
    endpoint: params.endpointPath,
    // Self-reported so a client can tell WHICH install this host runs from
    // without needing process-inspection privileges. See SessionHostDiagnostics.
    hostEntryPath: resolveHostEntryPath(),
    runtimeCount: params.runtimeCount,
    supportedRequestTypes: [...SESSION_HOST_SUPPORTED_REQUEST_TYPES],
    sessions,
    liveRuntimes,
    recoverySnapshots,
    inactiveRecords,
    recentLogs: params.recentLogs.slice(-limit),
    recentRequests: params.recentRequests.slice(-limit),
    recentTransitions: params.recentTransitions.slice(-limit)
  };
}

// src/session-lifecycle.ts
import {
  replayLaunchEnv,
  resolveSessionHostCols as resolveSessionHostCols2,
  resolveSessionHostRows as resolveSessionHostRows2
} from "@adhdev/session-host-core";
function compareDuplicateCandidates(a, b) {
  const score = (record) => {
    const lifecycleScore = record.lifecycle === "running" ? 4 : record.lifecycle === "starting" ? 3 : record.lifecycle === "stopping" ? 2 : record.lifecycle === "interrupted" ? 1 : 0;
    return [
      lifecycleScore,
      record.writeOwner ? 1 : 0,
      Array.isArray(record.attachedClients) ? record.attachedClients.length : 0,
      record.lastActivityAt || 0,
      record.startedAt || 0,
      record.createdAt || 0
    ];
  };
  const aScore = score(a);
  const bScore = score(b);
  for (let i = 0; i < aScore.length; i += 1) {
    if (aScore[i] === bScore[i]) continue;
    return bScore[i] - aScore[i];
  }
  return 0;
}
function planDuplicatePrune(sessions, filters) {
  const candidates = sessions.filter((record) => ["starting", "running", "stopping", "interrupted"].includes(record.lifecycle)).filter((record) => !filters.providerFilter || record.providerType === filters.providerFilter).filter((record) => !filters.workspaceFilter || record.workspace === filters.workspaceFilter);
  const groups = /* @__PURE__ */ new Map();
  for (const record of candidates) {
    const providerSessionId = typeof record.meta?.providerSessionId === "string" ? String(record.meta.providerSessionId).trim() : "";
    if (!providerSessionId) continue;
    const bindingKey = `${record.providerType}::${record.workspace}::${providerSessionId}`;
    const bucket = groups.get(bindingKey) || [];
    bucket.push(record);
    groups.set(bindingKey, bucket);
  }
  const duplicateGroups = [];
  const keptSessionIds = [];
  const duplicateRecords = [];
  for (const [bindingKey, records] of groups.entries()) {
    if (records.length < 2) continue;
    const sorted = [...records].sort((a, b) => compareDuplicateCandidates(a, b));
    const kept = sorted[0];
    const duplicates = sorted.slice(1);
    const providerSessionId = typeof kept.meta?.providerSessionId === "string" ? String(kept.meta.providerSessionId) : "";
    duplicateGroups.push({
      bindingKey,
      providerType: kept.providerType,
      workspace: kept.workspace,
      providerSessionId,
      keptSessionId: kept.sessionId,
      prunedSessionIds: duplicates.map((record) => record.sessionId)
    });
    keptSessionIds.push(kept.sessionId);
    for (const duplicate of duplicates) {
      duplicateRecords.push(duplicate);
    }
  }
  return { duplicateGroups, keptSessionIds, duplicateRecords };
}
function buildPayloadFromRecord(record) {
  return {
    sessionId: record.sessionId,
    runtimeKey: record.runtimeKey,
    displayName: record.displayName,
    providerType: record.providerType,
    category: record.category,
    workspace: record.workspace,
    launchCommand: { ...record.launchCommand, env: replayLaunchEnv(record.launchCommand), envMode: "launch_overrides" },
    cols: resolveSessionHostCols2(typeof record.meta?.sessionHostCols === "number" ? record.meta.sessionHostCols : void 0),
    rows: resolveSessionHostRows2(typeof record.meta?.sessionHostRows === "number" ? record.meta.sessionHostRows : void 0),
    meta: record.meta
  };
}
function buildRecoveredRecord(persisted) {
  const wasLiveRuntime = !["stopped", "failed"].includes(persisted.record.lifecycle);
  const hadAttachedClients = Array.isArray(persisted.record.attachedClients) && persisted.record.attachedClients.length > 0;
  const hadWriteOwner = !!persisted.record.writeOwner;
  const hadRecoveryInterest = hadAttachedClients || hadWriteOwner;
  const recoveredRecord = {
    ...persisted.record,
    attachedClients: [],
    writeOwner: null,
    lifecycle: wasLiveRuntime ? "stopped" : persisted.record.lifecycle,
    lastActivityAt: Date.now(),
    meta: {
      ...persisted.record.meta || {},
      restoredFromStorage: true,
      runtimeRecoveryState: wasLiveRuntime ? "orphan_snapshot" : "snapshot",
      runtimeHadAttachedClientsAtCrash: hadAttachedClients,
      runtimeHadWriteOwnerAtCrash: hadWriteOwner,
      runtimeAutoResumeSkipped: wasLiveRuntime && hadRecoveryInterest
    }
  };
  return { recoveredRecord, wasLiveRuntime, hadRecoveryInterest };
}

// src/session-protocol.ts
function getRequestSessionId(request) {
  const payload = request.payload;
  return typeof payload?.sessionId === "string" ? payload.sessionId : void 0;
}
function getRequestClientId(request) {
  const payload = request.payload;
  return typeof payload?.clientId === "string" ? payload.clientId : void 0;
}
function mergeRuntimeSnapshot(base, record, opts) {
  const cols = typeof record?.meta?.sessionHostCols === "number" ? record.meta.sessionHostCols : 80;
  const rows = typeof record?.meta?.sessionHostRows === "number" ? record.meta.sessionHostRows : 24;
  if (typeof opts.sinceSeq === "number" || !opts.runtimeText) {
    return {
      ...base,
      text: withReplayResyncPreamble(base.text, opts.sinceSeq),
      cols,
      rows
    };
  }
  return {
    ...base,
    text: opts.runtimeText,
    truncated: false,
    cols,
    rows
  };
}
var REPLAY_RESYNC_PREAMBLE = "\x1B[2J\x1B[H";
function withReplayResyncPreamble(text, sinceSeq) {
  if (typeof sinceSeq === "number" && sinceSeq > 0) return text;
  if (!text) return text;
  if (text.startsWith(REPLAY_RESYNC_PREAMBLE)) return text;
  return `${REPLAY_RESYNC_PREAMBLE}${text}`;
}

// src/server.ts
var SessionHostServer = class extends EventEmitter {
  endpoint;
  registry = new SessionHostRegistry();
  runtimes = /* @__PURE__ */ new Map();
  storage;
  recoveryFence;
  upgradeLease;
  instanceConfigDir;
  pidFilePath;
  isPidAliveOverride;
  getOwnerBirth;
  getSocketOwnerPids;
  isCancelled;
  startupFence = null;
  hasReplacementContext;
  restorePending = true;
  mutatingRequests = 0;
  endpointInode = null;
  ipcServer = null;
  sockets = /* @__PURE__ */ new Set();
  // Tracks which sessionIds each socket has subscribed to (via create/attach).
  // Used to avoid broadcasting session-specific events to uninterested sockets.
  socketSessions = /* @__PURE__ */ new Map();
  persistTimers = /* @__PURE__ */ new Map();
  startedAt = Date.now();
  recentLogs = [];
  recentRequests = [];
  recentTransitions = [];
  exitWaiters = /* @__PURE__ */ new Map();
  lastNoOutputInputWarnAt = /* @__PURE__ */ new Map();
  // Records the most recent explicit stop/delete/restart/prune request per
  // session so the termination diagnostic can attribute the exit to it.
  stopRequests = /* @__PURE__ */ new Map();
  // Shutdown is driven by independent SIGINT/SIGTERM handlers, so stop() can be
  // entered twice. Cache the in-flight promise and hand it to every later caller
  // instead of re-running flushAllPersistence()/runtime.stop() on already-cleared state.
  stopPromise = null;
  constructor(options = {}) {
    super();
    this.endpoint = options.endpoint || getDefaultSessionHostEndpoint(options.appName || "adhdev");
    if (options.upgradeBinding) {
      const relative3 = options.storageRootDir && path7.relative(options.upgradeBinding.stateDir, options.storageRootDir);
      if (this.endpoint.kind !== "unix" || !options.storageRootDir || !path7.isAbsolute(options.storageRootDir) || !path7.isAbsolute(options.upgradeBinding.stateDir) || relative3 === ".." || relative3?.startsWith(`..${path7.sep}`) || path7.isAbsolute(relative3 || "")) {
        throw new Error("native_host_instance_storage_binding_required");
      }
    }
    this.upgradeLease = options.upgradeBinding ? new HostUpgradeLease(options.upgradeBinding, this.endpoint.path) : null;
    this.instanceConfigDir = options.instanceConfigDir || null;
    this.pidFilePath = options.pidFilePath || null;
    this.isPidAliveOverride = options.isPidAlive;
    this.hasReplacementContext = Object.prototype.hasOwnProperty.call(options, "replacementProvenance");
    this.getOwnerBirth = options.getOwnerBirth;
    this.getSocketOwnerPids = options.getSocketOwnerPids;
    this.isCancelled = options.isCancelled;
    this.storage = new SessionHostStorage({
      appName: options.appName || "adhdev",
      rootDir: options.storageRootDir
    });
    this.recoveryFence = new OperatorRecoveryFence(options.storageRootDir || path7.join(resolveInstanceConfigDir3(process.env), "session-host", options.appName || "adhdev"));
  }
  isPidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (this.isPidAliveOverride) return this.isPidAliveOverride(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  }
  readProcessBirth(pid) {
    if (this.getOwnerBirth) return this.getOwnerBirth(pid);
    if (process.platform === "win32") return null;
    try {
      return String(
        execFileSync2("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2e3,
          windowsHide: true
        })
      ).trim() || null;
    } catch {
      return null;
    }
  }
  readSocketOwnerPids() {
    if (this.getSocketOwnerPids) return this.getSocketOwnerPids(this.endpoint.path);
    if (process.platform === "win32" || !fs7.existsSync(this.endpoint.path)) return [];
    const lsofBin = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
    try {
      const out = String(
        execFileSync2(lsofBin, ["-n", "-t", "--", this.endpoint.path], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2e3,
          windowsHide: true
        })
      );
      const pids = [];
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!/^\d+$/.test(trimmed)) return null;
        const pid = Number.parseInt(trimmed, 10);
        if (!Number.isSafeInteger(pid) || pid <= 0) return null;
        pids.push(pid);
      }
      return pids;
    } catch (error) {
      if (error?.status === 1 && String(error?.stdout ?? "").trim() === "") return [];
      return null;
    }
  }
  assertNoAutomaticReplacementContext() {
    if (this.isCancelled?.()) throw new Error("session_host_start_cancelled");
    if (this.hasReplacementContext) throw new Error("session_host_live_owner_replacement_unauthorized");
    if (this.instanceConfigDir && fs7.existsSync(this.instanceConfigDir)) {
      if (fs7.readdirSync(this.instanceConfigDir).some((name) => name.endsWith("-session-host-replacement.json"))) {
        throw new Error("session_host_live_owner_replacement_unauthorized");
      }
    }
    if (this.isCancelled?.()) throw new Error("session_host_start_cancelled");
  }
  async evictPriorEndpointOwners() {
    this.assertNoAutomaticReplacementContext();
    if (this.endpoint.kind !== "unix") return;
    const identity = (file) => {
      try {
        const stat2 = fs7.lstatSync(file, { bigint: true });
        return `${stat2.dev}:${stat2.ino}:${stat2.mode}`;
      } catch (error) {
        if (error.code === "ENOENT") return "missing";
        throw error;
      }
    };
    const configIdentity = this.instanceConfigDir ? identity(this.instanceConfigDir) : null;
    const endpointParent = fs7.realpathSync(path7.dirname(this.endpoint.path));
    const initialEndpoint = identity(this.endpoint.path);
    const readPid = () => {
      if (!this.pidFilePath) return "missing";
      try {
        const raw = fs7.readFileSync(this.pidFilePath, "utf8").trim();
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
          throw new Error("session_host_prior_owner_pidfile_corrupt");
        }
        return raw;
      } catch (error) {
        if (error.code === "ENOENT") return "missing";
        throw error;
      }
    };
    const initialPid = readPid();
    const initialBirth = initialPid === "missing" ? null : this.readProcessBirth(Number(initialPid));
    const assertGeneration = (expectedEndpoint) => {
      this.assertNoAutomaticReplacementContext();
      const currentPid = readPid();
      const birth = initialPid === "missing" ? null : this.readProcessBirth(Number(initialPid));
      const alive = initialPid !== "missing" && this.isPidAlive(Number(initialPid));
      if (currentPid !== initialPid || birth !== initialBirth || alive || this.instanceConfigDir && identity(this.instanceConfigDir) !== configIdentity || fs7.realpathSync(path7.dirname(this.endpoint.path)) !== endpointParent || identity(this.endpoint.path) !== expectedEndpoint || readPid() !== initialPid) {
        throw new Error("session_host_endpoint_changed_during_recovery");
      }
      this.assertNoAutomaticReplacementContext();
    };
    if (initialPid !== "missing" && this.isPidAlive(Number(initialPid))) {
      throw new Error("session_host_live_owner_replacement_unauthorized");
    }
    if (initialEndpoint !== "missing") {
      if (this.upgradeLease) throw new Error("native_host_endpoint_owner_unproved");
      if (initialPid === "missing") throw new Error("session_host_prior_owner_socket_unverified");
      for (let check = 0; check < 2; check++) {
        const owners = this.readSocketOwnerPids();
        if (owners === null) throw new Error("session_host_prior_owner_socket_unverified");
        if (owners.length !== 0) throw new Error("session_host_endpoint_changed_during_recovery");
        assertGeneration(initialEndpoint);
      }
      fs7.unlinkSync(this.endpoint.path);
    }
    this.startupFence = () => assertGeneration("missing");
    this.startupFence();
  }
  async start() {
    validateSessionHostEndpoint(this.endpoint);
    this.assertNoAutomaticReplacementContext();
    if (this.upgradeLease && fs7.existsSync(this.endpoint.path)) {
      throw new Error("native_host_endpoint_owner_unproved");
    }
    await this.evictPriorEndpointOwners();
    this.startupFence?.();
    if (this.upgradeLease) {
      await this.upgradeLease.start();
      try {
        this.startupFence?.();
      } catch (error) {
        await this.upgradeLease.close();
        throw error;
      }
    }
    this.startupFence?.();
    this.ipcServer = net.createServer((socket) => {
      this.sockets.add(socket);
      const parser = createLineParser((envelope) => {
        if (envelope.kind !== "request") return;
        void this.handleIncomingRequest(socket, envelope);
      });
      const flushParser = () => {
        let remainder = "";
        try {
          remainder = parser.end();
        } catch {
          return;
        }
        if (!remainder.trim()) return;
        this.recordHostLog(
          "warn",
          `session host discarded ${remainder.length} bytes of an incomplete IPC frame at EOF`
        );
      };
      const removeSocket = () => {
        this.sockets.delete(socket);
        this.socketSessions.delete(socket);
      };
      socket.on("close", () => {
        flushParser();
        removeSocket();
      });
      socket.on("end", () => {
        flushParser();
        removeSocket();
      });
      socket.on("error", () => {
        flushParser();
        removeSocket();
        try {
          socket.destroy();
        } catch {
        }
      });
      socket.on("data", parser);
    });
    try {
      await new Promise((resolve4, reject) => {
        this.ipcServer?.once("listening", () => resolve4());
        this.ipcServer?.once("error", reject);
        this.startupFence?.();
        this.ipcServer?.listen(this.endpoint.path);
      });
    } catch (error) {
      await this.upgradeLease?.close();
      throw error;
    }
    if (this.endpoint.kind === "unix") {
      if (this.upgradeLease) {
        fs7.chmodSync(this.endpoint.path, 384);
      }
      try {
        this.endpointInode = fs7.lstatSync(this.endpoint.path, { bigint: true }).ino;
      } catch {
        this.endpointInode = null;
      }
    }
    this.recordHostLog("info", `session host endpoint ready: ${this.endpoint.path}`);
    setTimeout(() => {
      try {
        if (!this.upgradeLease?.proof().held) this.restorePersistedRuntimes();
      } catch (error) {
        this.recordHostLog("error", `session host restore failed: ${error?.message || String(error)}`);
      } finally {
        this.restorePending = false;
      }
    }, 0);
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.runStop();
    return this.stopPromise;
  }
  async runStop() {
    this.flushAllPersistence();
    for (const runtime of this.runtimes.values()) {
      try {
        runtime.stop();
      } catch {
      }
    }
    this.runtimes.clear();
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }
    this.persistTimers.clear();
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.socketSessions.clear();
    let endpointReplaced = false;
    if (this.endpoint.kind === "unix" && this.endpointInode !== null) {
      try {
        const currentIno = fs7.lstatSync(this.endpoint.path, { bigint: true }).ino;
        endpointReplaced = currentIno !== this.endpointInode;
      } catch {
        endpointReplaced = true;
      }
    }
    if (this.ipcServer) {
      const server = this.ipcServer;
      this.ipcServer = null;
      if (endpointReplaced) {
        server.unref();
        server.removeAllListeners();
      } else {
        await new Promise((resolve4) => server.close(() => resolve4()));
      }
    }
    if (this.endpoint.kind === "unix" && !endpointReplaced) {
      try {
        if (this.endpointInode !== null && fs7.lstatSync(this.endpoint.path, { bigint: true }).ino === this.endpointInode) {
          fs7.unlinkSync(this.endpoint.path);
        }
      } catch {
      }
    }
    await this.upgradeLease?.close();
    this.removeAllListeners();
  }
  async handleRequest(request, sourceSocket) {
    const readOnly = ["get_operator_recovery_coverage_v1", "get_upgrade_lease", "acquire_upgrade_lease", "release_upgrade_lease", "get_host_diagnostics", "get_session", "list_sessions", "get_snapshot", "get_terminal_snapshot"].includes(request.type);
    let counted = false;
    try {
      if (!readOnly) {
        this.upgradeLease?.assertMutable();
        this.mutatingRequests++;
        counted = true;
      }
      switch (request.type) {
        case "get_operator_recovery_coverage_v1": {
          if (!/^[a-f0-9]{64}$/.test(request.payload?.nonce)) throw new Error("operator_recovery_nonce_required");
          let coverage = {
            protocol: 1,
            verdict: "UNKNOWN",
            reason: "native_guardian_coverage_missing"
          };
          try {
            if (this.upgradeLease) coverage = this.upgradeLease.recoveryCoverage();
          } catch {
          }
          return { success: true, result: { ...coverage, nonce: request.payload.nonce } };
        }
        case "get_upgrade_lease":
          if (!this.upgradeLease) throw new Error("native_host_upgrade_binding_unavailable");
          return { success: true, result: this.upgradeLease.proof() };
        case "acquire_upgrade_lease":
          if (!this.upgradeLease) throw new Error("native_host_upgrade_binding_unavailable");
          return { success: true, result: this.upgradeLease.acquire(
            request.payload,
            !this.restorePending && this.mutatingRequests === 0 && this.runtimes.size === 0 && this.registry.listSessions().length === 0 && !this.storage.hasRuntimeEntries()
          ) };
        case "release_upgrade_lease":
          if (!this.upgradeLease) throw new Error("native_host_upgrade_binding_unavailable");
          return { success: true, result: this.upgradeLease.release(request.payload) };
        case "create_session": {
          const record = this.registry.createSession(request.payload);
          if (sourceSocket) {
            this.subscribeSocketToSession(sourceSocket, record.sessionId);
          }
          this.schedulePersist(record.sessionId);
          this.emitEvent({ type: "session_created", sessionId: record.sessionId, record });
          this.recordRuntimeTransition(record.sessionId, "create_session", "starting", `provider=${record.providerType}`, true);
          try {
            const startedRecord = this.startRuntime(record, request.payload, "session_started");
            return { success: true, result: startedRecord };
          } catch (error) {
            this.registry.markStopped(record.sessionId, "failed");
            this.persistNow(record.sessionId);
            this.recordRuntimeTransition(record.sessionId, "create_session_failed", "failed", void 0, false, error?.message || String(error));
            return { success: false, error: error?.message || String(error) };
          }
        }
        case "list_sessions":
          return { success: true, result: this.registry.listSessionSummaries(request.payload?.activeOnly === true) };
        case "get_session": {
          const record = this.registry.getSession(request.payload.sessionId);
          return record ? { success: true, result: record } : { success: false, error: "session_absent" };
        }
        case "attach_session": {
          const record = this.registry.attachClient(request.payload);
          this.schedulePersist(record.sessionId);
          const client = record.attachedClients.find((item) => item.clientId === request.payload.clientId);
          if (client) {
            this.emitEvent({ type: "client_attached", sessionId: record.sessionId, client });
          }
          this.recordRuntimeTransition(record.sessionId, "attach_client", record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        case "detach_session": {
          const record = this.registry.detachClient(request.payload);
          this.schedulePersist(record.sessionId);
          this.emitEvent({ type: "client_detached", sessionId: record.sessionId, clientId: request.payload.clientId });
          this.recordRuntimeTransition(record.sessionId, "detach_client", record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        case "acquire_write": {
          const record = this.registry.acquireWrite(request.payload);
          this.persistNow(record.sessionId);
          this.emitEvent({ type: "write_owner_changed", sessionId: record.sessionId, owner: record.writeOwner });
          this.recordRuntimeTransition(record.sessionId, "acquire_write", record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        case "release_write": {
          const record = this.registry.releaseWrite(request.payload);
          this.persistNow(record.sessionId);
          this.emitEvent({ type: "write_owner_changed", sessionId: record.sessionId, owner: record.writeOwner });
          this.recordRuntimeTransition(record.sessionId, "release_write", record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        case "get_snapshot":
          return { success: true, result: await this.getSnapshotForRequest(request.payload.sessionId, request.payload.sinceSeq) };
        case "get_terminal_snapshot":
          return { success: true, result: await this.requireRuntime(request.payload.sessionId).getTerminalSnapshot() };
        case "get_host_diagnostics":
          return { success: true, result: this.getHostDiagnostics(request.payload) };
        case "clear_session_buffer": {
          const record = this.registry.clearBuffer(request.payload.sessionId);
          this.persistNow(record.sessionId);
          this.emitEvent({ type: "session_cleared", sessionId: record.sessionId });
          this.recordRuntimeTransition(record.sessionId, "clear_buffer", record.lifecycle, void 0, true);
          return { success: true, result: record };
        }
        case "update_session_meta": {
          const record = this.registry.updateSessionMeta(
            request.payload.sessionId,
            request.payload.meta || {},
            request.payload.replace === true
          );
          this.persistNow(record.sessionId);
          this.recordRuntimeTransition(record.sessionId, "update_meta", record.lifecycle, void 0, true);
          return { success: true, result: record };
        }
        case "send_input": {
          const client = this.getAttachedClient(request.payload.sessionId, request.payload.clientId);
          if (client?.readOnly) {
            return { success: false, error: `Client ${request.payload.clientId} is read-only` };
          }
          const session = this.registry.getSession(request.payload.sessionId);
          if (session?.writeOwner && session.writeOwner.clientId !== request.payload.clientId) {
            return { success: false, error: `Write owned by ${session.writeOwner.clientId}` };
          }
          const runtime = this.requireRuntime(request.payload.sessionId);
          const beforeSnapshotSeq = this.registry.getSnapshot(request.payload.sessionId)?.seq ?? 0;
          this.announceInput(request.payload.sessionId, request.payload.clientId);
          runtime.write(request.payload.data);
          this.scheduleNoOutputInputDiagnostic({
            sessionId: request.payload.sessionId,
            clientId: request.payload.clientId,
            input: request.payload.data,
            beforeSnapshotSeq
          });
          return { success: true, result: this.registry.getSession(request.payload.sessionId) };
        }
        case "get_input_state":
          return { success: true, result: this.registry.getInputState(request.payload.sessionId) };
        case "send_input_if_seq": {
          const p = request.payload;
          const client = this.getAttachedClient(p.sessionId, p.clientId);
          if (client?.readOnly) return { success: false, error: `Client ${p.clientId} is read-only` };
          const session = this.registry.getSession(p.sessionId);
          if (session?.writeOwner && session.writeOwner.clientId !== p.clientId) {
            return { success: false, error: `Write owned by ${session.writeOwner.clientId}` };
          }
          const runtime = this.requireRuntime(p.sessionId);
          const now = this.registry.getInputState(p.sessionId);
          if (now.inputSeq !== p.expectedInputSeq || now.inputEpoch !== p.expectedInputEpoch) {
            return { success: false, error: "input_seq_mismatch" };
          }
          this.announceInput(p.sessionId, p.clientId);
          runtime.write(p.data);
          return { success: true, result: this.registry.getSession(p.sessionId) };
        }
        case "resize_session": {
          this.requireRuntime(request.payload.sessionId).resize(request.payload.cols, request.payload.rows);
          const record = this.registry.getSession(request.payload.sessionId);
          if (record) {
            this.registry.restoreSession(
              {
                ...record,
                meta: {
                  ...record.meta || {},
                  sessionHostCols: request.payload.cols,
                  sessionHostRows: request.payload.rows
                }
              },
              this.registry.getSnapshot(request.payload.sessionId)
            );
          }
          this.schedulePersist(request.payload.sessionId);
          this.emitEvent({
            type: "session_resized",
            sessionId: request.payload.sessionId,
            cols: request.payload.cols,
            rows: request.payload.rows
          });
          return { success: true, result: this.registry.getSession(request.payload.sessionId) };
        }
        case "stop_session": {
          this.stopRequests.set(request.payload.sessionId, "stop");
          this.registry.setLifecycle(request.payload.sessionId, "stopping");
          this.persistNow(request.payload.sessionId);
          this.requireRuntime(request.payload.sessionId).stop();
          this.emitEvent({ type: "session_stopped", sessionId: request.payload.sessionId });
          this.recordRuntimeTransition(request.payload.sessionId, "stop_session", "stopping", void 0, true);
          return { success: true, result: this.registry.getSession(request.payload.sessionId) };
        }
        case "stop_mesh_writer": {
          const p = request.payload, record = this.registry.getSession(p.sessionId);
          const active = record?.meta.meshActiveAssignment;
          const launch = record?.meta.launchRecord;
          const keys = ["meshId", "nodeId", "taskId", "attemptId", "generation", "dispatchNonce", "ownerDaemonId"];
          if (!record || !this.runtimes.has(p.sessionId) || record.termination || !["running", "stopping"].includes(record.lifecycle) || record.category !== "cli" || record.providerType !== p.providerType || record.runtimeKey !== p.runtimeKey || record.startedAt !== p.startedAt || record.osPid !== p.osPid || !record.writeOwner || record.writeOwner.clientId !== p.clientId || record.writeOwner.ownerType !== "agent" || record.meta.assistant || record.meta.meshCoordinatorFor || launch?.launchedBy === "assistant" || launch?.roleLaunch || !Number.isSafeInteger(p.osPid) || p.osPid <= 0 || !Number.isSafeInteger(p.startedAt) || p.startedAt <= 0 || !active || !p.assignment || keys.some((key) => {
            const v = p.assignment[key];
            return (key === "generation" || key === "dispatchNonce" ? !Number.isSafeInteger(v) || Number(v) < 0 : typeof v !== "string" || !v) || active[key] !== v;
          })) {
            return { success: false, error: "mesh_writer_identity_or_ownership_changed" };
          }
          this.stopRequests.set(p.sessionId, "stop");
          this.registry.setLifecycle(p.sessionId, "stopping");
          this.persistNow(p.sessionId);
          this.requireRuntime(p.sessionId).stop("SIGKILL");
          this.recordRuntimeTransition(p.sessionId, "stop_mesh_writer", "stopping", void 0, true);
          return { success: true, result: { requested: true } };
        }
        case "delete_session": {
          const record = this.registry.getSession(request.payload.sessionId);
          if (!record) return { success: false, error: `Unknown session: ${request.payload.sessionId}` };
          if (this.runtimes.has(record.sessionId)) {
            if (!request.payload.force) {
              return { success: false, error: `Session ${record.sessionId} is still running; pass force to stop and delete it` };
            }
            this.stopRequests.set(record.sessionId, "delete");
            this.registry.setLifecycle(record.sessionId, "stopping");
            this.persistNow(record.sessionId);
            this.requireRuntime(record.sessionId).stop();
            await this.waitForRuntimeExit(record.sessionId).catch((error) => {
              this.recordRuntimeTransition(record.sessionId, "delete_session_timeout", "stopping", void 0, false, error?.message || String(error));
            });
          }
          this.registry.deleteSession(record.sessionId);
          this.storage.remove(record.sessionId);
          this.storage.removeTombstone(record.sessionId);
          this.stopRequests.delete(record.sessionId);
          this.emitEvent({ type: "session_deleted", sessionId: record.sessionId });
          this.recordRuntimeTransition(record.sessionId, "delete_session", record.lifecycle, void 0, true);
          return { success: true, result: { sessionId: record.sessionId, deleted: true } };
        }
        case "resume_session": {
          const existing = this.registry.getSession(request.payload.sessionId);
          if (!existing) {
            return { success: false, error: `Unknown session: ${request.payload.sessionId}` };
          }
          if (this.runtimes.has(request.payload.sessionId)) {
            return { success: true, result: existing };
          }
          const resumed = this.startRuntime(existing, buildPayloadFromRecord(existing), "session_resumed");
          this.recordRuntimeTransition(request.payload.sessionId, "resume_session", resumed.lifecycle, void 0, true);
          return { success: true, result: resumed };
        }
        case "restart_session": {
          const restarted = await this.restartRuntime(request.payload.sessionId);
          return { success: true, result: restarted };
        }
        case "prune_duplicate_sessions": {
          const result = await this.pruneDuplicateSessions(request.payload);
          return { success: true, result };
        }
        case "send_signal": {
          const runtime = this.requireRuntime(request.payload.sessionId);
          runtime.sendSignal(request.payload.signal);
          const record = this.registry.getSession(request.payload.sessionId);
          this.recordRuntimeTransition(request.payload.sessionId, "send_signal", record?.lifecycle, request.payload.signal, true);
          return { success: true, result: record };
        }
        case "force_detach_client": {
          const session = this.registry.getSession(request.payload.sessionId);
          if (session?.writeOwner?.clientId === request.payload.clientId) {
            const released = this.registry.releaseWrite({
              sessionId: request.payload.sessionId,
              clientId: request.payload.clientId
            });
            this.emitEvent({ type: "write_owner_changed", sessionId: released.sessionId, owner: released.writeOwner });
          }
          const record = this.registry.detachClient({
            sessionId: request.payload.sessionId,
            clientId: request.payload.clientId
          });
          this.schedulePersist(record.sessionId);
          this.emitEvent({ type: "client_detached", sessionId: record.sessionId, clientId: request.payload.clientId });
          this.recordRuntimeTransition(record.sessionId, "force_detach_client", record.lifecycle, request.payload.clientId, true);
          return { success: true, result: record };
        }
        default:
          return { success: false, error: `Unsupported session host request: ${request?.type || "unknown"}` };
      }
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    } finally {
      if (counted) this.mutatingRequests--;
    }
  }
  requireRuntime(sessionId) {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) throw new Error(`Runtime not found for session: ${sessionId}`);
    return runtime;
  }
  getAttachedClient(sessionId, clientId) {
    const session = this.registry.getSession(sessionId);
    return session?.attachedClients.find((client) => client.clientId === clientId) || null;
  }
  /** Count and announce one accepted input BEFORE it reaches the PTY, so a
   *  subscriber sees who wrote it before any output it causes. */
  announceInput(sessionId, clientId) {
    const seq = this.registry.recordInput(sessionId);
    const { inputEpoch } = this.registry.getInputState(sessionId);
    this.emitEvent({ type: "session_input", sessionId, seq, epoch: inputEpoch, clientId });
  }
  emitEvent(event) {
    const diagnosticOnly = event.type === "request_trace" || event.type === "runtime_transition" || event.type === "host_log";
    if (!diagnosticOnly) {
      const targetSessionId = "sessionId" in event ? event.sessionId : null;
      for (const socket of [...this.sockets]) {
        if (targetSessionId) {
          const sessions = this.socketSessions.get(socket);
          if (!sessions?.has(targetSessionId)) continue;
        }
        this.writeEnvelopeSafely(socket, {
          kind: "event",
          event
        });
      }
    }
    this.emit("event", event);
  }
  subscribeSocketToSession(socket, sessionId) {
    let sessions = this.socketSessions.get(socket);
    if (!sessions) {
      sessions = /* @__PURE__ */ new Set();
      this.socketSessions.set(socket, sessions);
    }
    sessions.add(sessionId);
  }
  async handleIncomingRequest(socket, envelope) {
    const sessionId = getRequestSessionId(envelope.request);
    if (sessionId && (envelope.request.type === "create_session" || envelope.request.type === "attach_session")) {
      this.subscribeSocketToSession(socket, sessionId);
    }
    const startedAt = Date.now();
    const response = await this.handleRequest(envelope.request, socket);
    if (sessionId && envelope.request.type === "create_session" && response.success) {
      const createdId = response.result?.sessionId;
      if (createdId && createdId !== sessionId) this.subscribeSocketToSession(socket, createdId);
    }
    this.recordRequestTrace({
      timestamp: startedAt,
      requestId: envelope.requestId,
      type: envelope.request.type,
      sessionId: getRequestSessionId(envelope.request),
      clientId: getRequestClientId(envelope.request),
      success: response.success,
      durationMs: Math.max(0, Date.now() - startedAt),
      error: response.success ? void 0 : response.error
    });
    this.writeEnvelopeSafely(socket, createResponseEnvelope(envelope.requestId, response));
  }
  writeEnvelopeSafely(socket, envelope) {
    if (socket.destroyed || !socket.writable || socket.writableEnded) {
      this.sockets.delete(socket);
      return;
    }
    const payload = `${JSON.stringify(envelope)}
`;
    try {
      socket.write(payload, (error) => {
        if (!error) return;
        this.sockets.delete(socket);
        try {
          socket.destroy();
        } catch {
        }
      });
    } catch {
      this.sockets.delete(socket);
      try {
        socket.destroy();
      } catch {
      }
    }
  }
  schedulePersist(sessionId) {
    const existing = this.persistTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.persistTimers.set(sessionId, setTimeout(() => {
      this.persistTimers.delete(sessionId);
      this.persistNow(sessionId);
    }, 200));
  }
  /**
   * @param allowTerminal - write even if the record is terminal. Only the exit
   * handler sets this, to stamp the final terminated record for the brief
   * post-mortem window before cleanup.
   */
  persistNow(sessionId, allowTerminal = false) {
    const record = this.registry.getSession(sessionId);
    if (!record) return;
    if (!allowTerminal && isTerminalRecord(record)) return;
    const snapshot = this.getSnapshot(sessionId);
    try {
      this.storage.save(record, snapshot);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "persist_failed";
      console.error(`[session-host] Persist failed for ${sessionId}: ${code}: ${error?.message || error}`);
    }
  }
  getHostDiagnostics(payload) {
    return buildHostDiagnostics({
      payload,
      hostStartedAt: this.startedAt,
      endpointPath: this.endpoint.path,
      runtimeCount: this.runtimes.size,
      sessions: this.registry.listSessions(),
      recentLogs: this.recentLogs,
      recentRequests: this.recentRequests,
      recentTransitions: this.recentTransitions
    });
  }
  recordHostLog(level, message, sessionId, data) {
    const entry = {
      timestamp: Date.now(),
      level,
      message,
      sessionId,
      data
    };
    pushRecent(this.recentLogs, entry);
    this.emitEvent({ type: "host_log", entry });
    this.emit("log", `[${level}] ${message}`);
  }
  recordRequestTrace(trace) {
    pushRecent(this.recentRequests, trace);
    this.emitEvent({ type: "request_trace", trace });
    if (!trace.success) {
      this.recordHostLog(
        "warn",
        `request ${trace.type} failed after ${trace.durationMs}ms${trace.error ? `: ${trace.error}` : ""}`,
        trace.sessionId,
        { requestId: trace.requestId, clientId: trace.clientId }
      );
    }
  }
  scheduleNoOutputInputDiagnostic(params) {
    if (!params.input || /^\x1b/.test(params.input)) {
      return;
    }
    const hasPotentialEcho = /[^\x00-\x1F\x7F]/.test(params.input);
    if (!hasPotentialEcho && params.input !== "\r" && params.input !== "\n") {
      return;
    }
    setTimeout(() => {
      let afterSnapshotSeq = params.beforeSnapshotSeq;
      try {
        afterSnapshotSeq = this.registry.getSnapshot(params.sessionId)?.seq ?? params.beforeSnapshotSeq;
      } catch {
        return;
      }
      if (afterSnapshotSeq > params.beforeSnapshotSeq) {
        return;
      }
      const now = Date.now();
      const lastWarnAt = this.lastNoOutputInputWarnAt.get(params.sessionId) || 0;
      if (now - lastWarnAt < 1e4) {
        return;
      }
      this.lastNoOutputInputWarnAt.set(params.sessionId, now);
      const record = this.registry.getSession(params.sessionId);
      this.recordHostLog(
        "warn",
        "send_input produced no terminal output after PTY write; runtime may be ignoring stdin or stuck in a hidden input reader",
        params.sessionId,
        {
          clientId: params.clientId,
          inputLength: params.input.length,
          beforeSnapshotSeq: params.beforeSnapshotSeq,
          afterSnapshotSeq,
          lifecycle: record?.lifecycle,
          osPid: record?.osPid,
          providerType: record?.providerType
        }
      );
      this.recordRuntimeTransition(
        params.sessionId,
        "send_input_no_output_after_write",
        record?.lifecycle,
        `clientId=${params.clientId} inputLength=${params.input.length} seq=${params.beforeSnapshotSeq}`,
        false,
        "no terminal output after PTY write"
      );
    }, 250);
  }
  recordRuntimeTransition(sessionId, action, lifecycle, detail, success = true, error) {
    const transition = {
      timestamp: Date.now(),
      sessionId,
      action,
      lifecycle,
      detail,
      success,
      error
    };
    pushRecent(this.recentTransitions, transition);
    this.emitEvent({ type: "runtime_transition", transition });
  }
  waitForRuntimeExit(sessionId, timeoutMs = 5e3) {
    if (!this.runtimes.has(sessionId)) {
      return Promise.resolve(this.registry.getSession(sessionId)?.lifecycle === "failed" ? 1 : 0);
    }
    return new Promise((resolve4, reject) => {
      const timeout = setTimeout(() => {
        const waiters2 = this.exitWaiters.get(sessionId) || [];
        this.exitWaiters.set(sessionId, waiters2.filter((waiter) => waiter !== onExit));
        reject(new Error(`Timed out waiting for runtime ${sessionId} to exit`));
      }, timeoutMs);
      const onExit = (exitCode) => {
        clearTimeout(timeout);
        resolve4(exitCode);
      };
      const waiters = this.exitWaiters.get(sessionId) || [];
      waiters.push(onExit);
      this.exitWaiters.set(sessionId, waiters);
    });
  }
  resolveExitWaiters(sessionId, exitCode) {
    const waiters = this.exitWaiters.get(sessionId);
    if (!waiters?.length) return;
    this.exitWaiters.delete(sessionId);
    for (const waiter of waiters) {
      try {
        waiter(exitCode);
      } catch {
      }
    }
  }
  // Synchronous, best-effort variant for background/periodic persistence
  // (persistNow, called from many sync contexts). Uses getSnapshotTextSync()
  // rather than waiting for in-flight PTY writes to flush — see that method's
  // doc. Interactive requests must use getSnapshotForRequest() instead.
  getSnapshot(sessionId, sinceSeq) {
    const snapshot = this.registry.getSnapshot(sessionId, sinceSeq);
    const record = this.registry.getSession(sessionId);
    const runtimeText = typeof sinceSeq === "number" ? "" : this.runtimes.get(sessionId)?.getSnapshotTextSync?.() || "";
    return mergeRuntimeSnapshot(snapshot, record, { sinceSeq, runtimeText });
  }
  // Flush-aware variant for the interactive `get_snapshot` IPC request (the
  // dashboard's runtime_snapshot seed). Awaits any PTY chunk still queued in
  // the xterm mirror's WriteBuffer before reading, so the response reflects
  // everything written so far rather than racing an in-flight parse. See
  // PtySessionRuntime.flushPendingWrites() for why that race existed.
  async getSnapshotForRequest(sessionId, sinceSeq) {
    const snapshot = this.registry.getSnapshot(sessionId, sinceSeq);
    const record = this.registry.getSession(sessionId);
    const runtimeText = typeof sinceSeq === "number" ? "" : await this.runtimes.get(sessionId)?.getSnapshotText?.() || "";
    return mergeRuntimeSnapshot(snapshot, record, { sinceSeq, runtimeText });
  }
  flushAllPersistence() {
    for (const sessionId of this.runtimes.keys()) {
      this.persistNow(sessionId);
    }
    for (const record of this.registry.listSessions()) {
      this.persistNow(record.sessionId);
    }
  }
  async restartRuntime(sessionId) {
    const existing = this.registry.getSession(sessionId);
    if (!existing) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (this.runtimes.has(sessionId)) {
      this.stopRequests.set(sessionId, "restart");
      this.registry.setLifecycle(sessionId, "stopping");
      this.persistNow(sessionId);
      this.recordRuntimeTransition(sessionId, "restart_requested", "stopping", void 0, true);
      this.requireRuntime(sessionId).stop();
      await this.waitForRuntimeExit(sessionId);
    }
    const latest = this.registry.getSession(sessionId) || existing;
    const restarted = this.startRuntime(latest, buildPayloadFromRecord(latest), "session_resumed");
    this.recordRuntimeTransition(sessionId, "restart_completed", restarted.lifecycle, void 0, true);
    return restarted;
  }
  async pruneDuplicateSessions(payload) {
    const providerFilter = typeof payload?.providerType === "string" ? payload.providerType.trim() : "";
    const workspaceFilter = typeof payload?.workspace === "string" ? payload.workspace.trim() : "";
    const dryRun = payload?.dryRun === true;
    const { duplicateGroups, keptSessionIds, duplicateRecords } = planDuplicatePrune(
      this.registry.listSessions(),
      { providerFilter, workspaceFilter }
    );
    const prunedSessionIds = [];
    if (!dryRun) {
      for (const duplicate of duplicateRecords) {
        await this.pruneDuplicateRuntime(duplicate);
        prunedSessionIds.push(duplicate.sessionId);
      }
    }
    this.recordHostLog(
      dryRun ? "info" : "warn",
      `${dryRun ? "session host dry-run found" : "session host pruned"} ${duplicateGroups.length} duplicate group(s)`,
      void 0,
      {
        providerType: providerFilter || void 0,
        workspace: workspaceFilter || void 0,
        dryRun,
        prunedSessionIds,
        keptSessionIds
      }
    );
    return {
      duplicateGroupCount: duplicateGroups.length,
      keptSessionIds,
      prunedSessionIds,
      groups: duplicateGroups
    };
  }
  restorePersistedRuntimes() {
    const states = this.storage.loadAll();
    let skippedAutoResumeSessions = 0;
    for (const persisted of states) {
      const { recoveredRecord, wasLiveRuntime, hadRecoveryInterest } = buildRecoveredRecord(persisted);
      this.registry.restoreSession(recoveredRecord, persisted.snapshot);
      this.storage.save(recoveredRecord, persisted.snapshot);
      if (wasLiveRuntime && hadRecoveryInterest) {
        skippedAutoResumeSessions += 1;
      }
    }
    if (skippedAutoResumeSessions > 0) {
      this.recordHostLog("warn", `session host restored ${skippedAutoResumeSessions} live runtime snapshot(s) without auto-resume`);
    }
  }
  async pruneDuplicateRuntime(record) {
    const providerSessionId = typeof record.meta?.providerSessionId === "string" ? String(record.meta.providerSessionId) : void 0;
    this.recordRuntimeTransition(
      record.sessionId,
      "prune_duplicate_session",
      record.lifecycle,
      providerSessionId ? `providerSessionId=${providerSessionId}` : void 0,
      true
    );
    if (this.runtimes.has(record.sessionId)) {
      this.stopRequests.set(record.sessionId, "prune");
      this.registry.setLifecycle(record.sessionId, "stopping");
      this.persistNow(record.sessionId);
      this.requireRuntime(record.sessionId).stop();
      await this.waitForRuntimeExit(record.sessionId).catch((error) => {
        this.recordRuntimeTransition(record.sessionId, "prune_duplicate_timeout", "stopping", void 0, false, error?.message || String(error));
      });
    }
    const pendingPersistTimer = this.persistTimers.get(record.sessionId);
    if (pendingPersistTimer) {
      clearTimeout(pendingPersistTimer);
      this.persistTimers.delete(record.sessionId);
    }
    this.registry.deleteSession(record.sessionId);
    this.storage.remove(record.sessionId);
    this.storage.removeTombstone(record.sessionId);
    this.stopRequests.delete(record.sessionId);
  }
  startRuntime(record, payload, startEventType) {
    this.recoveryFence.assertLaunchAllowed(payload);
    const leaveLaunch = this.recoveryFence.enterLaunch(payload);
    try {
      const runtime = new PtySessionRuntime({
        sessionId: record.sessionId,
        payload,
        onData: (data) => {
          const { seq } = this.registry.appendOutput(record.sessionId, data);
          this.schedulePersist(record.sessionId);
          this.emitEvent({ type: "session_output", sessionId: record.sessionId, seq, data });
        },
        onExit: (exitCode, signal) => this.handleRuntimeExit(record, exitCode, signal)
      });
      this.registry.setLifecycle(record.sessionId, "starting");
      const pid = runtime.start();
      this.runtimes.set(record.sessionId, runtime);
      const startedRecord = this.registry.markStarted(record.sessionId, pid);
      this.persistNow(record.sessionId);
      this.emitEvent({ type: startEventType, sessionId: record.sessionId, pid });
      this.recordRuntimeTransition(record.sessionId, startEventType, startedRecord.lifecycle, `pid=${pid}`, true);
      return startedRecord;
    } finally {
      leaveLaunch();
    }
  }
  /**
   * Handle a PTY termination: classify the (exitCode, signal) pair, stamp the
   * record + tombstone, emit exactly one structured diagnostic, and schedule
   * cleanup of the live persistence file (the tombstone is retained).
   */
  handleRuntimeExit(record, exitCode, signal) {
    const priorRecord = this.registry.getSession(record.sessionId);
    const termination = classifyTermination({
      exitCode,
      signal,
      osPid: priorRecord?.osPid,
      previousLifecycle: priorRecord?.lifecycle,
      lastOutputAt: priorRecord?.lastActivityAt,
      requestedStop: this.stopRequests.get(record.sessionId),
      terminatedAt: Date.now()
    });
    this.stopRequests.delete(record.sessionId);
    this.registry.markStopped(record.sessionId, termination.lifecycle, termination);
    this.runtimes.delete(record.sessionId);
    this.resolveExitWaiters(record.sessionId, exitCode);
    const pendingPersistTimer = this.persistTimers.get(record.sessionId);
    if (pendingPersistTimer) {
      clearTimeout(pendingPersistTimer);
      this.persistTimers.delete(record.sessionId);
    }
    this.persistNow(record.sessionId, true);
    this.storage.saveTombstone(record.sessionId, termination);
    this.emitEvent({ type: "session_exit", sessionId: record.sessionId, exitCode, signal, termination });
    const summary = `reason=${termination.reason} exitCode=${termination.exitCode === null ? "unknown" : termination.exitCode} signal=${termination.signal ?? "none"}`;
    this.recordHostLog(
      termination.lifecycle === "stopped" ? "info" : "warn",
      `session terminated: ${summary}`,
      record.sessionId,
      {
        runtimeKey: record.runtimeKey,
        providerType: record.providerType,
        osPid: termination.osPid,
        exitCode: termination.exitCode,
        signal: termination.signal,
        reason: termination.reason,
        previousLifecycle: termination.previousLifecycle,
        lifecycle: termination.lifecycle,
        lastOutputAt: termination.lastOutputAt,
        requestedStop: termination.requestedStop
      }
    );
    this.recordRuntimeTransition(
      record.sessionId,
      "session_exit",
      termination.lifecycle,
      summary,
      termination.lifecycle === "stopped",
      termination.lifecycle === "stopped" ? void 0 : summary
    );
    setTimeout(() => {
      const current = this.registry.getSession(record.sessionId);
      if (current && !isTerminalRecord(current)) return;
      this.registry.deleteSession(record.sessionId);
      this.storage.remove(record.sessionId);
    }, 5e3).unref?.();
    return termination;
  }
};

// src/threadpool-watchdog.ts
import * as fs8 from "fs";
import * as os2 from "os";
var THREADPOOL_WATCHDOG_INTERVAL_MS = 15e3;
var THREADPOOL_WATCHDOG_STALL_MS = 12e4;
function defaultProbe(done) {
  fs8.stat(os2.tmpdir(), () => done());
}
function startThreadpoolWatchdog(options) {
  const intervalMs = options.intervalMs ?? THREADPOOL_WATCHDOG_INTERVAL_MS;
  const stallMs = options.stallMs ?? THREADPOOL_WATCHDOG_STALL_MS;
  const probe = options.probe ?? defaultProbe;
  const now = options.now ?? Date.now;
  let inFlightSince = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    if (inFlightSince !== null) {
      const stalledForMs = now() - inFlightSince;
      if (stalledForMs >= stallMs) {
        stopped = true;
        clearInterval(timer);
        options.onStall(stalledForMs);
      }
      return;
    }
    const startedAt = now();
    inFlightSince = startedAt;
    probe(() => {
      if (inFlightSince === startedAt) inFlightSince = null;
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick
  };
}
function writeStderrLineSync(line) {
  try {
    fs8.writeSync(2, `${line}
`);
  } catch {
  }
}

// src/index.ts
var SESSION_HOST_APP_NAME = process.env.ADHDEV_SESSION_HOST_NAME || "adhdev";
var SHUTDOWN_DEADLINE_MS = 1e4;
var INSTANCE_CONFIG_DIR = resolveInstanceConfigDir4(process.env);
var INSTANCE_IPC_KEY = resolveSessionHostIpcKey(INSTANCE_CONFIG_DIR);
function getSessionHostEndpoint() {
  return getDefaultSessionHostEndpoint2(SESSION_HOST_APP_NAME, { ipcKey: INSTANCE_IPC_KEY });
}
function getSessionHostStorageRoot() {
  return path8.join(INSTANCE_CONFIG_DIR, "session-host", SESSION_HOST_APP_NAME);
}
function getSessionHostReplacementProvenanceFile(appName, configDir = INSTANCE_CONFIG_DIR) {
  const dir = configDir;
  if (!fs9.existsSync(dir)) fs9.mkdirSync(dir, { recursive: true });
  return path8.join(dir, `${appName}-session-host-replacement.json`);
}
function removeSessionHostReplacementProvenance(appName, configDir = INSTANCE_CONFIG_DIR) {
  try {
    const provenanceFile = path8.join(configDir, `${appName}-session-host-replacement.json`);
    if (fs9.existsSync(provenanceFile)) {
      fs9.unlinkSync(provenanceFile);
    }
  } catch {
  }
}
function getSessionHostPidFile(appName) {
  const dir = INSTANCE_CONFIG_DIR;
  if (!fs9.existsSync(dir)) fs9.mkdirSync(dir, { recursive: true });
  return path8.join(dir, `${appName}-session-host.pid`);
}
function writeSessionHostPid(appName) {
  fs9.writeFileSync(getSessionHostPidFile(appName), String(process.pid), "utf8");
}
function removeSessionHostPid(appName) {
  try {
    const pidFile = getSessionHostPidFile(appName);
    if (!fs9.existsSync(pidFile)) return;
    const recordedPid = Number.parseInt(fs9.readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isFinite(recordedPid) && recordedPid !== process.pid) return;
    fs9.unlinkSync(pidFile);
  } catch {
  }
}
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const readOnly = rest.includes("--read-only");
  const takeover = rest.includes("--takeover");
  const showAll = rest.includes("--all");
  const instanceKeyArgs = rest.filter((arg) => arg.startsWith("--instance-config-key="));
  const positional = rest.filter(
    (arg) => arg !== "--read-only" && arg !== "--takeover" && arg !== "--all" && !arg.startsWith("--instance-config-key=")
  );
  return {
    command: command || "serve",
    positional,
    readOnly,
    takeover,
    showAll,
    instanceKeyArgs
  };
}
async function runServer(instanceKeyArgs = []) {
  if (instanceKeyArgs.length > 1 || instanceKeyArgs.length === 1 && instanceKeyArgs[0] !== sessionHostInstanceArg(INSTANCE_CONFIG_DIR)) {
    throw new Error("session_host_instance_config_key_mismatch");
  }
  let upgradeBinding;
  const pinFile = process.env.ADHDEV_WORKER_GUARDIAN_PINS_FILE;
  if (pinFile) {
    const stat2 = fs9.lstatSync(pinFile);
    if (process.platform !== "darwin" || fs9.realpathSync(pinFile) !== pinFile || !stat2.isFile() || stat2.uid !== process.getuid?.() || stat2.mode & 63) throw new Error("guardian_launch_pins_untrusted");
    const pins = JSON.parse(fs9.readFileSync(pinFile, "utf8"));
    if (pins.nodePath !== fs9.realpathSync(process.execPath) || pins.hostEntryPath !== fs9.realpathSync(process.argv[1]) || pins.stateDir !== path8.join(INSTANCE_CONFIG_DIR, "session-host")) throw new Error("guardian_launch_executable_or_instance_mismatch");
    upgradeBinding = resolveGuardianArtifact(pins);
  }
  const endpoint = getSessionHostEndpoint();
  const server = new SessionHostServer({
    appName: SESSION_HOST_APP_NAME,
    upgradeBinding,
    endpoint,
    storageRootDir: getSessionHostStorageRoot(),
    instanceConfigDir: INSTANCE_CONFIG_DIR,
    pidFilePath: getSessionHostPidFile(SESSION_HOST_APP_NAME)
  });
  await server.start();
  writeSessionHostPid(SESSION_HOST_APP_NAME);
  const shutdown = async () => {
    const deadline = setTimeout(() => {
      writeStderrLineSync(`[session-host] stop() did not finish within ${SHUTDOWN_DEADLINE_MS / 1e3}s; exiting anyway.`);
      removeSessionHostPid(SESSION_HOST_APP_NAME);
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref?.();
    await server.stop();
    removeSessionHostPid(SESSION_HOST_APP_NAME);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  startThreadpoolWatchdog({
    onStall: (stalledForMs) => {
      writeStderrLineSync(
        `[session-host] libuv thread pool made no progress for ${Math.round(stalledForMs / 1e3)}s (PTY writes cannot complete); exiting so the daemon respawns the host.`
      );
      try {
        server.flushAllPersistence();
      } catch {
      }
      removeSessionHostPid(SESSION_HOST_APP_NAME);
      process.exit(1);
    }
  });
  process.on("exit", () => {
    server.flushAllPersistence();
    removeSessionHostPid(SESSION_HOST_APP_NAME);
  });
  await new Promise(() => {
  });
}
async function listRuntimes(showAll = false) {
  const client = new SessionHostClient({ endpoint: getSessionHostEndpoint() });
  try {
    const response = await client.request({
      type: "list_sessions",
      payload: {}
    });
    if (!response.success) {
      throw new Error(response.error || "Failed to list runtimes");
    }
    const runtimes = (response.result || []).filter((runtime) => showAll || runtime.lifecycle !== "stopped");
    if (runtimes.length === 0) {
      console.log("No runtimes.");
      return;
    }
    console.log("runtimeKey	lifecycle	owner	workspace	id	displayName");
    for (const runtime of runtimes) {
      console.log([
        runtime.runtimeKey,
        runtime.lifecycle,
        formatRuntimeOwner(runtime),
        runtime.workspaceLabel,
        runtime.sessionId,
        runtime.displayName
      ].join("	"));
    }
  } finally {
    await client.close().catch(() => {
    });
  }
}
async function attachRuntime(target2, readOnly = false, takeover = false) {
  const client = new SessionHostClient({ endpoint: getSessionHostEndpoint() });
  const clientId = `local-terminal-${process.pid}-${randomUUID2().slice(0, 8)}`;
  let lastSeq = 0;
  let restoredRawMode = false;
  let runtimeId = "";
  let localReadOnly = readOnly;
  const cleanup = async () => {
    process.stdout.off("resize", handleResize);
    process.stdin.off("data", handleInput);
    process.stdin.pause();
    if (process.stdin.isTTY && restoredRawMode) {
      process.stdin.setRawMode(false);
    }
    await client.request({
      type: "release_write",
      payload: {
        sessionId: runtimeId,
        clientId
      }
    }).catch(() => ({ success: false }));
    await client.request({
      type: "detach_session",
      payload: {
        sessionId: runtimeId,
        clientId
      }
    }).catch(() => ({ success: false }));
    await client.close().catch(() => {
    });
  };
  const handleResize = () => {
    void client.request({
      type: "resize_session",
      payload: {
        sessionId: runtimeId,
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24
      }
    }).catch(() => ({ success: false }));
  };
  const sendInputWithTakeover = async (data) => {
    let response = await client.request({
      type: "send_input",
      payload: {
        sessionId: runtimeId,
        clientId,
        data
      }
    });
    if (!response.success && response.error?.startsWith("Write owned by ")) {
      const ownerResponse = await client.request({
        type: "acquire_write",
        payload: {
          sessionId: runtimeId,
          clientId,
          ownerType: "user",
          force: true
        }
      });
      if (ownerResponse.success && ownerResponse.result) {
        response = await client.request({
          type: "send_input",
          payload: {
            sessionId: runtimeId,
            clientId,
            data
          }
        });
        if (response.success) {
          process.stderr.write(`Took control of ${ownerResponse.result.runtimeKey}.
`);
        }
      }
    }
    return response;
  };
  const handleInput = (chunk) => {
    if (!localReadOnly && chunk.length === 1 && chunk[0] === 29) {
      void cleanup().finally(() => process.exit(0));
      return;
    }
    if (localReadOnly) return;
    void sendInputWithTakeover(chunk.toString("utf8")).catch(() => ({ success: false }));
  };
  try {
    if (readOnly && takeover) {
      throw new Error("Use either --read-only or --takeover, not both");
    }
    const listResponse = await client.request({
      type: "list_sessions",
      payload: {}
    });
    if (!listResponse.success || !listResponse.result) {
      throw new Error(listResponse.error || "Failed to list runtimes");
    }
    let runtimeRecord = resolveAttachableRuntimeRecord(listResponse.result, target2);
    runtimeId = runtimeRecord.sessionId;
    if (runtimeRecord.lifecycle === "interrupted" && !readOnly) {
      const resumeResponse = await client.request({
        type: "resume_session",
        payload: {
          sessionId: runtimeId
        }
      });
      if (resumeResponse.success && resumeResponse.result) {
        runtimeRecord = resumeResponse.result;
      } else {
        process.stderr.write(
          `Runtime ${runtimeRecord.runtimeKey} could not be resumed automatically: ${resumeResponse.error || "unknown error"}
`
        );
      }
    }
    let effectiveReadOnly = readOnly;
    if (!effectiveReadOnly && runtimeRecord.writeOwner && runtimeRecord.writeOwner.clientId !== clientId && !takeover) {
      process.stderr.write(
        `Runtime ${runtimeRecord.runtimeKey} is currently owned by ${runtimeRecord.writeOwner.clientId}; first input will take control here.
`
      );
    }
    localReadOnly = effectiveReadOnly;
    const attachResponse = await client.request({
      type: "attach_session",
      payload: {
        sessionId: runtimeId,
        clientId,
        clientType: "local-terminal",
        readOnly: effectiveReadOnly
      }
    });
    if (!attachResponse.success) {
      throw new Error(attachResponse.error || `Failed to attach runtime ${runtimeId}`);
    }
    const attachedRecord = attachResponse.result || null;
    if (!effectiveReadOnly && takeover) {
      const ownerResponse = await client.request({
        type: "acquire_write",
        payload: {
          sessionId: runtimeId,
          clientId,
          ownerType: "user",
          force: takeover
        }
      });
      if (!ownerResponse.success) {
        throw new Error(ownerResponse.error || `Failed to acquire write owner for runtime ${runtimeId}`);
      }
    }
    const snapshotResponse = await client.request({
      type: "get_snapshot",
      payload: { sessionId: runtimeId }
    });
    if (!snapshotResponse.success) {
      throw new Error(snapshotResponse.error || `Failed to read runtime snapshot ${runtimeId}`);
    }
    lastSeq = snapshotResponse.result?.seq || 0;
    if (snapshotResponse.result?.text) {
      process.stdout.write(snapshotResponse.result.text);
    }
    if (attachedRecord?.lifecycle === "stopped" || attachedRecord?.lifecycle === "failed" || attachedRecord?.lifecycle === "interrupted") {
      process.stderr.write(`Runtime ${attachedRecord.runtimeKey} is already ${attachedRecord.lifecycle}. Detached after snapshot.
`);
      await cleanup();
      return;
    }
    const stopSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const signalHandlers = stopSignals.map((signal) => {
      const handler = () => {
        void cleanup().finally(() => process.exit(0));
      };
      process.on(signal, handler);
      return { signal, handler };
    });
    const unsubscribe = client.onEvent((event) => {
      if (!("sessionId" in event)) return;
      if (event.sessionId !== runtimeId) return;
      if (event.type === "session_output") {
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        process.stdout.write(event.data);
        return;
      }
      if (event.type === "session_exit") {
        void cleanup().finally(() => {
          for (const { signal, handler } of signalHandlers) {
            process.off(signal, handler);
          }
          unsubscribe();
          process.exit(event.exitCode ?? 0);
        });
      }
    });
    process.stdout.on("resize", handleResize);
    process.stdin.on("data", handleInput);
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      restoredRawMode = true;
    }
    handleResize();
    if (!effectiveReadOnly) {
      process.stderr.write(`Attached to runtime ${attachedRecord?.runtimeKey || runtimeId}. Press Ctrl+] to detach.
`);
    } else {
      process.stderr.write(`Attached to runtime ${attachedRecord?.runtimeKey || runtimeId} (read-only).
`);
    }
    await new Promise(() => {
    });
  } catch (error) {
    await cleanup().catch(() => {
    });
    throw error;
  }
}
async function main() {
  const { command, positional, readOnly, takeover, showAll, instanceKeyArgs } = parseArgs(process.argv.slice(2));
  if (command === "serve") {
    await runServer(instanceKeyArgs);
    return;
  }
  if (command === "list") {
    await listRuntimes(showAll);
    return;
  }
  if (command === "attach") {
    const target2 = positional[0];
    if (!target2) {
      throw new Error("runtime target is required: adhdev-sessiond attach <runtimeId|runtimeKey>");
    }
    await attachRuntime(target2, readOnly, takeover);
    return;
  }
  if (command === "resume") {
    const target2 = positional[0];
    if (!target2) {
      throw new Error("runtime target is required: adhdev-sessiond resume <runtimeId|runtimeKey>");
    }
    const client = new SessionHostClient({ endpoint: getSessionHostEndpoint() });
    try {
      const listResponse = await client.request({ type: "list_sessions", payload: {} });
      if (!listResponse.success || !listResponse.result) {
        throw new Error(listResponse.error || "Failed to list runtimes");
      }
      const runtimeRecord = resolveRuntimeRecord(listResponse.result, target2);
      const resumeResponse = await client.request({
        type: "resume_session",
        payload: {
          sessionId: runtimeRecord.sessionId
        }
      });
      if (!resumeResponse.success || !resumeResponse.result) {
        throw new Error(resumeResponse.error || `Failed to resume runtime ${runtimeRecord.runtimeKey}`);
      }
      console.log(`Resumed ${resumeResponse.result.runtimeKey} (${resumeResponse.result.sessionId})`);
    } finally {
      await client.close().catch(() => {
      });
    }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
var UNCAUGHT_EXCEPTION_WINDOW_MS = 6e4;
var UNCAUGHT_EXCEPTION_LIMIT = 10;
function createUncaughtExceptionLimiter(windowMs = UNCAUGHT_EXCEPTION_WINDOW_MS, limit = UNCAUGHT_EXCEPTION_LIMIT) {
  let windowStartedAt = null;
  let countInWindow = 0;
  return function shouldExit(now) {
    if (windowStartedAt === null || now - windowStartedAt > windowMs) {
      windowStartedAt = now;
      countInWindow = 0;
    }
    countInWindow += 1;
    return { exit: countInWindow > limit, countInWindow };
  };
}
if (__require.main === module) {
  const shouldExitOnUncaught = createUncaughtExceptionLimiter();
  process.on("uncaughtException", (err) => {
    console.error(`[session-host] Uncaught exception: ${err?.message}
${err?.stack || ""}`);
    const { exit, countInWindow } = shouldExitOnUncaught(Date.now());
    if (!exit) return;
    console.error(
      `[session-host] ${countInWindow} uncaught exceptions within ${UNCAUGHT_EXCEPTION_WINDOW_MS / 1e3}s (limit ${UNCAUGHT_EXCEPTION_LIMIT}); shutting down.`
    );
    removeSessionHostPid(SESSION_HOST_APP_NAME);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[session-host] Unhandled rejection: ${reason?.message || reason}`);
  });
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
export {
  SessionHostServer,
  createUncaughtExceptionLimiter,
  getSessionHostReplacementProvenanceFile,
  isManagedSessionHostCommandLine,
  readVerifiedReplacementProvenance,
  removeSessionHostReplacementProvenance,
  resolveGuardianArtifact,
  sessionHostInstanceArg,
  startThreadpoolWatchdog
};
//# sourceMappingURL=index.mjs.map