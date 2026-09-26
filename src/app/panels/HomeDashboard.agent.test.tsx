/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../../shared/types';
import { HomeDashboard, editorProjectHref, editorProjectReviewHref } from './HomeDashboard';

const project = { id: 'video/a', name: '動画A', dir: '/tmp/video-a', orientation: 'v', durationLabel: '1:00',
  sizeLabel: '1 MB', videoFile: null, status: 'cut', activityLabel: '既存の制作作業' } as ProjectSummary;
const noop = () => {}; const noopAsync = async () => {};
afterEach(() => { cleanup(); localStorage.clear(); });

function renderBoard(status: 'ready' | 'error' = 'ready') {
  const onPick = vi.fn();
  render(<HomeDashboard projects={[project]} error={null} onPick={onPick} onSetStage={noop} onCreate={noopAsync}
    onProjectsChanged={noop} now={Date.parse('2026-09-07T00:00:00Z')}
    agentBoard={{ status, error: status === 'error' ? 'offline' : null,
      items: { [project.id]: { projectId: project.id, editor: { connected: true, ready: true, dirty: true, failed: false },
        operation: { phase: 'cancelled', updatedAt: 1, applied: true, saved: false, reconciled: false }, humanReview: 'pending' } } }} />);
  return onPick;
}

describe('Homeカードの案件別AI状態', () => {
  it('既存制作状態とは別に停止・未保存・編集接続を表示する', () => {
    renderBoard(); const card = screen.getByTestId('project-card-video/a');
    expect(card.textContent).toContain('既存の制作作業');
    expect(screen.getByTestId('home-card-agent').textContent).toContain('AI作業停止このAI作業の保存は未確認');
    expect(screen.getByTestId('home-card-agent').textContent).toContain('編集画面編集画面に接続中・未保存の変更あり');
    expect(screen.getByTestId('home-card-agent').textContent).toContain('人の確認未確認');
  });

  it('最新取得失敗時は渡された旧成功itemを表示しない', () => {
    renderBoard('error');
    expect(screen.getByTestId('home-card-agent').textContent).toContain('AI作業確認できません');
    expect(screen.getByTestId('home-card-agent').textContent).not.toContain('停止');
  });

  it('取得成功pageに現在のカードが無い場合も「履歴なし」と確定しない', () => {
    render(<HomeDashboard projects={[project]} error={null} onPick={vi.fn()} onSetStage={noop} onCreate={noopAsync}
      onProjectsChanged={noop} agentBoard={{ status: 'ready', error: null, items: {} }} />);
    expect(screen.getByTestId('home-card-agent').textContent).toContain('AI作業確認できません');
    expect(screen.getByTestId('home-card-agent').textContent).not.toContain('まだありません');
  });

  it('Object prototypeと同名の案件IDをboard itemとして扱わない', () => {
    render(<HomeDashboard projects={[{ ...project, id: 'constructor' }]} error={null} onPick={vi.fn()}
      onSetStage={noop} onCreate={noopAsync} onProjectsChanged={noop}
      agentBoard={{ status: 'loading', error: null, items: {} }} />);
    expect(screen.getByTestId('home-card-agent').textContent).toContain('確認中');
  });

  it('別タブlinkは実URLと安全属性を持ち、click・Enter・Spaceを親カードへ渡さない', () => {
    const onPick = renderBoard(); const link = screen.getByRole('link', { name: '別タブで開く' });
    expect(link.getAttribute('href')).toContain('?project=video%2Fa');
    expect(link.getAttribute('target')).toBe('_blank'); expect(link.getAttribute('rel')).toBe('noopener');
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link); fireEvent.keyDown(link, { key: 'Enter' }); fireEvent.keyDown(link, { key: ' ' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('未確認の変更は既存queryを保った専用の確認linkから別タブで開ける', () => {
    const onPick = renderBoard();
    const link = screen.getByRole('link', { name: '変更を確認' });
    expect(link.getAttribute('href')).toContain('project=video%2Fa');
    expect(link.getAttribute('href')).toContain('agentActivity=review');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link); fireEvent.keyDown(link, { key: 'Enter' }); fireEvent.keyDown(link, { key: ' ' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('カード本体の通常clickは従来どおり同じタブで開く', () => {
    const onPick = renderBoard();
    fireEvent.click(screen.getByTestId('project-card-video/a'));
    expect(onPick).toHaveBeenCalledWith('video/a');
  });

  it('現在URLの他queryを保ってprojectだけを設定する', () => {
    expect(editorProjectHref('a/b', 'http://localhost/base?theme=dark#old')).toBe('/base?theme=dark&project=a%2Fb');
    expect(editorProjectReviewHref('a/b', 'http://localhost/base?theme=dark#old'))
      .toBe('/base?theme=dark&project=a%2Fb&agentActivity=review');
  });
});
