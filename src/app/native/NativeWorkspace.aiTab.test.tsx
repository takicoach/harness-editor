/** @vitest-environment jsdom */
import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';

describe('AI タブから依頼・履歴を外す',()=>{
  const source=readFileSync('src/app/native/NativeWorkspace.tsx','utf8');
  it('サブナビの文言が残っていない',()=>{
    expect(source).not.toContain('依頼・履歴');
    expect(source).not.toContain('native-ai-navigation');
  });
  it('ClaudePanel を import していない',()=>{
    expect(source).not.toMatch(/import\s*\{\s*ClaudePanel\s*\}/);
  });
  it('legacy 側の ClaudePanel / AiRequestPanel は残す（挙動を変えない）',()=>{
    expect(readFileSync('src/app/App.tsx','utf8')).toContain('ClaudePanel');
    expect(readFileSync('src/app/panels/ClaudePanel.tsx','utf8')).toContain('AiRequestPanel');
  });
});
