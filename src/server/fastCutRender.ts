import type { RenderOptions } from '../shared/renderPreset';
import { targetResolution } from '../shared/renderPreset';
import { sec } from './ffmpegTime';
import {
  buildAudioChain,
  buildVideoChain,
  chainLayout,
  type TransitionOverlapSpec,
} from './transitionFilter';

/**
 * カットしただけの動画を ffmpeg 直結で書き出す（Remotion を通さない高速経路）。
 *
 * Remotion 経路はフレームを 1.5 倍スーパーサンプリングで描き直すため、4K 指定だと
 * 5760×3240 の描画になり実測 10 時間超だった。テロップもエフェクトも無いなら
 * 原本を trim して concat するだけでよく、同じ素材が 9 分で終わる（2026-07-25 実測）。
 */

/** 残す区間（原本フレーム・end は排他）。 */
export interface KeptSegment {
  start: number;
  end: number;
}

/** 出力されるはずのフレーム数（＝カット後の尺）。書き出し後の検算に使う。 */
export function expectedCutFrames(segments: readonly KeptSegment[]): number {
  return segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
}

/**
 * 残す区間を trim/atrim して concat する filter_complex スクリプトを組み立てる。
 *
 * 区間が 100 を超えると引数長の上限に当たるため、呼び出し側はこれをファイルへ書き出し
 * `-/filter_complex` で渡す（引き継ぎ手順と同じ形）。
 */
