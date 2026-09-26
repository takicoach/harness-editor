import { sec } from './ffmpegTime';
import { overlayColorFor } from '../core/transitionStyle';
import { effectiveDirection } from '../core/transitionDirection';
import type { ExportTimeline } from '../core/exportTimeline';
import type { SceneTransition, SlideDirection } from '../core/types';
import type { KeptSegment } from './fastCutRender';

/**
 * シーン転換の filter graph 組み立て（M3 T2）。
 *
 * 方式はすべて T1 スパイクで実 ffmpeg 実行して確定したもので、ここはその**製品側の純関数への移植**
 * である（スパイクは流用しない）。
 *
 * 要点（すべて実測の帰結・「改善」しないこと）:
 * - 入力は `format=gbrp` に揃えてから xfade へ。yuv420p のまま混ぜると crossfade で床超え画素が出る。
 * - `settb=1/fps,setpts=N` で整数 pts に載せ、`offset=(lenA−D)/fps`・`duration=D/fps` を与える。
 *   窓内フレーム k で progress P = k/D となり Remotion の p と位相ずれ 0（T1 実測）。
 * - `crossfade` は stock `fade`、`slide` は stock `slide{方向}`（名前は恒等写像）、
 *   `wipe` は stock が 1 画素ずれるため正典式の直訳 `custom:expr=`。
 * - 音声は重なり窓で**合算**（正典表③）。`atrim → adelay=…S:all=1 → amix=normalize=0:dropout_transition=0`。
 * - fade 系（fadeBlack/fadeWhite/fadeColor）は色レイヤの alpha を `geq` で駆動し、
 *   オーバーレイ鎖の**図形鎖の後・撮影 PNG（telop+title）鎖の前**に挟む（設計判断5・正典表②で
 *   「最前面ではなくテロップより下」が確定・64f5fd4）。`fade` フィルタは丸め規則が違うため使わない。
 */

/** 重なり系の転換種別（総尺が overlap 分縮む3種）。 */
export type OverlapTransitionKind = 'crossfade' | 'slide' | 'wipe';

/** 区間 afterIndex と afterIndex+1 の間に置く重なり系転換（frames は最終座標での重なりフレーム数）。 */
export interface TransitionOverlapSpec {
  afterIndex: number;
  frames: number;
  kind: OverlapTransitionKind;
  direction?: SlideDirection;
}

/** fade 系の色レイヤ1枚（at が数値のときは**最終座標**の join フレーム）。 */
export interface SceneFadeSpec {
  /** `#RRGGBB`（overlayColorFor と同じ規約）。 */
  color: string;
  at: 'head' | 'tail' | number;
  durationFrames: number;
}

/**
 * 音声のサンプルレート。`adelay=…S`（サンプル指定）を成立させるため、遅延の前に
 * `aresample=48000` で 48kHz へ揃える（applyAudioMix の SE/BGM レーンと同じ 48kHz）。
 *
 * **`aformat=…channel_layouts=stereo` は入れない**（実測 2026-09-02）: モノラル素材だと
 * mono→stereo の正規化で振幅が 1/√2 になり、T1 スパイクの amix 出力とサンプル同値でなくなる。
 * チャンネル配置の正規化は従来どおり applyAudioMix 側（`[cuta]` の aformat）だけが行う
 * ＝転換の有無でチャンネル数の扱いが変わらない。
 *
 * **48kHz は前提であって計測値ではない**（C-7 M-7）。素材のレートが何であっても
 * `aresample=48000` で 48kHz へ**変換**してから `adelay=…S`（サンプル指定）と
 * `assertAudioGroupSamples` のサンプル数検算を行うので、この定数が素材のレートと
 * 食い違っていても計算は破綻しない。逆に、ここを変えるなら applyAudioMix 側の
 * `aresample=48000`（`nativeExportAudio.ts`）と**同時に**変えること
 * ——片方だけ変えると群の出口でレートが混ざり、adelay のサンプル数がずれる。
 */
const AUDIO_SAMPLE_RATE = 48000;

