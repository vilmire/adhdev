/**
 * ADHDev Launcher — IDE Launch/Relaunch with CDP
 * 
 * Launches IDE with Chrome DevTools Protocol (remote-debugging-port).
 * If IDE is already running, terminates it and restarts with CDP option.
 * 
 * Pipeline:
 * 1. IDE process detection (already running?)
 * 2. If already running with CDP → reuse as-is
 * 3. If running without CDP → kill process → wait → restart with CDP
 * 4. Not running → start fresh with CDP
 * 
 * Usage:
 * adhdev launch — Launch configured IDE with CDP port
 * adhdev launch cursor — Launch Cursor with CDP port
 * adhdev launch --workspace /path — Open specific workspace
 */

import { execSync, spawn, spawnSync } from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { detectIDEs } from './detection/ide-detector.js';
import { IDEInfo } from './detection/ide-detector.js';
import { ProviderLoader } from './providers/provider-loader.js';

// ─── Provider-based dynamic IDE infrastructure ────────────────
// Reads cdpPorts, processNames from provider.js — only create provider.js to add new IDE

let _providerLoader: ProviderLoader | null = null;

function getProviderLoader(): ProviderLoader {
    if (!_providerLoader) {
        _providerLoader = new ProviderLoader({ logFn: () => {} }); // Suppress logs during launch
        _providerLoader.loadAll();
        _providerLoader.registerToDetector(); // IDE provider → detector registry
    }
    return _providerLoader;
}

function getCdpPorts(): Record<string, [number, number]> {
    return getProviderLoader().getCdpPortMap();
}

function getMacAppIdentifiers(): Record<string, string> {
    return getProviderLoader().getMacAppIdentifiers();
}

function getWinProcessNames(): Record<string, string[]> {
    return getProviderLoader().getWinProcessNames();
}

// ─── Helpers ────────────────────────────────────

/** Find available port (primary → secondary → sequential after) */
async function findFreePort(ports: [number, number]): Promise<number> {
    for (const port of ports) {
        const free = await checkPortFree(port);
        if (free) return port;
    }
 // If both ports in use, scan from secondary+1
    let port = ports[1] + 1;
    while (port < ports[1] + 10) {
        if (await checkPortFree(port)) return port;
        port++;
    }
    throw new Error('No free port found');
}

function checkPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.on('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => {
            server.close(() => resolve(true));
        });
    });
}

/** Check if CDP responds on port */
async function isCdpActive(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const req = require('http').get(`http://127.0.0.1:${port}/json/version`, {
            timeout: 2000,
        }, (res: any) => {
            let data = '';
            res.on('data', (c: string) => data += c);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    resolve(!!info['WebKit-Version'] || !!info['Browser']);
                } catch {
                    resolve(false);
                }
            });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

/** Kill IDE process (graceful → force) */
export async function killIdeProcess(ideId: string): Promise<boolean> {
    const plat = os.platform();
    const appName = getMacAppIdentifiers()[ideId];
    const winProcesses = getWinProcessNames()[ideId];

    try {
        if (plat === 'darwin' && appName) {
 // macOS: graceful quit via osascript
            try {
                execSync(`osascript -e 'tell application "${appName}" to quit' 2>/dev/null`, {
                    timeout: 5000,
                });
            } catch {
                try { execSync(`pkill -f "${appName}" 2>/dev/null`); } catch { }
            }
        } else if (plat === 'win32' && winProcesses) {
 // Windows: taskkill for each process name
            for (const proc of winProcesses) {
                try {
                    execSync(`taskkill /IM "${proc}" /F 2>nul`, { timeout: 5000 });
                } catch { }
            }
 // Process name may differ, so also try via WMIC
            try {
                const exeName = winProcesses[0].replace('.exe', '');
                execSync(`powershell -Command "Get-Process -Name '${exeName}' -ErrorAction SilentlyContinue | Stop-Process -Force"`, {
                    timeout: 10000,
                });
            } catch { }
        } else {
            try { execSync(`pkill -f "${ideId}" 2>/dev/null`); } catch { }
        }

 // Wait for process kill (max 15 seconds)
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (!isIdeRunning(ideId)) return true;
        }

 // Force terminate retry
        if (plat === 'darwin' && appName) {
            try { execSync(`pkill -9 -f "${appName}" 2>/dev/null`); } catch { }
        } else if (plat === 'win32' && winProcesses) {
            for (const proc of winProcesses) {
                try { execSync(`taskkill /IM "${proc}" /F 2>nul`); } catch { }
            }
        }

        await new Promise(r => setTimeout(r, 2000));
        return !isIdeRunning(ideId);

    } catch {
        return false;
    }
}

