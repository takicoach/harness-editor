/**
 * @vitest-environment jsdom
 */
/**
 * status-ia-1: 一覧の取得中に「まだプロジェクトがありません」という嘘の空状態を出さない。
 * 取得中は読込中表示、取得後に 0 件なら空状態、という順序を pin する。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { HomeDashboard } from './HomeDashboard';

afterEach(cleanup);

const noop = () => {};
const noopAsync = async () => {};

function renderHome(props: { projects?: never[]; loading?: boolean }) {
  return render(
    <HomeDashboard
      projects={props.projects ?? []}
      error={null}
      loading={props.loading ?? false}
      onPick={noop}
      onSetStage={noop}
      onCreate={noopAsync}
      onProjectsChanged={noop}
    />,
  );
}

describe('HomeDashboard — 一覧の取得中表示（status-ia-1）', () => {
  it('loading 中は空状態ではなく読込中を出す', () => {
    const { queryByTestId, container } = renderHome({ loading: true });
    expect(queryByTestId('home-loading')).not.toBeNull();
    expect(container.textContent).not.toContain('まだプロジェクトがありません');
  });

  it('取得後に 0 件なら空状態を出す', () => {
    const { queryByTestId, container } = renderHome({ loading: false });
    expect(queryByTestId('home-loading')).toBeNull();
    expect(container.textContent).toContain('まだプロジェクトがありません');
  });

  it('取得失敗の表示は読込中より優先される（error が来たら読込中で固まらない）', () => {
    const { container, queryByTestId } = render(
      <HomeDashboard
        projects={[]}
        error="boom"
        loading
        onPick={noop}
        onSetStage={noop}
        onCreate={noopAsync}
        onProjectsChanged={noop}
      />,
    );
    expect(queryByTestId('home-loading')).toBeNull();
    expect(container.textContent).toContain('プロジェクト一覧を取得できませんでした');
  });
});

describe('HomeDashboard — 工程ドットの 3 値（status-ia-10）', () => {
  function withSteps(steps: Record<string, unknown>) {
    return [
      {
        id: 'p1',
        name: 'p1',
        dir: '/root/p1',
        orientation: 'v',
        durationLabel: '1:00',
        sizeLabel: '1 MB',
        videoFile: null,
        status: 'telop',
        steps,
      },
    ] as never;
  }

  it('done / todo / unknown を data-state で出す（data-done は互換で残す）', () => {
    const { container } = render(
      <HomeDashboard
        projects={withSteps({ transcribe: true, cut: false, telop: 'invalid', audio: false, rendered: false })}
        error={null}
        onPick={noop}
        onSetStage={noop}
        onCreate={noopAsync}
        onProjectsChanged={noop}
        now={Date.parse('2026-09-07T00:00:00Z')}
      />,
    );
    const stateOf = (step: string): string | null =>
      container.querySelector(`.home-step[data-step="${step}"]`)?.getAttribute('data-state') ?? null;

    expect(stateOf('transcribe')).toBe('done');
    expect(stateOf('cut')).toBe('todo');
    // 判定不能を「未」と同値に潰さない（旧 data-done は両方 "false"）。
    expect(stateOf('telop')).toBe('unknown');
    expect(container.querySelector('.home-step[data-step="telop"]')?.getAttribute('data-done')).toBe('false');
  });
});

describe('HomeDashboard — 読込中でもドロップを受ける（サイクル 3 残 Minor）', () => {
  /** ファイルドラッグを模した DataTransfer もどき。 */
  function fileDrag(): { dataTransfer: DataTransfer } {
    return {
      dataTransfer: {
        types: ['Files'],
        items: [],
        files: [],
        dropEffect: 'none',
      } as unknown as DataTransfer,
    };
  }

  it('読込中の画面にドラッグしてもヒントが出る（黙って無視しない）', () => {
    const { container, queryByTestId } = renderHome({ loading: true });
    const home = container.querySelector('.home') as HTMLElement;
    expect(queryByTestId('home-loading')).not.toBeNull();
    fireEvent.dragEnter(home, fileDrag());
    expect(queryByTestId('home-drop-hint')).not.toBeNull();
  });

  it('一覧が出ている画面と同じハンドラが付いている（分岐で抜け落ちない）', () => {
    for (const loading of [true, false]) {
      const { container, queryByTestId } = renderHome({ loading });
      const home = container.querySelector('.home') as HTMLElement;
      fireEvent.dragEnter(home, fileDrag());
      expect(queryByTestId('home-drop-hint'), String(loading)).not.toBeNull();
      cleanup();
    }
  });
});