/**
 * 正典（@remotion/transitions wipe の clip-path）の直訳式。T1 スパイクの `wipeExpr` と同値。
 *
 * ffmpeg の xfade は progress `P` を 1→0 で回す（P=1 が転換開始＝純 A）ので、正典の p（0→1）は `1-P`。
 * ただし **P は k/D の厳密値にならない**（実測: D=3・k=1 で floor(P*255)=169／厳密なら 170）ので
 * `k = round((1-P)*D)` でフレーム格子へ吸着させる。閾値は **先に掛けてから割る**
 * （`W-W*k/D`。`W*(1-k/D)` と書くと 1-k/D の丸め誤差が幅倍されて境界が 1 画素ずれる）。
 *
 * 方向写像は正典 left→from-right / right→from-left / up→from-bottom / down→from-top。
 * `W`/`H` は xfade の式変数なので解像度を定数展開する必要はない（D だけを展開する）。
 */
export function wipeExpr(direction: SlideDirection, durationFrames: number): string {
  const k = `round((1-P)*${durationFrames})`;
  const thX = `W*${k}/${durationFrames}`;
  const thY = `H*${k}/${durationFrames}`;
  switch (direction) {
    case 'left':
      return `if(gte(X\\,W-${thX})\\,B\\,A)`;
    case 'right':
      return `if(lt(X\\,${thX})\\,B\\,A)`;
    case 'up':
      return `if(gte(Y\\,H-${thY})\\,B\\,A)`;
    case 'down':
      return `if(lt(Y\\,${thY})\\,B\\,A)`;
  }
}

/**
 * `wipeExpr` が描く A/B 境界の位置（**画素 index**・T5 レビュー C-1 の幾何軸の期待値）。
 *
 * `wipeExpr` は ffmpeg の式なので、テストから「境界がどこに来るはずか」を数値で引けない。
 * ここは**同じ閾値式 `size*k/D`（k = round((1−P)*D)）を JS 側で 1 回だけ書いた**もので、
 * 両者が同値であることは `transitionFilter.test.ts` が
 * **式を実際に評価して**突き合わせる（写し崩れは pin が赤で落とす）。
 *
 * 返り値の意味: 走査軸（left/right は X・up/down は Y）に沿って
 * `[0, index)` が `firstIsA ? A : B`・`[index, size)` がもう一方。
 * - left : `X >= W − W·k/D` が B → index = ceil(W − W·k/D)・前半 A
 * - right: `X <  W·k/D` が B     → index = ceil(W·k/D)・前半 B
 * - up   : `Y >= H − H·k/D` が B → index = ceil(H − H·k/D)・前半 A
 * - down : `Y <  H·k/D` が B     → index = ceil(H·k/D)・前半 B
 *
 * `ceil` は「`gte`/`lt` の比較を満たす最小の整数座標」であって丸めの好みではない
 * （`W·k/D` が整数のときは境界がちょうどその列に来る）。
 */
export function wipeBoundaryIndex(
  direction: SlideDirection,
  windowFrame: number,
  durationFrames: number,
  size: { width: number; height: number },
): { index: number; firstIsA: boolean; axis: 'x' | 'y' } {
  if (!Number.isInteger(windowFrame) || windowFrame < 0 || windowFrame > durationFrames) {
    throw new Error(`wipeBoundaryIndex: windowFrame(${windowFrame}) が [0, ${durationFrames}] の外です`);
  }
  const k = windowFrame;
  const th = (extent: number): number => (extent * k) / durationFrames;
  switch (direction) {
    case 'left':
      return { index: Math.ceil(size.width - th(size.width)), firstIsA: true, axis: 'x' };
    case 'right':
      return { index: Math.ceil(th(size.width)), firstIsA: false, axis: 'x' };
    case 'up':
      return { index: Math.ceil(size.height - th(size.height)), firstIsA: true, axis: 'y' };
    case 'down':
      return { index: Math.ceil(th(size.height)), firstIsA: false, axis: 'y' };
  }
}

/**
 * xfade の `transition=` に与える値（stock 名 または `custom:expr=…`）。
 * `W`/`H` は式変数・fps は呼び出し側（offset/duration）が扱うため、ここは種別と D だけで決まる。
 */
export function xfadeFor(
  kind: OverlapTransitionKind,
  direction: SlideDirection | undefined,
  durationFrames: number,
): string {
  if (kind === 'crossfade') return 'fade';
  // B-0（受入 F・2026-09-02）: direction 未指定は**正典と同じ既定方向**で描く。
  // エディタが direction を永続化していなかったため実プロジェクトの wipe/slide は必ず未指定で、
  // ここで throw すると転換が丸ごと Remotion 経路へ退避していた（＝native 書き出しで転換が消える）。
  // 既定値の正本は `core/transitionDirection.ts`（`presentationFor` の default 分岐と pin 済み）。
  const dir = effectiveDirection({ direction });
  if (kind === 'slide') return `slide${dir}`;
  return `custom:expr=${wipeExpr(dir, durationFrames)}`;
}

