/**
 * Cline v1 — resolve_action
 *
 * Cline Approve/Reject handle.
 * Clineis uses vscode-button web component besides button tag.
 * chatState.primaryButtonText / secondaryButtonText Exact matching.
 *
 * Parameter: ${ ACTION } — "approve" or "reject"
 *
 * strategy:
 *   1. chatState.primaryButtonText == Approve → click primary vscode-button
 *   2. Search based on data-testid
 *   3. text matching (button + vscode-button)
 *   4. Pass approval directly via Fiber onSendMessage
 *
 * final Check: 2026-03-07
 */
(() => {
    try {
        const inner = document.querySelector('iframe');
        const doc = inner?.contentDocument || inner?.contentWindow?.document;
        if (!doc) return false;

        const action = ${ ACTION };
        const approvePatterns = ['proceed', 'approve', 'allow', 'accept', 'save', 'run', 'yes', 'confirm', 'resume'];
        const rejectPatterns = ['reject', 'deny', 'cancel', 'no', 'skip'];
        const patterns = action === 'approve' ? approvePatterns : rejectPatterns;

        // ─── Collect all clickable elements (button + vscode-button) ───
        const allBtns = [
            ...Array.from(doc.querySelectorAll('button')),
            ...Array.from(doc.querySelectorAll('vscode-button')),
        ].filter(b => b.offsetWidth > 0 && b.offsetHeight > 0);

        // ─── 1step: data-testid based ───
        for (const btn of allBtns) {
            const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
            if (action === 'approve' && (testId.includes('approve') || testId.includes('proceed') || testId.includes('accept') || testId.includes('run') || testId.includes('primary'))) {
                btn.click(); return true;
            }
            if (action === 'reject' && (testId.includes('reject') || testId.includes('deny') || testId.includes('cancel') || testId.includes('secondary'))) {
                btn.click(); return true;
            }
        }

        // ─── 2step: text matching ───
        for (const btn of allBtns) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text.length === 0 || text.length > 40) continue;
            if (patterns.some(p => text.startsWith(p) || text === p || text.includes(p))) {
                btn.click(); return true;
            }
        }

        // ─── 3step: aria-label ───
        for (const btn of allBtns) {
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (patterns.some(p => label.includes(p))) {
                btn.click(); return true;
            }
        }

        // ─── Step 4: chatState based — primary/secondary button Direct matching ───
        // chatState.primaryButtonText = "Approve", secondaryButtonText = "Reject"
        // Largest vscode-button is primary button
        const vscBtns = Array.from(doc.querySelectorAll('vscode-button'))
            .filter(b => b.offsetWidth > 100);  // Large buttons only
        if (vscBtns.length > 0) {
            if (action === 'approve') {
                // Largest button is primary
                vscBtns.sort((a, b) => b.offsetWidth - a.offsetWidth);
                vscBtns[0].click(); return true;
            }
            // reject: Smallest large button
            if (action === 'reject' && vscBtns.length > 1) {
                vscBtns.sort((a, b) => a.offsetWidth - b.offsetWidth);
                vscBtns[0].click(); return true;
            }
        }

        return false;
    } catch { return false; }
})()
