/**
 * CDP Scripts — Router
 *
 * Version routing is handled by ProviderLoader:
 * Pattern:
 *   - Scripts WITHOUT params: loaded as-is (self-invoking IIFE)
 *   - Scripts WITH params: loaded as function expression, invoked with params JSON
 *     e.g. `(${script})(${JSON.stringify(params)})`
 */

'use strict';

const fs   = require('fs');
const path = require('path');

function load(name) {
    try { return fs.readFileSync(path.join(__dirname, name), 'utf-8'); }
    catch { return null; }
}

function getMessageText(params) {
    return typeof params === 'string' ? params : params?.message || '';
}

function withParams(name, params) {
    let script = load(name);
    if (!script) return null;
    
    // For legacy scripts checking MESSAGE, interpolate them manually
    if (script.includes('${ MESSAGE }')) {
        const msg = getMessageText(params);
        return script.replace(/\$\{ MESSAGE \}/g, JSON.stringify(msg));
    }
    if (script.includes('${ BUTTON_TEXT }')) {
        const btn = params?.BUTTON_TEXT || params?.buttonText || '';
        return script.replace(/\$\{ BUTTON_TEXT \}/g, JSON.stringify(btn));
    }
    
    return `(${script})(${JSON.stringify(params)})`;
}

// ─── Core (no params — IIFE) ───

module.exports.readChat       = () => load('read_chat.js') || load('webview_read_chat.js');
module.exports.sendMessage    = (params) => {
    let s = load('send_message.js');
    if (!s) s = load('webview_send_message.js');
    if (!s) return null;
    // Legacy template substitution fallback
    if (s.includes('${ MESSAGE }')) {
        const msg = getMessageText(params);
        return s.replace(/\$\{ MESSAGE \}/g, JSON.stringify(msg));
    }
    return withParams('send_message.js', params) || withParams('webview_send_message.js', params);
};
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
    return withParams('resolve_action.js', { buttonText, BUTTON_TEXT: buttonText });
};

module.exports.setModel = (params) => {
    const model = typeof params === 'string' ? params : params?.model;
    return withParams('set_model.js', { model });
};

module.exports.setMode = (params) => {
    const mode = typeof params === 'string' ? params : params?.mode;
    return withParams('set_mode.js', { mode });
};
