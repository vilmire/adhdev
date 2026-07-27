/**
 * Cline v1 — new_session
 *
 * structure:
 *   1. Click "New Task" button or "+" button
 *   2. data-testid first → aria-label → text matching
 *
 * final Check: 2026-03-07
 */
(() => {
    try {
        const inner = document.querySelector('iframe');
        const doc = inner?.contentDocument || inner?.contentWindow?.document;
        if (!doc) return 'no doc';

        const buttons = Array.from(doc.querySelectorAll('button'))
            .filter(b => b.offsetWidth > 0 && b.offsetHeight > 0);

        // ─── 1step: data-testid based ───
        for (const btn of buttons) {
            const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
            if (testId.includes('new-task') || testId.includes('new-chat') || testId.includes('new_task')) {
                btn.click();
                return 'clicked (testid)';
            }
        }

        // ─── 2step: Based on aria-label ───
        for (const btn of buttons) {
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (ariaLabel.includes('new task') || ariaLabel.includes('new chat')
                || ariaLabel.includes('plus') || ariaLabel === 'new') {
                btn.click();
                return 'clicked (aria)';
            }
        }

        // ─── 3step: text matching ───
        for (const btn of buttons) {
            const text = (btn.textContent || '').trim();
            if (text === '+' || text.includes('New Task') || text.includes('New Chat')) {
                btn.click();
                return 'clicked (text)';
            }
        }

        // ─── Step 4: SVG plus icon button ───
        for (const btn of buttons) {
            const svg = btn.querySelector('svg');
            if (!svg) continue;
            const path = svg.querySelector('path');
            if (path) {
                const d = path.getAttribute('d') || '';
                // Common SVG plus icon path pattern
                if (d.includes('M12') && (d.includes('H5') || d.includes('h') || d.includes('v'))) {
                    // Icon-only button with no other button text
                    const text = (btn.textContent || '').trim();
                    if (text.length < 3) {
                        btn.click();
                        return 'clicked (svg)';
                    }
                }
            }
        }

        // ─── Step 5: Welcome screen detect (already New session) ───
        const bodyText = (doc.body.textContent || '').toLowerCase();
        if (bodyText.includes('what can i do for you') || bodyText.includes('start a new task') || bodyText.includes('type your task')) {
            return 'clicked (already new)';
        }

        // ─── Step 6: History view detect → return to welcome by clicking Done ───
        if (bodyText.includes('history') && bodyText.includes('done')) {
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim();
                if (text === 'Done') {
                    btn.click();
                    return 'clicked (history done)';
                }
            }
        }

        return 'no button found';
    } catch (e) { return 'error: ' + e.message; }
})()
