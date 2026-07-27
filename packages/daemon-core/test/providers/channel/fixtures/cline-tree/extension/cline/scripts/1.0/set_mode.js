/**
 * Cline — set_mode
 * mode selectorfrom Select specified mode
 * ${MODE} → JSON.stringify(modeName)
 * → { success: boolean }
 */
(async () => {
    try {
        const inner = document.querySelector('iframe');
        const doc = inner?.contentDocument || inner?.contentWindow?.document;
        if (!doc) return JSON.stringify({ success: false, error: 'no doc' });

        const target = ${MODE};
        const trigger = doc.querySelector('[data-testid="mode-selector-trigger"], [data-testid="mode-switch"]');
        if (!trigger) return JSON.stringify({ success: false, error: 'no mode trigger' });

        // Open dropdown
        trigger.click();
        await new Promise(r => setTimeout(r, 300));

        // Search target mode from options
        const options = doc.querySelectorAll('[data-testid*="mode-option"], [role="option"], [class*="dropdown"] [class*="item"], [class*="listbox"] [class*="option"]');
        for (const opt of options) {
            const text = (opt.textContent || '').trim();
            if (text === target || text.toLowerCase().includes(target.toLowerCase())) {
                opt.click();
                await new Promise(r => setTimeout(r, 200));
                return JSON.stringify({ success: true, mode: text });
            }
        }

        // close
        doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return JSON.stringify({ success: false, error: 'mode not found: ' + target });
    } catch (e) { return JSON.stringify({ success: false, error: e.message }); }
})()