/**
 * 区間 1 本を xfade/concat に渡せる形へ正規化する。
 * trim は既存経路と同じ「fps → 秒指定 trim → setpts=PTS-STARTPTS」に、
 * `format=gbrp,settb=1/fps,setpts=N` を足しただけ（重なりが無いときはこの関数を通らない＝既存経路不変）。
 */
export function normalizeSegment(
  index: number,
  segment: KeptSegment,
  fps: number,
  options: { gbrp: boolean },
): string {
  const start = sec(segment.start, fps);
  const end = sec(segment.end, fps);
  const format = options.gbrp ? 'format=gbrp,' : '';
  return (
    `[0:v]fps=${fps},trim=start=${start}:end=${end},setpts=PTS-STARTPTS,` +
    `${format}settb=1/${fps},setpts=N[v${index}];`
  );
}

/**
 * どの区間が xfade 群の内側にいるか（= `format=gbrp` を掛ける区間か）。
 * **gbrp は xfade 群の内側だけ**（コントローラ確定 2026-09-02）: 群の出口で `format=yuv420p` へ
 * 戻してから concat・既存 overlay 鎖へ渡す。転換に関与しない区間には gbrp を入れない。
 */
export function segmentsInXfadeGroups(
  segmentCount: number,
  overlaps: readonly TransitionOverlapSpec[],
): boolean[] {
  const inGroup = new Array<boolean>(segmentCount).fill(false);
  for (const o of overlapByIndex(segmentCount, overlaps).values()) {
    inGroup[o.afterIndex] = true;
    inGroup[o.afterIndex + 1] = true;
  }
  return inGroup;
}

export interface ChainLayout {
  /** 各区間の最終タイムライン上の開始フレーム。 */
  finalStarts: number[];
  /** 最終総フレーム数（= Σlen − Σoverlap）。 */
  totalFrames: number;
}

/** overlaps を afterIndex で引ける形に検算しながら畳む。 */
function overlapByIndex(
  segmentCount: number,
  overlaps: readonly TransitionOverlapSpec[],
): Map<number, TransitionOverlapSpec> {
  const map = new Map<number, TransitionOverlapSpec>();
  for (const o of overlaps) {
    if (!Number.isInteger(o.afterIndex) || o.afterIndex < 0 || o.afterIndex >= segmentCount - 1) {
      throw new Error(`転換の afterIndex(${o.afterIndex}) が区間の範囲外です（区間数 ${segmentCount}）`);
    }
    if (map.has(o.afterIndex)) {
      throw new Error(`同じ境界(afterIndex=${o.afterIndex})に転換が2つあります`);
    }
    if (!Number.isInteger(o.frames) || o.frames <= 0) {
      throw new Error(`転換の重なりフレーム数(${o.frames})が正の整数ではありません`);
    }
    map.set(o.afterIndex, o);
  }
  return map;
}

/**
 * 区間列 + overlaps から最終座標のレイアウトを求める（映像 chain と音声 chain の唯一の共有計算）。
 * 重なりが「直前までの累積長」または「後続区間の長さ」以上なら throw（xfade が成立しない＝
 * 黙って壊れた filter を出さない）。
 */
