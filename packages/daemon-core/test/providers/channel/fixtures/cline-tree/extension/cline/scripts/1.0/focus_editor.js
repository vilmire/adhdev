/**
 * Cline v1 — focus_editor
 *
 * Cline webview iframe focus on input field inside.
 * send_message Call before send_message or use for dashboard Focus button.
 *
 * final Check: 2026-03-07
 */
(() => {
    try {
        const inner = document.querySelector('iframe');
        const doc = inner?.contentDocument || inner?.contentWindow?.document;
        if (!doc) return 'no doc';

        // data-testid first → fallback
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
        if (!target) {
            // contenteditable fallback
            const editables = doc.querySelectorAll('[contenteditable="true"]');
            for (const el of editables) {
                if (el.offsetParent !== null && el.offsetHeight > 10) {
                    target = el;
                    break;
                }
            }
        }
        if (!target) return 'no input';

        target.focus();
        // Move cursor to end
        if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
            const len = (target.value || '').length;
            target.setSelectionRange(len, len);
        }
        return 'focused';
    } catch (e) {
        return 'error: ' + e.message;
    }
})()
