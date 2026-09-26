import { describe, it, expect } from 'vitest';
import { usableTools, pickInitialTool, toolButtonState, toolButtonHint, type ToolInfo } from './aiToolSwitcher';

const t = (id: 'claude' | 'codex', over: Partial<ToolInfo> = {}): ToolInfo => ({
  id, label: id === 'claude' ? 'Claude' : 'Codex',
  installed: true, versionOk: true, installable: id === 'claude',
  path: id === 'claude' ? '/Users/x/.local/bin/claude' : '/opt/homebrew/bin/codex',
  source: 'path', status: 'ready', ...over,
});

describe('toolButtonState', () => {
  it('起動できるものは ready', () => {
    expect(toolButtonState(t('claude'))).toBe('ready');
  });
  it('版が古ければ outdated', () => {
    expect(toolButtonState(t('codex', { versionOk: false, status: 'outdated' }))).toBe('outdated');
  });
  it('未導入で自動導入できるものは installable', () => {
    expect(toolButtonState(t('claude', { installed: false, path: null, source: null, status: 'missing' }))).toBe('installable');
  });
  it('未導入で自動導入できないものは manual', () => {
    expect(toolButtonState(t('codex', { installed: false, path: null, source: null, status: 'missing' }))).toBe('manual');
  });
  it('検出に失敗したものは unverified（未導入と区別する）', () => {
    expect(toolButtonState(t('claude', { installed: false, path: null, source: null, status: 'unverified' }))).toBe('unverified');
  });
});

describe('toolButtonHint', () => {
  it('起動できるときは見つかった場所を出す', () => {
    expect(toolButtonHint(t('claude'))).toBe('見つかった場所: /Users/x/.local/bin/claude');
  });
  it('検出失敗は再確認をうながす', () => {
    expect(toolButtonHint(t('claude', { installed: false, path: null, source: null, status: 'unverified' }))).toBe('見つかりません（再確認）');
  });
  it('自動導入できないものは手順リンクの案内', () => {
    expect(toolButtonHint(t('codex', { installed: false, path: null, source: null, status: 'missing' }))).toBe('未導入です。導入手順を見る');
  });
  it('版が古いときは場所と一緒に出す', () => {
    expect(toolButtonHint(t('codex', { versionOk: false, status: 'outdated' }))).toBe('版が古いです（/opt/homebrew/bin/codex）');
  });
});

describe('usableTools / pickInitialTool', () => {
  it('usableTools は導入済みかつ版 OK だけ', () => {
    expect(usableTools([t('claude'), t('codex', { versionOk: false })]).map(x => x.id)).toEqual(['claude']);
  });
  it('保存値が使えなければ使える先頭へ落とす', () => {
    expect(pickInitialTool([t('claude'), t('codex', { installed: false })], 'codex')).toBe('claude');
  });
  it('1 つも使えなければ null', () => {
    expect(pickInitialTool([t('claude', { installed: false }), t('codex', { installed: false })], 'claude')).toBeNull();
  });
  it('不正な保存値でも落ちない', () => {
    for (const bad of ['gemini', '', 'CLAUDE', '{}', null]) expect(pickInitialTool([t('claude'), t('codex')], bad)).toBe('claude');
  });
});

describe('shouldShowToolSwitcher は撤廃された', () => {
  it('export されていない（常に 2 ボタンを出すため）', async () => {
    const module = await import('./aiToolSwitcher');
    expect('shouldShowToolSwitcher' in module).toBe(false);
  });
});
