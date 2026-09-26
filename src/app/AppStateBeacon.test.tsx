/**
 * @vitest-environment jsdom
 */
/**
 * AI エージェント向けの画面状態ビーコン。
 * キーの並びが固定であること（契約）と、dirty の変化が反映されることを pin する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { AppStateBeacon, serializeAppState, APP_STATE_ELEMENT_ID } from './AppStateBeacon';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const base = {
  project: 'p1',
  dirty: false,
  saveStatus: 'idle',
  selection: null,
  warnings: [] as string[],
  renderStatus: 'idle',
};

describe('serializeAppState', () => {
  it('キーの並びは固定（契約）', () => {
    const json = serializeAppState({ ...base, playheadFrame: 0 });
    expect(Object.keys(JSON.parse(json))).toEqual([
      'project',
      'dirty',
      'saveStatus',
      'playheadFrame',
      'selection',
      'warnings',
      'renderStatus',
    ]);
  });

  it('入力順が違っても出力の並びは同じ', () => {
    const a = serializeAppState({ ...base, playheadFrame: 3 });
    const b = serializeAppState({
      renderStatus: 'idle',
      warnings: [],
      selection: null,
      playheadFrame: 3,
      saveStatus: 'idle',
      dirty: false,
      project: 'p1',
    });
    expect(a).toBe(b);
  });

  it('案件名に </script> が入っても埋め込みが壊れない', () => {
    const json = serializeAppState({ ...base, project: 'a</script>b', playheadFrame: 0 });
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json).project).toBe('a</script>b');
  });
});

describe('AppStateBeacon', () => {
  it('hidden な application/json として現在の状態を出す', () => {
    const { getByTestId } = render(
      <AppStateBeacon state={base} getPlayheadFrame={() => 42} />,
    );
    const el = getByTestId(APP_STATE_ELEMENT_ID);
    expect(el.getAttribute('type')).toBe('application/json');
    expect(el.id).toBe(APP_STATE_ELEMENT_ID);
    expect((el as HTMLElement).hidden).toBe(true);
    const parsed = JSON.parse(el.textContent ?? '{}');
    expect(parsed).toMatchObject({ project: 'p1', dirty: false, playheadFrame: 42 });
  });

  it('dirty の変化が（デバウンス後に）反映される', () => {
    vi.useFakeTimers();
    const { getByTestId, rerender } = render(
      <AppStateBeacon state={base} getPlayheadFrame={() => 0} />,
    );
    expect(JSON.parse(getByTestId(APP_STATE_ELEMENT_ID).textContent ?? '{}').dirty).toBe(false);

    rerender(<AppStateBeacon state={{ ...base, dirty: true }} getPlayheadFrame={() => 0} />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(JSON.parse(getByTestId(APP_STATE_ELEMENT_ID).textContent ?? '{}').dirty).toBe(true);
  });
});