export function chainLayout(
  segments: readonly KeptSegment[],
  overlaps: readonly TransitionOverlapSpec[],
): ChainLayout {
  if (segments.length === 0) throw new Error('区間がありません');
  const map = overlapByIndex(segments.length, overlaps);
  const finalStarts: number[] = [];
  let acc = 0; // 直前までの最終座標での累積長
  segments.forEach((s, i) => {
    const len = s.end - s.start;
    if (len <= 0) throw new Error(`区間 ${i} の長さが 0 以下です`);
    if (i === 0) {
      finalStarts.push(0);
      acc = len;
      return;
    }
    const o = map.get(i - 1);
    const overlap = o?.frames ?? 0;
    if (overlap >= acc || overlap >= len) {
      throw new Error(
        `転換の重なり(${overlap})が区間長を超えています（直前まで ${acc} / 区間 ${i} は ${len}）`,
      );
    }
    finalStarts.push(acc - overlap);
    acc = acc - overlap + len;
  });
  /**
   * **ネストの不変条件**（C-7 M-2）: 区間 i に左右から掛かる重なりの和が区間長を超えないこと。
   *
   * 上のループが見るのは「片側ずつ」なので、`D_left < len` と `D_right < len` を両方満たしても
   * `D_left + D_right > len` の形（区間 i が両側から食い尽くされる＝xfade の入力が
   * 負の長さになる）が素通りする。正典（`transitionEngine` の cap = floor(len/2)）は
   * この形を作らないので、ここに来たら**呼び出し側の写し崩れ**（黙って壊れた filter を出さない）。
   */
  segments.forEach((s, i) => {
    const len = s.end - s.start;
    const left = map.get(i - 1)?.frames ?? 0;
    const right = map.get(i)?.frames ?? 0;
    if (left + right > len) {
      throw new Error(
        `区間 ${i} が両側の転換で食い尽くされます（左 ${left} + 右 ${right} > 区間長 ${len}）`,
      );
    }
  });
  return { finalStarts, totalFrames: acc };
}

export interface VideoChain {
  /** 区間ごとの `[0:v]…[v{i}];` 行（gbrp は xfade 群の内側だけ）。 */
  segmentLines: string[];
  /** xfade 群・群出口の yuv420p 化・群同士の concat（末尾は `[outv];`）。 */
  chainLines: string[];
}

/**
 * 映像 chain。入力ラベルは `normalizeSegment` の `[v{i}]`。
 * 隣接に重なりがあれば xfade で結び、無ければ群の切れ目にして最後に concat する
 * （xfade は duration>0 必須なので重なり 0 を xfade で書かない）。
 *
 * **色空間の適用範囲（コントローラ確定 2026-09-02）**: `format=gbrp` は **xfade 群の内側だけ**。
 * 群の出口で `format=yuv420p` へ戻してから concat し、既存の overlay 鎖（applyOverlays）へ渡す。
 * 転換に関与しない区間は gbrp を通らない（転換の無いプロジェクトの script は別分岐で 1 文字不変）。
 */
export function buildVideoChain(
  segments: readonly KeptSegment[],
  overlaps: readonly TransitionOverlapSpec[],
  fps: number,
): VideoChain {
  const map = overlapByIndex(segments.length, overlaps);
  chainLayout(segments, overlaps); // 不変条件（重なり量）をここでも検算する
  const inGroup = segmentsInXfadeGroups(segments.length, overlaps);
  const segmentLines = segments.map((s, i) => normalizeSegment(i, s, fps, { gbrp: inGroup[i]! }));

  const chainLines: string[] = [];
  const groupLabels: string[] = [];
  /** 群を閉じる: xfade 群なら出口で yuv420p へ戻す。単独区間はもともと yuv420p のまま。 */
  const closeGroup = (label: string, isXfadeGroup: boolean, index: number): void => {
    if (!isXfadeGroup) {
      groupLabels.push(label);
      return;
    }
    chainLines.push(`${label}format=yuv420p[g${index}];`);
    groupLabels.push(`[g${index}]`);
  };

  let current = '[v0]';
  let currentLen = segments[0]!.end - segments[0]!.start;
  let groupStart = 0;
  let isXfadeGroup = false;
  for (let i = 1; i < segments.length; i++) {
    const len = segments[i]!.end - segments[i]!.start;
    const o = map.get(i - 1);
    if (o === undefined) {
      closeGroup(current, isXfadeGroup, groupStart);
      current = `[v${i}]`;
      currentLen = len;
      groupStart = i;
      isXfadeGroup = false;
      continue;
    }
    const duration = (o.frames / fps).toFixed(9);
    const offset = ((currentLen - o.frames) / fps).toFixed(9);
    const transition = xfadeFor(o.kind, o.direction, o.frames);
    chainLines.push(
      `${current}[v${i}]xfade=transition=${transition}:duration=${duration}:offset=${offset}[x${i}];`,
    );
    current = `[x${i}]`;
    currentLen = currentLen - o.frames + len;
    isXfadeGroup = true;
  }

  if (groupLabels.length === 0 && isXfadeGroup) {
    // 全区間が1つの xfade 群（concat 不要）。群の出口がそのまま [outv]。
    chainLines.push(`${current}format=yuv420p[outv];`);
    return { segmentLines, chainLines };
  }
  closeGroup(current, isXfadeGroup, groupStart);
  chainLines.push(`${groupLabels.join('')}concat=n=${groupLabels.length}:v=1:a=0[outv];`);
  return { segmentLines, chainLines };
}

