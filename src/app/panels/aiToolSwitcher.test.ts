import { describe, it, expect } from 'vitest';
import { shouldShowToolSwitcher, usableTools, pickInitialTool, type ToolInfo } from './aiToolSwitcher';

const t = (id: 'claude' | 'codex', over: Partial<ToolInfo> = {}): ToolInfo => ({
  id, label: id === 'claude' ? 'Claude' : 'Codex',
  installed: true, versionOk: true, installable: id === 'claude', ...over,
});

describe('shouldShowToolSwitcher', () => {
  it('使える物が1つなら出さない（利用者の画面を変えない）', () => {
    expect(shouldShowToolSwitcher([t('claude'), t('codex', { installed: false })])).toBe(false);
    expect(shouldShowToolSwitcher([t('claude')])).toBe(false);
  });

  it('使える物が2つなら出す', () => {
    expect(shouldShowToolSwitcher([t('claude'), t('codex')])).toBe(true);
  });

  it('版が古いツールは数に入れない', () => {
    expect(shouldShowToolSwitcher([t('claude'), t('codex', { versionOk: false })])).toBe(false);
  });

  it('1つも使えなければ出さない', () => {
    expect(shouldShowToolSwitcher([t('claude', { installed: false }), t('codex', { installed: false })])).toBe(false);
  });
});

describe('usableTools', () => {
  it('導入済みかつ版 OK のものだけ返す', () => {
    const list = usableTools([t('claude'), t('codex', { versionOk: false })]);
    expect(list.map((x) => x.id)).toEqual(['claude']);
  });
});

describe('pickInitialTool', () => {
  it('保存値が使えるならそれを選ぶ', () => {
    expect(pickInitialTool([t('claude'), t('codex')], 'codex')).toBe('codex');
  });

  it('保存値が未導入なら使える先頭へ落とす', () => {
    expect(pickInitialTool([t('claude'), t('codex', { installed: false })], 'codex')).toBe('claude');
  });

  it('保存値が版不足なら使える先頭へ落とす', () => {
    expect(pickInitialTool([t('claude'), t('codex', { versionOk: false })], 'codex')).toBe('claude');
  });

  it('保存値が不正な文字列でも落ちない', () => {
    for (const bad of ['gemini', '', 'CLAUDE', '{}', null]) {
      expect(pickInitialTool([t('claude'), t('codex')], bad)).toBe('claude');
    }
  });

  it('使える物が無ければ null', () => {
    expect(pickInitialTool([t('claude', { installed: false })], 'claude')).toBeNull();
  });
});
