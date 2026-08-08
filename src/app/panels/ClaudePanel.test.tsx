/**
 * @vitest-environment jsdom
 */
/**
 * ClaudePanel のユニットテスト（feat/simplified-ai-tab: UI 簡素化に伴い縮小）。
 *
 * 在席2段表示・詰まった processing 指示の打ち切りボタン・指示履歴/入力欄・
 * 上下2段折りたたみは UI ごと撤去したため、それらを検証していたテストは削除した
 * （純関数 isStuckInstruction / stuckElapsedMinutes / presenceLabel も他から参照が
 * 無いため関数自体を削除・テストも削除。詳細は .sdd/simplified-ai-tab-report.md）。
 * 残すのは I-2 回帰（showTerminal=false の間は AiTerminal をマウントしない・
 * AI の導入確認すら呼ばない）——UI が変わっても消してはいけない安全ゲート。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ClaudePanel } from './ClaudePanel';
import { EventBusProvider } from '../eventBus';

/** jsdom に EventSource が無いため、テスト用の最小モックを用意する。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

/** ClaudePanel を EventBusProvider でラップして render する。 */
function renderPanel(props: Parameters<typeof ClaudePanel>[0]) {
  return render(
    <EventBusProvider projectId={props.projectId ?? ''}>
      <ClaudePanel {...props} />
    </EventBusProvider>,
  );
}

const noop = () => {};
const buildContext = () => ({ frame: 0, timeSec: 0, selection: null });

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe('ClaudePanel — showTerminal=false（I-2: ホーム画面等では端末をマウントしない）', () => {
  it('showTerminal=false の間は AiTerminal を描画せず、/api/ai/tools も叩かない', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new Error('showTerminal=false の間は fetch されないはず');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderPanel({
      projectId: null,
      open: true,
      onToggle: noop,
      buildContext,
      embedded: true,
      showTerminal: false,
    });

    expect(container.querySelector('.cl-embedded')).not.toBeNull();
    expect(container.querySelector('.clt')).toBeNull();
    expect(container.querySelector('[data-testid="claude-terminal"]')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/ai/tools')).toBe(false);
  });
});
