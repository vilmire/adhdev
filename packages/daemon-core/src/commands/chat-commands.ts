/**
 * Chat Commands — readChat, sendChat, listChats, newChat, switchChat,
 *                 setMode, changeModel, setThoughtLevel, resolveAction, chatHistory
 */

import type { CommandResult, CommandHelpers } from './handler.js';
import { readChatHistory } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';

function getTargetedCliAdapter(h: CommandHelpers, args: any, providerType?: string) {
    return h.getCliAdapter(args?._targetInstance || h.currentIdeType || providerType);
}

export async function handleChatHistory(h: CommandHelpers, args: any): Promise<CommandResult> {
    const { agentType, offset, limit, instanceId } = args;
    try {
        const provider = h.getProvider(agentType);
        const agentStr = provider?.type || agentType || h.currentIdeType || '';
        const result = readChatHistory(agentStr, offset || 0, limit || 30, instanceId);
        return { success: true, ...result, agent: agentStr };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

export async function handleReadChat(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);

    const _log = (msg: string) => LOG.debug('Command', `[read_chat] ${msg}`);

    // CLI / ACP category: read from adapter
    if (provider?.category === 'cli' || provider?.category === 'acp') {
        const adapter = getTargetedCliAdapter(h, args, provider.type);
        if (adapter) {
            _log(`${provider.category} adapter: ${(adapter as any).cliType}`);
            const status = (adapter as any).getStatus?.();
            if (status) {
                return {
                    success: true,
                    messages: status.messages || [],
                    status: status.status,
                    activeModal: status.activeModal,
                    terminalHistory: status.terminalHistory || '',
                };
            }
        }
        return { success: false, error: `${provider.category} adapter not found` };
    }

    // Extension category: evaluateInSession
    if (provider?.category === 'extension') {
        try {
            const evalResult = await h.evaluateProviderScript('readChat', undefined, 50000);
            if (evalResult?.result) {
                let parsed = evalResult.result;
                if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
                if (parsed && typeof parsed === 'object') {
                    _log(`Extension OK: ${parsed.messages?.length || 0} msgs`);
                    h.historyWriter.appendNewMessages(
                        provider.type || 'unknown_extension',
                        parsed.messages || [],
                        parsed.title,
                        args?.instanceId
                    );
                    return { success: true, ...parsed };
                }
            }
        } catch (e: any) {
            _log(`Extension error: ${e.message}`);
        }
        // Alternative: AgentStreamManager (script fail when)
        if (h.agentStream) {
            const cdp = h.getCdp();
            if (cdp) {
                const streams = await h.agentStream.collectAgentStreams(cdp);
                const stream = streams.find((s: any) => s.agentType === provider.type);
                if (stream) {
                    h.historyWriter.appendNewMessages(
                        stream.agentType,
                        stream.messages || [],
                        undefined,
                        args?.instanceId
                    );
                    return { success: true, messages: stream.messages || [], status: stream.status, agentType: stream.agentType };
                }
            }
        }
        return { success: true, messages: [], status: 'idle' };
    }

    // IDE category (default): cdp.evaluate
    const cdp = h.getCdp();
    if (!cdp?.isConnected) return { success: false, error: 'CDP not connected' };

    // webview IDE (Kiro, PearAI) → evaluateInWebviewFrame directly use
    const webviewScript = h.getProviderScript('webviewReadChat') || h.getProviderScript('webview_read_chat');
    if (webviewScript) {
        try {
            const matchText = provider?.webviewMatchText;
            const matchFn = matchText
                ? (body: string) => body.includes(matchText)
                : undefined;
            const raw = await cdp.evaluateInWebviewFrame(webviewScript, matchFn);
            if (raw) {
                let parsed: any = raw;
                if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
                if (parsed && typeof parsed === 'object') {
                    _log(`Webview OK: ${parsed.messages?.length || 0} msgs`);
                    h.historyWriter.appendNewMessages(
                        provider?.type || h.currentIdeType || 'unknown_webview',
                        parsed.messages || [],
                        parsed.title,
                        args?.instanceId
                    );
                    return { success: true, ...parsed };
                }
            }
        } catch (e: any) {
            _log(`Webview readChat error: ${e.message}`);
        }
        return { success: true, messages: [], status: 'idle' };
    }

    // Regular IDE (Cursor, Windsurf, Trae etc) → main DOM evaluate
    const script = h.getProviderScript('readChat') || h.getProviderScript('read_chat');
    if (script) {
        try {
            const result = await cdp.evaluate(script, 50000);
            let parsed: any = result;
            if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
            if (parsed && typeof parsed === 'object' && parsed.messages?.length > 0) {
                _log(`OK: ${parsed.messages?.length} msgs`);
                h.historyWriter.appendNewMessages(
                    provider?.type || h.currentIdeType || 'unknown_ide',
                    parsed.messages || [],
                    parsed.title,
                    args?.instanceId
                );
                return { success: true, ...parsed };
            }
        } catch (e: any) {
            LOG.info('Command', `[read_chat] Script error: ${e.message}`);
        }
    }

    return { success: true, messages: [], status: 'idle' };
}

export async function handleSendChat(h: CommandHelpers, args: any): Promise<CommandResult> {
    const text = args?.text || args?.message;
    if (!text) return { success: false, error: 'text required' };
    const _log = (msg: string) => LOG.debug('Command', `[send_chat] ${msg}`);
    const provider = h.getProvider(args?.agentType);

    const _logSendSuccess = (method: string, targetAgent?: string) => {
        h.historyWriter.appendNewMessages(
            targetAgent || provider?.type || h.currentIdeType || 'unknown_agent',
            [{ role: 'user', content: text, receivedAt: Date.now() }],
            undefined, // title
            args?.instanceId
        );
        return { success: true, sent: true, method, targetAgent };
    };

    // CLI / ACP category: transmit via adapter
    if (provider?.category === 'cli' || provider?.category === 'acp') {
        const adapter = getTargetedCliAdapter(h, args, provider.type);
        if (adapter) {
            _log(`${provider.category} adapter: ${(adapter as any).cliType}`);
            try {
                await adapter.sendMessage(text);
                return _logSendSuccess(`${provider.category}-adapter`, (adapter as any).cliType);
            } catch (e: any) {
                return { success: false, error: `${provider.category} send failed: ${e.message}` };
            }
        }
    }

    // Extension category: via AgentStreamManager
    if (provider?.category === 'extension') {
        _log(`Extension: ${provider.type}`);
        // Method 1: provider sendMessage script via evaluateInSession
        try {
            const evalResult = await h.evaluateProviderScript('sendMessage', { MESSAGE: text }, 30000);
            if (evalResult?.result) {
                let parsed = evalResult.result;
                if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
                if (parsed?.sent) {
                    _log(`Extension script sent OK`);
                    return _logSendSuccess('extension-script');
                }
                if (parsed?.needsTypeAndSend) {
                    _log(`Extension needsTypeAndSend → AgentStreamManager`);
                }
            }
        } catch (e: any) {
            _log(`Extension script error: ${e.message}`);
        }
        // Method 2: AgentStreamManager
        if (h.agentStream && h.getCdp()) {
            const ok = await h.agentStream.sendToAgent(h.getCdp()!, provider.type, text, h.currentIdeType);
            if (ok) {
                _log(`AgentStreamManager sent OK`);
                return _logSendSuccess('agent-stream');
            }
        }
        return { success: false, error: `Extension '${provider.type}' send failed` };
    }

    // IDE category (default): Provider → typeAndSend → script
    const targetCdp = h.getCdp();
    if (!targetCdp?.isConnected) {
        _log(`No CDP for ${h.currentIdeType}`);
        return { success: false, error: `CDP for ${h.currentIdeType || 'unknown'} not connected` };
    }

    _log(`Targeting IDE: ${h.currentIdeType}`);

    // Method 0: webview-based IDE (try webviewSendMessage first)
    if (provider?.webviewMatchText && provider?.scripts?.webviewSendMessage) {
        try {
            const webviewScript = (provider.scripts as any).webviewSendMessage(text);
            if (webviewScript && targetCdp.evaluateInWebviewFrame) {
                const matchText = provider.webviewMatchText;
                const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
                const wvResult = await targetCdp.evaluateInWebviewFrame(webviewScript, matchFn);
                let wvParsed: any = wvResult;
                if (typeof wvResult === 'string') { try { wvParsed = JSON.parse(wvResult); } catch { } }
                if (wvParsed?.sent) {
                    _log(`webviewSendMessage (priority) OK`);
                    return _logSendSuccess('webview-script-priority');
                }
                _log(`webviewSendMessage (priority) did not confirm sent, falling through`);
            }
        } catch (e: any) {
            _log(`webviewSendMessage (priority) failed: ${e.message}, falling through`);
        }
    }

    // Method 1: use provider.inputMethod if available (main frame input)
    if (provider?.inputMethod === 'cdp-type-and-send' && provider.inputSelector) {
        try {
            const sent = await targetCdp.typeAndSend(provider.inputSelector, text);
            if (sent) {
                _log(`typeAndSend(provider.inputSelector=${provider.inputSelector}) success`);
                return _logSendSuccess('typeAndSend-provider');
            }
        } catch (e: any) {
            _log(`typeAndSend(provider) failed: ${e.message}`);
        }
    }

    // Method 2: provider sendMessage script
    const sendScript = h.getProviderScript('sendMessage', { MESSAGE: text });
    if (sendScript) {
        try {
            const result = await targetCdp.evaluate(sendScript, 30000);
            let parsed: any = result;
            if (typeof result === 'string') { try { parsed = JSON.parse(result); } catch { } }
            if (parsed?.sent) {
                _log(`sendMessage script OK`);
                return _logSendSuccess('script');
            }
            // needsTypeAndSend response: typeAndSend using script-specified selector
            if (parsed?.needsTypeAndSend && parsed?.selector) {
                try {
                    const sent = await targetCdp.typeAndSend(parsed.selector, text);
                    if (sent) {
                        _log(`typeAndSend(script.selector=${parsed.selector}) success`);
                        return _logSendSuccess('typeAndSend-script');
                    }
                } catch (e: any) {
                    _log(`typeAndSend(script.selector) failed: ${e.message}`);
                }
            }
            // webviewSendMessage: attempt direct transmission from inside webview iframe
            if (parsed?.needsTypeAndSend && provider?.scripts?.webviewSendMessage) {
                try {
                    const webviewScript = (provider.scripts as any).webviewSendMessage(text);
                    if (webviewScript && targetCdp.evaluateInWebviewFrame) {
                        const matchText = provider.webviewMatchText;
                        const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
                        const wvResult = await targetCdp.evaluateInWebviewFrame(webviewScript, matchFn);
                        let wvParsed: any = wvResult;
                        if (typeof wvResult === 'string') { try { wvParsed = JSON.parse(wvResult); } catch { } }
                        if (wvParsed?.sent) {
                            _log(`webviewSendMessage OK`);
                            return _logSendSuccess('webview-script');
                        }
                    }
                } catch (e: any) {
                    _log(`webviewSendMessage failed: ${e.message}`);
                }
            }
            // Coordinate-based fallback: input field inside webview iframe
            if (parsed?.needsTypeAndSend && parsed?.clickCoords) {
                try {
                    const { x, y } = parsed.clickCoords;
                    const sent = await targetCdp.typeAndSendAt(x, y, text);
                    if (sent) {
                        _log(`typeAndSendAt(${x},${y}) success`);
                        return _logSendSuccess('typeAndSendAt-script');
                    }
                } catch (e: any) {
                    _log(`typeAndSendAt failed: ${e.message}`);
                }
            }
        } catch (e: any) {
            _log(`sendMessage script failed: ${e.message}`);
        }
    }

    _log('All methods failed');
    return { success: false, error: 'No provider method could send the message' };
}

export async function handleListChats(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);

    // Extension: via AgentStreamManager
    if (provider?.category === 'extension' && h.agentStream && h.getCdp()) {
        try {
            const chats = await h.agentStream.listAgentChats(h.getCdp()!, provider.type);
            LOG.info('Command', `[list_chats] Extension: ${chats.length} chats`);
            return { success: true, chats };
        } catch (e: any) {
            LOG.info('Command', `[list_chats] Extension error: ${e.message}`);
        }
    }

    // webview IDE
    try {
        const webviewScript = h.getProviderScript('webviewListSessions') || h.getProviderScript('webview_list_sessions');
        if (webviewScript) {
            const matchText = provider?.webviewMatchText;
            const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
            const raw = await h.getCdp()?.evaluateInWebviewFrame?.(webviewScript, matchFn);
            let parsed: any = raw;
            if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
            if (parsed?.sessions) {
                LOG.info('Command', `[list_chats] Webview OK: ${parsed.sessions.length} chats`);
                return { success: true, chats: parsed.sessions };
            }
        }
    } catch (e: any) {
        LOG.info('Command', `[list_chats] Webview error: ${e.message}`);
    }

    // IDE/default: evaluateProviderScript
    try {
        const evalResult = await h.evaluateProviderScript('listSessions');
        if (evalResult) {
            let parsed = evalResult.result;
            if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
            if (Array.isArray(parsed)) {
                LOG.info('Command', `[list_chats] OK: ${parsed.length} chats`);
                return { success: true, chats: parsed };
            }
        }
    } catch (e: any) {
        LOG.info('Command', `[list_chats] error: ${e.message}`);
    }

    return { success: false, error: 'listSessions script not available for this provider' };
}

