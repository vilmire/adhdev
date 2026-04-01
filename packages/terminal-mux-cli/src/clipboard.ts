import { spawnSync } from 'child_process';

function tryCopy(command: string, args: string[], text: string): boolean {
  try {
    const result = spawnSync(command, args, {
      input: text,
      stdio: ['pipe', 'ignore', 'ignore'],
      encoding: 'utf8',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function copyTextToClipboard(text: string): void {
  if (process.platform === 'darwin') {
    if (tryCopy('pbcopy', [], text)) return;
    throw new Error('pbcopy is not available');
  }
  if (process.platform === 'win32') {
    if (tryCopy('clip', [], text)) return;
    if (tryCopy('powershell', ['-NoProfile', '-Command', 'Set-Clipboard'], text)) return;
    throw new Error('No clipboard command is available on Windows');
  }
  if (tryCopy('wl-copy', [], text)) return;
  if (tryCopy('xclip', ['-selection', 'clipboard'], text)) return;
  if (tryCopy('xsel', ['--clipboard', '--input'], text)) return;
  throw new Error('No clipboard command is available');
}
