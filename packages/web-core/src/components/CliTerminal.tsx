/**
 * CliTerminal — browser terminal wrapper used by dashboard/machine views.
 *
 * Renderer is ghostty-web via @adhdev/terminal-render-web.
 */
import {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
    type ForwardRefExoticComponent,
    type RefAttributes,
} from 'react';
import type {
    GhosttyTerminalViewProps,
    TerminalRendererHandle as CliTerminalHandle,
} from '@adhdev/terminal-render-web';

export type { CliTerminalHandle };

type CliTerminalProps = GhosttyTerminalViewProps;
type TerminalViewComponent = ForwardRefExoticComponent<GhosttyTerminalViewProps & RefAttributes<CliTerminalHandle>>;
let rendererLoadLogged = false;

export const CliTerminal = forwardRef<CliTerminalHandle, CliTerminalProps>(
    ({ onInput, onResize, fontSize = 13, readOnly = false }, ref) => {
        const innerRef = useRef<CliTerminalHandle>(null);
        const [LoadedTerminal, setLoadedTerminal] = useState<TerminalViewComponent | null>(null);
        const pendingWritesRef = useRef<string[]>([]);
        const pendingClearRef = useRef(false);
        const pendingFitRef = useRef(false);
        const pendingBumpResizeRef = useRef(false);

        const flushPending = () => {
            const terminal = innerRef.current;
            if (!terminal) return;

            if (pendingClearRef.current) {
                terminal.clear();
                pendingClearRef.current = false;
            }

            for (const chunk of pendingWritesRef.current) terminal.write(chunk);
            pendingWritesRef.current = [];

            if (pendingFitRef.current) {
                terminal.fit();
                pendingFitRef.current = false;
            }

            if (pendingBumpResizeRef.current) {
                terminal.bumpResize();
                pendingBumpResizeRef.current = false;
            }
        };

        useImperativeHandle(ref, () => ({
            write: (data: string) => {
                if (innerRef.current) innerRef.current.write(data);
                else pendingWritesRef.current.push(data);
            },
            clear: () => {
                if (innerRef.current) innerRef.current.clear();
                else {
                    pendingWritesRef.current = [];
                    pendingClearRef.current = true;
                }
            },
            reset: () => {
                if (innerRef.current && 'reset' in innerRef.current && typeof (innerRef.current as any).reset === 'function') {
                    (innerRef.current as any).reset();
                } else {
                    pendingWritesRef.current = [];
                    pendingClearRef.current = true;
                }
            },
            resize: (cols: number, rows: number) => {
                if (innerRef.current && 'resize' in innerRef.current && typeof (innerRef.current as any).resize === 'function') {
                    (innerRef.current as any).resize(cols, rows);
                }
            },
            fit: () => {
                if (innerRef.current) innerRef.current.fit();
                else pendingFitRef.current = true;
            },
            bumpResize: () => {
                if (innerRef.current) innerRef.current.bumpResize();
                else pendingBumpResizeRef.current = true;
            },
        }), []);

        useEffect(() => {
            if (!LoadedTerminal) return;
            const frame = requestAnimationFrame(() => {
                flushPending();
            });
            return () => cancelAnimationFrame(frame);
        }, [LoadedTerminal]);

        useEffect(() => {
            let cancelled = false;
            void import('@adhdev/terminal-render-web')
                .then((mod) => {
                    if (!rendererLoadLogged) {
                        rendererLoadLogged = true;
                        console.info('[CliTerminal] renderer module loaded: ghostty-web');
                    }
                    if (!cancelled) setLoadedTerminal(() => mod.GhosttyTerminalView as TerminalViewComponent);
                })
                .catch((error) => {
                    console.error('[CliTerminal] failed to load terminal renderer', error);
                });
            return () => {
                cancelled = true;
            };
        }, []);

        if (!LoadedTerminal) {
            return (
                <div
                    className="w-full h-full rounded-lg overflow-hidden animate-pulse"
                    style={{ background: '#0f1117' }}
                />
            );
        }

        return (
            <LoadedTerminal
                ref={innerRef}
                onInput={onInput}
                onResize={onResize}
                fontSize={fontSize}
                readOnly={readOnly}
                className="w-full h-full rounded-lg overflow-hidden"
            />
        );
    }
);

CliTerminal.displayName = 'CliTerminal';
