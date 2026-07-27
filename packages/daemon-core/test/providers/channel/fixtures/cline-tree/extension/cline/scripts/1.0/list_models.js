/**
 * Cline — list_models
 * Available from dropdown Model list + current Select return model
 * → { models: string[], current: string }
 */
(async () => {
    try {
        const inner = document.querySelector('iframe');
        const doc = inner?.contentDocument || inner?.contentWindow?.document;
        if (!doc) return JSON.stringify({ models: [], current: '', error: 'no doc' });

        // Current model: read from mode-switch or model selector
        let current = '';
        const modeSwitch = doc.querySelector('[data-testid="mode-switch"]');
        if (modeSwitch) current = (modeSwitch.textContent || '').trim();
        if (!current) {
            const modelSel = doc.querySelector('[data-testid*="model"], [aria-label*="model" i]');
            if (modelSel) current = (modelSel.textContent || '').trim();
        }

        // Dropdown trigger search
        const trigger = doc.querySelector('[data-testid="model-selector"], [data-testid*="model-dropdown"], [data-testid="dropdown-trigger"]');
        if (!trigger) return JSON.stringify({ models: [], current, error: 'no model trigger' });

        // Open dropdown
        trigger.click();
        await new Promise(r => setTimeout(r, 300));

        // collect options
        const options = doc.querySelectorAll('[data-testid*="dropdown-option"], [role="option"], [class*="dropdown"] [class*="item"], [class*="listbox"] [class*="option"]');
        const models = [];
        for (const opt of options) {
            const text = (opt.textContent || '').trim();
            if (text && text.length > 1 && text.length < 100) models.push(text);
        }

        // close
        doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        if (trigger.click) trigger.click(); // fallback close

        return JSON.stringify({ models: [...new Set(models)], current });
    } catch (e) { return JSON.stringify({ models: [], current: '', error: e.message }); }
})()
