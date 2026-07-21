/**
 * LanguageSelector — Custom accessible language switcher popover.
 *
 * A 🌐 trigger button opens a custom listbox popover of the supported
 * languages (native labels: English / 한국어 / 日本語 / 中文(简体) / Español).
 * The previously-used transparent native <select> overlay is gone — it produced
 * the OS-native dropdown; this renders an in-app popover instead while keeping
 * native-<select>-level accessibility.
 *
 * Selecting an option calls useLanguage().setLanguage, which drives
 * i18next.changeLanguage, updates <html lang>, persists to localStorage('lang'),
 * and broadcasts the sync events — that behaviour is unchanged.
 *
 * Accessibility: the trigger exposes aria-haspopup="listbox"/aria-expanded; the
 * popover is role="listbox" with role="option"/aria-selected items and
 * aria-activedescendant tracking. Keyboard: ↑/↓ move the active option, Home/End
 * jump, Enter/Space select, Esc closes and restores focus to the trigger. A
 * pointer-down outside closes the popover; focus returns to the trigger on close.
 *
 * `variant` switches only the trigger's outer look — "sidebar" (default) matches
 * ThemeToggle's nav-item, "landing" is a compact pill for the landing header.
 * The popover markup/behaviour is identical across variants.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { useLanguage } from '../i18n/useLanguage'
import { LANGUAGE_OPTIONS, type SupportedLanguage } from '../i18n/languages'
import { computeLanguageMenuPosition, type LangMenuStyle } from './languageMenuPosition'
import { IconGlobe, IconCheck } from './Icons'

type LanguageSelectorVariant = 'sidebar' | 'landing'

interface LanguageSelectorProps {
    /** Icon-only trigger (sidebar collapsed). Ignored for the landing variant. */
    collapsed?: boolean
    /** Trigger appearance only — the popover is identical across variants. */
    variant?: LanguageSelectorVariant
}

function Caret({ open }: { open: boolean }) {
    return (
        <svg
            width={12}
            height={12}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`lang-switch-caret${open ? ' open' : ''}`}
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    )
}

