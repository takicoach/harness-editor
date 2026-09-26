/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { fixture } from '../../core/sequence/fixtures';
import { DEFAULT_TEXT_APPEARANCE } from '../../core/sequence/model';
import { fitTextBoxToStage } from './nativeSampleFit';
import * as nativeSampleFit from './nativeSampleFit';
import { NativeText } from '../../preview/native/NativeText';
import { NativeAnimationList } from './NativeAnimationList';
import { sampleLoopFrame, sampleLoopFrames, sampleLoopSubscriberCount } from './animationSampleLoop';
import { TELOP_ANIMATION_IDS, TELOP_ANIMATION_LABELS } from '../../core/telopAnimation';
import { BUILTIN_TELOP_PACK_VERSION } from '../../server/telopPack/identity';
import { CURRENT_BUILTIN_TELOP_PACK_VERSION } from './telopAnimationSupport';

vi.mock('../../preview/native/NativeText', () => ({ NativeText: vi.fn(() => null) }));

// 見本の舞台は ResizeObserver で監視される（jsdom には実装が無い）。各テストは既定で無害なスタブを
// 使い、監視を検証したいテストだけコールバックを捕まえるスタブへ上書きする。
// 見本のループは IntersectionObserver で「見えているカードだけ」動かすので、こちらは
// 監視対象とコールバックを常に捕まえておき、テストが可視・不可視を自分で決められるようにする。
type Watch = { element: Element; notify(visible: boolean): void };
let watches: Watch[] = [];
beforeEach(() => {
  watches = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class {
    callback: (entries: { isIntersecting: boolean }[]) => void;
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { this.callback = callback; }
    observe(element: Element) {
      watches.push({ element, notify: visible => this.callback([{ isIntersecting: visible }]) });
    }
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** 目当ての見本を「画面に見えている」状態にする。 */
const show = (stage: HTMLElement, visible = true) =>
  act(() => watches.filter(watch => watch.element === stage).forEach(watch => watch.notify(visible)));
const frameOf = (stage: HTMLElement) => Number(stage.dataset.nativeSampleFrame);
/** rAF を刻んで、その間に見えたフレームをすべて集める。 */
const run = (stage: HTMLElement, ticks: number) => {
  const seen = new Set<number>([frameOf(stage)]);
  for (let index = 0; index < ticks; index++) {
    act(() => { vi.advanceTimersByTime(16); });
    seen.add(frameOf(stage));
  }
  return seen;
};

/** free=true で「自由な書式」の字幕にする（リポジトリ内実装なので常に 17 種対応）。 */
const setup = (options: { free?: boolean } & Partial<Parameters<typeof NativeAnimationList>[0]> = {}) => {
  const { free = false, ...overrides } = options;
  const document = fixture();
  const clip = document.clips.find(item => item.content.kind === 'telop')!;
  if (free) Object.assign(clip.content, { textMode: 'free', appearance: { ...DEFAULT_TEXT_APPEARANCE } });
  const onChoose = vi.fn().mockResolvedValue(true);
  render(<NativeAnimationList projectId="p" document={document} clip={clip}
    content={clip.content as never} assets={document.assets.filter(asset => asset.textStyleCatalog)}
    disabled={false} onChoose={onChoose} {...overrides} />);
  return { document, clip, onChoose };
};

/** setup() は render まで済ませてしまうので、props だけ欲しい 2 テスト（自由書式・旧版案件）用に別で組む。 */
const propsFor = (build: (document: ReturnType<typeof fixture>,
  clip: ReturnType<typeof fixture>['clips'][number]) => void) => {
  const document = fixture();
  const clip = document.clips.find(item => item.content.kind === 'telop')!;
  build(document, clip);
  return { projectId: 'p', document, clip, content: clip.content as never,
    assets: document.assets.filter(asset => asset.textStyleCatalog),
    disabled: false, onChoose: vi.fn().mockResolvedValue(true) };
};

const freeTextProps = () => propsFor((_document, clip) => {
  Object.assign(clip.content, { textMode: 'free', appearance: { ...DEFAULT_TEXT_APPEARANCE } });
});

/** componentAssetId 経由で `version` の builtin 資産を参照する字幕。 */
const oldPackProps = (version: string) => propsFor((document, clip) => {
  Object.assign(clip.content, { textMode: 'component', componentAssetId: 'builtin-under-test' });
  document.assets.push({ id: 'builtin-under-test', kind: 'component', file: 'public/builtin.tsx',
    name: 'テロップスタイル', fingerprint: 'fp', streams: [],
    textStyleCatalog: { source: 'builtin', packId: 'harness.builtin', version, componentHash: 'x',
      entries: TELOP_ANIMATION_IDS.map((_id, index) => ({ id: index + 1, name: `style-${index + 1}`,
        animations: [...TELOP_ANIMATION_IDS] })), animations: [...TELOP_ANIMATION_IDS] } });
});

describe('アニメーション一覧', () => {
  it('17 枚のカードを 1 つのグループに並べる', () => {
    setup();
    const group = screen.getByRole('group', { name: 'アニメーション' });
    expect(within(group).getAllByRole('button', { pressed: false }).length
      + within(group).getAllByRole('button', { pressed: true }).length).toBe(17);
  });

  it('パック字幕では自由書式の注記は出ない（裁定 7 は自由書式限定）', () => {
    setup();
    expect(screen.queryByText(/自由書式の字幕は従来どおり/)).toBeNull();
  });

  it('非対応のカードは押せず、理由が常時読める 1 行で出る', () => {
    setup();   // fixture の部品は能力を宣言していない＝不明＝全種非対応
    const card = screen.getByRole('button', { name: /ポップ/, pressed: false });
    expect((card as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('このスタイルの部品はこの動きに対応していません。').length).toBeGreaterThan(0);
  });

  it('対応しているカードを押すと 1 回だけ書き込む', async () => {
    const { onChoose } = setup({ free: true });
    fireEvent.click(screen.getByRole('button', { name: /^フェード/, pressed: false }));
    expect(onChoose).toHaveBeenCalledOnce();
    expect(onChoose).toHaveBeenCalledWith('fadeOnly');
  });

  it('見本を押して動かすボタンは無い（見えているカードは自動で動く）', () => {
    setup({ free: true });
    expect(screen.queryByRole('button', { name: /見本を再生/ })).toBeNull();
  });

  it('見本に渡す字幕は描画に効く入力をすべて保つ（fadeOnly の id 分岐が本番と同じになる）', () => {
    const { clip } = setup({ free: true });
    const stage = screen.getByTestId('animation-sample-fadeOnly');
    const segment = JSON.parse(stage.dataset.sampleSegment!);
    const content = clip.content as { legacyId?: number; data: Record<string, unknown> };
    expect(segment.id).toBe(content.legacyId ?? 1);
    expect(segment.text).toBe(content.data.text);
    expect(segment.template).toBe(content.data.template);
    expect(segment.style).toBe(content.data.style);
    expect(segment.position).toEqual(content.data.position);
    expect(segment.scale).toBe(content.data.scale);
  });

  it('更新の導線は渡されていないと出ない（押せない導線を置かない）', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'この案件の字幕で新しい動きを使えるようにする' })).toBeNull();
  });

  it('更新の導線は渡されたときだけ出る（中身は I-2）', async () => {
    const onEnable = vi.fn();
    setup({ onEnableNewAnimations: onEnable });
    fireEvent.click(screen.getByRole('button', { name: 'この案件の字幕で新しい動きを使えるようにする' }));
    expect(onEnable).toHaveBeenCalledOnce();
  });

  it('自由書式の見本には、その字幕の appearance（文字色・縁取り・影・背景・フォント）がそのまま渡る', () => {
    const { clip } = setup({ free: true });
    const content = clip.content as { appearance: unknown };
    expect(NativeText).toHaveBeenCalled();
    const call = (NativeText as unknown as Mock).mock.calls[0]![0] as { appearance: unknown };
    // 既定値を渡しているのではなく、この字幕自身の appearance オブジェクトを渡している。
    expect(call.appearance).toEqual(content.appearance);
  });

  it('舞台サイズが変わると ResizeObserver が測り直して見本の transform を更新する', () => {
    vi.spyOn(nativeSampleFit, 'measureTextBox').mockReturnValue({ left: 0, top: 0, width: 100, height: 40 });
    let stageWidth = 220;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function stub() {
      return { width: stageWidth, height: stageWidth * .75, left: 0, top: 0, right: stageWidth,
        bottom: stageWidth * .75, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    // 17 枚それぞれが自分の ResizeObserver を作る。observe(element) で監視対象を記録し、
    // 目当ての 1 枚（fadeOnly）のコールバックだけを後で呼び出せるようにする。
    const instances: { element: Element; callback: () => void }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      callback: () => void;
      constructor(callback: () => void) { this.callback = callback; }
      observe(element: Element) { instances.push({ element, callback: this.callback }); }
      disconnect() {}
    });

    setup({ free: true });
    const stage = screen.getByTestId('animation-sample-fadeOnly');
    const drawing = () => stage.shadowRoot!.querySelector('div[style]') as HTMLDivElement;
    const before = drawing().style.transform;
    expect(before).not.toBe('');   // マウント時点で一度測っている（前提の確認）

    stageWidth = 440;   // パネル幅が広がった想定
    const observed = instances.find(entry => entry.element === stage)!;
    expect(observed).toBeDefined();
    act(() => observed.callback());

    expect(drawing().style.transform).not.toBe(before);
  });

  it('「なし」の説明は「追加アニメーションなし（スタイル自前の短いフェードは残る）」に統一されている', () => {
    // 完全静止は提供範囲外（Codex P2-9）。「動かさずに出します。」は嘘になる。
    expect(TELOP_ANIMATION_LABELS.none.description).toContain('追加のアニメーションなし');
    expect(TELOP_ANIMATION_LABELS.none.description).toContain('短いフェード');
  });

  it('自由書式の字幕では 17 種すべてが選べ、その旨を 1 行で出す（裁定 7）', () => {
    const view = render(<NativeAnimationList {...freeTextProps()} />);
    expect(view.getByText(new RegExp(`自由書式の字幕は従来どおり全 ${TELOP_ANIMATION_IDS.length} 種`))).toBeTruthy();
    expect(view.container.querySelectorAll('.native-animation-reason')).toHaveLength(0);
  });

  it('旧版のパックを使っている案件では「この版では反映されません」を出す', () => {
    const view = render(<NativeAnimationList {...oldPackProps('1.0.0')} />);
    expect(view.getByText(/この版では反映されません/)).toBeTruthy();
  });

  it('最新版なら注記を出さない', () => {
    const view = render(<NativeAnimationList {...oldPackProps(CURRENT_BUILTIN_TELOP_PACK_VERSION)} />);
    expect(view.queryByText(/この版では反映されません/)).toBeNull();
  });

  it('画面側が持つ現行版の写しは、正本（identity.ts の BUILTIN_TELOP_PACK_VERSION）と一致する', () => {
    // identity.ts は node:crypto を import しており、そのままブラウザ束ねに含めると
    // native-telop-animation-audit の「再生」待ちが timeout する（クライアント側は写しを持つ理由）。
    // 写しがずれたら、この監査より先にこのテストで気づけるようにする。
    expect(CURRENT_BUILTIN_TELOP_PACK_VERSION).toBe(BUILTIN_TELOP_PACK_VERSION);
  });
});