export async function handleNewChat(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);

    if (provider?.category === 'cli') {
        const adapter = getTargetedCliAdapter(h, args, provider.type);
        if (!adapter) return { success: false, error: 'CLI adapter not running' };
        if (typeof (adapter as any).clearHistory === 'function') {
            (adapter as any).clearHistory();
            return { success: true, cleared: true };
        }
        return { success: false, error: 'new_chat not supported by this CLI provider' };
    }

    if (provider?.category === 'extension' && h.agentStream && h.getCdp()) {
        const ok = await h.agentStream.newAgentSession(h.getCdp()!, provider.type, h.currentIdeType);
        return { success: ok };
    }

    // webview IDE
    try {
        const webviewScript = h.getProviderScript('webviewNewSession') || h.getProviderScript('webview_new_session');
        if (webviewScript) {
            const matchText = provider?.webviewMatchText;
            const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
            const raw = await h.getCdp()?.evaluateInWebviewFrame?.(webviewScript, matchFn);
            if (raw) return { success: true, result: raw };
        }
    } catch (e: any) {
        return { success: false, error: `webviewNewSession failed: ${e.message}` };
    }

    try {
        const evalResult = await h.evaluateProviderScript('newSession');
        if (evalResult) return { success: true };
    } catch (e: any) {
        return { success: false, error: `newSession failed: ${e.message}` };
    }

    return { success: false, error: 'newSession script not available for this provider' };
}