export interface AudioChain {
  /** 区間ごとの `[0:a]…[a{i}];` 行（区間行の位置に差し込む）。 */
  segmentLines: string[];
  /** 群ごとの amix と群同士の concat（末尾行に `;` を付けない）。 */
  chainLines: string[];
}

/**
 * 群の総サンプル数の検算（M-1）。フレーム数から求めた期待値と 1 サンプル以上ずれたら throw する。
 *
 * `adelay` のサンプル数は `Math.round` で丸めるため、48000/fps が整数でない fps（29.97 等）では
 * 群ごとに最大 1 サンプルの誤差が乗りうる。**それ以上のずれは計算の誤り**（群の切り方・相対遅延の
 * 取り違え）なので、黙って音がずれた動画を出さずにここで止める。
 */
export function assertAudioGroupSamples(
  groupIndex: number,
  groupFrames: number,
  fps: number,
  actualSamples: number,
): void {
  const expected = Math.round((groupFrames * AUDIO_SAMPLE_RATE) / fps);
  if (Math.abs(actualSamples - expected) > 1) {
    throw new Error(
      `音声群 ${groupIndex} のサンプル数が想定と一致しません（想定 ${expected} / 組み立て ${actualSamples}・${groupFrames} フレーム）`,
    );
  }
}

/**
 * 音声 chain。**映像と同じ群構造**（I-2）: xfade 群の内側だけ `amix` で合算し、
 * 重なりに触れない区間は `concat` でつなぐ。群同士も `concat` で並べる。
 *
 * 重なり窓を**合算**するのは T1 正典表③（Remotion は両 Sequence の音を同時に鳴らす）の帰結。
 * ただし全区間を1つの `amix` に入れると、区間数ぶんのレーンを全尺にわたって足し続けることになり、
 * 300 区間規模で書き出し時間が跳ね上がる（report の実測表）。合算が要るのは群の内側だけ。
 *
 * 各行は `atrim → asetpts → aresample=48000 →（群内相対の）adelay`。
 * `adelay` は `S` サフィックスでサンプル指定できる（T1 実測）。サンプル数を確定させるため、
 * 遅延の前に `aresample=48000`（applyAudioMix と同じレーン）で 48kHz へ揃える。
 * 48000/fps が整数でない fps（29.97 等）では四捨五入する — 既存経路の秒指定 trim（小数6桁）と
 * 同程度の丸めで、フレーム境界より十分細かい（総サンプルは assertAudioGroupSamples で検算）。
 *
 * `amix` の引数は T1 スパイク由来（M-2 訂正）: **合算そのものを成立させているのは
 * `normalize=0`**（既定の `normalize=1` は入力本数で割るため音量が下がる）。
 * `dropout_transition=0` は「入力の1本が終わったときの音量遷移時間」を 0 にする補助で、
 * 合算の本体ではない（既定 2 秒だと窓の出口で不要なゲイン変化が乗る）。
 */
