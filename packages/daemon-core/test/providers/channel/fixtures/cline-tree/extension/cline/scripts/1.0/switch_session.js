/**
 * Cline v1 — switch_session (Fiber hooks → showTaskWithId gRPC)
 *
 * strategy:
 * 1. Find taskHistory, showHistoryView in Fiber DFS
 * 2. Done by clicking history close → showHistoryView() → reopen
 * 3. Virtuoso Render wait (max 5 secs, retry every 500ms + scroll/resize )
 * 4. Rendered item Fiber hooksfrom showTaskWithId callback extract
 * 5. showTaskWithId(taskId) call → Switch Task via gRPC
 *
 * Parameter: ${ SESSION_ID } — task ID (number string) or title
 * final Check: 2026-03-07
 */
(async () => {
    try {
        const inner = document.querySelector('iframe');
        const doc = inner?.contentDocument || inner?.contentWindow?.document;
        if (!doc) return false;

        const sessionId = ${ SESSION_ID };
        if (!sessionId) return false;

        const findFiberKey = (el) => Object.keys(el).find(k =>
            k.startsWith('__reactFiber') || k.startsWith('__reactProps') || k.startsWith('__reactContainer'));
        const getFiber = (el) => {
            const fk = findFiberKey(el);
            if (!fk) return null;
            let fiber = el[fk];
            if (fk.startsWith('__reactContainer') && fiber?._internalRoot?.current)
                fiber = fiber._internalRoot.current;
            return fiber;
        };

        // ─── 1. Find taskHistory, showHistoryView in Fiber DFS ───
        const root = doc.getElementById('root');
        if (!root) return false;
        const rootFk = findFiberKey(root);
        if (!rootFk) return false;
        let rootFiber = root[rootFk];
        if (rootFk.startsWith('__reactContainer') && rootFiber?._internalRoot?.current)
            rootFiber = rootFiber._internalRoot.current;

        let showHistoryView = null;
        let taskHistory = null;
        const visited = new Set();
        const scanFiber = (f, depth) => {
            if (!f || depth > 60 || visited.has(f)) return;
            visited.add(f);
            const props = f.memoizedProps || f.pendingProps;
            if (props) {
                if (typeof props.showHistoryView === 'function' && !showHistoryView)
                    showHistoryView = props.showHistoryView;
                if (props.taskHistory && Array.isArray(props.taskHistory) && !taskHistory)
                    taskHistory = props.taskHistory;
            }
            if (!taskHistory && f.memoizedState) {
                let st = f.memoizedState;
                while (st) {
                    try {
                        const ms = st.memoizedState;
                        if (ms?.taskHistory && Array.isArray(ms.taskHistory)) {
                            taskHistory = ms.taskHistory;
                            break;
                        }
                    } catch { }
                    st = st.next;
                }
            }
            if (f.child) scanFiber(f.child, depth + 1);
            if (f.sibling) scanFiber(f.sibling, depth + 1);
        };
        scanFiber(rootFiber, 0);

        if (!taskHistory || taskHistory.length === 0) return false;

        // target task search (ID or title matching)
        const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const idNorm = norm(sessionId);
        let targetTask = taskHistory.find(t => String(t.id) === sessionId);
        if (!targetTask) {
            targetTask = taskHistory.find(t => {
                const title = norm(t.task || '');
                return title.includes(idNorm) || idNorm.includes(title);
            });
        }
        if (!targetTask) return false;
        const targetId = String(targetTask.id);

 // ─── 2. showHistoryView Fiber root DFS retry ───
        if (!showHistoryView) {
            // DOM element-based search (when not found from Fiber root)
            for (const el of doc.querySelectorAll('*')) {
                let fiber = getFiber(el);
                for (let d = 0; d < 20 && fiber; d++) {
                    const p = fiber.memoizedProps;
                    if (p && typeof p.showHistoryView === 'function') {
                        showHistoryView = p.showHistoryView;
                        break;
                    }
                    fiber = fiber.return;
                }
                if (showHistoryView) break;
            }
        }
        if (!showHistoryView) return false;

 // ─── 3. history toggle (close → open) ───
        // Done via button close
        const doneBtn = Array.from(doc.querySelectorAll('button'))
            .find(b => b.textContent.trim() === 'Done' && b.offsetHeight > 0);
        if (doneBtn) {
            doneBtn.click();
            await new Promise(r => setTimeout(r, 400));
        }

        // history open
        showHistoryView();

        // ─── 4. Virtuoso Render wait (max 5 secs, retry every 500ms) ───
        let il = null;
        for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise(r => setTimeout(r, 500));
            // Trigger scroll + resize
            const sd = doc.querySelector('.overflow-y-scroll, [data-testid=virtuoso-scroller]');
            if (sd) {
                sd.dispatchEvent(new Event('scroll', { bubbles: true }));
                doc.defaultView?.dispatchEvent(new Event('resize'));
            }
            il = doc.querySelector('[data-testid=virtuoso-item-list]');
            if (il && il.children.length > 0) break;
        }

        if (!il || il.children.length === 0) return false;

        // ─── 5. Fiber hooksfrom showTaskWithId extract ───
        let showTaskFn = null;
        const findFiberKeySimple = (el) => Object.keys(el).find(k => k.startsWith('__reactFiber'));

        for (const child of il.children) {
            // Search in child or all elements inside child
            const targets = [child, ...child.querySelectorAll('*')];
            for (const el of targets) {
                const fk = findFiberKeySimple(el);
                if (!fk) continue;
                let fiber = el[fk];
                for (let d = 0; d < 30 && fiber; d++) {
                    if (fiber.memoizedState) {
                        let hook = fiber.memoizedState;
                        let hookIdx = 0;
                        while (hook && hookIdx < 30) {
                            const ms = hook.memoizedState;
                            if (Array.isArray(ms) && ms.length === 2 && typeof ms[0] === 'function') {
                                const fnSrc = ms[0].toString();
                                if (fnSrc.includes('showTaskWithId')) {
                                    showTaskFn = ms[0];
                                    break;
                                }
                            }
                            hook = hook.next;
                            hookIdx++;
                        }
                    }
                    if (showTaskFn) break;
                    fiber = fiber.return;
                }
                if (showTaskFn) break;
            }
            if (showTaskFn) break;
        }

        // Fallback: Fiber DFS all search
        if (!showTaskFn) {
            const visited2 = new Set();
            const dfs2 = (f, depth) => {
                if (!f || depth > 60 || visited2.has(f) || showTaskFn) return;
                visited2.add(f);
                if (f.memoizedState) {
                    let h = f.memoizedState; let i = 0;
                    while (h && i < 30) {
                        const ms = h.memoizedState;
                        if (Array.isArray(ms) && ms.length === 2 && typeof ms[0] === 'function' &&
                            ms[0].toString().includes('showTaskWithId')) {
                            showTaskFn = ms[0]; return;
                        }
                        h = h.next; i++;
                    }
                }
                if (f.child) dfs2(f.child, depth + 1);
                if (f.sibling) dfs2(f.sibling, depth + 1);
            };
            dfs2(rootFiber, 0);
        }

        if (!showTaskFn) return false;

        // ─── 6. showTaskWithId(targetId) call ───
        try {
            await showTaskFn(targetId);
        } catch {
            return false;
        }

        await new Promise(r => setTimeout(r, 1500));
        return true;
    } catch { return false; }
})()
