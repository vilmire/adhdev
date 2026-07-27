/**
 * Cline — set_model
 * from Select specified model
 * ${MODEL} → JSON.stringify(modelName)
 * → { success: boolean }
 */
(async () => {
    try {
        const inner = document.querySelector('iframe');
        const doc = inner?.contentDocument || inner?.contentWindow?.document;
        if (!doc) return JSON.stringify({ success: false, error: 'no doc' });

        const target = ${MODEL};
        const trigger = doc.querySelector('[data-testid="model-selector"], [data-testid*="model-dropdown"], [data-testid="dropdown-trigger"]');
        if (!trigger) return JSON.stringify({ success: false, error: 'no model trigger' });

        // Open dropdown
        trigger.click();
        await new Promise(r => setTimeout(r, 300));

        // Search target model from options
        const options = doc.querySelectorAll('[data-testid*="dropdown-option"], [role="option"], [class*="dropdown"] [class*="item"], [class*="listbox"] [class*="option"]');
        for (const opt of options) {
            const text = (opt.textContent || '').trim();
            if (text === target || text.includes(target)) {
                opt.click();
                await new Promise(r => setTimeout(r, 200));
                return JSON.stringify({ success: true, model: text });
            }
        }

        // close
        doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return JSON.stringify({ success: false, error: 'model not found: ' + target });
    } catch (e) { return JSON.stringify({ success: false, error: e.message }); }
})()