export function buildAudioChain(
  segments: readonly KeptSegment[],
  overlaps: readonly TransitionOverlapSpec[],
  fps: number,
): AudioChain {
  const { finalStarts } = chainLayout(segments, overlaps);
  const map = overlapByIndex(segments.length, overlaps);

  // 群 = 連続する重なりでつながった区間の並び（映像 buildVideoChain と同じ切り方）。
  const groups: number[][] = [];
  segments.forEach((_, i) => {
    if (i > 0 && map.has(i - 1)) {
      groups[groups.length - 1]!.push(i);
      return;
    }
    groups.push([i]);
  });

  const segmentLines: string[] = [];
  const chainLines: string[] = [];
  const groupLabels: string[] = [];
  groups.forEach((members, g) => {
    const groupStart = finalStarts[members[0]!]!;
    let groupEnd = groupStart;
    let lastEndSamples = 0;
    for (const i of members) {
      const s = segments[i]!;
      // 遅延は**群の先頭からの相対**（群同士は concat で並ぶので絶対座標にしない）。
      const relFrames = finalStarts[i]! - groupStart;
      const delaySamples = Math.round((relFrames * AUDIO_SAMPLE_RATE) / fps);
      const delay = delaySamples > 0 ? `,adelay=${delaySamples}S:all=1` : '';
      segmentLines.push(
        `[0:a]atrim=start=${sec(s.start, fps)}:end=${sec(s.end, fps)},asetpts=PTS-STARTPTS,` +
          `aresample=${AUDIO_SAMPLE_RATE}${delay}[a${i}];`,
      );
      groupEnd = Math.max(groupEnd, finalStarts[i]! + (s.end - s.start));
      lastEndSamples = Math.max(
        lastEndSamples,
        delaySamples + Math.round(((s.end - s.start) * AUDIO_SAMPLE_RATE) / fps),
      );
    }
    assertAudioGroupSamples(g, groupEnd - groupStart, fps, lastEndSamples);
    if (members.length === 1) {
      groupLabels.push(`[a${members[0]!}]`);
      return;
    }
    const labels = members.map((i) => `[a${i}]`).join('');
    const mix = `amix=inputs=${members.length}:normalize=0:dropout_transition=0:duration=longest`;
    if (groups.length === 1) {
      // 全区間が1つの群なら concat は要らない（amix の出力がそのまま [outa]）。
      chainLines.push(`${labels}${mix}[outa]`);
      groupLabels.length = 0;
      return;
    }
    chainLines.push(`${labels}${mix}[ga${g}];`);
    groupLabels.push(`[ga${g}]`);
  });

  if (groupLabels.length > 0) {
    chainLines.push(`${groupLabels.join('')}concat=n=${groupLabels.length}:v=0:a=1[outa]`);
  }
  return { segmentLines, chainLines };
}

/**
 * fade 色レイヤの alpha 式（0..255）。`transitionStyle` の線形式をそのまま直訳する
 * （`fade` フィルタは丸め規則が違うため使わない・設計判断5）。
 * - `head`: edgeOverlayOpacityAt(head) = clip(1 − N/D, 0, 1)
 * - `tail`: edgeOverlayOpacityAt(tail) = clip((N − (total−D))/D, 0, 1)
 * - 数値 at（最終座標の join フレーム J）: joinOverlayOpacityAt = clip(1 − |N−J|/(D/2), 0, 1)
 */
export function sceneFadeAlphaExpr(
  at: 'head' | 'tail' | number,
  durationFrames: number,
  totalFrames: number,
  /**
   * 色ソースの先頭フレームが最終タイムラインの何フレーム目かΩ（C-3）。
   * `geq` の `N` はフィルタが処理した通し番号（0 起点）なので、窓に切った色ソースでは
   * `N` が窓内相対になる。式のフレーム原点をここでシフトして絶対フレームへ戻す。
   */
  originFrame = 0,
): string {
  if (durationFrames <= 0) throw new Error('fade の durationFrames が 0 以下です');
  /** `N + originFrame - k` を定数畳み込みして書く（origin=0・k=0 なら素の `N`）。 */
  const shifted = (k: number): string => {
    const c = originFrame - k;
    return c === 0 ? 'N' : c > 0 ? `N+${c}` : `N-${-c}`;
  };
  if (at === 'head') return `255*clip(1-${shifted(0)}/${durationFrames},0,1)`;
  if (at === 'tail') {
    return `255*clip((${shifted(totalFrames - durationFrames)})/${durationFrames},0,1)`;
  }
  return `255*clip(1-abs(${shifted(at)})/(${durationFrames}/2),0,1)`;
}

/**
 * 色レイヤを載せる窓（C-3）。**全尺の色ソースに geq を掛けてはいけない**——
 * alpha が 0 と分かっているフレームまで 1 画素ずつ式を評価するため、実データ規模
 * （300 秒・640×360・fade 1 枚）で書き出しが桁で遅くなる（レビュー実測 104s → 8.6s）。
 *
 * 窓は正典の不透明度が 0 になる範囲の外側を含まない（含んでもよいが無駄）:
 * - `head`: `[0, D)`（edgeOverlayOpacityAt は frame >= D で 0）
 * - `tail`: `[total−D, total)`（frame <= total−D で 0）
 * - 数値 at（join J）: `[J−D/2, J+D/2)` を整数フレームへ切り上げた範囲
 *   （joinOverlayOpacityAt は |frame−J| >= D/2 で 0）
 * 総尺の外へはみ出す分はクリップする。
 */