/** Check if IDE process is running */
export function isIdeRunning(ideId: string): boolean {
    const plat = os.platform();

    try {
        if (plat === 'darwin') {
            const appName = getMacAppIdentifiers()[ideId];
            if (!appName) return false;
            const result = execSync(`pgrep -f "${appName}" 2>/dev/null`, { encoding: 'utf-8' });
            return result.trim().length > 0;
        } else if (plat === 'win32') {
            const winProcesses = getWinProcessNames()[ideId];
            if (!winProcesses) return false;
 // Check each process name
            for (const proc of winProcesses) {
                try {
                    const result = execSync(`tasklist /FI "IMAGENAME eq ${proc}" /NH 2>nul`, { encoding: 'utf-8' });
                    if (result.includes(proc)) return true;
                } catch { }
            }
 // Also check via PowerShell (when tasklist cannot find)
            try {
                const exeName = winProcesses[0].replace('.exe', '');
                const result = execSync(
                    `powershell -Command "(Get-Process -Name '${exeName}' -ErrorAction SilentlyContinue).Count"`,
                    { encoding: 'utf-8', timeout: 5000 }
                );
                return parseInt(result.trim()) > 0;
            } catch { }
            return false;
        } else {
            const result = execSync(`pgrep -f "${ideId}" 2>/dev/null`, { encoding: 'utf-8' });
            return result.trim().length > 0;
        }
    } catch {
        return false;
    }
}

/** Detect currently open workspace path */
function detectCurrentWorkspace(ideId: string): string | undefined {
    const plat = os.platform();

    if (plat === 'darwin') {
        try {
            const appName = getMacAppIdentifiers()[ideId];
            if (!appName) return undefined;
            const result = execSync(
                `lsof -c "${appName}" 2>/dev/null | grep cwd | head -1 | awk '{print $NF}'`,
                { encoding: 'utf-8', timeout: 3000 }
            );
            const dir = result.trim();
            if (dir && dir !== '/') return dir;
        } catch { }
    } else if (plat === 'win32') {
 // Windows: read IDE recent workspaces from storage.json
        try {
            const fs = require('fs');
            const appNameMap = getMacAppIdentifiers(); // Provider-based dynamic mapping
            const appName = appNameMap[ideId];
            if (appName) {
                const storagePath = path.join(
                    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
                    appName, 'storage.json'
                );
                if (fs.existsSync(storagePath)) {
                    const data = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
 // openedPathsList.workspaces3 has recent workspace paths
                    const workspaces = data?.openedPathsList?.workspaces3 || data?.openedPathsList?.entries || [];
                    if (workspaces.length > 0) {
                        const recent = workspaces[0];
 // Can be object { folderUri: 'file:///...' } or string
                        const uri = typeof recent === 'string' ? recent : recent?.folderUri;
                        if (uri?.startsWith('file:///')) {
                            return decodeURIComponent(uri.replace('file:///', ''));
                        }
                    }
                }
            }
        } catch { }
    }

    return undefined;
}

// ─── Launch Logic ───────────────────────────────

export interface LaunchOptions {
    ideId?: string;
    workspace?: string;
    newWindow?: boolean;
}

export interface LaunchResult {
    success: boolean;
    ideId: string;
    ideName: string;
    port: number;
    action: 'started' | 'restarted' | 'reused' | 'failed';
    message: string;
    error?: string;
}

/**
 * Execute IDE with CDP port (relaunch pipeline)
 * 
 * 1. IDE detect
 * 2. per-fixed IDE CDP port determine
 * 3. CDP not active → reuse
 * 4. IDE execute during but CDP none → terminate → restart with CDP
 * 5. IDE not running → start fresh with CDP
 */
