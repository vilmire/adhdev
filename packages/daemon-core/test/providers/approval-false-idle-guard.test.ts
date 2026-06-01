/**
 * Regression tests for the false idle / false completion guard in approval-utils.
 *
 * The observed incident: Claude Code surfaces an approval prompt ("Do you want to
 * proceed? 1. Yes  2. No") as text on the PTY screen. The PTY status parser reports
 * 'idle' because it cannot find the matching modal, and the last parsed assistant
 * message contains the approval prompt text. This causes mesh to emit
 * agent:generating_completed prematurely, setting the session to idle while Claude
 * Code is still waiting for user input.
 *
 * looksLikeActiveApprovalPromptText() guards against this case by recognising common
 * approval prompt textual patterns so completionHasFinalAssistantMessage() returns
 * false and the completion event is deferred until the real assistant turn completes.
 */

import { describe, expect, it } from 'vitest'
import { looksLikeActiveApprovalPromptText } from '../../src/providers/approval-utils.js'

describe('looksLikeActiveApprovalPromptText', () => {
    it('detects classic "Do you want to proceed?" + numbered Yes/No choices', () => {
        const text = `Do you want to proceed?\n1. Yes\n2. No, and don't do this again`
        expect(looksLikeActiveApprovalPromptText(text)).toBe(true)
    })

    it('detects approval prompt with "This command requires approval" + choices', () => {
        const text = `This command requires approval\n\n  1. Yes, run it\n  2. No`
        expect(looksLikeActiveApprovalPromptText(text)).toBe(true)
    })

    it('detects "Yes, and don\'t ask again" + "No" pattern without explicit question', () => {
        const text = `Run npm install --save-dev jest?\n\n❯ 1. Yes, and don't ask again\n  2. No`
        expect(looksLikeActiveApprovalPromptText(text)).toBe(true)
    })

    it('detects "Yes, always allow" + "No" pattern', () => {
        const text = `Allow this action?\n\n  1. Yes, always allow\n  2. No`
        expect(looksLikeActiveApprovalPromptText(text)).toBe(true)
    })

    it('detects quick safety check prompts', () => {
        const text = `Quick safety check\n\nIs this a project you trust?\n\n  1. Yes, I trust this folder\n  2. No, exit`
        expect(looksLikeActiveApprovalPromptText(text)).toBe(true)
    })

    it('detects "What do you want to do?" choice menu', () => {
        const text = `What do you want to do?\n\n  1. Continue editing\n  2. Stop and review\n  3. Abort`
        expect(looksLikeActiveApprovalPromptText(text)).toBe(true)
    })

    it('returns false for a normal completed assistant response', () => {
        const text = `I've finished implementing the feature. The changes include:\n\n- Added the new endpoint\n- Updated the tests\n- Fixed the type error`
        expect(looksLikeActiveApprovalPromptText(text)).toBe(false)
    })

    it('returns false for empty or whitespace-only input', () => {
        expect(looksLikeActiveApprovalPromptText('')).toBe(false)
        expect(looksLikeActiveApprovalPromptText('   \n  ')).toBe(false)
    })

    it('returns false for approval question without numbered choices', () => {
        const text = `Do you want to proceed? Please type yes or no.`
        expect(looksLikeActiveApprovalPromptText(text)).toBe(false)
    })

    it('returns false for content longer than 2000 chars (not a prompt)', () => {
        const longContent = 'Here is a detailed explanation. '.repeat(100)
        expect(looksLikeActiveApprovalPromptText(longContent)).toBe(false)
    })

    it('returns false for a summary that merely mentions "yes" in prose', () => {
        const text = `Yes, I completed the task. The function now handles edge cases correctly.`
        expect(looksLikeActiveApprovalPromptText(text)).toBe(false)
    })

    it('is case-insensitive for "Do you want to proceed"', () => {
        const text = `DO YOU WANT TO PROCEED?\n1. YES\n2. NO`
        expect(looksLikeActiveApprovalPromptText(text)).toBe(true)
    })
})
