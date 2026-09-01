import { describe, expect, it } from 'vitest'
import { parseClaudeInteractiveTuiQuestion } from '../src/providers/types/interactive-prompt'

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
})
