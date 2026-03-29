/**
 * CDP DOM Analysis Tools — DOM dump, query, debug
 *
 * Separated from daemon-commands.ts.
 * Tools for analyzing DOM structure when developing new IDE scripts.
 */

import type { DaemonCdpManager } from './manager.js';
import type { CommandResult } from '../commands/handler.js';

type CdpGetter = (ideType?: string) => DaemonCdpManager | null;

/**
 * CDP DOM analysis handler
 * 
 * Uses getCdp from DaemonCommandHandler.
 */
export class CdpDomHandlers {
    private getCdp: CdpGetter;

    constructor(getCdp: CdpGetter) {
        this.getCdp = getCdp;
    }

 /**
 * CDP DOM Dump — IDE's DOM tree retrieve
 * 
 * args:
 * selector?: string — CSS selector to dump specific area only (default: All)
 * depth?: number — Dump depth limit (default: 10)
 * attrs?: boolean — Whether to include properties (default: true)
 * maxLength?: number — Max character count (default: 200000)
 * format?: 'html' | 'tree' | 'summary' — Output format (default: 'html')
 * sessionId?: string — Agent webview session ID (if provided, match webview DOM)
 */
    async handleDomDump(args: any): Promise<CommandResult> {
        if (!this.getCdp()?.isConnected) return { success: false, error: 'CDP not connected' };

        const selector = args?.selector || 'body';
        const depth = args?.depth || 10;
        const maxLength = args?.maxLength || 200000;
        const format = args?.format || 'html';
        const attrs = args?.attrs !== false;
        const sessionId = args?.sessionId;

        try {
            let expression: string;

            if (format === 'summary') {
 // Summary mode: extract key structure only (classes, tags, roles)
                expression = `(() => {
                    const root = document.querySelector('${selector.replace(/'/g, "\\'")}');
                    if (!root) return JSON.stringify({ error: 'Selector not found: ${selector}' });
                    
                    function summarize(el, depth, maxD) {
                        if (depth > maxD) return { tag: '...', note: 'max depth' };
                        const node = {
                            tag: el.tagName?.toLowerCase(),
                            id: el.id || undefined,
                            class: el.className && typeof el.className === 'string' ? el.className.split(' ').filter(c => c).slice(0, 5).join(' ') : undefined,
                            role: el.getAttribute?.('role') || undefined,
                            'data-testid': el.getAttribute?.('data-testid') || undefined,
                            childCount: el.children?.length || 0,
                        };
                        if (el.children?.length > 0 && depth < maxD) {
                            node.children = Array.from(el.children).slice(0, 30).map(c => summarize(c, depth + 1, maxD));
                        }
                        return node;
                    }
                    return JSON.stringify(summarize(root, 0, ${depth}));
                })()`;
            } else if (format === 'tree') {
 // Tree mode: text-based tree view
                expression = `(() => {
                    const root = document.querySelector('${selector.replace(/'/g, "\\'")}');
                    if (!root) return 'Selector not found: ${selector}';
                    
                    function tree(el, indent, depth, maxD) {
                        if (depth > maxD) return indent + '...\\n';
                        let line = indent + '<' + (el.tagName?.toLowerCase() || '?');
                        if (el.id) line += ' #' + el.id;
                        if (el.className && typeof el.className === 'string') {
                            const cls = el.className.trim().split(' ').filter(c => c).slice(0, 3).join('.');
                            if (cls) line += ' .' + cls;
                        }
                        const role = el.getAttribute?.('role');
                        if (role) line += ' [role=' + role + ']';
                        const testId = el.getAttribute?.('data-testid');
                        if (testId) line += ' [data-testid=' + testId + ']';
                        line += '> (' + (el.children?.length || 0) + ')\\n';
                        
                        let result = line;
                        if (el.children?.length > 0 && depth < maxD) {
                            for (let i = 0; i < Math.min(el.children.length, 30); i++) {
                                result += tree(el.children[i], indent + '  ', depth + 1, maxD);
                            }
                            if (el.children.length > 30) result += indent + '  ... +' + (el.children.length - 30) + ' more\\n';
                        }
                        return result;
                    }
                    return tree(root, '', 0, ${depth});
                })()`;
            } else {
 // HTML mode: full dump via outerHTML
                expression = `(() => {
                    const root = document.querySelector('${selector.replace(/'/g, "\\'")}');
                    if (!root) return 'Selector not found: ${selector}';
                    let html = root.outerHTML;
                    if (html.length > ${maxLength}) {
                        html = html.slice(0, ${maxLength}) + '\\n<!-- TRUNCATED at ${maxLength} chars -->';
                    }
                    return html;
                })()`;
            }

            let result;
            if (sessionId) {
                result = await this.getCdp()!.evaluateInSessionFrame(sessionId, expression);
            } else {
                result = await this.getCdp()!.evaluate(expression, 30000);
            }

 // Summary mode JSON parsing
            if (format === 'summary' && typeof result === 'string') {
                try {
                    result = JSON.parse(result);
                } catch { /* keep as string */ }
            }

            const size = typeof result === 'string' ? result.length : JSON.stringify(result).length;
            return { success: true, result, format, selector, size };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

 /**
 * CDP DOM Query — CSS Test selector
 * Check how many elements match selector and what elements they are
 * 
 * args:
 * selector: string — CSS selector
 * limit?: number — Max element count to return (default: 20)
 * content?: boolean — Whether to include text content (default: true)
 * sessionId?: string — agent webview session ID
 */
    async handleDomQuery(args: any): Promise<CommandResult> {
        if (!this.getCdp()?.isConnected) return { success: false, error: 'CDP not connected' };

        const selector = args?.selector;
        if (!selector) return { success: false, error: 'selector required' };
        const limit = args?.limit || 20;
        const content = args?.content !== false;
        const sessionId = args?.sessionId;

        const expression = `(() => {
            try {
                const els = document.querySelectorAll('${selector.replace(/'/g, "\\'")}');
                const results = [];
                for (let i = 0; i < Math.min(els.length, ${limit}); i++) {
                    const el = els[i];
                    const item = {
                        index: i,
                        tag: el.tagName?.toLowerCase(),
                        id: el.id || null,
                        class: el.className && typeof el.className === 'string' ? el.className.trim().slice(0, 200) : null,
                        role: el.getAttribute?.('role') || null,
                        'data-testid': el.getAttribute?.('data-testid') || null,
                        rect: (() => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } })(),
                        visible: el.offsetParent !== null || el.offsetWidth > 0,
                    };
                    ${content ? `item.text = (el.textContent || '').trim().slice(0, 200);` : ''}
                    ${content ? `item.value = el.value !== undefined ? String(el.value).slice(0, 200) : undefined;` : ''}
                    results.push(item);
                }
                return JSON.stringify({ total: els.length, results });
            } catch(e) {
                return JSON.stringify({ error: e.message });
            }
        })()`;

        try {
            let raw;
            if (sessionId) {
                raw = await this.getCdp()!.evaluateInSessionFrame(sessionId, expression);
            } else {
                raw = await this.getCdp()!.evaluate(expression, 15000);
            }

            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return { success: true, ...parsed, selector };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

 /**
 * CDP DOM Debug — IDE AI panel specialized analysis
 * Collect all essential info at once when supporting new IDE
 * 
 * args:
 * ideType?: string — IDE type hint
 * sessionId?: string — agent webview session ID 
 */
    async handleDomDebug(args: any): Promise<CommandResult> {
        if (!this.getCdp()?.isConnected) return { success: false, error: 'CDP not connected' };
        const sessionId = args?.sessionId;

        const expression = `(() => {
            const result = {
                url: location.href,
                title: document.title,
                viewport: { w: window.innerWidth, h: window.innerHeight },
                
 // Input field info
                inputs: [],
 // Textarea info
                textareas: [],
 // Contenteditable info
                editables: [],
 // Buttons (send, submit etc)
                buttons: [],
 // iframes (agent webviews)
                iframes: [],
 // role="textbox" info
                textboxes: [],
            };

 // Input fields
            document.querySelectorAll('input[type="text"], input:not([type])').forEach((el, i) => {
                if (i >= 10) return;
                result.inputs.push({
                    tag: 'input',
                    id: el.id || null,
                    class: (el.className || '').toString().slice(0, 150),
                    placeholder: el.getAttribute('placeholder') || null,
                    name: el.name || null,
                    value: el.value?.slice(0, 100) || null,
                    visible: el.offsetParent !== null,
                    rect: (() => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } })(),
                });
            });

 // textarea
            document.querySelectorAll('textarea').forEach((el, i) => {
                if (i >= 10) return;
                result.textareas.push({
                    id: el.id || null,
                    class: (el.className || '').toString().slice(0, 150),
                    placeholder: el.getAttribute('placeholder') || null,
                    rows: el.rows,
                    value: el.value?.slice(0, 100) || null,
                    visible: el.offsetParent !== null,
                    rect: (() => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } })(),
                });
            });

 // contenteditable
            document.querySelectorAll('[contenteditable="true"]').forEach((el, i) => {
                if (i >= 10) return;
                result.editables.push({
                    tag: el.tagName?.toLowerCase(),
                    id: el.id || null,
                    class: (el.className || '').toString().slice(0, 150),
                    role: el.getAttribute('role') || null,
                    text: (el.textContent || '').trim().slice(0, 100),
                    visible: el.offsetParent !== null,
                    rect: (() => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } })(),
                });
            });

 // role="textbox"
            document.querySelectorAll('[role="textbox"]').forEach((el, i) => {
                if (i >= 10) return;
                result.textboxes.push({
                    tag: el.tagName?.toLowerCase(),
                    id: el.id || null,
                    class: (el.className || '').toString().slice(0, 150),
                    'aria-label': el.getAttribute('aria-label') || null,
                    text: (el.textContent || '').trim().slice(0, 100),
                    visible: el.offsetParent !== null,
                    rect: (() => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } })(),
                });
            });

 // Buttons (send, submit, accept, reject, approve etc)
            const btnKeywords = /send|submit|accept|reject|approve|deny|cancel|confirm|run|execute|apply/i;
            document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach((el, i) => {
                const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
                if (i < 30 && (text.length < 30 || btnKeywords.test(text))) {
                    result.buttons.push({
                        tag: el.tagName?.toLowerCase(),
                        id: el.id || null,
                        class: (el.className || '').toString().slice(0, 150),
                        text: text.slice(0, 80),
                        'aria-label': el.getAttribute('aria-label') || null,
                        disabled: el.disabled || el.getAttribute('disabled') !== null,
                        visible: el.offsetParent !== null,
                        rect: (() => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } })(),
                    });
                }
            });

 // iframes
            document.querySelectorAll('iframe, webview').forEach((el, i) => {
                if (i >= 20) return;
                result.iframes.push({
                    tag: el.tagName?.toLowerCase(),
                    id: el.id || null,
                    class: (el.className || '').toString().slice(0, 150),
                    src: el.getAttribute('src')?.slice(0, 200) || null,
                    title: el.getAttribute('title') || null,
                    visible: el.offsetParent !== null,
                    rect: (() => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } })(),
                });
            });

            return JSON.stringify(result);
        })()`;

        try {
            let raw;
            if (sessionId) {
                raw = await this.getCdp()!.evaluateInSessionFrame(sessionId, expression);
            } else {
                raw = await this.getCdp()!.evaluate(expression, 30000);
            }

            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return { success: true, ...parsed };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }
}
