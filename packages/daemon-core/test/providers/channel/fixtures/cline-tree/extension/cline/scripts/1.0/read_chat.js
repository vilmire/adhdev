/**
 * Cline v1 — read_chat (v2 — Fiber based Determine role)
 *
 * structure (Cline 3.x — saoudrizwan.claude-dev):
 *   1. outer webview iframe → inner contentDocument
 *   2. data-testid="virtuoso-item-list" (React Virtuoso) — active message blocks
 *   3. React Fiber → extract message type directly from data array
 *      - type: "say", say: "user_feedback" → user
 *      - type: "say", say: "text" → assistant
 *      - type: "say", say: "checkpoint_created" → system (skip)
 *      - type: "ask", ask: "followup" → assistant (question)
 *      - type: "ask", ask: "tool" → assistant (tool approval wait)
 *   4. Extract content from DOM textContent + sanitize
 *
 * final Check: 2026-03-07
 */
(() => {
    try {
        const inner = document.querySelector('iframe');
        if (!inner) return JSON.stringify({ error: 'no inner iframe' });
        const doc = inner.contentDocument || inner.contentWindow?.document;
        if (!doc) return JSON.stringify({ error: 'cannot access contentDocument' });

        const root = doc.getElementById('root');
        if (!root) return JSON.stringify({ error: 'no root element' });

        const isVisible = root.offsetHeight > 0;

        // ─── 1. Extract data array from Fiber ───
        const virtuosoList = doc.querySelector('[data-testid="virtuoso-item-list"]');
        let fiberData = null;

        if (virtuosoList && virtuosoList.children.length > 0) {
            const firstItem = virtuosoList.children[0];
            const fiberKey = Object.keys(firstItem).find(k =>
                k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
            );
            if (fiberKey) {
                let fiber = firstItem[fiberKey];
                for (let d = 0; d < 25 && fiber; d++) {
                    const props = fiber.memoizedProps || fiber.pendingProps;
                    if (props && props.data && Array.isArray(props.data) && props.data.length > 0) {
                        fiberData = props.data;
                        break;
                    }
                    fiber = fiber.return;
                }
            }
        }

        // ─── 2. Message parsing ───
        const messages = [];

        if (fiberData) {
            // ★ Fiber based: most accurate Determine role
            for (let i = 0; i < fiberData.length; i++) {
                const item = fiberData[i];
                if (!item || typeof item !== 'object') continue;

                const msgType = item.type;  // "say" or "ask"
                const saySub = item.say;    // "user_feedback", "text", "checkpoint_created", etc.
                const askSub = item.ask;    // "followup", "tool", "command", etc.
                const text = item.text || '';

                // Skip system events
                if (saySub === 'checkpoint_created') continue;
                if (saySub === 'api_req_started' || saySub === 'api_req_finished') continue;
                if (saySub === 'shell_integration_warning') continue;

                // Determine role
                let role = 'assistant';
                if (saySub === 'user_feedback') role = 'user';
                if (saySub === 'user_feedback_diff') role = 'user';

                // Extract content
                let content = '';
                if (text) {
                    // ask.followup text may be JSON
                    if (askSub === 'followup' && text.startsWith('{')) {
                        try {
                            const parsed = JSON.parse(text);
                            content = parsed.question || parsed.text || text;
                        } catch { content = text; }
                    } else {
                        content = text;
                    }
                }

                // DOM text fallback (when Fiber text is empty)
                if (!content && virtuosoList && virtuosoList.children[i]) {
                    content = (virtuosoList.children[i].textContent || '').trim();
                }

                // Skip too short or empty content
                if (!content || content.length < 2) continue;

                // Clean noise
                content = content
                    .replace(/CheckpointCompareRestore(Save)?/gi, '')
                    .replace(/^\s*API Request.*$/gm, '')
                    .replace(/^\s*Cost:.*$/gm, '')
                    .replace(/\s{3,}/g, '\n')
                    .trim();

                if (content.length < 2) continue;

                // Preserve code blocks (extract structure from DOM)
                if (virtuosoList.children[i]) {
                    const domItem = virtuosoList.children[i];
                    const preBlocks = domItem.querySelectorAll('pre');
                    if (preBlocks.length > 0 && role === 'assistant') {
                        let structured = '';
                        const walk = (node) => {
                            if (node.nodeType === 3) {
                                structured += node.textContent;
                                return;
                            }
                            if (node.nodeType !== 1) return;
                            const el = node;
                            if (el.tagName === 'PRE') {
                                const codeEl = el.querySelector('code');
                                const lang = codeEl ? (codeEl.className.match(/language-(\w+)/)?.[1] || '') : '';
                                const BLOCK_TAGS_C = new Set(['DIV', 'P', 'BR', 'LI', 'TR']);
                                const extractCode = (n) => {
                                    if (n.nodeType === 3) return n.textContent || '';
                                    if (n.nodeType !== 1) return '';
                                    if (n.tagName === 'BR') return '\n';
                                    const ps = [];
                                    for (const c of n.childNodes) {
                                        const ib = c.nodeType === 1 && BLOCK_TAGS_C.has(c.tagName);
                                        const tx = extractCode(c);
                                        if (tx) { if (ib && ps.length > 0) ps.push('\n'); ps.push(tx); if (ib) ps.push('\n'); }
                                    }
                                    return ps.join('').replace(/\n{2,}/g, '\n');
                                };
                                const code = extractCode(codeEl || el);
                                structured += '\n```' + lang + '\n' + code.trim() + '\n```\n';
                                return;
                            }
                            for (const child of el.childNodes) walk(child);
                        };
                        walk(domItem);
                        const cleaned = structured.replace(/CheckpointCompareRestore(Save)?/gi, '').trim();
                        if (cleaned.length > content.length * 0.5) {
                            content = cleaned;
                        }
                    }
                }

                // Length limit
                if (content.length > 2000) content = content.substring(0, 2000) + '…';

                messages.push({
                    role,
                    content,
                    timestamp: item.ts || (Date.now() - (fiberData.length - i) * 1000),
                    // Debug: Message subtype
                    _type: msgType,
                    _sub: saySub || askSub,
                });
            }
        } else if (virtuosoList && virtuosoList.children.length > 0) {
            // Fallback: DOM based parsing (Fiber on access failure)
            for (let i = 0; i < virtuosoList.children.length; i++) {
                const item = virtuosoList.children[i];
                const rawText = (item.textContent || '').trim();
                if (!rawText || rawText.length < 2) continue;
                if (/^Checkpoint(Compare|Restore|Save)/i.test(rawText)) continue;
                if (/^(Thinking\.\.\.|Loading\.\.\.)$/i.test(rawText)) continue;

                let role = 'assistant';
                let content = rawText
                    .replace(/CheckpointCompareRestore(Save)?/gi, '')
                    .replace(/\s{3,}/g, '\n')
                    .trim();
                if (content.length < 2) continue;
                if (content.length > 2000) content = content.substring(0, 2000) + '…';

                messages.push({ role, content, timestamp: Date.now() - (virtuosoList.children.length - i) * 1000 });
            }
        }

        // ─── 3. Input field ───
        let inputContent = '';
        const chatInput = doc.querySelector('[data-testid="chat-input"]');
        if (chatInput) {
            inputContent = chatInput.value || chatInput.textContent || '';
        }

        // ─── 4. Status determination ───
        let status = 'idle';
        const buttons = Array.from(doc.querySelectorAll('button'))
            .filter(b => b.offsetWidth > 0);
        const buttonTexts = buttons.map(b => (b.textContent || '').trim().toLowerCase());

        if (buttonTexts.includes('cancel')) status = 'generating';

 // Fiber datafrom last type=ask Check
        if (fiberData && fiberData.length > 0) {
            const last = fiberData[fiberData.length - 1];
            if (last.type === 'ask') {
                if (last.ask === 'followup') status = 'waiting_approval';
                if (last.ask === 'tool' || last.ask === 'command') status = 'waiting_approval';
            }
        }

        // button based complement
        const approvalPatterns = /^(proceed|approve|allow|accept|save|run command|yes|confirm)/i;
        if (buttonTexts.some(b => approvalPatterns.test(b))) status = 'waiting_approval';

        if (!isVisible && messages.length === 0) status = 'panel_hidden';

        // ─── 5. model/mode ───
        let model = '';
        const modeSwitch = doc.querySelector('[data-testid="mode-switch"]');
        if (modeSwitch) model = (modeSwitch.textContent || '').trim();
        if (!model) {
            const modelSel = doc.querySelector('[data-testid*="model"], [aria-label*="model" i]');
            if (modelSel) model = (modelSel.textContent || '').trim();
        }
        const mode = modeSwitch ? (modeSwitch.textContent || '').trim() : '';

        // ─── 6. Approval modal ───
        let activeModal = null;
        if (status === 'waiting_approval') {
            const approvalBtns = buttons
                .map(b => (b.textContent || '').trim())
                .filter(t => t && t.length > 0 && t.length < 40 &&
                    /proceed|approve|allow|accept|run|yes|reject|deny|cancel|no|skip|save|confirm/i.test(t));

            let modalMessage = 'Cline wants to perform an action';
            if (fiberData && fiberData.length > 0) {
                const last = fiberData[fiberData.length - 1];
                if (last.ask === 'followup' && last.text) {
                    try {
                        const parsed = JSON.parse(last.text);
                        modalMessage = parsed.question || last.text.substring(0, 200);
                    } catch { modalMessage = last.text.substring(0, 200); }
                } else if (last.ask === 'tool' || last.ask === 'command') {
                    modalMessage = `Cline wants to use ${last.ask}`;
                }
            }

            if (approvalBtns.length > 0) {
                activeModal = { message: modalMessage, buttons: [...new Set(approvalBtns)] };
            }
        }

        // ─── 7. Token/Cost ───
        let tokenInfo = '';
        const costEl = doc.querySelector('[data-testid*="cost"], [data-testid*="token"]');
        if (costEl) tokenInfo = (costEl.textContent || '').trim();

        return JSON.stringify({
            agentType: 'cline',
            agentName: 'Cline',
            extensionId: 'saoudrizwan.claude-dev',
            status,
            isVisible,
            messages: messages.slice(-30),
            inputContent,
            model,
            mode,
            tokenInfo,
            activeModal,
        });
    } catch (e) {
        return JSON.stringify({ error: e.message || String(e) });
    }
})()
