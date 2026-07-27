/**
 * Cline v1 — send_message
 *
 * structure:
 *   1. outer webview → access inner iframe contentDocument
 *   2. Set value on data-testid="chat-input" textarea (React controlled)
 *   3. React Fiberfrom Find onSend function and call directly (most reliable)
 *   4. Fallback: data-testid="send-button" click or Enter key
 *
 * ⚠️ Cline send-button is a DIV tag, and React normal click event
 *    Does not handle sending. Must call Fiber onSend() directly for correct behavior.
 *
 * final Check: 2026-03-07
 */
(async () => {
    try {
        const inner = document.querySelector('iframe');
        const doc = inner?.contentDocument || inner?.contentWindow?.document;
        if (!doc) return 'error: no doc';

        // ─── 1. Find input field ───
        let target = doc.querySelector('[data-testid="chat-input"]');
        if (!target) {
            const textareas = doc.querySelectorAll('textarea');
            for (const ta of textareas) {
                if (ta.offsetParent !== null && ta.offsetHeight > 20) {
                    target = ta;
                    break;
                }
            }
        }
        if (!target) return 'error: no chat-input';

        // ─── 2. Set React controlled input value ───
        const proto = inner.contentWindow?.HTMLTextAreaElement?.prototype
            || HTMLTextAreaElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

        if (nativeSetter) {
            nativeSetter.call(target, ${ MESSAGE });
        } else {
            target.value = ${ MESSAGE };
        }

        // Trigger React event
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));

        // Wait for React setState to reflect
        await new Promise(r => setTimeout(r, 300));

        // ─── 3. Fiber onSend Call directly (first) ───
        const allEls = doc.querySelectorAll('*');
        for (const el of allEls) {
            const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'));
            if (!fk) continue;
            let fiber = el[fk];
            for (let d = 0; d < 15 && fiber; d++) {
                const props = fiber.memoizedProps || fiber.pendingProps;
                if (props && typeof props.onSend === 'function') {
                    props.onSend();
                    return 'sent';
                }
                fiber = fiber.return;
            }
        }

        // ─── 4. Fallback: send-button click ───
        const sendBtn = doc.querySelector('[data-testid="send-button"]');
        if (sendBtn) {
            try {
                const rect = sendBtn.getBoundingClientRect();
                const opts = {
                    bubbles: true, cancelable: true, view: inner.contentWindow,
                    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
                };
                sendBtn.dispatchEvent(new MouseEvent('mousedown', opts));
                sendBtn.dispatchEvent(new MouseEvent('mouseup', opts));
                sendBtn.dispatchEvent(new MouseEvent('click', opts));
                return 'sent';
            } catch (e) { }
        }

        // ─── 5. Final Fallback: Enter key ───
        target.focus();
        target.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13,
            bubbles: true, cancelable: true,
        }));

        return 'sent';
    } catch (e) {
        return 'error: ' + e.message;
    }
})()
