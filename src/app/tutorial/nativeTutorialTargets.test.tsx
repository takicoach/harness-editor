/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../../shared/types';
import { HomeDashboard } from '../panels/HomeDashboard';
import { saveHomeView } from '../panels/homeViewPref';
import { NativeAddBar } from '../native/NativeAddBar';
import { NativeAiBand } from '../native/NativeAiBand';
import { NativeHeader, type NativeHeaderProps } from '../native/NativeHeader';
import { NATIVE_TUTORIAL_STEPS, tutorialTarget } from './nativeTutorialSteps';

afterEach(() => { cleanup(); localStorage.clear(); });

function project(id: string): ProjectSummary {
  return {
    id, name: id, orientation: 'v', durationLabel: '1:00', sizeLabel: '1 MB', videoFile: null, status: 'telop',
    steps: { transcribe: true, cut: true, telop: 'empty', audio: false, rendered: false },
  } as ProjectSummary;
}
function home(projects: ProjectSummary[]) {
  saveHomeView('panel');
  return render(<HomeDashboard projects={projects} error={null} onPick={vi.fn()} onSetStage={vi.fn()} onCreate={vi.fn()}
    onProjectsChanged={vi.fn()} now={Date.parse('2026-09-25T00:00:00Z')} />);
}
function headerProps(): NativeHeaderProps {
  return { title: 't', saveState: 'saved', mode: 'edit', onMode: vi.fn(), canUndo: true, canRedo: false, busy: false, onUndo: vi.fn(), onRedo: vi.fn(),
    onHome: vi.fn(), onActivity: vi.fn(), onSettings: vi.fn(), settingsOpen: false, onSave: vi.fn(), saveDisabled: false,
    exportControl: <button className="btn-primary">書き出し</button>, autoSave: true, onAutoSave: vi.fn() };
}

describe('ホームの目印（旧画面と共用・既存クラスは残す）', () => {
  it('作品ありでは home・home-grid・home-view-switch・home-create が正しい要素に付く', () => {
    const view = home([project('a'), project('b')]);
    const at = (name: string) => view.container.querySelector<HTMLElement>(tutorialTarget(name));
    expect(at('home')?.classList.contains('home')).toBe(true);
    expect(at('home-grid')?.classList.contains('home-grid')).toBe(true);
    expect(at('home-view-switch')?.classList.contains('home-view-switch')).toBe(true);
    expect(at('home-create')).toBe(view.getByRole('button', { name: '＋ 動画を作成する' }));
    expect(at('home-create')?.classList.contains('home-create-btn')).toBe(true);
  });
  it('作品0件でも home と home-create がある', () => {
    const view = home([]);
    expect(view.container.querySelector(tutorialTarget('home'))).not.toBeNull();
    expect(view.container.querySelector(tutorialTarget('home-create'))).toBe(view.getByRole('button', { name: '＋ 動画を作成する' }));
  });
});

describe('編集画面の目印', () => {
  it('ヘッダー: モードの切替・AIの作業・保存（自動保存と保存ボタンの2つ）', () => {
    const view = render(<NativeHeader {...headerProps()} />);
    const modes = view.container.querySelector(tutorialTarget('modes'))!;
    expect(modes.tagName).toBe('NAV');
    expect(modes.contains(view.getByRole('button', { name: '編集' }))).toBe(true);
    expect(view.container.querySelector(tutorialTarget('ai-work'))).toBe(view.getByRole('button', { name: 'AIの作業' }));
    const save = [...view.container.querySelectorAll(tutorialTarget('save'))];
    expect(save).toHaveLength(2);
    expect(save[0]).toBe(view.getByRole('checkbox', { name: '自動保存' }).closest('label'));
    expect(save[1]).toBe(view.getByRole('button', { name: '保存' }));
  });
  it('道具列: 「＋ テロップ」のボタン1つだけに add-telop', () => {
    const view = render(<NativeAddBar disabled={false} onAddText={vi.fn()} onAddTitle={vi.fn()} onPickShape={vi.fn()} onGoMaterials={vi.fn()} />);
    const targets = view.container.querySelectorAll(tutorialTarget('add-telop'));
    expect(targets).toHaveLength(1);
    expect(targets[0]).toBe(view.getByRole('button', { name: 'T テキスト' }));
    expect(targets[0]?.getAttribute('title')).toBe('テロップ');
    expect(targets[0]?.textContent).toBe('＋ テロップ');
  });
  it('右パネル上部の「AI で編集する」に ai-panel', () => {
    const view = render(<NativeAiBand open={false} disabled={false} onOpen={vi.fn()} onBack={vi.fn()} />);
    expect(view.container.querySelector(tutorialTarget('ai-panel'))).toBe(view.getByRole('button', { name: '✦ AI で編集する' }));
  });
  it('素材パネル・タイムライン・書き出しボタン（描画が重いので原文で確かめる。見える検査は e2e）', () => {
    const workspace = readFileSync('src/app/native/NativeWorkspace.tsx', 'utf8');
    expect(workspace).toContain('id="native-panel-materials" data-tutorial="materials"');
    expect(workspace).toContain('<section className="native-timeline-panel" data-tutorial="timeline">');
    expect(readFileSync('src/app/native/NativeExportControl.tsx', 'utf8')).toContain('<button className="btn-primary" data-tutorial="export"');
  });
  it('手順表が照らす目印（「？」の help を含む）は、すべてどこかの部品に付いている', () => {
    const sources = ['src/app/panels/HomeDashboard.tsx', 'src/app/native/NativeHeader.tsx', 'src/app/native/NativeAddBar.tsx',
      'src/app/native/NativeAiBand.tsx', 'src/app/native/NativeWorkspace.tsx', 'src/app/native/NativeExportControl.tsx']
      .map((file) => readFileSync(file, 'utf8')).join('\n');
    const names = new Set<string>(['home', 'home-grid']);
    for (const step of NATIVE_TUTORIAL_STEPS) {
      if (typeof step.target === 'string') names.add(step.target.replace(/^\[data-tutorial="(.+)"\]$/, '$1'));
    }
    expect(names.has('help')).toBe(true); // 前提: 「？」の手順が検査対象に入っている
    for (const name of names) expect(sources.includes(`data-tutorial="${name}"`), name).toBe(true);
  });
});
