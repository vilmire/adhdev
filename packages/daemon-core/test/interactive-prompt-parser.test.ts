import { describe, expect, it } from 'vitest'
import { parseClaudeInteractiveTuiQuestion, readFocusedClaudeTuiQuestion } from '../src/providers/types/interactive-prompt'
import { claudeTuiQuestionMatches } from '../src/providers/spec/claude-tui-helpers'

describe('parseClaudeInteractiveTuiQuestion', () => {
  it('parses side panel without leaking', () => {
    const screenText = `
✔ Submit
✂️                   │ ✊ vs ✂️
❯ 1. ✊ 바위           │ 바위가 가위를 깨뜨림
  바위가 가위를 깨뜨립니다 │
  2. ✋ 보             │ → 오너 승 🏆
  가위가 보를 자릅니다     │
  3. ✂️ 가위           │
  둘 다 가위             │
Enter to select
`;
    const parsed = parseClaudeInteractiveTuiQuestion({ screenText, header: '' }, 0);
    expect(parsed?.options?.[0].label).toBe('✊ 바위');
    expect(parsed?.options?.[0].description).toBe('바위가 가위를 깨뜨립니다');
    expect(parsed?.question).toBe('✂️');
  })

  it('reassembles wrapped Korean and emoji question text and option labels', () => {
    const question = '★rc.58 라이브 검증입니다. ★이 모달이 ★제대로 보이나요? (✂️ 이모지·라벨·설명이 섞이지 않았는지) 그리고 터미널 폭을 넘긴 뒤에도 질문 전체가 그대로 보이는지 확인합니다.'
    const wrappedOption = '⚠️ 렌더링은 OK, 모달이 안 닫힘 — 한글과 이모지 🚨가 섞인 아주 긴 옵션 라벨도 터미널 줄바꿈 뒤 하나의 라벨로 복원되어야 합니다'
    expect(question.length).toBeGreaterThan(80)
    expect(wrappedOption.length).toBeGreaterThan(60)

    // Headerless reproduction: the terminal has already wrapped the logical
    // strings into physical rows. A right-hand preview panel is present too,
    // reproducing the two rc.58 symptoms without copying parser logic here.
    const screenText = [
      '★rc.58 라이브 검증입니다. ★이 모달이 ★제대로 보이나요? │ 선택 미리보기',
      '  (✂️ 이모지·라벨·설명이 섞이지 않았는지) 그리고 터미널 폭을 │ 질문/선택 상세',
      '  넘긴 뒤에도 질문 전체가 그대로 보이는지 확인합니다.            │',
      '',
      '❯ 1. ✅ 렌더링과 모달 제출이 모두 정상입니다                     │ 정상 경로 ✅',
      '  2. ⚠️ 렌더링은 OK, 모달이 안 닫힘 — 한글과 이모지 🚨가 │ 실패 경로 ⚠️',
      '     섞인 아주 긴 옵션 라벨도 터미널 줄바꿈 뒤 하나의 라벨로 │',
      '     복원되어야 합니다                                            │',
      '  3. ❌ 렌더링부터 실패합니다                                     │ 렌더 실패',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n')

    const parsed = parseClaudeInteractiveTuiQuestion({ screenText, header: '' }, 0)

    expect(parsed?.question).toBe(question)
    expect(parsed?.options[1].label).toBe(wrappedOption)
  })

  // PERMANENT mesh_answer_question FAILURE ON WRAPPED QUESTIONS (live defect,
  // 2026-09-18, Jupiter / claude-cli, session 10717dca).
  //
  // A question too wide for the TUI wraps onto a second physical row, and
  // claude draws that continuation flush-left starting with a bare box
  // border glyph (│), with NO leading whitespace before it. The pre-existing
  // "right-side preview panel" strip in readClaudeTuiScreenLines only matches
  // a │/┃ preceded by whitespace (see its comment — it is deliberately a
  // RIGHT-side-divider heuristic), so this flush-left border survived
  // unstripped straight into the reconstructed question text:
  //
  //   expected "…쓸 수 없다. 어떻게 진행할까?"
  //   focused  "│ …쓸 수 없다. │ 어떻게 진행할까?"
  //
  // Every retry re-read the same live screen and rebuilt the same garbled
  // string, so the mismatch was permanent — mesh_answer_question could never
  // succeed on this prompt by label OR by index, and the only recovery was
  // cancelling the task.
  it('★REGRESSION (live defect 2026-09-18): a flush-left wrapped question parses without box-border artifacts', () => {
    const screenText = [
      '←  ✔ Submit  →',
      '',
      '│ adhdev-mesh MCP 서버가 이 세션에서 미승인 상태라 mesh_* 도구를 쓸 수 없다.',
      '│ 어떻게 진행할까?',
      '',
      '❯ 1. 계속 진행',
      '  2. 중단',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n')

    const parsed = parseClaudeInteractiveTuiQuestion({ screenText, header: '' }, 0)

    expect(parsed?.question).toBe(
      'adhdev-mesh MCP 서버가 이 세션에서 미승인 상태라 mesh_* 도구를 쓸 수 없다. 어떻게 진행할까?',
    )
    // No leaked box-drawing glyph anywhere in the reconstructed text.
    expect(parsed?.question).not.toMatch(/[│┃]/)
  })

  it('★REGRESSION: readFocusedClaudeTuiQuestion (the live assert-path reader) also strips the flush-left border', () => {
    const screenText = [
      '←  ✔ Submit  →',
      '',
      '│ adhdev-mesh MCP 서버가 이 세션에서 미승인 상태라 mesh_* 도구를 쓸 수 없다.',
      '│ 어떻게 진행할까?',
      '',
      '❯ 1. 계속 진행',
      '  2. 중단',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n')

    const focused = readFocusedClaudeTuiQuestion(screenText)

    expect(focused?.question).toBe(
      'adhdev-mesh MCP 서버가 이 세션에서 미승인 상태라 mesh_* 도구를 쓸 수 없다. 어떻게 진행할까?',
    )

    // The actual failure mode: the ORIGINALLY CAPTURED prompt (now parsed
    // clean, same fix applied on the capture path) must match what a live
    // re-read of the identical screen produces. Before the fix both sides
    // independently produced the SAME garbled string with the SAME bug, so
    // this always accidentally matched — but the real defect was that this
    // was compared against a freshly re-read screen that raced repaint
    // timing and briefly showed intermediate content, permanently failing.
    // The fix's job here is narrower and mechanical: verify the parser used
    // by BOTH capture and the live assert no longer emits box-drawing noise.
    const expectedQuestion = {
      question: 'adhdev-mesh MCP 서버가 이 세션에서 미승인 상태라 mesh_* 도구를 쓸 수 없다. 어떻게 진행할까?',
      multiSelect: false,
      options: [{ label: '계속 진행' }, { label: '중단' }],
    }
    expect(claudeTuiQuestionMatches(expectedQuestion as any, focused as any)).toBe(true)
  })

  it('regression guard: short, unwrapped questions still parse unchanged', () => {
    const screenText = [
      '←  ✔ Submit  →',
      '',
      'Continue with the deploy?',
      '',
      '❯ 1. Yes',
      '  2. No',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n')

    const parsed = parseClaudeInteractiveTuiQuestion({ screenText, header: '' }, 0)
    expect(parsed?.question).toBe('Continue with the deploy?')
  })

  it('safety guard: an unrelated foreign question is still rejected as a mismatch', () => {
    const screenText = [
      '←  ✔ Submit  →',
      '',
      '│ adhdev-mesh MCP 서버가 이 세션에서 미승인 상태라 mesh_* 도구를 쓸 수 없다.',
      '│ 어떻게 진행할까?',
      '',
      '❯ 1. 계속 진행',
      '  2. 중단',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n')
    const focused = readFocusedClaudeTuiQuestion(screenText)

    const foreignQuestion = {
      question: 'Which branch should we cut from?',
      multiSelect: false,
      options: [{ label: 'main' }, { label: 'develop' }],
    }
    expect(claudeTuiQuestionMatches(foreignQuestion as any, focused as any)).toBe(false)
  })
})
