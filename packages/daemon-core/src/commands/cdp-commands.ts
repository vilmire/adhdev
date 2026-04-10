/**
 * CDP Commands — cdpEval, screenshot, cdpCommand, cdpBatch, cdpRemoteAction,
 *                discoverAgents, file operations
 */

import type { CommandResult, CommandHelpers } from './handler.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Windows Virtual Key Code mapping for special keys (Chrome CDP requirement)
const KEY_TO_VK: Record<string, number> = {
    Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Space: 32,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
    Insert: 45, F1: 112, F2: 113, F3: 114, F4: 115, F5: 116,
    F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
    Control: 17, Shift: 16, Alt: 18, Meta: 91, CapsLock: 20,
    ' ': 32,
};

// ─── CDP direct commands ──────────────────────────

export async function handleCdpEval(h: CommandHelpers, args: any): Promise<CommandResult> {
    if (!h.getCdp()?.isConnected) return { success: false, error: 'CDP not connected' };
    const expression = args?.expression || args?.script;
    if (!expression) return { success: false, error: 'expression required' };
    try {
        const result = await h.getCdp()!.evaluate(expression, 50000);
        return { success: true, result };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

export async function handleScreenshot(h: CommandHelpers, args: any): Promise<CommandResult> {
    if (!h.getCdp()?.isConnected) return { success: false, error: 'CDP not connected' };
    try {
        const buf = await h.getCdp()!.captureScreenshot();
        if (buf) {
            const b64 = buf.toString('base64');
            return { success: true, result: b64, base64: b64, screenshot: b64, format: 'webp' };
        }
        return { success: false, error: 'Screenshot failed' };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

export async function handleCdpCommand(h: CommandHelpers, args: any): Promise<CommandResult> {
    if (!h.getCdp()?.isConnected) return { success: false, error: 'CDP not connected' };
    const method = args?.method;
    const params = args?.params || {};
    if (!method) return { success: false, error: 'method required' };
    try {
        const result = await h.getCdp()!.sendCdpCommand(method, params);
        return { success: true, result };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

export async function handleCdpBatch(h: CommandHelpers, args: any): Promise<CommandResult> {
    if (!h.getCdp()?.isConnected) return { success: false, error: 'CDP not connected' };
    const commands = Array.isArray(args?.commands) ? args.commands : null;
    const stopOnError = args?.stopOnError !== false;
    if (!commands?.length) return { success: false, error: 'commands array required' };

    const results: any[] = [];
    for (const cmd of commands) {
        if (!cmd || typeof cmd !== 'object' || typeof cmd.method !== 'string') {
            results.push({ method: null, success: false, error: 'Invalid command entry' });
            if (stopOnError) break;
            continue;
        }
        try {
            const result = await h.getCdp()!.sendCdpCommand(cmd.method, cmd.params || {});
            results.push({ method: cmd.method, success: true, result });
        } catch (e: any) {
            results.push({ method: cmd.method, success: false, error: e.message });
            if (stopOnError) break;
        }
    }
    return { success: true, results };
}

export async function handleCdpRemoteAction(h: CommandHelpers, args: any): Promise<CommandResult> {
    if (!h.getCdp()?.isConnected) return { success: false, error: 'CDP not connected' };
    const action = args?.action;
    const params = args?.params || args;

    try {
        switch (action) {
            case 'input_key': {
                const { type: evType, key, code, text, unmodifiedText, modifiers } = params;
                // modifiers is a numeric bitmask: 1=alt, 2=ctrl, 4=meta, 8=shift
                const mod = typeof modifiers === 'number' ? modifiers : 0;
                // Chrome CDP needs windowsVirtualKeyCode for special keys to register
                const vk = KEY_TO_VK[key] || (key.length === 1 ? key.charCodeAt(0) : 0);
                if (evType === 'char') {
                    // Character input — single char event with text field
                    await h.getCdp()!.send('Input.dispatchKeyEvent', {
                        type: 'char', key, code,
                        text: text || key,
                        unmodifiedText: unmodifiedText || text || key,
                        ...(vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}),
                        ...(mod ? { modifiers: mod } : {}),
                    });
                } else {
                    // Non-character key (arrows, Enter, Escape, Tab, Backspace, etc.)
                    await h.getCdp()!.send('Input.dispatchKeyEvent', {
                        type: 'rawKeyDown', key, code,
                        ...(text ? { text } : {}),
                        ...(vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}),
                        ...(mod ? { modifiers: mod } : {}),
                    });
                    await h.getCdp()!.send('Input.dispatchKeyEvent', {
                        type: 'keyUp', key, code,
                        ...(vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}),
                        ...(mod ? { modifiers: mod } : {}),
                    });
                }
                return { success: true };
            }
            case 'input_click': {
                let { x, y, nx, ny, button: btn, clickCount } = params;
                if ((x === undefined || y === undefined) && nx !== undefined && ny !== undefined) {
                    const viewport = await h.getCdp()!.evaluate(
                        'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })'
                    ) as string;
                    const { w, h: vh } = JSON.parse(viewport);
                    x = Math.round(nx * w);
                    y = Math.round(ny * vh);
                }
                if (x === undefined || y === undefined) {
                    return { success: false, error: 'No coordinates provided (x,y or nx,ny required)' };
                }
                const cc = clickCount || 1;
                await h.getCdp()!.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed', x, y, button: btn || 'left', clickCount: cc,
                });
                await h.getCdp()!.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x, y, button: btn || 'left', clickCount: cc,
                });
                return { success: true, x, y };
            }
            case 'input_type': {
                const { text } = params;
                for (const char of text || '') {
                    await h.getCdp()!.send('Input.dispatchKeyEvent', {
                        type: 'char', text: char, key: char,
                        unmodifiedText: char,
                    });
                }
                return { success: true };
            }
            case 'page_screenshot': return handleScreenshot(h, args);
            case 'page_eval': return handleCdpEval(h, params);
            case 'dom_query': {
                const html = await h.getCdp()!.querySelector(params?.selector);
                return { success: true, html };
            }
            case 'input_wheel': {
                let { x, y, nx, ny, deltaX, deltaY } = params;
                if ((x === undefined || y === undefined) && nx !== undefined && ny !== undefined) {
                    const viewport = await h.getCdp()!.evaluate(
                        'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })'
                    ) as string;
                    const { w, h: vh } = JSON.parse(viewport);
                    x = Math.round(nx * w);
                    y = Math.round(ny * vh);
                }
                await h.getCdp()!.send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel', x: x || 0, y: y || 0,
                    deltaX: deltaX || 0, deltaY: deltaY || 0,
                });
                return { success: true };
            }
            case 'input_mouseMoved': {
                let { x, y, nx, ny } = params;
                if ((x === undefined || y === undefined) && nx !== undefined && ny !== undefined) {
                    const viewport = await h.getCdp()!.evaluate(
                        'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })'
                    ) as string;
                    const { w, h: vh } = JSON.parse(viewport);
                    x = Math.round(nx * w);
                    y = Math.round(ny * vh);
                }
                await h.getCdp()!.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved', x: x || 0, y: y || 0,
                });
                return { success: true };
            }
            default:
                return { success: false, error: `Unknown remote action: ${action}` };
        }
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

