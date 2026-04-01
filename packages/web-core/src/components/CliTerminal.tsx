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

export const CliTerminal = forwardRef<CliTerminalHandle, CliTerminalProps>(
    ({ onInput, onResize, fontSize = 13, readOnly = false }, ref) => {
        const innerRef = useRef<CliTerminalHandle>(null);
        const [LoadedTerminal, setLoadedTerminal] = useState<TerminalViewComponent | null>(null);

        useImperativeHandle(ref, () => ({
            write: (data: string) => innerRef.current?.write(data),
            clear: () => innerRef.current?.clear(),
            fit: () => innerRef.current?.fit(),
            bumpResize: () => innerRef.current?.bumpResize(),
        }), []);

        useEffect(() => {
            let cancelled = false;
            void import('@adhdev/terminal-render-web')
                .then((mod) => {
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