describe('見本のカタログ再生（ループ）', () => {
  const FRAMES = sampleLoopFrames(30);   // fixture は 30fps → 固定 2.5 秒 = 75 フレーム

  it('見えているカードだけが共通ティッカーへ購読し、見えなくなると解除する', () => {
    vi.useFakeTimers();
    setup({ free: true });
    const stage = screen.getByTestId('animation-sample-slideIn');
    expect(sampleLoopSubscriberCount()).toBe(0);   // まだ誰も見えていない
    show(stage);
    expect(sampleLoopSubscriberCount()).toBe(1);
    show(stage, false);
    expect(sampleLoopSubscriberCount()).toBe(0);
  });

  it('ティッカーが進むとフレームが進み、退場（最終フレーム）まで見せてから最初へ戻る', () => {
    vi.useFakeTimers();
    setup({ free: true });
    const stage = screen.getByTestId('animation-sample-slideIn');
    show(stage);
    // 2.5 秒 + 0.5 秒静止 + 少し = 1 周を必ず跨ぐ。
    const seen = run(stage, 220);
    expect(seen.size).toBeGreaterThan(40);                     // 実際に多数のフレームを描いた
    expect(Math.max(...seen)).toBe(FRAMES - 1);                // 退場まで見せる（中央で止まらない）
    expect(Math.max(...seen)).toBeGreaterThan(Math.round(FRAMES / 2));   // ①の回帰: 中央打ち切りの再発防止
    expect(Math.min(...seen)).toBe(0);                          // 最初へ戻っている
  });

  it('タブが隠れている間は止まる', () => {
    vi.useFakeTimers();
    setup({ free: true });
    const stage = screen.getByTestId('animation-sample-slideIn');
    show(stage);
    run(stage, 10);
    const stopped = frameOf(stage);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    run(stage, 60);
    expect(frameOf(stage)).toBe(stopped);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    run(stage, 20);
    expect(frameOf(stage)).not.toBe(stopped);
  });

  it('動きを控える設定（prefers-reduced-motion）では動かさず静止させる', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
    setup({ free: true });
    const stage = screen.getByTestId('animation-sample-slideIn');
    show(stage);
    expect(sampleLoopSubscriberCount()).toBe(0);
    expect(run(stage, 60).size).toBe(1);
    expect(frameOf(stage)).toBe(Math.round(FRAMES / 2));   // 入退場のフェード窓に入らない中間フレーム
  });

  it('ループは表示だけで、文書へは何も書かない', () => {
    vi.useFakeTimers();
    const { onChoose } = setup({ free: true });
    const stage = screen.getByTestId('animation-sample-slideIn');
    show(stage);
    run(stage, 200);
    expect(onChoose).not.toHaveBeenCalled();
    // 見本の segment は尺（固定 2.5 秒）以外を動かさない＝文書の値をそのまま映しているだけ。
    expect(JSON.parse(stage.dataset.sampleSegment!).endFrame).toBe(FRAMES);
  });
});

