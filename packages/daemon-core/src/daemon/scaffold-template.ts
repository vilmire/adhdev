/**
 * Provider scaffold template generator
 * Generates provider.json + scripts/ directory structure (Antigravity pattern).
 *
 * New pattern:
 *   - Scripts WITHOUT params: self-invoking IIFE — (() => { ... })()
 *   - Scripts WITH params: function expression — (params) => { ... }
 *     Router invokes: `(${script})(${JSON.stringify(params)})`
 *   - Each function is a separate .js file in scripts/<version>/
 *   - scripts.js router loads + invokes individual files
 */

export interface ScaffoldOptions {
  cdpPorts?: [number, number];
  cli?: string;
  processName?: string;
  installPath?: string;
  binary?: string;
  extensionId?: string;
  version?: string;
  osPaths?: Record<string, string[]>;
  processNames?: Record<string, string>;
}

export interface ScaffoldResult {
  'provider.json': string;
  files?: Record<string, string>;
}

export function generateTemplate(type: string, name: string, category: string, opts: ScaffoldOptions = {}): string {
  const result = generateFiles(type, name, category, opts);
  return result['provider.json'];
}

/**
 * Generate provider.json + per-function script files.
 * Returns a map of relative paths -> file contents.
 */
export function generateFiles(type: string, name: string, category: string, opts: ScaffoldOptions = {}): ScaffoldResult {
  const { cdpPorts, cli, processName, installPath, binary, extensionId, version = '0.1' } = opts;

  // ─── CLI / ACP: provider.json only ───
  if (category === 'cli' || category === 'acp') {
    const bin = binary || type;
    const meta: Record<string, any> = {
      type,
      name,
      category,
      icon: '💻',
      binary: bin,
      spawn: {
        command: bin,
        args: [],
        shell: true,
      },
      patterns: {
        prompt: ['^[>$#] '],
        generating: ['\\.{3}$', 'thinking'],
        approval: ['\\(y\\/n\\)', 'approve', 'allow'],
        ready: ['ready'],
      },
    };
    return { 'provider.json': JSON.stringify(meta, null, 2) + '\n' };
  }

  // ─── IDE / Extension: provider.json + scripts/ directory ───
  const isExtension = category === 'extension';
  const scriptDir = `scripts/${version}`;

  const meta: Record<string, any> = {
    type,
    name,
    category,
    displayName: name,
    icon: isExtension ? '🧩' : '💻',
  };
  if (cli) meta.cli = cli;
  if (cdpPorts) meta.cdpPorts = cdpPorts;
  else if (!isExtension) meta.cdpPorts = [9222, 9223];
  
  if (opts.processNames) meta.processNames = opts.processNames;
  else if (processName) meta.processNames = { darwin: processName };
  
  if (opts.osPaths) meta.paths = opts.osPaths;
  else if (installPath) meta.paths = { darwin: [installPath] };
  
  if (isExtension) {
    meta.extensionId = extensionId || `publisher.${type}`;
    meta.extensionIdPattern = `${extensionId || type}`;
  } else {
    meta.inputMethod = 'cdp-type-and-send';
    meta.inputSelector = '[contenteditable="true"][role="textbox"]';
    if (cli) meta.versionCommand = `${cli} --version`;
    meta.providerVersion = '1.0.0';
    meta.compatibility = [
      { ideVersion: `>=${version}.0`, scriptDir },
    ];
    meta.defaultScriptDir = scriptDir;
  }

  // ─── Individual script files ───
  const files: Record<string, string> = {};

  // Router (scripts.js)
  files[`${scriptDir}/scripts.js`] = `/**
 * ${name} CDP Scripts — Router
 *
 * Loads individual .js files and invokes with params.
 * Pattern:
 *   - No-params scripts: loaded as-is (IIFE)
 *   - With-params scripts: \`(\${script})(\${JSON.stringify(params)})\`
 */

'use strict';

const fs   = require('fs');
const path = require('path');

function load(name) {
    try { return fs.readFileSync(path.join(__dirname, name), 'utf-8'); }
    catch { return null; }
}

function withParams(name, params) {
    const script = load(name);
    if (!script) return null;
    return \`(\${script})(\${JSON.stringify(params)})\`;
}

// ─── Core (no params — IIFE) ───

module.exports.readChat       = () => load('read_chat.js');
module.exports.sendMessage    = () => load('send_message.js');
module.exports.listSessions   = () => load('list_sessions.js');
module.exports.newSession     = () => load('new_session.js');
module.exports.focusEditor    = () => load('focus_editor.js');
module.exports.openPanel      = () => load('open_panel.js');
module.exports.listModels     = () => load('list_models.js');
module.exports.listModes      = () => load('list_modes.js');

// ─── With params (function expression) ───

module.exports.switchSession = (params) => {
    const index = typeof params === 'number' ? params : params?.index ?? 0;
    const title = typeof params === 'string' ? params : params?.title || null;
    return withParams('switch_session.js', { index, title });
};

module.exports.resolveAction = (params) => {
    const action = typeof params === 'string' ? params : params?.action || 'approve';
    const buttonText = params?.button || params?.buttonText
        || (action === 'approve' ? 'Accept' : action === 'reject' ? 'Reject' : action);
    return withParams('resolve_action.js', { buttonText });
};

module.exports.setModel = (params) => {
    const model = typeof params === 'string' ? params : params?.model;
    return withParams('set_model.js', { model });
};

module.exports.setMode = (params) => {
    const mode = typeof params === 'string' ? params : params?.mode;
    return withParams('set_mode.js', { mode });
};
`;

  // read_chat.js — most complex, stub with detailed TODO
  files[`${scriptDir}/read_chat.js`] = `/**
 * ${name} — read_chat
 *
 * Extract chat messages, status, and approval state from DOM.
 *
 * TODO: Identify via CDP/DevConsole:
 *   1. Chat container selector
 *   2. User message selector + class pattern
 *   3. Assistant message selector + class pattern
 *   4. Status detection (generating/idle/waiting_approval)
 *   5. Approval dialog detection (buttons, modal)
 *   6. Input field selector
 *
 * Preferred live-state surface:
 *   - controlValues: explicit current control selections (model/mode/etc.)
 *   - summaryMetadata: compact always-visible metadata for dashboard/recent views
 * Legacy top-level model/mode output is no longer the preferred shape.
 * → { id, status, title, messages[], inputContent, activeModal, controlValues?, summaryMetadata? }
 */
(() => {
  try {
    const messages = [];
    let status = 'idle';
    let activeModal = null;

    // TODO: Query chat container and extract messages
    // Example:
    //   document.querySelectorAll('.chat-message').forEach(el => {
    //     const role = el.classList.contains('user') ? 'user' : 'assistant';
    //     messages.push({ role, content: el.innerText.trim(), index: messages.length });
    //   });

    // TODO: Detect generating state
    // TODO: Detect approval dialogs -> status = 'waiting_approval'

    const inputEl = document.querySelector('[contenteditable="true"]');
    const inputContent = inputEl?.innerText?.trim() || '';

    return JSON.stringify({
      id: 'active',
      status,
      title: document.title,
      messages,
      inputContent,
      activeModal,
      // TODO: Return explicit selections when available, e.g.
      // controlValues: { model: selectedModel, mode: selectedMode },
      // summaryMetadata: { items: [{ id: 'model', value: selectedModelLabel || selectedModel, shortValue: selectedModel, order: 10 }] },
    });
  } catch(e) {
    return JSON.stringify({ id: '', status: 'error', messages: [], error: e.message });
  }
})()
`;

  // send_message.js
  files[`${scriptDir}/send_message.js`] = `/**
 * ${name} — send_message
 *
 * For cdp-type-and-send IDEs: returns selector for daemon to type into.
 * → { sent: false, needsTypeAndSend: true, selector }
 */
(() => {
  try {
    const input = document.querySelector('${meta.inputSelector || '[contenteditable="true"]'}');
    if (!input) return JSON.stringify({ sent: false, error: 'Input not found' });
    return JSON.stringify({
      sent: false,
      needsTypeAndSend: true,
      selector: '${meta.inputSelector || '[contenteditable="true"]'}',
    });
  } catch(e) {
    return JSON.stringify({ sent: false, error: e.message });
  }
})()
`;

  // list_sessions.js
  files[`${scriptDir}/list_sessions.js`] = `/**
 * ${name} — list_sessions
 *
 * TODO: Query session/chat list from sidebar.
 * → { sessions: [{ id, title, active, index }] }
 */
(() => {
  try {
    const sessions = [];
    // TODO: Find session list container and parse items
    return JSON.stringify({ sessions });
  } catch(e) {
    return JSON.stringify({ sessions: [], error: e.message });
  }
})()
`;

  // switch_session.js
  files[`${scriptDir}/switch_session.js`] = `/**
 * ${name} — switch_session
 *
 * params.index: number, params.title: string|null
 * TODO: Click on session in sidebar by title or index.
 * → { switched: true/false }
 */
(params) => {
  try {
    // TODO: Find session list and click target
    return JSON.stringify({ switched: false, error: 'Not implemented' });
  } catch(e) {
    return JSON.stringify({ switched: false, error: e.message });
  }
}
`;

  // new_session.js
  files[`${scriptDir}/new_session.js`] = `/**
 * ${name} — new_session
 *
 * TODO: Click "New Chat" button.
 * → { created: true/false }
 */
(() => {
  try {
    const btn = document.querySelector('[aria-label*="New Chat"], [aria-label*="New Composer"]');
    if (btn) { btn.click(); return JSON.stringify({ created: true }); }
    return JSON.stringify({ created: false, error: 'New Chat button not found' });
  } catch(e) {
    return JSON.stringify({ created: false, error: e.message });
  }
})()
`;

  // focus_editor.js
  files[`${scriptDir}/focus_editor.js`] = `/**
 * ${name} — focus_editor
 */
(() => {
  try {
    const input = document.querySelector('${meta.inputSelector || '[contenteditable="true"]'}');
    if (input) { input.focus(); return 'focused'; }
    return 'not_found';
  } catch(e) { return 'error'; }
})()
`;

  // open_panel.js
  files[`${scriptDir}/open_panel.js`] = `/**
 * ${name} — open_panel
 *
 * TODO: Open chat/AI panel if not visible.
 */
(() => {
  try {
    // TODO: Check if panel visible, if not find toggle button
    return 'not_found';
  } catch(e) { return 'error'; }
})()
`;

  // resolve_action.js
  files[`${scriptDir}/resolve_action.js`] = `/**
 * ${name} — resolve_action
 *
 * params.buttonText: string — button text to find and click.
 * → { resolved: true/false, clicked? }
 */
(params) => {
  try {
    const btns = [...document.querySelectorAll('button, [role="button"]')].filter(b => b.offsetWidth > 0);
    const searchText = (params.buttonText || '').toLowerCase();
    const target = btns.find(b => (b.textContent||'').trim().toLowerCase().includes(searchText));
    if (target) {
      target.click();
      return JSON.stringify({ resolved: true, clicked: target.textContent.trim() });
    }
    return JSON.stringify({ resolved: false, available: btns.map(b => b.textContent.trim()).filter(Boolean).slice(0, 10) });
  } catch(e) { return JSON.stringify({ resolved: false, error: e.message }); }
}
`;

  // list_models.js
  files[`${scriptDir}/list_models.js`] = `/**
 * ${name} — list_models
 *
 * TODO: Open model dropdown and extract model list.
 * → { models[], current }
 */
(() => {
  try {
    return JSON.stringify({ models: [], current: '' });
  } catch(e) { return JSON.stringify({ models: [], current: '', error: e.message }); }
})()
`;

  // list_modes.js
  files[`${scriptDir}/list_modes.js`] = `/**
 * ${name} — list_modes
 *
 * TODO: Open mode dropdown and extract mode list.
 * → { modes[], current }
 */
(() => {
  try {
    return JSON.stringify({ modes: [], current: '' });
  } catch(e) { return JSON.stringify({ modes: [], current: '', error: e.message }); }
})()
`;

  // set_model.js
  files[`${scriptDir}/set_model.js`] = `/**
 * ${name} — set_model
 *
 * params.model: string
 * TODO: Open model dropdown and select target model.
 * → { success: true/false }
 */
async (params) => {
  try {
    return JSON.stringify({ success: false, error: 'Not implemented' });
  } catch(e) { return JSON.stringify({ success: false, error: e.message }); }
}
`;

  // set_mode.js
  files[`${scriptDir}/set_mode.js`] = `/**
 * ${name} — set_mode
 *
 * params.mode: string
 * TODO: Open mode dropdown and select target mode.
 * → { success: true/false }
 */
async (params) => {
  try {
    return JSON.stringify({ success: false, error: 'Not implemented' });
  } catch(e) { return JSON.stringify({ success: false, error: e.message }); }
}
`;

  return {
    'provider.json': JSON.stringify(meta, null, 2) + '\n',
    files,
  };
}