export async function handleSwitchChat(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);
    const ideType = h.currentIdeType;
    const sessionId = args?.sessionId || args?.id || args?.chatId;
    if (!sessionId) return { success: false, error: 'sessionId required' };
    LOG.info('Command', `[switch_chat] sessionId=${sessionId}, ideType=${ideType}`);

    if (provider?.category === 'extension' && h.agentStream && h.getCdp()) {
        const ok = await h.agentStream.switchAgentSession(h.getCdp()!, provider.type, sessionId);
        return { success: ok, result: ok ? 'switched' : 'failed' };
    }

    const cdp = h.getCdp(ideType);
    if (!cdp?.isConnected) return { success: false, error: 'CDP not connected' };

    // webview IDE
    try {
        const webviewScript = h.getProviderScript('webviewSwitchSession', { SESSION_ID: JSON.stringify(sessionId) });
        if (webviewScript) {
            const matchText = provider?.webviewMatchText;
            const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
            const raw = await cdp.evaluateInWebviewFrame?.(webviewScript, matchFn);
            if (raw) return { success: true, result: raw };
        }
    } catch (e: any) {
        return { success: false, error: `webviewSwitchSession failed: ${e.message}` };
    }

    const script = h.getProviderScript('switchSession', { SESSION_ID: JSON.stringify(sessionId) })
        || h.getProviderScript('switch_session', { SESSION_ID: JSON.stringify(sessionId) });
    if (!script) return { success: false, error: 'switch_session script not available' };

    try {
        const raw = await cdp.evaluate(script, 15000);
        LOG.info('Command', `[switch_chat] result: ${raw}`);

        let parsed: any = null;
        try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { }

        if (parsed?.action === 'click' && parsed.clickX && parsed.clickY) {
            const x = Math.round(parsed.clickX);
            const y = Math.round(parsed.clickY);
            LOG.info('Command', `[switch_chat] CDP click at (${x}, ${y}) for "${parsed.title}"`);
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mousePressed', x, y, button: 'left', clickCount: 1
            });
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x, y, button: 'left', clickCount: 1
            });
            await new Promise(r => setTimeout(r, 2000));

            // Auto-handle workspace selection dialog
            const wsResult = await cdp.evaluate(`
                (() => {
                    const inp = Array.from(document.querySelectorAll('input[type="text"]'))
                        .find(i => i.offsetWidth > 0 && (i.placeholder || '').includes('Select where'));
                    if (!inp) return null;
                    const rows = inp.closest('[class*="quickInput"]')?.querySelectorAll('[class*="cursor-pointer"]');
                    if (rows && rows.length > 0) {
                        const r = rows[0].getBoundingClientRect();
                        return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
                    }
                    return null;
                })()
            `, 5000);
            if (wsResult) {
                try {
                    const ws = JSON.parse(wsResult as string);
                    await cdp.send('Input.dispatchMouseEvent', {
                        type: 'mousePressed', x: ws.x, y: ws.y, button: 'left', clickCount: 1
                    });
                    await cdp.send('Input.dispatchMouseEvent', {
                        type: 'mouseReleased', x: ws.x, y: ws.y, button: 'left', clickCount: 1
                    });
                } catch { }
            }
            return { success: true, result: 'switched' };
        }

        if (parsed?.error) return { success: false, error: parsed.error };
        return { success: true, result: raw };
    } catch (e: any) {
        LOG.error('Command', `[switch_chat] error: ${e.message}`);
        return { success: false, error: e.message };
    }
}