describe('見本のループ（純関数）', () => {
  it('固定 2.5 秒。字幕の実尺には合わせない', () => {
    expect(sampleLoopFrames(30)).toBe(75);
    expect(sampleLoopFrames(60)).toBe(150);
  });

  it('0 から最終フレームまで進み、0.5 秒静止してから先頭へ戻る', () => {
    const fps = 30, frames = sampleLoopFrames(fps), hold = 15;
    expect(sampleLoopFrame(0, fps, frames)).toBe(0);
    expect(sampleLoopFrame(1000, fps, frames)).toBe(30);
    expect(sampleLoopFrame(((frames - 1) / fps) * 1000, fps, frames)).toBe(frames - 1);
    // 静止区間はずっと最終フレーム。
    expect(sampleLoopFrame((frames / fps) * 1000, fps, frames)).toBe(frames - 1);
    expect(sampleLoopFrame(((frames + hold - 1) / fps) * 1000, fps, frames)).toBe(frames - 1);
    // 1 周したら先頭へ。
    expect(sampleLoopFrame(((frames + hold) / fps) * 1000, fps, frames)).toBe(0);
  });
});

describe('見本の切り出し計算（純関数）', () => {
  it('文字の箱を余白込みでカードいっぱいに収める transform を返す', () => {
    const fit = fitTextBoxToStage({ left: 100, top: 200, width: 300, height: 80 }, { width: 220, height: 160 }, 70);
    // 余白 70px を四辺へ足した箱（440x220）を 220x160 の舞台へ収める縮小率とオフセット。
    expect(fit.scale).toBeCloseTo(4 / 11, 5);
    expect(fit.x).toBeCloseTo(210 / 11, 5);
    expect(fit.y).toBeCloseTo(-80 / 11, 5);
  });

  it('余白 0 なら測った文字の箱そのものを中央へ収める', () => {
    const fit = fitTextBoxToStage({ left: 0, top: 0, width: 100, height: 40 }, { width: 200, height: 100 });
    expect(fit.scale).toBeCloseTo(Math.min((200 - 28) / (100 + 40 * .4), (100 - 28) / (40 * 1.4)), 5);
    expect(fit.x).toBeGreaterThan(0);
    expect(fit.y).toBeGreaterThan(0);
  });

  it('舞台の寸法が 0（未測定）なら安全な既定値を返す', () => {
    expect(fitTextBoxToStage({ left: 0, top: 0, width: 100, height: 40 }, { width: 0, height: 0 })).toEqual({ scale: 0, x: 0, y: 0 });
  });
});

describe('unsupported animation samples',()=>{
  it('uses the standard free-text renderer for reference samples without enabling unsupported choices',()=>{
    vi.mocked(NativeText).mockClear();
    const props=oldPackProps(CURRENT_BUILTIN_TELOP_PACK_VERSION);
    const asset=props.document.assets.find(a=>a.id==='builtin-under-test')!;
    asset.textStyleCatalog!.animations=['none','fadeOnly'];
    for(const entry of asset.textStyleCatalog!.entries)entry.animations=['none','fadeOnly'];
    render(<NativeAnimationList {...props}/>);
    expect(vi.mocked(NativeText).mock.calls.some(([arg])=>arg.segment.animation==='popIn')).toBe(true);
    expect(vi.mocked(NativeText).mock.calls.some(([arg])=>arg.segment.animation==='fadeOnly')).toBe(false);
    expect((screen.getByRole('button',{name:/^ポップ/}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('標準書式での参考見本').length).toBeGreaterThan(0);
  });
});
