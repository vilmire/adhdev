/**
 * Cline v1 — open_panel
 *
 * Check panel status and attempt to open.
 *
 * VS Code API access is limited from iframe context,
 * When panel is hidden 'panel_hidden' Return status.
 * → daemon AgentStreamManager or
 *   agent_stream_focus must be opened via message.
 *
 * Return: 'visible' | 'panel_hidden'
 * final Check: 2026-03-07
 */
(() => {
    try {
        const inner = document.querySelector('iframe');
        const doc = inner?.contentDocument || inner?.contentWindow?.document;
        if (!doc) return 'panel_hidden';

        const root = doc.getElementById('root');
        if (root && root.offsetHeight > 0) return 'visible';

        return 'panel_hidden';
    } catch (e) { return 'error: ' + e.message; }
})()