export function sceneFadeWindow(
  at: 'head' | 'tail' | number,
  durationFrames: number,
  totalFrames: number,
): { startFrame: number; frames: number } {
  if (durationFrames <= 0) throw new Error('fade の durationFrames が 0 以下です');
  const rawStart =
    at === 'head' ? 0 : at === 'tail' ? totalFrames - durationFrames : Math.ceil(at - durationFrames / 2);
  const rawEnd =
    at === 'head'
      ? durationFrames
      : at === 'tail'
      ? totalFrames
      : Math.ceil(at + durationFrames / 2);
  const startFrame = Math.max(0, rawStart);
  const endFrame = Math.min(totalFrames, rawEnd);
  if (endFrame <= startFrame) {
    throw new Error(`fade の窓が空です（at=${String(at)} D=${durationFrames} total=${totalFrames}）`);
  }
  return { startFrame, frames: endFrame - startFrame };
}

/**
 * CSS Level 1 の 16 色（C-1）。正典（`overlayColorFor` → プレビューの CSS）は色文字列を
 * **そのままブラウザに描かせる**ので、`#RRGGBB` 以外の指定でも絵は出る。native 側が
 * `#RRGGBB` しか受けないと、その差が丸ごと Remotion 退避（遅い経路）に化ける。
 *
 * 変換表を **CSS Level 1 の 16 色に限定**するのは、名前色の正典が「ブラウザの CSS 色解決」で、
 * 拡張色（X11 の 140 色）まで手写しすると表が正典と乖離したときに**黙って別の色**を描くため。
 * ここに無い名前は変換しない＝退避（Remotion が正典の色で描く）。
 */
const CSS_LEVEL1_COLORS: Record<string, string> = {
  black: '000000', silver: 'C0C0C0', gray: '808080', white: 'FFFFFF',
  maroon: '800000', red: 'FF0000', purple: '800080', fuchsia: 'FF00FF',
  green: '008000', lime: '00FF00', olive: '808000', yellow: 'FFFF00',
  navy: '000080', blue: '0000FF', teal: '008080', aqua: '00FFFF',
};

/**
 * 色文字列 → ffmpeg の `0xRRGGBB`。**変換できない形式は null**（黙って別の色を出さない）。
 *
 * 受けるのは `#RRGGBB` / `#RGB`（短縮）/ CSS Level 1 の 16 色名（大小無視）。
 * 呼び出し側（`planFastCut`）は図形ラスタライズより**前**にこれで適格性を判定し、
 * null なら plan 不成立（Remotion 退避）にする。
 */
export function ffmpegColorOrNull(color: string): string | null {
  // `#RRGGBB` は**大小をそのまま**通す（既存プロジェクトの script を 1 文字も変えないため）。
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return `0x${color.slice(1)}`;
  if (/^#[0-9a-fA-F]{3}$/.test(color)) {
    const [r, g, b] = [color[1]!, color[2]!, color[3]!];
    return `0x${`${r}${r}${g}${g}${b}${b}`.toUpperCase()}`;
  }
  const named = CSS_LEVEL1_COLORS[color.trim().toLowerCase()];
  return named === undefined ? null : `0x${named}`;
}

/** `ffmpegColorOrNull` の throw 版（filter 行の組み立て時点では適格性が確定している前提）。 */
function ffmpegColor(color: string): string {
  const converted = ffmpegColorOrNull(color);
  if (converted === null) {
    throw new Error(`fade の色 "${color}" を ffmpeg の色へ変換できません（#RRGGBB / #RGB / CSS 基本 16 色）`);
  }
  return converted;
}

/**
 * fade 色レイヤ 1 枚の filter 行（**窓長ぶんだけ**の単色ソース + alpha を geq で駆動）。
 * 入力を消費しないので `-i` の追加は不要（overlay 鎖の入力 index に影響しない）。
 *
 * C-3: 色ソースは `sceneFadeWindow` の窓長で作り、`setpts=N+窓開始` で最終座標へ置く。
 * `geq` の `N` は窓内相対になるので、alpha 式のフレーム原点も同じだけシフトする。
 */