export async function handleSetMode(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);
    const mode = args?.mode || 'agent';

    // ACP provider
    if (provider?.category === 'acp') {
        const adapter = getTargetedCliAdapter(h, args, provider.type);
        if (adapter) {
            const acpInstance = (adapter as any)._acpInstance;
            if (acpInstance && typeof acpInstance.onEvent === 'function') {
                acpInstance.onEvent('set_mode', { mode });
                return { success: true, mode };
            }
        }
        return { success: false, error: 'ACP adapter not found' };
    }

    // 1. webview setMode
    const webviewScript = h.getProviderScript('webviewSetMode', { MODE: JSON.stringify(mode) });
    if (webviewScript) {
        const cdp = h.getCdp();
        if (cdp?.isConnected) {
            try {
                const matchText = provider?.webviewMatchText;
                const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
                const raw = await cdp.evaluateInWebviewFrame?.(webviewScript, matchFn);
                let result: any = raw;
                if (typeof raw === 'string') { try { result = JSON.parse(raw); } catch { } }
                if (result?.success) return { success: true, mode, method: 'webview-script' };
            } catch (e: any) {
                LOG.info('Command', `[set_mode] webview script error: ${e.message}`);
            }
        }
    }

    // 2. main frame setMode
    const mainScript = h.getProviderScript('setMode', { MODE: JSON.stringify(mode) });
    if (mainScript) {
        try {
            const evalResult = await h.evaluateProviderScript('setMode', { MODE: JSON.stringify(mode) }, 15000);
            if (evalResult?.result) {
                let parsed = evalResult.result;
                if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
                if (parsed?.success) return { success: true, mode, method: 'script' };
            }
        } catch (e: any) {
            LOG.info('Command', `[set_mode] script error: ${e.message}`);
        }
    }

    return { success: false, error: `setMode '${mode}' not supported by this provider` };
}