export async function handleDiscoverAgents(h: CommandHelpers, args: any): Promise<CommandResult> {
    if (!h.getCdp()?.isConnected) return { success: false, error: 'CDP not connected' };
    const agents = await h.getCdp()!.discoverAgentWebviews();
    return { success: true, agents };
}

// ─── File commands ─────────────────────────────

function normalizeWindowsRequestedPath(requestedPath: string): string {
    const trimmed = requestedPath.trim();
    if (!trimmed) return '.';

    const slashDriveMatch = trimmed.match(/^[/\\]([A-Za-z])(?:[/\\](.*))?$/);
    if (slashDriveMatch) {
        const drive = slashDriveMatch[1].toUpperCase();
        const rest = (slashDriveMatch[2] || '').replace(/[/\\]+/g, '\\');
        return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
    }

    if (/^[A-Za-z]:$/.test(trimmed)) {
        return `${trimmed[0].toUpperCase()}:\\`;
    }

    if (/^[A-Za-z]:[^/\\].*$/.test(trimmed)) {
        return `${trimmed[0].toUpperCase()}:\\${trimmed.slice(2).replace(/[/\\]+/g, '\\')}`;
    }

    if (/^[A-Za-z]:[/\\]/.test(trimmed)) {
        return `${trimmed[0].toUpperCase()}:${trimmed.slice(2)}`;
    }

    return trimmed;
}

function resolveSafePath(requestedPath: string): string {
    const rawPath = typeof requestedPath === 'string' ? requestedPath.trim() : '';
    const inputPath = rawPath || '.';
    const home = os.homedir();

    if (inputPath.startsWith('~')) {
        return path.resolve(path.join(home, inputPath.slice(1)));
    }

    if (process.platform === 'win32') {
        const normalized = normalizeWindowsRequestedPath(inputPath);
        if (path.win32.isAbsolute(normalized)) {
            return path.win32.normalize(normalized);
        }
        return path.win32.resolve(normalized);
    }

    if (path.isAbsolute(inputPath)) {
        return path.normalize(inputPath);
    }

    return path.resolve(inputPath);
}

function listDirectoryEntriesSafe(dirPath: string): Array<{ name: string; type: 'directory' | 'file'; size?: number }> {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files: Array<{ name: string; type: 'directory' | 'file'; size?: number }> = [];

    for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        try {
            if (entry.isDirectory()) {
                files.push({ name: entry.name, type: 'directory' });
                continue;
            }
            if (entry.isFile()) {
                let size: number | undefined;
                try {
                    size = fs.statSync(entryPath).size;
                } catch {
                    size = undefined;
                }
                files.push({ name: entry.name, type: 'file', size });
                continue;
            }

            const stat = fs.statSync(entryPath);
            files.push({
                name: entry.name,
                type: stat.isDirectory() ? 'directory' : 'file',
                size: stat.isFile() ? stat.size : undefined,
            });
        } catch {
            // Skip inaccessible entries such as protected Windows root files.
        }
    }

    return files;
}

export async function handleFileRead(h: CommandHelpers, args: any): Promise<CommandResult> {
    try {
        const filePath = resolveSafePath(args?.path);
        const content = fs.readFileSync(filePath, 'utf-8');
        return { success: true, content, path: filePath };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

export async function handleFileWrite(h: CommandHelpers, args: any): Promise<CommandResult> {
    try {
        const filePath = resolveSafePath(args?.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, args?.content || '', 'utf-8');
        return { success: true, path: filePath };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

export async function handleFileList(h: CommandHelpers, args: any): Promise<CommandResult> {
    try {
        const dirPath = resolveSafePath(args?.path || '.');
        const files = listDirectoryEntriesSafe(dirPath);
        return { success: true, files, path: dirPath };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

export async function handleFileListBrowse(h: CommandHelpers, args: any): Promise<CommandResult> {
    try {
        const dirPath = resolveSafePath(args?.path || '.');
        const files = listDirectoryEntriesSafe(dirPath)
            .filter(entry => entry.type === 'directory')
            .sort((a, b) => a.name.localeCompare(b.name));
        return { success: true, files, path: dirPath };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}