export function sceneFadeLayer(
  spec: SceneFadeSpec,
  index: number,
  fps: number,
  size: { width: number; height: number },
  totalFrames: number,
): string {
  const win = sceneFadeWindow(spec.at, spec.durationFrames, totalFrames);
  const alpha = sceneFadeAlphaExpr(spec.at, spec.durationFrames, totalFrames, win.startFrame);
  const shift = win.startFrame === 0 ? 'N' : `N+${win.startFrame}`;
  return (
    `color=c=${ffmpegColor(spec.color)}:s=${size.width}x${size.height}:r=${fps}:d=${sec(win.frames, fps)},` +
    `format=rgba,settb=1/${fps},setpts=${shift},` +
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'[fd${index}];`
  );
}

/**
 * ExportTimeline から重なり系転換を導く（設計判断7: 各工程が `playbackToFinal` を独自に呼ばない）。
 * 重なり量は `finalEnd(i) − finalStart(i+1)` だけを読み、kind/direction は転換定義から引く
 * （kind/direction は座標ではないので timeline には無い）。
 */
export function deriveTransitionOverlaps(
  timeline: ExportTimeline,
  transitions: readonly SceneTransition[],
): TransitionOverlapSpec[] {
  const out: TransitionOverlapSpec[] = [];
  for (let i = 0; i + 1 < timeline.segments.length; i++) {
    const a = timeline.segments[i]!;
    const b = timeline.segments[i + 1]!;
    const frames = a.finalEnd - b.finalStart;
    if (frames <= 0) continue;
    const matched = transitions.filter(
      (x) => x.at === a.playbackEnd && (x.kind === 'crossfade' || x.kind === 'slide' || x.kind === 'wipe'),
    );
    if (matched.length === 0) {
      throw new Error(`最終座標に重なり(${frames})があるのに転換定義が見つかりません（境界 ${a.playbackEnd}）`);
    }
    // M-4: 同じつなぎ目に重なり系が2つある入力は、どちらの kind/direction を採るかが
    // 一意に決まらない（find は先頭を黙って選ぶ）。壊れた filter を出さずにここで止める。
    if (matched.length > 1) {
      throw new Error(
        `同じつなぎ目(再生 ${a.playbackEnd})に重なり系の転換が2つ以上あります（id: ${matched.map((x) => x.id).join(', ')}）`,
      );
    }
    const t = matched[0]!;
    out.push({ afterIndex: i, frames, kind: t.kind as OverlapTransitionKind, direction: t.direction });
  }
  return out;
}

/**
 * ExportTimeline から fade 系の色レイヤ仕様を導く。数値 at は**最終座標の join フレーム**
 * （= その境界で始まる区間の finalStart）へ写す。
 *
 * **境界に一致しない at は捨てる（I-3・実態の訂正）**: 旧コメントは「プレビューも境界一致の
 * ものだけを描く」と書いていたが、それは誤り。プレビュー（`EditorComposition.SceneOverlayLayer`）が
 * 落とすのは **`computeJoins` に無い原本 at** で、そこは呼び出し側（fastCutPlan の
 * `resolveSceneTransitions`）が既に済ませている。ここへ来る at は**再生座標の join フレーム**で、
 * 区間境界と一致するのが構造的な前提——一致しないならプレビューは描くのに書き出しは描かない
 * （＝プレビューと違う絵）ので、**捨てはするが黙らない**（呼び出しごとに 1 回 warn する）。
 */
export function deriveSceneFadeSpecs(
  timeline: ExportTimeline,
  transitions: readonly SceneTransition[],
): SceneFadeSpec[] {
  const out: SceneFadeSpec[] = [];
  const dropped: Array<number | string> = [];
  for (const t of transitions) {
    const color = overlayColorFor(t.kind, t.color);
    if (color === null) continue; // 重なり系はオーバーレイで描かない
    if (t.durationFrames <= 0) continue;
    if (t.at === 'head' || t.at === 'tail') {
      out.push({ color, at: t.at, durationFrames: t.durationFrames });
      continue;
    }
    const seg = timeline.segments.find((s) => s.playbackStart === t.at);
    if (seg === undefined) {
      dropped.push(t.at);
      continue;
    }
    out.push({ color, at: seg.finalStart, durationFrames: t.durationFrames });
  }
  if (dropped.length > 0) {
    // 1 回だけ（転換ごとに撒かない）。プレビューと書き出しの乖離を示す信号なので黙らせない。
    console.warn(
      `[sme] シーン転換の fade を捨てました（再生座標 ${dropped.join(', ')} が区間境界と一致しません）。` +
        'プレビューは描くが書き出しには出ません',
    );
  }
  return out;
}
