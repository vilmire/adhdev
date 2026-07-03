/**
 * chatScrollHelpers — pure scroll-decision helpers, types, and constants for
 * ChatMessageList.
 *
 * Extracted verbatim from ChatMessageList.tsx (survey C9 3/3). These are the pure
 * functions that decide when to auto-scroll / restore a snapshot / show the jump
 * buttons — no React, no side effects. The stateful effects that call them stay in
 * ChatMessageList.tsx (and are pinned there by a source-string test). Every symbol
 * here is re-exported from ChatMessageList.tsx so existing import paths resolve.
 */

import { buildChatMessageSignature } from '@adhdev/daemon-core/chat/chat-signatures';
import type { ChatMessage } from '../../types';

export type ChatScrollSnapshot = {
    top: number;
    fromBottom: number;
    messageFingerprint?: string;
}

export type ChatContentAutoScrollOptions = {
    hasSelection: boolean;
    userScrolledUp: boolean;
    /** True only when the transcript fingerprint changed; status/typing-only updates must not pull history to bottom. */
    hasChatContentChanged?: boolean;
    isNewMessage?: boolean;
    isNearBottomAfterUpdate?: boolean;
}

export type ChatResizeAutoScrollOptions = {
    hasSelection: boolean;
    userScrolledUp: boolean;
    contextAutoScrollActive: boolean;
}

export type ChatScrollJumpButtonState = {
    showTop: boolean;
    showBottom: boolean;
}

export type ChatScrollJumpButtonOptions = {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    topThresholdPx?: number;
    bottomThresholdPx?: number;
}

export const CHAT_SCROLL_NEAR_BOTTOM_PX = 200;
export const CHAT_SCROLL_TOP_JUMP_THRESHOLD_PX = 80;
export const CHAT_BOTTOM_AUTO_SCROLL_WINDOW_MS = 650;
export const chatScrollSnapshotCache = new Map<string, ChatScrollSnapshot>();

export function shouldRestoreChatScrollSnapshot(
    snapshot: ChatScrollSnapshot | null | undefined,
    currentMessageFingerprint: string,
): boolean {
    if (!snapshot) return false;
    const savedFingerprint = String(snapshot.messageFingerprint || '');
    if (!savedFingerprint) return true;
    return savedFingerprint === String(currentMessageFingerprint || '');
}

export function buildChatScrollFingerprint(messages: ChatMessage[], lastMessageHash?: string): string {
    if (!Array.isArray(messages) || messages.length === 0) return '0:empty';
    const providedHash = String(lastMessageHash || '').trim();
    if (providedHash) return `${messages.length}:${providedHash}`;
    const lastMessage = messages[messages.length - 1];
    return `${messages.length}:${buildChatMessageSignature(lastMessage)}`;
}

export function shouldAutoScrollOnChatVisibilityChange(
    previousIsVisible: boolean,
    nextIsVisible: boolean,
): boolean {
    void previousIsVisible;
    void nextIsVisible;
    // Dockview tab/focus/split/floating changes should preserve the user's current
    // read position. Explicit navigation intents still use scrollToBottomRequestNonce.
    return false;
}

export function shouldRestoreChatScrollOnVisibilityChange(
    previousIsVisible: boolean,
    nextIsVisible: boolean,
    snapshot: ChatScrollSnapshot | null | undefined,
    currentMessageFingerprint: string,
): boolean {
    if (previousIsVisible || !nextIsVisible) return false;
    return shouldRestoreChatScrollSnapshot(snapshot, currentMessageFingerprint);
}

export function getChatScrollJumpButtonState({
    scrollTop,
    scrollHeight,
    clientHeight,
    topThresholdPx = CHAT_SCROLL_TOP_JUMP_THRESHOLD_PX,
    bottomThresholdPx = CHAT_SCROLL_NEAR_BOTTOM_PX,
}: ChatScrollJumpButtonOptions): ChatScrollJumpButtonState {
    const safeScrollTop = Math.max(0, Number(scrollTop) || 0);
    const safeScrollHeight = Math.max(0, Number(scrollHeight) || 0);
    const safeClientHeight = Math.max(0, Number(clientHeight) || 0);
    const maxScrollTop = Math.max(0, safeScrollHeight - safeClientHeight);
    if (maxScrollTop <= 0) return { showTop: false, showBottom: false };
    return {
        showTop: safeScrollTop > topThresholdPx,
        showBottom: Math.max(0, safeScrollHeight - safeScrollTop - safeClientHeight) > bottomThresholdPx,
    };
}

export function getChatScrollJumpButtonStateForElement(el: HTMLElement): ChatScrollJumpButtonState {
    return getChatScrollJumpButtonState({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
    });
}

export function isChatScrollSnapshotScrolledUp(
    snapshot: ChatScrollSnapshot | null | undefined,
    thresholdPx = CHAT_SCROLL_NEAR_BOTTOM_PX,
): boolean {
    return !!snapshot && snapshot.fromBottom >= thresholdPx;
}

export function shouldOpenBottomAutoScrollWindowOnInitialChatMount(
    snapshot: ChatScrollSnapshot | null | undefined,
    currentMessageFingerprint: string,
): boolean {
    if (!shouldRestoreChatScrollSnapshot(snapshot, currentMessageFingerprint)) return true;
    return !isChatScrollSnapshotScrolledUp(snapshot);
}

export function shouldAutoScrollAfterChatContentChange({
    hasSelection,
    userScrolledUp,
    hasChatContentChanged = true,
}: ChatContentAutoScrollOptions): boolean {
    if (hasSelection) return false;
    if (userScrolledUp) return false;
    if (!hasChatContentChanged) return false;
    // If the view is in bottom-follow mode, keep following for both appended messages
    // and same-message streaming growth. Reading "near bottom" after the DOM update
    // can already be false when a tall chunk or a wrapped split-pane layout was added.
    return true;
}

export function shouldAutoScrollOnChatResize({
    hasSelection,
    userScrolledUp,
    contextAutoScrollActive,
}: ChatResizeAutoScrollOptions): boolean {
    if (hasSelection) return false;
    return contextAutoScrollActive || !userScrolledUp;
}

export function restoreChatScrollSnapshot(el: HTMLDivElement, snapshot: ChatScrollSnapshot): void {
    const nextTop = Math.max(0, el.scrollHeight - el.clientHeight - snapshot.fromBottom);
    el.scrollTop = Number.isFinite(nextTop) ? nextTop : snapshot.top;
}
