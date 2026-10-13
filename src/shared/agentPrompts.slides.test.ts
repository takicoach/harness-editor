import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_LOOP_PROMPT, EDITOR_BRIEF, SERIAL_LOOP_PROMPT, SLIDES_CLAUDE_NOTE, SLIDES_CODEX_NOTE, SLIDES_REQUEST_WORKFLOW } from './agentPrompts';

describe('スライドの手順書', () => {
  it('共通の約束は、道具・スキーマ・修復回数・operationId・画像の扱いを含む', () => {
    for (const word of ['slides_read', 'slides_validate', 'slides_apply_outline', 'slides_apply_pages', 'slides_runs', 'harness-slides-outline/1', 'harness-slides-page/1',
      '2 回まで', 'operationId', 'regenerate=true', '枠を空けたまま']) expect(SLIDES_REQUEST_WORKFLOW).toContain(word);
  });
  it('環境別: Claude の待機と Codex の待機に、それぞれの一言が入る', () => {
    expect(AGENT_LOOP_PROMPT).toContain(SLIDES_CLAUDE_NOTE);
    expect(SERIAL_LOOP_PROMPT).toContain(SLIDES_CODEX_NOTE);
    expect(SERIAL_LOOP_PROMPT).not.toContain(SLIDES_CLAUDE_NOTE);
  });
  it('接続マニュアルに同じ文言と、確認済みの環境の表がある', () => {
    const manual = readFileSync('docs/MCP接続マニュアル.md', 'utf8');
    expect(manual).toContain(SLIDES_REQUEST_WORKFLOW);
    expect(manual).toContain(EDITOR_BRIEF);
    expect(manual).toContain('### AI が読む手順（editor_guide の slides）');
    expect(manual).toContain('## 7. スライドを AI に作らせる');
    expect(manual).toContain('| 確かめたこと | Claude（AI タブ） | Codex（AI タブ） | 貼り付け |');
  });
});