export default function LanguageSelector({ collapsed, variant = 'sidebar' }: LanguageSelectorProps) {
    const { language, setLanguage } = useLanguage()
    const { t } = useTranslation('common')

    const [open, setOpen] = useState(false)
    // Which option the keyboard is currently on (drives aria-activedescendant).
    const [activeIndex, setActiveIndex] = useState(0)

    const rootRef = useRef<HTMLDivElement>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const listRef = useRef<HTMLUListElement>(null)
    const baseId = useId()

    // The menu is portaled to <body> and positioned `fixed`, so it escapes the
    // sidebar's `overflow`/`contain` clipping (which is what hid it when the
    // sidebar was collapsed to 56px). Position is computed from the trigger rect.
    const [menuStyle, setMenuStyle] = useState<LangMenuStyle | null>(null)

    const updatePosition = useCallback(() => {
        const trigger = triggerRef.current
        if (!trigger) return
        const rect = trigger.getBoundingClientRect()
        const list = listRef.current
        // Fall back to sensible natural dimensions before the list has laid out.
        const menuWidth = Math.max(list?.offsetWidth ?? 0, 168)
        const menuHeight = list?.scrollHeight ?? LANGUAGE_OPTIONS.length * 36 + 12
        setMenuStyle(
            computeLanguageMenuPosition({
                trigger: {
                    top: rect.top,
                    left: rect.left,
                    right: rect.right,
                    bottom: rect.bottom,
                    width: rect.width,
                    height: rect.height,
                },
                viewport: { width: window.innerWidth, height: window.innerHeight },
                menu: { width: menuWidth, height: menuHeight },
                variant,
            }),
        )
    }, [variant])

    const currentIndex = Math.max(
        0,
        LANGUAGE_OPTIONS.findIndex((option) => option.code === language),
    )
    const current = LANGUAGE_OPTIONS[currentIndex] ?? LANGUAGE_OPTIONS[0]

    const label = t('language.label', { defaultValue: 'Language' })
    const selectLabel = t('language.select', { defaultValue: 'Select language' })

    const optionId = (index: number) => `${baseId}-opt-${index}`

    const openMenu = useCallback(() => {
        setActiveIndex(currentIndex)
        setOpen(true)
    }, [currentIndex])

    const closeMenu = useCallback((restoreFocus = true) => {
        setOpen(false)
        if (restoreFocus) triggerRef.current?.focus()
    }, [])

    const choose = useCallback(
        (index: number) => {
            const option = LANGUAGE_OPTIONS[index]
            if (option) setLanguage(option.code as SupportedLanguage)
            closeMenu()
        },
        [setLanguage, closeMenu],
    )

    // Close on outside pointer-down / focus leaving the widget. The menu is
    // portaled outside `rootRef`, so "inside" means either the trigger's root or
    // the portaled listbox.
    useEffect(() => {
        if (!open) return
        const isInside = (node: Node | null) =>
            !!(rootRef.current?.contains(node) || listRef.current?.contains(node))
        const onPointerDown = (event: PointerEvent) => {
            if (!isInside(event.target as Node)) setOpen(false)
        }
        const onFocusIn = (event: FocusEvent) => {
            if (!isInside(event.target as Node)) setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('focusin', onFocusIn, true)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('focusin', onFocusIn, true)
        }
    }, [open])

    // Compute the fixed position when opening, and keep it anchored while the
    // page scrolls or resizes (the trigger rect can move under a fixed menu).
    useLayoutEffect(() => {
        if (!open) {
            setMenuStyle(null)
            return
        }
        updatePosition()
        const onReflow = () => updatePosition()
        window.addEventListener('resize', onReflow)
        // capture:true so we also react to scrolls in nested containers.
        window.addEventListener('scroll', onReflow, true)
        return () => {
            window.removeEventListener('resize', onReflow)
            window.removeEventListener('scroll', onReflow, true)
        }
    }, [open, updatePosition])

    // Move DOM focus to the listbox once it opens AND has been positioned. The
    // menu renders `visibility: hidden` until `menuStyle` is computed (so it never
    // flashes at 0,0); a hidden element can't take focus, so gate on menuStyle —
    // otherwise the keyboard handlers (arrows/Enter/Escape) never receive events.
    useEffect(() => {
        if (open && menuStyle) listRef.current?.focus()
    }, [open, menuStyle])

    const onListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
        const last = LANGUAGE_OPTIONS.length - 1
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault()
                setActiveIndex((i) => (i >= last ? 0 : i + 1))
                break
            case 'ArrowUp':
                event.preventDefault()
                setActiveIndex((i) => (i <= 0 ? last : i - 1))
                break
            case 'Home':
                event.preventDefault()
                setActiveIndex(0)
                break
            case 'End':
                event.preventDefault()
                setActiveIndex(last)
                break
            case 'Enter':
            case ' ':
                event.preventDefault()
                choose(activeIndex)
                break
            case 'Escape':
                event.preventDefault()
                closeMenu()
                break
            case 'Tab':
                setOpen(false)
                break
            default:
                break
        }
    }

    const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (open) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openMenu()
        }
    }

    const triggerClass =
        variant === 'landing'
            ? 'lang-switch-trigger lang-switch-trigger--landing'
            : `lang-switch-trigger lang-switch-trigger--sidebar nav-item cursor-pointer${collapsed ? ' justify-center py-2.5 px-0' : ''}`

    const showLabel = variant === 'landing' || !collapsed

    return (
        <div ref={rootRef} className="lang-switch">
            <button
                ref={triggerRef}
                type="button"
                className={triggerClass}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={`${label}: ${current.label}`}
                title={`${label}: ${current.label}`}
                onClick={() => (open ? closeMenu(false) : openMenu())}
                onKeyDown={onTriggerKeyDown}
            >
                <span className="nav-icon lang-switch-icon"><IconGlobe size={16} /></span>
                {showLabel && <span className="lang-switch-label text-xs">{current.label}</span>}
                {showLabel && <Caret open={open} />}
            </button>

            {open && typeof document !== 'undefined' &&
                createPortal(
                    <ul
                        ref={listRef}
                        role="listbox"
                        tabIndex={-1}
                        aria-label={selectLabel}
                        aria-activedescendant={optionId(activeIndex)}
                        className={`lang-switch-menu lang-switch-menu--${variant}`}
                        style={{
                            position: 'fixed',
                            top: menuStyle?.top ?? 0,
                            left: menuStyle?.left ?? 0,
                            maxHeight: menuStyle?.maxHeight,
                            overflowY: 'auto',
                            // Hidden until positioned so it never flashes at 0,0.
                            visibility: menuStyle ? 'visible' : 'hidden',
                        }}
                        onKeyDown={onListKeyDown}
                    >
                        {LANGUAGE_OPTIONS.map((option, index) => {
                            const selected = option.code === current.code
                            const active = index === activeIndex
                            return (
                                <li
                                    key={option.code}
                                    id={optionId(index)}
                                    role="option"
                                    aria-selected={selected}
                                    className={`lang-switch-option${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
                                    onMouseEnter={() => setActiveIndex(index)}
                                    onClick={() => choose(index)}
                                >
                                    <span className="lang-switch-check" aria-hidden="true">
                                        {selected ? <IconCheck size={14} /> : null}
                                    </span>
                                    <span className="lang-switch-option-label">{option.label}</span>
                                </li>
                            )
                        })}
                    </ul>,
                    document.body,
                )}
        </div>
    )
}
