export interface PaneSearchMatch {
  line: number;
  column: number;
  preview: string;
}

export function searchPaneText(text: string, query: string): PaneSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: PaneSearchMatch[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] || '';
    const lower = line.toLowerCase();
    let start = 0;
    while (start < lower.length) {
      const found = lower.indexOf(needle, start);
      if (found < 0) break;
      matches.push({
        line: lineIndex + 1,
        column: found + 1,
        preview: line,
      });
      start = found + Math.max(needle.length, 1);
    }
  }
  return matches;
}