export async function handleChangeModel(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);
    const model = args?.model;

    LOG.info('Command', `[change_model] model=${model} provider=${provider?.type} category=${provider?.category} ideType=${h.currentIdeType} providerType=${h.currentProviderType}`);

    // ACP provider
    if (provider?.category === 'acp') {
        const adapter = getTargetedCliAdapter(h, args, provider.type);
        LOG.info('Command', `[change_model] ACP adapter found: ${!!adapter}, type=${(adapter as any)?.cliType}, hasAcpInstance=${!!(adapter as any)?._acpInstance}`);
        if (adapter) {
            const acpInstance = (adapter as any)._acpInstance;
            if (acpInstance && typeof acpInstance.onEvent === 'function') {
                acpInstance.onEvent('change_model', { model });
                LOG.info('Command', `[change_model] Dispatched change_model event to ACP instance`);
                return { success: true, model };
            }
        }
        return { success: false, error: 'ACP adapter not found' };
    }

    // 1. webview setModel
    const webviewScript = h.getProviderScript('webviewSetModel', { MODEL: JSON.stringify(model) });
    if (webviewScript) {
        const cdp = h.getCdp();
        if (cdp?.isConnected) {
            try {
                const matchText = provider?.webviewMatchText;
                const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
                const raw = await cdp.evaluateInWebviewFrame?.(webviewScript, matchFn);
                let result: any = raw;
                if (typeof raw === 'string') { try { result = JSON.parse(raw); } catch { } }
                if (result?.success) return { success: true, model, method: 'webview-script' };
            } catch (e: any) {
                LOG.info('Command', `[change_model] webview script error: ${e.message}`);
            }
        }
    }

    // 2. main frame setModel
    const mainScript = h.getProviderScript('setModel', { MODEL: JSON.stringify(model) });
    if (mainScript) {
        try {
            const evalResult = await h.evaluateProviderScript('setModel', { MODEL: JSON.stringify(model) }, 15000);
            if (evalResult?.result) {
                let parsed = evalResult.result;
                if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
                if (parsed?.success) return { success: true, model, method: 'script' };
            }
        } catch (e: any) {
            LOG.info('Command', `[change_model] script error: ${e.message}`);
        }
    }

    return { success: false, error: 'changeModel not supported by this IDE provider' };
}

