/**
 * Cline v1 — list_chats (Fiber + DOM dual access)
 *
 * 1st: extract taskHistory array from React Fiber
 *      Search all of __reactFiber, __reactProps, __reactContainer
 * 2nd: Virtuoso DOM parsing
 *
 * Return: JSON string — [{id, title, status, time, cost, tokensIn, tokensOut, modelId}]
 *
 * final Check: 2026-03-07
 */
(() => {
    try {
        const inner = document.querySelector('iframe');
        const doc = inner?.contentDocument || inner?.contentWindow?.document;
        if (!doc) return JSON.stringify({ error: 'no_doc', panel: 'hidden' });

        // Fiber key search helper — search all __reactFiber, __reactProps, __reactContainer
        const findFiberKey = (el) => Object.keys(el).find(k =>
            k.startsWith('__reactFiber') || k.startsWith('__reactProps') || k.startsWith('__reactContainer'));

        const getFiber = (el) => {
            const fk = findFiberKey(el);
            if (!fk) return null;
            let fiber = el[fk];
            // If __reactContainer, access inner fiber tree root
            if (fk.startsWith('__reactContainer') && fiber?._internalRoot?.current) {
                fiber = fiber._internalRoot.current;
            }
            return fiber;
        };

        // ─── 1st: search taskHistory from Fiber props ───
        const allEls = doc.querySelectorAll('*');
        let taskHistory = null;

        for (const el of allEls) {
            let fiber = getFiber(el);
            if (!fiber) continue;

            for (let d = 0; d < 30 && fiber; d++) {
                const props = fiber.memoizedProps || fiber.pendingProps;
                if (props && props.taskHistory && Array.isArray(props.taskHistory)) {
                    taskHistory = props.taskHistory;
                    break;
                }
                // Also search in memoizedState chain
                if (fiber.memoizedState) {
                    let st = fiber.memoizedState;
                    while (st) {
                        try {
                            const ms = st.memoizedState;
                            if (ms && typeof ms === 'object' && !Array.isArray(ms)) {
                                if (ms.taskHistory && Array.isArray(ms.taskHistory)) {
                                    taskHistory = ms.taskHistory;
                                    break;
                                }
                            }
                        } catch { }
                        st = st.next;
                    }
                }
                if (taskHistory) break;
                fiber = fiber.return;
            }
            if (taskHistory) break;
        }

        if (taskHistory && taskHistory.length > 0) {
            const results = taskHistory.slice(0, 50).map((task, i) => ({
                id: task.id || String(task.ts),
                title: (task.task || '').substring(0, 120),
                status: i === 0 ? 'current' : '',
                time: task.ts ? new Date(task.ts).toISOString() : '',
                cost: task.totalCost ? `$${task.totalCost.toFixed(4)}` : '',
                tokensIn: task.tokensIn || 0,
                tokensOut: task.tokensOut || 0,
                modelId: task.modelId || '',
                size: task.size || 0,
                isFavorited: !!task.isFavorited,
            }));
            return JSON.stringify(results);
        }

        // ─── 2nd: Virtuoso DOM parsing ───
        const items = doc.querySelectorAll('[data-item-index]');
        if (items.length > 0) {
            const results = Array.from(items).slice(0, 50).map(el => ({
                id: el.getAttribute('data-item-index') || '',
                title: (el.textContent || '').trim().substring(0, 120),
                status: '',
            }));
            return JSON.stringify(results);
        }

        return JSON.stringify([]);
    } catch (e) {
        return JSON.stringify({ error: e.message || String(e) });
    }
})()