export function buildCutFilterScript(
  segments: readonly KeptSegment[],
  fps: number,
  overlaps: readonly TransitionOverlapSpec[] = [],
  options: { expectTotalFrames?: number } = {},
): string {
  if (segments.length === 0) {
    throw new Error('残す区間がありません（全部カットされています）');
  }
  if (overlaps.length > 0) {
    return buildTransitionFilterScript(segments, fps, overlaps, options.expectTotalFrames);
  }
  if (options.expectTotalFrames !== undefined && options.expectTotalFrames !== expectedCutFrames(segments)) {
    throw new Error(
      `総フレーム数が想定と一致しません（想定 ${options.expectTotalFrames} / 組み立て ${expectedCutFrames(segments)}）`,
    );
  }
  const lines: string[] = [];
  segments.forEach((s, i) => {
    const start = sec(s.start, fps);
    const end = sec(s.end, fps);
    lines.push(`[0:v]fps=${fps},trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}];`);
    lines.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}];`);
  });
  const inputs = segments.map((_, i) => `[v${i}][a${i}]`).join('');
  lines.push(`${inputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`);
  return lines.join('\n') + '\n';
}

/**
 * 重なり系トランジションがある場合の filter script（M3 T2）。
 *
 * 既存経路（overlaps 空）とは**別の分岐**にしてある: 転換が無いプロジェクトの出力は
 * 上の従来コードがそのまま作るので 1 文字も変わらない（受入 E）。
 * 映像は「区間を gbrp へ正規化 → xfade 群 + concat → 最後に yuv420p」、
 * 音声は「区間ごとに atrim → 48kHz へ揃える → adelay(サンプル) → amix で合算」（T1 正典表③）。
 * 総フレーム数は ExportTimeline の `totalFrames`（= finalTotalFrames）と厳密一致を検算し、
 * 違えば throw する（呼び出し側はこれを Remotion 退避の引き金にする）。
 */
function buildTransitionFilterScript(
  segments: readonly KeptSegment[],
  fps: number,
  overlaps: readonly TransitionOverlapSpec[],
  expectTotalFrames: number | undefined,
): string {
  const layout = chainLayout(segments, overlaps);
  if (expectTotalFrames !== undefined && expectTotalFrames !== layout.totalFrames) {
    throw new Error(
      `総フレーム数が想定と一致しません（想定 ${expectTotalFrames} / 組み立て ${layout.totalFrames}）`,
    );
  }
  const audio = buildAudioChain(segments, overlaps, fps);
  const video = buildVideoChain(segments, overlaps, fps);
  const lines: string[] = [];
  segments.forEach((_, i) => {
    lines.push(video.segmentLines[i]!);
    lines.push(audio.segmentLines[i]!);
  });
  lines.push(...video.chainLines);
  lines.push(...audio.chainLines);
  return lines.join('\n') + '\n';
}

/**
 * **contain フィルタ（C-0）**: 素材寸法 `probed` を composition（`videoConfig.resolution`）へ
 * 「アスペクト維持で内接させ、余白を中央黒帯で埋める」1本の文字列。同寸なら null。
 *
 * 正典（Remotion）は composition の中に
 * `OffthreadVideo style={{width:'100%',height:'100%',objectFit:'contain'}}` で素材を置く。
 * native も**必ず composition を正本**にする（素材寸法で書き出すと、色レイヤ・撮影 PNG・
 * 図形だけが composition 幾何のまま左上に乗る＝受入 F で観測した壊れ方になる）。
 * アスペクトが同じなら pad は恒等（`ow-iw = oh-ih = 0`）。
 *
 * **`force_divisible_by=2`（M-4）**: `force_original_aspect_ratio=decrease` の内接寸法は
 * 奇数になり得る（1920×1080 → 1080×1920 の内容高は 607.5 → 607）。奇数のまま yuv420p へ
 * 落とすとクロマ平面が半端になり、エンコーダ側の丸めがどちらに転ぶか読めない。
 * 偶数へ丸めた場合の正典（Remotion `objectFit:'contain'`）とのずれは**実測 0.5px 以内**
 * （1920×1080 → 1080×1920: 内容高 607.5 → 608〔最近傍の偶数〕・内容行 656〜1263 に対し
 * 正典は 656.25〜1263.75 ＝ 端のずれ 0.25px・高さの差 0.5px）で、e2e の許容 ±2px の内側。
 * 幾何は一致するがリサンプラが違う（lanczos vs Chromium）ため、画素一致は保証しない。
 */
/**
 * **SAR 正規化（C-8）**: 非正方画素（SAR≠1:1）の素材を**表示寸法**へ直し、以後を正方画素として
 * 扱わせる 1 本。contain の前段にだけ入る。
 *
 * 正典（Remotion）の `objectFit:'contain'` はブラウザの**表示寸法**で解く（1440×1080 SAR 4:3 は
 * 1920×1080 として内接する）。native の `scale=…force_original_aspect_ratio=decrease` は
 * 復号寸法で解くので、正規化しないと 4:3 として内接し表示アスペクトが歪む（16:9 composition に
 * 出ないはずの左右黒帯が出る）。
 *
 * `sar` は scale フィルタの実行時変数（**復号後**＝自動回転後の入力の画素比）なので、
 * 回転メタつき素材でも正しい。幅を偶数へ丸める（`trunc(iw*sar/2)*2`）のは yuv420p の
 * クロマ平面が奇数幅を持てないため。丸めによる表示寸法のずれは最大 1px（1920 に対し 0.05%）で、
 * この後の contain（`force_original_aspect_ratio=decrease`）が composition へ内接させ直す。
 */
export const SAR_NORMALIZE_FILTER = 'scale=trunc(iw*sar/2)*2:ih:flags=lanczos,setsar=1';

/**
 * SAR 正規化を入れるべきか（C-8）。**既知の非正方画素のときだけ** true。
 *
 * SAR 不明（`null`・ffprobe が `0:1`/N/A を返す）で入れてはいけない——`scale` の `sar` 変数が
 * 0 になり幅 0 の script を焼く。不明は `exact:false` 経由で contain が必ず入る側に倒っている。
 */
function needsSarNormalize(probed: { sar?: number | null }): boolean {
  return typeof probed.sar === 'number' && Number.isFinite(probed.sar) && probed.sar > 0 && probed.sar !== 1;
}

export function containFilterFor(
  probed: { width: number; height: number; exact?: boolean; sar?: number | null },
  composition: { width: number; height: number },
): string | null {
  // exact === false は「表示寸法を読み切れていない」（SAR≠1:1・回転不明）。等値でも省略しない
  // ＝同アスペクトなら pad は恒等なので副作用はなく、素材寸法のまま焼く事故だけを塞ぐ（I-1）。
  // 非正方画素（C-8）は復号寸法が composition と同じでも表示寸法が違うので、同様に省略しない。
  if (
    probed.exact !== false &&
    !needsSarNormalize(probed) &&
    probed.width === composition.width &&
    probed.height === composition.height
  ) {
    return null;
  }
  const w = composition.width;
  const h = composition.height;
  // 非正方画素は先に表示寸法へ直す（C-8）。SAR=1:1 / 不明では 1 文字も足さない（受入 E）。
  const prefix = needsSarNormalize(probed) ? `${SAR_NORMALIZE_FILTER},` : '';
  return (
    prefix +
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
  );
}

/** 区間の映像行（`[0:v]…[v{i}];`）だけを拾う。音声行（`[0:a]…[a{i}];`）は対象外。 */
const SEGMENT_VIDEO_LINE = /^\[0:v\].*\[v\d+\];$/;

/**
 * contain を**主映像の各区間正規化の直後**（出力ラベル `[v{i}]` の直前）へ挟む。
 *
 * xfade・concat・fade 色レイヤ・overlay 鎖はこれより下流なので、以後はすべて composition
 * 寸法で揃う。区間行が 1 本も見つからない／`expectSegments` と本数が違うときは throw
 * （**一部の区間にだけ contain が入った script** を黙って焼かない＝呼び出し側が Remotion 退避
 * できる。行の形が変わったのに正規表現だけ古い、という取りこぼしをここで赤にする）。
 */
export function applySegmentContain(script: string, contain: string, expectSegments?: number): string {
  let applied = 0;
  const lines = script.split('\n').map((line) => {
    if (!SEGMENT_VIDEO_LINE.test(line)) return line;
    applied += 1;
    return line.replace(/(\[v\d+\];)$/, `,${contain}$1`);
  });
  if (applied === 0) {
    throw new Error('applySegmentContain: 区間の映像行（[0:v]…[v{i}];）が見つかりません');
  }
  if (expectSegments !== undefined && applied !== expectSegments) {
    throw new Error(
      `applySegmentContain: contain を入れた区間数が想定と違います（想定 ${expectSegments} / 実際 ${applied}）`,
    );
  }
  return lines.join('\n');
}

/**
 * 出力解像度が原本と同じなら null（スケールフィルタ不要）、違えば scale フィルタ文字列。
 * 偶数へ丸める（H.264 は奇数解像度を扱えない）。
 */
export function scaleFilterFor(
  options: RenderOptions,
  source: { width: number; height: number },
): string | null {
  const target = targetResolution(source.width, source.height, options.resolution);
  if (target.width === source.width && target.height === source.height) return null;
  return `scale=${target.width}:${target.height}:flags=lanczos`;
}

/**
 * 縮小（scale）を script の最後段へ 1 回だけ挿入する（C-2）。
 *
 * 旧実装は `script.replace('[outv][outa]', …)` で、**転換ありの script では
 * この並びが存在しない**（映像 chain が `[outv];` で終わり、音声は別行の `[outa]`）ため
 * 置換が黙って空振りし、4K のまま書き出していた。挿入点は overlay 鎖と同じ
 * 「script 中に `[outv]` は必ず1個」という契約に統一する。
 *
 * 出力は旧実装と1文字同一（`…[catv][outa];\n[catv]scale…[outv]\n`）。
 * 置換対象が見つからなければ throw する（黙って原寸で書き出さない・呼び出し側は Remotion 退避）。
 */
export function applyScaleFilter(script: string, scale: string): string {
  const marker = '[outv]';
  const idx = script.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error('applyScaleFilter: script に [outv] が見つかりません（scale を挿入できません）');
  }
  if (script.indexOf(marker) !== idx) {
    throw new Error('applyScaleFilter: script に [outv] が複数個あります（挿入点が一意に決まりません）');
  }
  const rewritten = script.slice(0, idx) + '[catv]' + script.slice(idx + marker.length);
  return rewritten.trimEnd() + ';\n[catv]' + scale + '[outv]\n';
}

/** 画質（CRF 相当）→ ハードウェアエンコーダのビットレート。原本の解像度から決める。 */
function bitrateFor(quality: RenderOptions['quality'], pixels: number): string {
  // 4K(≒830万画素) で 高:80M / 標準:50M / 軽量:25M。解像度に比例させる。
  const base = quality === 'high' ? 80 : quality === 'standard' ? 50 : 25;
  const scaled = Math.max(6, Math.round((base * pixels) / (3840 * 2160)));
  return `${scaled}M`;
}

export interface FastCutArgsInput {
  /** 入力＝原本動画の絶対パス。 */
  input: string;
  /** filter_complex スクリプトのパス。 */
  filterScript: string;
  /** 出力パス。 */
  output: string;
  options: RenderOptions;
  /** 出力の画素数計算に使う最終解像度。 */
  target: { width: number; height: number };
  /** ハードウェアエンコーダ（macOS の VideoToolbox）を使えるか。 */
  hardware: boolean;
  /**
   * 追加入力（SE/BGM/図形PNG/連番PNG等）。main 入力の直後に順序どおり `-i` で追加される。
   * loop 指定は `-stream_loop -1` を `-i` の直前に付ける（音声ループ）。
   * image 指定は静止画入力用: `-loop 1 -framerate {F} -t {D} -i path` を出力する
   * （loop とは排他・音声の `-stream_loop -1` の挙動・順序には一切触れない）。
   * sequence 指定は image2 連番入力用（M2c T4・captureSequenceInput.buildCaptureSequenceInput
   * の出力をそのまま渡す想定）: `-framerate {F} -start_number {N} -i path` を出力する
   * （image/loop とは別分岐・排他。path は連番パターン（例: `dir/%06d.png`）を渡す）。
   */
  extraInputs?: ReadonlyArray<{
    path: string;
    loop?: boolean;
    image?: { framerate: number; durationSec: string };
    sequence?: { framerate: number; startNumber: number };
  }>;
}

/**
 * ffmpeg の引数を組み立てる。
 *
 * - macOS は `h264_videotoolbox`（CRF ではなくビットレート指定）で数分に収まる。
 * - それ以外は `libx264`（CRF 指定）。速度は落ちるが同じ結果になる。
 * - 進捗は `-progress pipe:1` で stdout へ流し、UI の進捗バーに繋ぐ。
 */
export function buildFastCutArgs({
  input,
  filterScript,
  output,
  options,
  target,
  hardware,
  extraInputs,
}: FastCutArgsInput): string[] {
  const codec = hardware
    ? ['-c:v', 'h264_videotoolbox', '-b:v', bitrateFor(options.quality, target.width * target.height)]
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', options.quality === 'high' ? '18' : options.quality === 'standard' ? '21' : '24'];
  return [
    '-hide_banner',
    '-nostats',
    '-progress', 'pipe:1',
    '-i', input,
    ...(extraInputs ?? []).flatMap((e) =>
      e.image
        ? ['-loop', '1', '-framerate', String(e.image.framerate), '-t', e.image.durationSec, '-i', e.path]
        : e.sequence
        ? ['-framerate', String(e.sequence.framerate), '-start_number', String(e.sequence.startNumber), '-i', e.path]
        : [...(e.loop ? ['-stream_loop', '-1'] : []), '-i', e.path],
    ),
    '-/filter_complex', filterScript,
    '-map', '[outv]',
    '-map', '[outa]',
    ...codec,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '320k',
    '-movflags', '+faststart',
    '-y', output,
  ];
}

/**
 * `-progress pipe:1` の出力から進捗を取り出す。総フレーム数は呼び出し側が持つ
 * （ffmpeg は concat 後の総尺を事前に知らせないため）。
 */
export function parseFfmpegProgress(
  chunk: string,
  total: number,
): { frames: number; total: number; percent: number } | null {
  if (total <= 0) return null;
  let last: number | null = null;
  for (const m of chunk.matchAll(/frame=\s*(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) last = n;
  }
  if (last === null) return null;
  return { frames: last, total, percent: Math.min(100, Math.round((last / total) * 100)) };
}

/**
 * 書き出した動画のフレーム数を ffprobe で数え、想定（カット後の尺）と一致するか検算する。
 * 一致すれば null、違えば注意書きを返す。数えられない場合も null（検算できないだけで失敗ではない）。
 */
export function verifyCutFrames(
  output: string,
  expectedFrames: number,
  probeFrames: (path: string) => number | null,
): string | null {
  const actual = probeFrames(output);
  if (actual === null || actual <= 0) return null;
  // 1 フレームのずれは端数（可変フレームレート素材など）で普通に起きる。
  if (Math.abs(actual - expectedFrames) <= 1) return null;
  return `書き出した動画の長さが想定と違います（想定 ${expectedFrames} フレーム / 実際 ${actual} フレーム）。カット位置がずれていないか確認してください`;
}

/**
 * nativeExport 用の厳密検算。計測不能・1 フレームの不一致も失敗として返す
 * （返り値はフォールバックの引き金。従来 verifyCutFrames の「数えられなければ成功」を引き継がない）。
 */
export function verifyCutFramesStrict(
  output: string,
  expectedFrames: number,
  probeFrames: (path: string) => number | null,
): string | null {
  const actual = probeFrames(output);
  if (actual === null || actual <= 0) {
    return '出力フレーム数を計測できませんでした（ffprobe 失敗）。検証できない出力は成功にしません';
  }
  if (actual !== expectedFrames) {
    return `出力フレーム数が想定と一致しません（想定 ${expectedFrames} / 実際 ${actual}）`;
  }
  return null;
}

/**
 * 出力の**寸法**を検収する（C-0 I-2）。フレーム数検査と同じ fail-loud
 * （計測不能も失敗＝検証できない出力を成功にしない）。
 *
 * 受入 F の事故は「フレーム数は合っているのに寸法が素材のまま」だったので、
 * `verifyCutFramesStrict` だけでは通ってしまう。contain を外した script の出力を
 * 食わせると赤になることを e2e が毎回示す（`nativeExportComposition.e2e.test.ts`）。
 */
/**
 * 出力 SAR の許容幅（C-8）。**厳密な 1 では回さない**——`force_divisible_by=2` の 1px 丸めで
 * `scale` が DAR 保存のために SAR をわずかに動かすため（実測 2026-09-03: 1920×1080 素材 →
 * 1080×1920 composition の正しい出力が **1.000823**〔= 1216:1215〕）。厳密比較にすると
 * 素材≠composition のプロジェクトが**全件 Remotion 退避**になる。
 *
 * 上限の理屈: 丸めは内容辺 d に対し最大 1px なので偏差は 1/d。実運用の最小辺 480 でも 0.0021。
 * 一方、検出対象のアナモルフィック素材は SAR 4:3 = 偏差 0.333（許容の 33 倍）・
 * DV 標準の 40:33 でも 0.212。1% は両者の間に十分な余裕をもって引ける。
 */
export const SAR_VERIFY_TOLERANCE = 0.01;

export function verifyOutputSize(
  output: string,
  expected: { width: number; height: number },
  probeSize: (path: string) => { width: number; height: number; sar?: number | null } | null,
): string | null {
  const actual = probeSize(output);
  if (actual === null || actual.width <= 0 || actual.height <= 0) {
    return '出力の寸法を計測できませんでした（ffprobe 失敗）。検証できない出力は成功にしません';
  }
  if (actual.width !== expected.width || actual.height !== expected.height) {
    return `出力の寸法が想定と一致しません（想定 ${expected.width}x${expected.height} / 実際 ${actual.width}x${actual.height}）`;
  }
  /**
   * **出力 SAR = 1:1（C-8）**。寸法が合っていても非正方画素なら**表示寸法**が想定と違う
   * （1920×1080 SAR 4:3 は 2560×1080 として表示される）。計測できない場合も失敗
   * （寸法・フレーム数と同じ fail-loud。製品経路の `probeVideoSize` は必ず数値か null を返す）。
   */
  if (typeof actual.sar !== 'number' || !Number.isFinite(actual.sar)) {
    return '出力の SAR を計測できませんでした（ffprobe 失敗）。検証できない出力は成功にしません';
  }
  if (Math.abs(actual.sar - 1) > SAR_VERIFY_TOLERANCE) {
    return `出力の SAR が 1:1 ではありません（実際 ${actual.sar}）。表示寸法が想定 ${expected.width}x${expected.height} と一致しません`;
  }
  return null;
}
