import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  showsSubtitlePanel,
  loadLayout,
  saveLayout,
  loadWorkspaceMode,
  saveWorkspaceMode,
  workspaceModeDefaults,
  workspaceModeLayout,
  type LayoutPreset,
  loadPanelLayout,
  savePanelLayout,
} from './layoutPreset';
import type { EditState } from '../edit/editState';

function mk(selection: EditState['selection'], telops: Array<{ id: number; manual?: boolean }> = []): EditState {
  return { selection, telops } as unknown as EditState;
}
const subtitleSel = mk({ kind: 'telop', id: 1 }, [{ id: 1, manual: false }]);
const bgmSel = mk({ kind: 'bgm', id: 1 });

describe('showsSubtitlePanel', () => {
  it('subtitle モード＋字幕選択は true', () => expect(showsSubtitlePanel(subtitleSel, 'subtitle', 'transcript')).toBe(true));
  it('subtitle モード＋BGM は false', () => expect(showsSubtitlePanel(bgmSel, 'subtitle', 'transcript')).toBe(false));
  it('subtitle モード＋未選択は false', () => expect(showsSubtitlePanel(mk(null), 'subtitle', 'transcript')).toBe(false));
  it('standard モードは字幕でも false', () => expect(showsSubtitlePanel(subtitleSel, 'standard', 'transcript')).toBe(false));
  it('tall-dock モードは字幕でも false', () => expect(showsSubtitlePanel(subtitleSel, 'tall-dock', 'transcript')).toBe(false));
  it('waveform モードは字幕でも false', () => expect(showsSubtitlePanel(subtitleSel, 'waveform', 'transcript')).toBe(false));
  // G-4（ビジュアル検品）実測: 字幕モードで設定タブを開くと、右ドックの設定と subpanel に
  // **同じ設定フォームが 2 つ**出て、id（ins-telop-manual / ins-start / ins-pos-x など）が
  // 文書内で重複していた（label の for が先頭の要素だけを指す＝もう一方が操作不能）。
  it('subtitle モードでも設定タブなら false（設定フォームの二重表示・id 重複を防ぐ）', () =>
    expect(showsSubtitlePanel(subtitleSel, 'subtitle', 'settings')).toBe(false));
  it('subtitle モード＋AI タブは true（設定は出ていないので併置してよい）', () =>
    expect(showsSubtitlePanel(subtitleSel, 'subtitle', 'ai')).toBe(true));
});

describe('load/saveLayout', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });
  it('既定は standard', () => expect(loadLayout()).toBe('standard'));
  it('不正値は standard', () => { saveLayout('xxx' as LayoutPreset); expect(loadLayout()).toBe('standard'); });
  it('保存往復', () => { saveLayout('tall-dock'); expect(loadLayout()).toBe('tall-dock'); saveLayout('subtitle'); expect(loadLayout()).toBe('subtitle'); saveLayout('waveform'); expect(loadLayout()).toBe('waveform'); });
  it('タブ別の配置は旧プリセットと他タブを上書きせず保持する', () => {
    saveLayout('subtitle');
    expect(loadPanelLayout('edit')).toBe('standard');
    expect(loadPanelLayout('finish')).toBe('tall-dock');
    savePanelLayout('edit','tall-dock');
    savePanelLayout('finish','standard');
    expect(loadPanelLayout('edit')).toBe('tall-dock');
    expect(loadPanelLayout('finish')).toBe('standard');
    expect(loadLayout()).toBe('subtitle');
  });
  it('不正値と保存先が使えない環境では各タブの既定へ戻る', () => {
    localStorage.setItem('sme-panel-layout-finish','invalid');
    expect(loadPanelLayout('finish')).toBe('tall-dock');
    vi.stubGlobal('localStorage',{getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('denied');}});
    expect(loadPanelLayout('edit')).toBe('standard');
    expect(()=>savePanelLayout('edit','tall-dock')).not.toThrow();
  });
  it('旧4プリセットと主モードは別の保存値として共存する', () => {
    saveLayout('waveform');
    saveWorkspaceMode('finish');
    expect(loadLayout()).toBe('waveform');
    expect(loadWorkspaceMode()).toBe('finish');
  });
});

describe('workspace mode', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });

  it('初回は確認で、文字起こしと全体表示を主役にする', () => {
    expect(loadWorkspaceMode()).toBe('review');
    expect(workspaceModeDefaults('review')).toEqual({ dock: 'transcript', timeline: 'overview' });
  });

  it('仕上げは設定と詳細タイムラインを主役にする', () => {
    expect(workspaceModeDefaults('finish')).toEqual({ dock: 'settings', timeline: 'detail' });
  });

  it('編集は再読込で復元でき、通常タイムラインを開く', () => {
    saveWorkspaceMode('edit');
    expect(loadWorkspaceMode()).toBe('edit');
    expect(workspaceModeDefaults(loadWorkspaceMode())).toEqual({ dock: 'settings', timeline: 'cut' });
  });

  it('編集と仕上げで作業領域を切り替え、詳細レイアウトの保存値も維持できる', () => {
    expect(workspaceModeLayout('edit')).toBe('waveform');
    expect(workspaceModeLayout('finish')).toBe('tall-dock');
    saveLayout(workspaceModeLayout('edit'));
    expect(loadLayout()).toBe('waveform');
    saveLayout('waveform');
    expect(loadLayout()).toBe('waveform');
    expect(workspaceModeLayout('review')).toBe('standard');
  });
});
