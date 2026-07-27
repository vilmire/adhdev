/**
 * Cline — list_modes
 * Available Mode list from mode selector + Return current mode
 * → { modes: string[], current: string }
 */
(async () => {
    try {
        const inner = document.querySelector('iframe');
        const doc = inner?.contentDocument || inner?.contentWindow?.document;
        if (!doc) return JSON.stringify({ modes: [], current: '', error: 'no doc' });

        // Current mode
        const trigger = doc.querySelector('[data-testid="mode-selector-trigger"], [data-testid="mode-switch"]');
        if (!trigger) return JSON.stringify({ modes: [], current: '', error: 'no mode trigger' });
        const current = (trigger.textContent || '').trim();

        // Open dropdown
        trigger.click();
        await new Promise(r => setTimeout(r, 300));

        // collect options
        const options = doc.querySelectorAll('[data-testid*="mode-option"], [role="option"], [class*="dropdown"] [class*="item"], [class*="listbox"] [class*="option"]');
        const modes = [];
        for (const opt of options) {
            const text = (opt.textContent || '').trim();
            if (text && text.length > 1 && text.length < 50) modes.push(text);
        }

        // close
        doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        if (trigger.click) trigger.click(); // fallback close

        return JSON.stringify({ modes: [...new Set(modes)], current });
    } catch (e) { return JSON.stringify({ modes: [], current: '', error: e.message }); }
})()
