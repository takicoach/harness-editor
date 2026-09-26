/**
 * 撮影ページのフレーム制御プロトコル（M2b T2・設計判断2/7）。
 *
 * ページは `window.__capture` に `init(spec)` / `setFrame(n)` を公開し、Playwright ドライバ
 * （T3）は Promise の resolve を「そのフレームが確実に描き終わった」合図として撮影する。
 *
 * ここには React も DOM も持ち込まない。描画・コミットACK・rAF・fonts.ready・decode() を
 * deps として受け取る純粋な状態機械にして、順序と失敗種別を jsdom で pin できるようにする
 * （実配線は entry.tsx。jsdom で通って実ブラウザで動かない構造を避けるため、entry 側は
 *  素朴な薄い層に留める）。
 */

/**
 * 撮影対象のレイヤ種別（設計判断8: M2b は1レイヤ=1撮影パス）。
 * 'telop-title' は M2c T3 の追加（設計判断3）: telop の上に title を積む合成レイヤ
 * （z 順 = EditorComposition.tsx:586-588 と同順・telop 下・title 上）。
 */
export type CaptureLayerKind = 'telop' | 'title' | 'image' | 'telop-title';

export interface CaptureVideoConfigSpec {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

export interface CaptureSpec {
  layer: CaptureLayerKind;
  /** 素材解決（staticFile → /api/asset）と部品バンドル取得に使うプロジェクト ID。 */
  projectId: string;
  videoConfig: CaptureVideoConfigSpec;
  /** レイヤ種別ごとの描画データ。正本は layers.tsx の TelopLayerData / TitleLayerData /
   *  ImageLayerData（telop: {telops:[]} / title: {titles, titleStyle} / image: {images:[]}）。 */
  data: unknown;
  /** 初期化直後に描くフレーム（既定 0）。 */
  initialFrame?: number;
}

export type CaptureErrorKind =
  | 'not-initialized'
  | 'invalid-frame'
  | 'invalid-spec'
  | 'busy'
  | 'timeout'
  | 'async-error'
  | 'component-load-failed'
  | 'font-load-failed'
  | 'asset-decode-failed'
  | 'capture-runtime-unsupported'
  | 'render-error';

export type CaptureResult =
  | { ok: true }
  | { ok: false; kind: CaptureErrorKind; message: string };

/** 1回の描画要求。tick は「同じフレームを再指定しても再描画・再ACKさせる」ための単調増加値。 */
export interface CaptureView {
  spec: CaptureSpec;
  frame: number;
  tick: number;
}

export interface CaptureControllerDeps {
  /**
   * init の最初に1回だけ走る非同期の下準備（撮影対象部品のバンドル取得・
   * staticFile リゾルバの設定など）。失敗は component-load-failed。
   */
  prepare?(spec: CaptureSpec): Promise<void>;
  /**
   * 指定 view を描画してコミットまで進める。描画中の例外はここから同期 throw する
   * （browserDeps.tsx は flushSync で同期コミットし、ErrorBoundary が拾った例外を投げ直す）。
   */
  render(view: CaptureView): void;
  /** React が実際にこの tick をコミットしたことの明示 ACK（browserDeps.tsx は useLayoutEffect で resolve）。 */
  waitForCommit(tick: number): Promise<void>;
  requestAnimationFrame(callback: () => void): void;
  /** document.fonts.ready 相当。 */
  waitForFonts(): Promise<void>;
  /** 全 <img> の decode() 完了待ち。失敗は fail-loud（asset-decode-failed）。 */
  decodeImages(): Promise<void>;
  /**
   * ページで起きた非同期例外（window.onerror / unhandledrejection）を1件取り出して消す。
   * React の描画スタックの外で落ちた例外はここでしか観測できないため、各段の後に確認して
   * 応答へ載せる（欠けたフレームを ok:true のまま撮らせない）。
   */
  takeAsyncError?(): unknown | null;
  /** 各段の時限（省略時は DEFAULT_CAPTURE_TIMEOUTS）。 */
  timeouts?: Partial<CaptureTimeouts>;
}

/**
 * 各段の時限（ms）。時限が無いと「返ってこない」が唯一の観測不能な失敗形になるため、
 * すべての待ちに上限を置く（超過は kind:'timeout' でドライバへ返す）。
 * 既定値は「実機で正常なら二桁 ms で返る」段に対する十分な余裕として置いた保守的な値。
 */
export interface CaptureTimeouts {
  /** React コミット ACK。 */
  commitMs: number;
  /** document.fonts.ready。Web フォントのネットワーク取得を含む。 */
  fontsMs: number;
  /** 全 <img>.decode()。大きな画像素材のデコードを含む。 */
  decodeMs: number;
  /** requestAnimationFrame 1回。タブが不可視だと rAF が止まるため短めに切る。 */
  frameMs: number;
}

export const DEFAULT_CAPTURE_TIMEOUTS: CaptureTimeouts = {
  commitMs: 10_000,
  fontsMs: 30_000,
  decodeMs: 30_000,
  frameMs: 5_000,
};

export interface CaptureController {
  init(spec: CaptureSpec): Promise<CaptureResult>;
  setFrame(frame: number): Promise<CaptureResult>;
}

/** 例外メッセージから失敗種別を決める（設計判断7: captureRuntime: 接頭辞は最後の網）。 */
export function classifyRenderError(err: unknown): CaptureErrorKind {
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith('captureRuntime') ? 'capture-runtime-unsupported' : 'render-error';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(kind: CaptureErrorKind, message: string): CaptureResult {
  return { ok: false, kind, message };
}

function isValidFrame(frame: number): boolean {
  return Number.isInteger(frame) && frame >= 0;
}

function isValidSpec(spec: CaptureSpec | null | undefined): spec is CaptureSpec {
  if (typeof spec !== 'object' || spec === null) return false;
  const { layer, projectId, videoConfig } = spec;
  if (layer !== 'telop' && layer !== 'title' && layer !== 'image' && layer !== 'telop-title') return false;
  if (typeof projectId !== 'string' || projectId === '') return false;
  if (typeof videoConfig !== 'object' || videoConfig === null) return false;
  // M-2: typeof === 'number' だけでは NaN/Infinity/0/負数を通してしまう。
  // width/height/fps/durationInFrames はいずれも「有限かつ正」でなければ撮影が成立しない。
  return ['width', 'height', 'fps', 'durationInFrames'].every((key) => {
    const v = (videoConfig as unknown as Record<string, unknown>)[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
  });
}

/**
 * 撮影プロトコルの状態機械。
 *
 * - init 前・init 失敗後の setFrame は not-initialized（黙って空フレームを撮らせない）
 * - setFrame の resolve 条件 = 描画 → コミットACK → fonts.ready → img.decode → requestAnimationFrame ×2
 *   （rAF×2 は「コミット後の style/layout がブラウザの次の描画に反映されきる」までの待ち。
 *    スペックの撮影契約。1回だけだと同じフレーム内に合流して未反映のまま撮れることがある）
 * - init はさらに document.fonts.ready と全 <img>.decode() を待つ
 * - setFrame も途中から初出する字幕のローカルフォントと画像の decode を待つ。
 *   解決済みの font 待ちは直ちに終わり、未完の場合は fontsMs で打ち切る。
 */
export function createCaptureController(deps: CaptureControllerDeps): CaptureController {
  let current: CaptureSpec | null = null;
  let tick = 0;
  let busy = false;
  const limits: CaptureTimeouts = { ...DEFAULT_CAPTURE_TIMEOUTS, ...deps.timeouts };

  /** 時限つきの待ち。超過したら TimeoutError を投げる（呼び出し側が kind:'timeout' へ写す）。 */
  class TimeoutError extends Error {}
  async function within<T>(promise: Promise<T>, ms: number, stage: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TimeoutError(`${stage} が ${ms}ms 以内に返りませんでした`)), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 非同期例外（window.onerror / unhandledrejection）が溜まっていれば失敗にする。 */
  function asyncFailure(): CaptureResult | null {
    const err = deps.takeAsyncError?.() ?? null;
    if (err === null) return null;
    return fail('async-error', messageOf(err));
  }

  const nextFrame = (): Promise<void> =>
    within(
      new Promise<void>((resolve) => {
        deps.requestAnimationFrame(() => resolve());
      }),
      limits.frameMs,
      'requestAnimationFrame',
    );

  async function draw(spec: CaptureSpec, frame: number): Promise<CaptureResult> {
    tick += 1;
    try {
      deps.render({ spec, frame, tick });
    } catch (err) {
      return fail(classifyRenderError(err), messageOf(err));
    }
    try {
      await within(deps.waitForCommit(tick), limits.commitMs, 'コミット ACK');
    } catch (err) {
      if (err instanceof TimeoutError) return fail('timeout', messageOf(err));
      return fail(classifyRenderError(err), messageOf(err));
    }
    return asyncFailure() ?? { ok: true };
  }

  async function runInit(spec: CaptureSpec): Promise<CaptureResult> {
    current = null;
    if (!isValidSpec(spec)) {
      return fail('invalid-spec', `撮影スペックが不正です: ${JSON.stringify(spec ?? null)}`);
    }
    const frame = spec.initialFrame ?? 0;
    if (!isValidFrame(frame)) {
      return fail('invalid-frame', `initialFrame は 0 以上の整数のみです（受け取った値: ${frame}）`);
    }
    if (deps.prepare) {
      try {
        await deps.prepare(spec);
      } catch (err) {
        return fail('component-load-failed', messageOf(err));
      }
    }
    const drawn = await draw(spec, frame);
    if (!drawn.ok) return drawn;
    try {
      await within(deps.waitForFonts(), limits.fontsMs, 'document.fonts.ready');
    } catch (err) {
      if (err instanceof TimeoutError) return fail('timeout', messageOf(err));
      return fail('font-load-failed', messageOf(err));
    }
    try {
      await within(deps.decodeImages(), limits.decodeMs, '画像の decode()');
    } catch (err) {
      // M2a 申し送り: decode 失敗は黙って空フレームを焼かず、撮影を中断させる。
      if (err instanceof TimeoutError) return fail('timeout', messageOf(err));
      return fail('asset-decode-failed', messageOf(err));
    }
    const asyncFailed = asyncFailure();
    if (asyncFailed !== null) return asyncFailed;
    current = spec;
    return { ok: true };
  }

  async function runSetFrame(frame: number): Promise<CaptureResult> {
    const spec = current;
    if (spec === null) {
      return fail('not-initialized', 'init() が成功していません。setFrame の前に init を呼んでください。');
    }
    if (!isValidFrame(frame)) {
      return fail('invalid-frame', `frame は 0 以上の整数のみです（受け取った値: ${frame}）`);
    }
    const drawn = await draw(spec, frame);
    if (!drawn.ok) return drawn;
    // 字幕が init 後に初出すると、描画時にローカルフォントの読込が始まる。
    try {
      await within(deps.waitForFonts(), limits.fontsMs, 'document.fonts.ready');
    } catch (err) {
      if (err instanceof TimeoutError) return fail('timeout', messageOf(err));
      return fail('font-load-failed', messageOf(err));
    }
    // C-1: init と同じ decode 段をここにも挟む。区間の途中から現れる画像
    // （例: startFrame:20）は init 時点では DOM に存在せず、setFrame で初めて
    // <img> が生える。ここで待たないと、その画像の decode() 完了前に screenshot
    // してしまい、壊れた/空の画素を黙って撮ってしまう（M2a 申し送りの契約）。
    // 既に decode 済みの img の decode() は解決済み Promise を返すだけなので、
    // 毎フレーム呼んでもコストは軽い。
    try {
      await within(deps.decodeImages(), limits.decodeMs, '画像の decode()');
    } catch (err) {
      if (err instanceof TimeoutError) return fail('timeout', messageOf(err));
      return fail('asset-decode-failed', messageOf(err));
    }
    try {
      await nextFrame();
      await nextFrame();
    } catch (err) {
      return fail('timeout', messageOf(err));
    }
    return asyncFailure() ?? { ok: true };
  }

  /**
   * 直列化。撮影は「1フレーム撮り終えてから次」を前提にしており、並行に呼ばれると
   * tick とコミット ACK の対応が壊れる（前の待ちが取り残される）。重なった呼び出しは
   * 黙って待たせず kind:'busy' で即座に返し、ドライバ側の誤用を観測可能にする。
   */
  async function serialize(run: () => Promise<CaptureResult>): Promise<CaptureResult> {
    if (busy) {
      return fail('busy', '前の init/setFrame がまだ完了していません（撮影は直列に呼んでください）。');
    }
    busy = true;
    try {
      return await run();
    } finally {
      busy = false;
    }
  }

  return {
    init: (spec: CaptureSpec) => serialize(() => runInit(spec)),
    setFrame: (frame: number) => serialize(() => runSetFrame(frame)),
  };
}

/** ドライバから見える面。`window.__capture` に生える。 */
export interface CaptureApi {
  init(spec: CaptureSpec): Promise<CaptureResult>;
  setFrame(frame: number): Promise<CaptureResult>;
}

/** コントローラを window へ公開する（Playwright は page.evaluate から呼ぶ）。 */
export function installCaptureApi(target: Record<string, unknown>, controller: CaptureController): void {
  const api: CaptureApi = {
    init: (spec) => controller.init(spec),
    setFrame: (frame) => controller.setFrame(frame),
  };
  target['__capture'] = api;
}