export async function launchWithCdp(options: LaunchOptions = {}): Promise<LaunchResult> {
    const platform = os.platform();

 // 1. IDE determine
    let targetIde: IDEInfo | undefined;
    const ides = await detectIDEs();

    if (options.ideId) {
        targetIde = ides.find(i => i.id === options.ideId && i.installed);
        if (!targetIde) {
            return {
                success: false, ideId: options.ideId, ideName: options.ideId,
                port: 0, action: 'failed',
                message: '', error: `IDE '${options.ideId}' not found or not installed`,
            };
        }
    } else {
        const { loadConfig } = await import('./config/config.js');
        const config = loadConfig();
        if (config.selectedIde) {
            targetIde = ides.find(i => i.id === config.selectedIde && i.installed);
        }
        if (!targetIde) {
            targetIde = ides.find(i => i.installed);
        }
        if (!targetIde) {
            return {
                success: false, ideId: 'unknown', ideName: 'Unknown',
                port: 0, action: 'failed',
                message: '', error: 'No IDE found. Install VS Code, Cursor, or Antigravity first.',
            };
        }
    }

 // 2. per-fixed IDE CDP port determine
    const portPair = getCdpPorts()[targetIde.id] || [9333, 9334];

 // 3. Check if CDP is not yet enabled
    for (const port of portPair) {
        if (await isCdpActive(port)) {
            return {
                success: true, ideId: targetIde.id, ideName: targetIde.displayName,
                port, action: 'reused',
                message: `CDP already active on port ${port}`,
            };
        }
    }

 // 4. Check if IDE is currently running
    const alreadyRunning = isIdeRunning(targetIde.id);
    const workspace = options.workspace || (alreadyRunning ? detectCurrentWorkspace(targetIde.id) : undefined);

 // 5. If IDE is running, terminate it
    if (alreadyRunning) {
        const killed = await killIdeProcess(targetIde.id);
        if (!killed) {
            return {
                success: false, ideId: targetIde.id, ideName: targetIde.displayName,
                port: 0, action: 'failed',
                message: '', error: `Could not stop ${targetIde.displayName}. Close it manually and try again.`,
            };
        }
 // Wait for process full termination
        await new Promise(r => setTimeout(r, 3000));
    }

 // 6. Find available port
    const port = await findFreePort(portPair);

 // 7. Execute with CDP
    try {
        if (platform === 'darwin') {
            await launchMacOS(targetIde, port, workspace, options.newWindow);
        } else if (platform === 'win32') {
            await launchWindows(targetIde, port, workspace, options.newWindow);
        } else {
            await launchLinux(targetIde, port, workspace, options.newWindow);
        }

 // Wait for CDP to enable (max 15 seconds)
        let cdpReady = false;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (await isCdpActive(port)) {
                cdpReady = true;
                break;
            }
        }

        return {
            success: true, ideId: targetIde.id, ideName: targetIde.displayName,
            port, action: alreadyRunning ? 'restarted' : 'started',
            message: cdpReady
                ? `${targetIde.displayName} launched with CDP on port ${port}`
                : `${targetIde.displayName} launched (CDP may take a moment to initialize)`,
        };
    } catch (e: any) {
        return {
            success: false, ideId: targetIde.id, ideName: targetIde.displayName,
            port, action: 'failed',
            message: '', error: e?.message || String(e),
        };
    }
}

// ─── Platform Launch ────────────────────────────

async function launchMacOS(ide: IDEInfo, port: number, workspace?: string, newWindow?: boolean): Promise<void> {
    const appName = getMacAppIdentifiers()[ide.id];

    const args = ['--remote-debugging-port=' + port];
    if (newWindow) args.push('--new-window');
    if (workspace) args.push(workspace);

    if (appName) {
 // 'open -a' execution (ensures GUI session)
        const openArgs = ['-a', appName, '--args', ...args];
        spawn('open', openArgs, { detached: true, stdio: 'ignore' }).unref();
    } else if (ide.cliCommand) {
 // CLI based execute
        spawn(ide.cliCommand, args, { detached: true, stdio: 'ignore' }).unref();
    } else {
        throw new Error(`No app identifier or CLI for ${ide.displayName}`);
    }
}

async function launchWindows(ide: IDEInfo, port: number, workspace?: string, newWindow?: boolean): Promise<void> {
    const cli = ide.cliCommand;
    if (!cli) {
        throw new Error(`No CLI command for ${ide.displayName}. Please add it to PATH.`);
    }

 // Compose arguments for CLI command — IDE CLI wrapper (.cmd) handles Electron execution
    const parts = [`"${cli}"`, `--remote-debugging-port=${port}`];
    if (newWindow) parts.push('--new-window');
    if (workspace) parts.push(`"${workspace}"`);

    const fullCmd = parts.join(' ');

 // exec fire-and-forget: delegate to CLI to properly start IDE process
    const { exec: execCmd } = require('child_process');
    execCmd(fullCmd, { windowsHide: true }, () => {
 // IDE process runs independently even after CLI per-terminates wrap
    });
}

async function launchLinux(ide: IDEInfo, port: number, workspace?: string, newWindow?: boolean): Promise<void> {
    const cli = ide.cliCommand;
    if (!cli) {
        throw new Error(`No CLI command for ${ide.displayName}. Make sure it's in PATH.`);
    }

    const args = ['--remote-debugging-port=' + port];
    if (newWindow) args.push('--new-window');
    if (workspace) args.push(workspace);

    spawn(cli, args, { detached: true, stdio: 'ignore' }).unref();
}

export function getAvailableIdeIds(): string[] {
    return getProviderLoader().getAvailableIdeTypes();
}