export async function handleSetThoughtLevel(h: CommandHelpers, args: any): Promise<CommandResult> {
    const configId = args?.configId;
    const value = args?.value;
    if (!configId || !value) return { success: false, error: 'configId and value required' };

    const provider = h.getProvider(args?.agentType);
    if (!provider || provider.category !== 'acp') {
        return { success: false, error: 'set_thought_level only for ACP providers' };
    }
    const adapter = getTargetedCliAdapter(h, args, provider.type);
    const acpInstance = adapter?._acpInstance;
    if (!acpInstance) return { success: false, error: 'ACP instance not found' };

    try {
        await acpInstance.setConfigOption(configId, value);
        LOG.info('Command', `[set_thought_level] ${configId}=${value} for ${provider.type}`);
        return { success: true, configId, value };
    } catch (e: any) {
        return { success: false, error: e?.message };
    }
}

export async function handleResolveAction(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);
    const action = args?.action || 'approve';
    const button = args?.button || args?.buttonText
        || (action === 'approve' ? 'Accept' : action === 'reject' ? 'Reject' : 'Accept');

    LOG.info('Command', `[resolveAction] action=${action} button="${button}" provider=${provider?.type}`);

    // 0. CLI / ACP category: navigate approval dialog via PTY arrow keys + Enter
    if (provider?.category === 'cli') {
        const adapter = getTargetedCliAdapter(h, args, provider.type);
        if (!adapter) return { success: false, error: 'CLI adapter not running' };

        // Handle data-driven resolve actions (like from the dashboard 'Fix' button)
        if (args?.data && typeof (adapter as any).resolveAction === 'function') {
            try {
                await (adapter as any).resolveAction(args.data);
                LOG.info('Command', `[resolveAction] CLI PTY → resolveAction triggered with data payload`);
                return { success: true, method: 'cli-resolve-action' };
            } catch (e: any) {
                return { success: false, error: `CLI resolveAction failed: ${e.message}` };
            }
        }

        const status = (adapter as any).getStatus?.();
        if (status?.status !== 'waiting_approval') {
            return { success: false, error: 'Not in approval state' };
        }
        const buttons: string[] = status.activeModal?.buttons || ['Allow once', 'Always allow', 'Deny'];
        // Resolve button index: explicit buttonIndex arg → button text match → action fallback
        let buttonIndex = typeof args?.buttonIndex === 'number' ? args.buttonIndex : -1;
        if (buttonIndex < 0) {
            const btnLower = button.toLowerCase();
            buttonIndex = buttons.findIndex(b => b.toLowerCase().includes(btnLower));
        }
        if (buttonIndex < 0) {
            if (action === 'reject' || action === 'deny') {
                buttonIndex = buttons.findIndex(b => /deny|reject|no/i.test(b));
                if (buttonIndex < 0) buttonIndex = buttons.length - 1;
            } else if (action === 'always' || /always/i.test(button)) {
                buttonIndex = buttons.findIndex(b => /always/i.test(b));
                if (buttonIndex < 0) buttonIndex = 1;
            } else {
                buttonIndex = 0; // approve → first option (default selected)
            }
        }
        if (typeof (adapter as any).resolveModal === 'function') {
            (adapter as any).resolveModal(buttonIndex);
        } else {
            const keys = '\x1B[B'.repeat(Math.max(0, buttonIndex)) + '\r';
            (adapter as any).writeRaw?.(keys);
        }
        LOG.info('Command', `[resolveAction] CLI PTY → buttonIndex=${buttonIndex} "${buttons[buttonIndex] ?? '?'}"`);
        return { success: true, buttonIndex, button: buttons[buttonIndex] ?? button };
    }

    // 1. Extension: via AgentStreamManager
    if (provider?.category === 'extension' && h.agentStream && h.getCdp()) {
        const ok = await h.agentStream.resolveAgentAction(
            h.getCdp()!, provider.type, action, h.currentIdeType
        );
        return { success: ok };
    }

    // 2. Webview Provider script
    if (provider?.scripts?.webviewResolveAction || provider?.scripts?.webview_resolve_action) {
        const script = h.getProviderScript('webviewResolveAction', { action, button, buttonText: button })
            || h.getProviderScript('webview_resolve_action', { action, button, buttonText: button });
        if (script) {
            const cdp = h.getCdp();
            if (cdp?.isConnected) {
                try {
                    const matchText = provider?.webviewMatchText;
                    const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
                    const raw = await cdp.evaluateInWebviewFrame?.(script, matchFn);
                    let result: any = raw;
                    if (typeof raw === 'string') { try { result = JSON.parse(raw); } catch { } }
                    LOG.info('Command', `[resolveAction] webview script result: ${JSON.stringify(result)}`);

                    if (result?.resolved) return { success: true, clicked: result.clicked };
                    if (result?.found && result.x != null && result.y != null) {
                        LOG.info('Command', `[resolveAction] Webview coordinate click not fully supported via CDP. Click directly in script.`);
                    }
                    if (result?.found || result?.resolved) return { success: true };
                } catch (e: any) {
                    return { success: false, error: `webviewResolveAction failed: ${e.message}` };
                }
            }
        }
    }

    // 3. Provider script (Main DOM) → returns coords → CDP mouse click
    if (provider?.scripts?.resolveAction) {
        const script = provider.scripts.resolveAction({ action, button, buttonText: button });
        if (script) {
            const cdp = h.getCdp();
            if (!cdp?.isConnected) return { success: false, error: 'CDP not connected' };
            try {
                const raw = await cdp.evaluate(script, 30000);
                let result: any = raw;
                if (typeof raw === 'string') { try { result = JSON.parse(raw); } catch {} }
                LOG.info('Command', `[resolveAction] script result: ${JSON.stringify(result)}`);

                if (result?.resolved) {
                    LOG.info('Command', `[resolveAction] script-click resolved — "${result.clicked}"`);
                    return { success: true, clicked: result.clicked };
                }
                if (result?.found && result.x != null && result.y != null) {
                    const x = result.x;
                    const y = result.y;
                    await cdp.send('Input.dispatchMouseEvent', {
                        type: 'mousePressed', x, y, button: 'left', clickCount: 1
                    });
                    await cdp.send('Input.dispatchMouseEvent', {
                        type: 'mouseReleased', x, y, button: 'left', clickCount: 1
                    });
                    LOG.info('Command', `[resolveAction] CDP click at (${x}, ${y}) — "${result.text}"`);
                    return { success: true, clicked: result.text };
                }
                return { success: false, error: result?.found === false ? `Button not found: ${button}` : 'No coordinates' };
            } catch (e: any) {
                return { success: false, error: `resolveAction failed: ${e.message}` };
            }
        }
    }

    return { success: false, error: 'resolveAction script not available for this provider' };
}
