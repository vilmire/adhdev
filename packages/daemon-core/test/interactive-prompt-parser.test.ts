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
    console.log(JSON.stringify(parsed, null, 2));
    expect(parsed?.options?.[0].label).toBe('✊ 바위');
    expect(parsed?.options?.[0].description).toBe('바위가 가위를 깨뜨립니다');
    expect(parsed?.question).toBe('✂️');
  })
})
