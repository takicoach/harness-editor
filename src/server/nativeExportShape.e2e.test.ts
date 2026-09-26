import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAudioMix } from './nativeExportAudio';
import { applyShapeOverlays, type ShapeOverlay } from './nativeExportVideo';
import { buildCutFilterScript, buildFastCutArgs } from './fastCutRender';
import { probeFrameCount } from './probeFrames';
import { pcmWindowRms } from './renderCompare';
import { resolveFfmpegBin } from './resolveFfmpeg';
import { rasterizeShape } from './shapeRaster';
import { sec } from './ffmpegTime';
import type { ShapeSegment } from '../core/types';

/**
 * 図形オーバーレイ（InsertShape）の実 ffmpeg 統合テスト（M1d T5）。
 * 既存 e2e（nativeExportDucking.e2e.test.ts・nativeExportSe.e2e.test.ts）と同じ流儀で、
 * planFastCut（プロジェクト fixture）は経由せず、buildCutFilterScript → applyAudioMix →
 * applyShapeOverlays → buildFastCutArgs を直接合成して実 ffmpeg を1回だけ回す。
 * 理由: 既存3本の e2e が全て同じ「直接合成」流儀に統一されており（プロジェクト fixture
 * 不要）、fastCutPlan 経由にすると project fixture の用意（cutData/shapeData/public 配置）が
 * 増えるだけで検証したい対象（フィルタスクリプトの実 ffmpeg 受理とピクセル合成）は変わらない。
 *
 * fixture 設計（T3 レビューの実測知見・ブリーフ「計測上の注意」を反映）:
 * - 背景 color=0x004400（R0,G68,B0）・640x360・fps=30
 * - 図形は rect・thickness='thick'（360*0.016=5.76→round 6px）・color #FFCC00（SHAPE_COLORS の
 *   黄・R255,G204,B0）。実測で判明した追加事項: overlay の既定 format=yuv420 は「合成前に
 *   4:2:0化」に加えて RGB↔YUV 変換そのものに数値誤差を持つ（libswscale の固定小数点丸め）。
 *   #FF3B30（赤）で検証したところ α=1（完全不透明・ブレンドなし）でも G/B が数単位ズレる
 *   （実測 (255,59,48)→(255,55,43)、diff (0,4,5)）ことを確認した。これは shape 合成コードの
 *   バグではなく yuv420p 変換自体の丸め（`format=yuv420p` 単体・overlay 経由のどちらでも
 *   同じズレが再現し、`overlay=...:format=rgb`（YUV変換を回避）にすると diff (0,0,0) に戻る
 *   ことで確認済み）。SHAPE_COLORS の6色を同条件で実測した結果、#FFCC00 と #FFFFFF は
 *   diff (0,0,0)（YUV 往復が可逆な色域）だったため、本ファイルは #FFCC00 を採用する
 *   （実装コードの色選択肢を制約するものではなく、あくまで E2E fixture の色選定）
 * - 観測点は矩形の上辺中央 (320,72)（rectY=72 ちょうど・水平辺の中央・2x2 クロマブロックが
 *   完全に stroke 内に収まる位置）。矩形は x1=0.2,y1=0.2,x2=0.8,y2=0.8 → rectX=128,rectY=72,
 *   rectW=384,rectH=216（640x360 に対して shapeSvgGeometry で機械算出）
 * - 書き出し quality は 'high'（libx264 crf=18）を使う。crf=21（'standard'）では圧縮由来の
 *   追加ズレが乗り、D<16(geq) の frame34 で B チャンネルが ±5 を超えて RED になることを確認
 *   したため（実測 B=18.25 vs 期待23.91・diff5.66）、圧縮由来ノイズを減らす目的で選択した
 * - 量子化丸め: fade フィルタ（D>=16）は四捨五入・geq（D<16）は切り捨て（T3 実測知見）。
 *   例: α 期待127.5 → fade 128 / geq 127。以下の手計算コメントはこれを反映する
 *
 * 合成式（overlay の基本式）: out = bg*(255-a)/255 + fg*a/255（a は 0..255 のアルファ値）
 */
const ffmpeg = resolveFfmpegBin();

const BG = { r: 0, g: 68, b: 0 }; // 0x004400
const FG = { r: 255, g: 204, b: 0 }; // #FFCC00（YUV 往復可逆・実測 diff (0,0,0)）
const EDGE = { x: 320, y: 72 }; // 上辺中央
const FAR_BG = { x: 10, y: 10 }; // 図形から十分離れた背景点

const RECT_SHAPE_BASE = {
  kind: 'rect' as const,
  x1: 0.2,
  y1: 0.2,
  x2: 0.8,
  y2: 0.8,
  color: '#FFCC00',
  thickness: 'thick' as const,
  opacity: 1,
};

function composite(bg: number, fg: number, alpha255: number): number {
  return (bg * (255 - alpha255) + fg * alpha255) / 255;
}

/** overlay 合成後の 2x2 クロマブロックを平均した RGB を返す（select フィルタでフレーム番号厳密指定）。 */
function extractBlockAvgRgb(
  bin: string,
  videoPath: string,
  frame: number,
  x: number,
  y: number,
  size = 2,
): { r: number; g: number; b: number } {
  const filter = `select=eq(n\\,${frame}),crop=${size}:${size}:${x}:${y}`;
  const buf = execFileSync(
    bin,
    [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-vf', filter,
      '-fps_mode', 'passthrough',
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-y', '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const n = size * size;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    r += buf[i * 3]!;
    g += buf[i * 3 + 1]!;
    b += buf[i * 3 + 2]!;
  }
  return { r: r / n, g: g / n, b: b / n };
}

function expectClose(actual: number, expected: number, tol: number, label: string): void {
  const diff = Math.abs(actual - expected);
  expect(diff, `${label}: 実測${actual.toFixed(2)} 期待${expected.toFixed(2)} 差${diff.toFixed(2)} 許容${tol}`).toBeLessThanOrEqual(tol);
}

describe.skipIf(!ffmpeg.ok)('nativeExport 図形オーバーレイ（実 ffmpeg 統合）', () => {
  it('区間内実測・フェード完了・フェード中間・残像なし・境界フレーム（D=60・fade 対経路）', () => {
    const bin = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';
    const dir = mkdtempSync(join(tmpdir(), 'native-export-shape-e2e-d60-'));
    try {
      const mainPath = join(dir, 'main.mp4');
      const shapePngPath = join(dir, 'shape.png');
      const outPath = join(dir, 'out.mp4');
      const scriptPath = join(dir, 'filter.txt');

      // 背景: 640x360・30fps・4秒（120 frame）。frame100 まで無傷であることを見るため十分な尺。
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=0x004400:size=640x360:rate=30:duration=4',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:duration=4',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        mainPath,
      ]);

      const shape: ShapeSegment = { id: 1, startFrame: 30, endFrame: 90, ...RECT_SHAPE_BASE };
      writeFileSync(shapePngPath, rasterizeShape(shape, 640, 360));

      const cutScript = buildCutFilterScript([{ start: 0, end: 120 }], 30);
      const overlays: ShapeOverlay[] = [{ startFrame: 30, endFrame: 90, durationFrames: 60 }];
      const script = applyShapeOverlays(cutScript, overlays, 30, 1);
      writeFileSync(scriptPath, script);

      const target = { width: 640, height: 360 };
      const options = { resolution: 'full' as const, quality: 'high' as const };

      execFileSync(bin, buildFastCutArgs({
        input: mainPath,
        filterScript: scriptPath,
        output: outPath,
        options,
        target,
        hardware: false,
        extraInputs: [{ path: shapePngPath, image: { framerate: 30, durationSec: sec(60, 30) } }],
      }));

      expect(probeFrameCount(outPath)).toBe(120);

      // --- 1. 区間内ピクセル実測（frame60: 区間中央・D>=16 で fade-in(8)/fade-out(52) の外＝α=1 全開） ---
      // N(クリップ相対)=60-30=30。inFade=min(30/8,1)=1・outFade=(60-30)/8=3.75→clip1。α=1（丸め不要）。
      // 合成 = bg*0 + fg*1 = fg（完全一致）。
      const px60Edge = extractBlockAvgRgb(bin, outPath, 60, EDGE.x, EDGE.y);
      expectClose(px60Edge.r, FG.r, 3, 'frame60 edge R');
      expectClose(px60Edge.g, FG.g, 3, 'frame60 edge G');
      expectClose(px60Edge.b, FG.b, 3, 'frame60 edge B');
      const px60Far = extractBlockAvgRgb(bin, outPath, 60, FAR_BG.x, FAR_BG.y);
      expectClose(px60Far.r, BG.r, 3, 'frame60 far R');
      expectClose(px60Far.g, BG.g, 3, 'frame60 far G');
      expectClose(px60Far.b, BG.b, 3, 'frame60 far B');
      // 持ち越し①: 矩形の内側中心（fill=none なので stroke 域内の中心点は透明のはず）が
      // 背景色と一致すること。fill=none が退化して塗りつぶしになる変異（この e2e が
      // 実 ffmpeg 経由で捕捉すべき）をここで検出する。
      // rect: x1=0.2,y1=0.2,x2=0.8,y2=0.8 → rectX=128,rectY=72,rectW=384,rectH=216（640x360）
      // → 中心 (128+192, 72+108) = (320,180)。
      const px60Inside = extractBlockAvgRgb(bin, outPath, 60, 320, 180);
      expectClose(px60Inside.r, BG.r, 3, 'frame60 内側中心 R（fill=none 退化検出）');
      expectClose(px60Inside.g, BG.g, 3, 'frame60 内側中心 G（fill=none 退化検出）');
      expectClose(px60Inside.b, BG.b, 3, 'frame60 内側中心 B（fill=none 退化検出）');

      // --- 区間外フレーム（残像なし＝eof_action=pass の検証） ---
      // frame10（区間開始前）・frame100（区間終了後）は enable が false なので edge 点も背景一致。
      for (const frame of [10, 100]) {
        const px = extractBlockAvgRgb(bin, outPath, frame, EDGE.x, EDGE.y);
        expectClose(px.r, BG.r, 3, `frame${frame} edge R（残像なし）`);
        expectClose(px.g, BG.g, 3, `frame${frame} edge G（残像なし）`);
        expectClose(px.b, BG.b, 3, `frame${frame} edge B（残像なし）`);
      }

      // --- 2. フェード実測（frame34: N=34-30=4・fadeOpacity=min(4/8,56/8)=0.5） ---
      // α_frac=0.5 → α255=127.5 → fade 対は四捨五入で 128。FG=(255,204,0)・BG=(0,68,0)。
      // R = bg*(255-128)/255 + fg*128/255 = 0*127/255 + 255*128/255 = 128.0
      // G = 68*127/255 + 204*128/255 = (8636+26112)/255 = 136.27
      // B = 0（bg・fg とも B=0 なので合成値も常に 0）
      const px34 = extractBlockAvgRgb(bin, outPath, 34, EDGE.x, EDGE.y);
      const a34 = 128;
      expectClose(px34.r, composite(BG.r, FG.r, a34), 5, 'frame34 (fade 半分) R');
      expectClose(px34.g, composite(BG.g, FG.g, a34), 5, 'frame34 (fade 半分) G');
      expectClose(px34.b, composite(BG.b, FG.b, a34), 5, 'frame34 (fade 半分) B');

      // --- 4. 境界フレーム（終了側: [start,end) 排他・半フレーム中点の実証） ---
      // frame89: N=59。inFade=min(59/8,1)=1・outFade=(60-59)/8=0.125→α_frac=0.125→α255=31.875
      // → 四捨五入で 32。まだ enable 域内で可視（消えていない）。
      const px89 = extractBlockAvgRgb(bin, outPath, 89, EDGE.x, EDGE.y);
      const a89 = 32;
      expectClose(px89.r, composite(BG.r, FG.r, a89), 5, 'frame89 (境界直前) R');
      expectClose(px89.g, composite(BG.g, FG.g, a89), 5, 'frame89 (境界直前) G');
      expectClose(px89.b, composite(BG.b, FG.b, a89), 5, 'frame89 (境界直前) B');
      // frame90: enable=gte(t,89.5/30)*lt(t,89.5/30) → t=90/30=3.0 は lt(3.0, sec(89.5,30)=2.983333)
      // を満たさず enable=false。overlay 非適用＝背景そのまま（[start,end) の end 排他の実証）。
      const px90 = extractBlockAvgRgb(bin, outPath, 90, EDGE.x, EDGE.y);
      expectClose(px90.r, BG.r, 3, 'frame90 (境界=消えている) R');
      expectClose(px90.g, BG.g, 3, 'frame90 (境界=消えている) G');
      expectClose(px90.b, BG.b, 3, 'frame90 (境界=消えている) B');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D<16 の min 合成実測（geq 経路）・積との有意差・開始境界の実証', () => {
    const bin = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';
    const dir = mkdtempSync(join(tmpdir(), 'native-export-shape-e2e-d8-'));
    try {
      const mainPath = join(dir, 'main.mp4');
      const shapePngPath = join(dir, 'shape.png');
      const outPath = join(dir, 'out.mp4');
      const scriptPath = join(dir, 'filter.txt');

      // 背景: 640x360・30fps・2秒（60 frame）。frame38 までを見るのに十分。
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=0x004400:size=640x360:rate=30:duration=2',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:duration=2',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        mainPath,
      ]);

      const shape: ShapeSegment = { id: 1, startFrame: 30, endFrame: 38, ...RECT_SHAPE_BASE };
      writeFileSync(shapePngPath, rasterizeShape(shape, 640, 360));

      const cutScript = buildCutFilterScript([{ start: 0, end: 60 }], 30);
      const overlays: ShapeOverlay[] = [{ startFrame: 30, endFrame: 38, durationFrames: 8 }];
      const script = applyShapeOverlays(cutScript, overlays, 30, 1);
      writeFileSync(scriptPath, script);

      const target = { width: 640, height: 360 };
      const options = { resolution: 'full' as const, quality: 'high' as const };

      execFileSync(bin, buildFastCutArgs({
        input: mainPath,
        filterScript: scriptPath,
        output: outPath,
        options,
        target,
        hardware: false,
        extraInputs: [{ path: shapePngPath, image: { framerate: 30, durationSec: sec(8, 30) } }],
      }));

      expect(probeFrameCount(outPath)).toBe(60);

      // --- 3. D<16 の min 合成実測（frame34: N=34-30=4・D=8） ---
      // min(4/8,(8-4)/8) = min(0.5,0.5) = 0.5 → α_frac=0.5 → α255=127.5 → geq は切り捨てで 127。
      // FG=(255,204,0)・BG=(0,68,0)。R=255*127/255=127.0 / G=(68*128+204*127)/255=135.73 / B=0。
      const px34 = extractBlockAvgRgb(bin, outPath, 34, EDGE.x, EDGE.y);
      const aMin = 127;
      const expectedMinR = composite(BG.r, FG.r, aMin);
      expectClose(px34.r, expectedMinR, 5, 'frame34 (geq min) R');
      expectClose(px34.g, composite(BG.g, FG.g, aMin), 5, 'frame34 (geq min) G');
      expectClose(px34.b, composite(BG.b, FG.b, aMin), 5, 'frame34 (geq min) B');
      // 積 (fadeIn×fadeOut=0.5×0.5=0.25) だった場合の合成値（regression 検出用）:
      // α_frac=0.25→α255=63.75→切り捨て63。R=255*63/255=63.0。min 期待(127.0)との差は64、
      // ±5 の許容を大きく超える。geq 経路が積に退化していないことを同時に証明する。
      const aProd = 63;
      const expectedProdR = composite(BG.r, FG.r, aProd);
      expect(
        Math.abs(px34.r - expectedProdR),
        `frame34 R が積(0.25)合成値(${expectedProdR.toFixed(2)})に退化していないこと（実測${px34.r.toFixed(2)}）`,
      ).toBeGreaterThan(15);

      // --- 4. 境界フレーム（開始側: [start,end) 排他・半フレーム中点の実証） ---
      // 持ち越し③: enable 式の開始境界（半フレームずらしの厳密な文字列）の担保は
      // fastCutPlan.test.ts の unit テスト（enable 実値の pin・例えば
      // 'M1d: 図形オーバーレイの配線' 配下の各テストの `enable='gte(t,...)*lt(t,...)'`
      // 全一致アサーション）にある。ここ（e2e）は実 ffmpeg がその式をピクセルどおりに
      // 解釈することの実証であり、式そのものの正しさは unit 側の pin が担保する。
      // frame29（区間開始前）: enable=false → 背景一致。
      const px29 = extractBlockAvgRgb(bin, outPath, 29, EDGE.x, EDGE.y);
      expectClose(px29.r, BG.r, 3, 'frame29 (開始前) R');
      expectClose(px29.g, BG.g, 3, 'frame29 (開始前) G');
      expectClose(px29.b, BG.b, 3, 'frame29 (開始前) B');
      // frame30（区間開始）: enable=true だが N=0 で fadeOpacity(0,8,8)=min(0,1)=0 → α=0 で
      // 合成上は背景と一致（正典 fadeOpacity の frame=0 で 0 という仕様どおり）。
      const px30 = extractBlockAvgRgb(bin, outPath, 30, EDGE.x, EDGE.y);
      expectClose(px30.r, BG.r, 3, 'frame30 (開始・α=0) R');
      expectClose(px30.g, BG.g, 3, 'frame30 (開始・α=0) G');
      expectClose(px30.b, BG.b, 3, 'frame30 (開始・α=0) B');
      // frame31（N=1）: min(1/8,7/8)=0.125→α255=floor(31.875)=31。可視差が出る＝区間が
      // 開始直後から実際に効いている証拠（frame29 の厳密背景一致との対比）。
      const px31 = extractBlockAvgRgb(bin, outPath, 31, EDGE.x, EDGE.y);
      const aStart = 31;
      expectClose(px31.r, composite(BG.r, FG.r, aStart), 5, 'frame31 (開始直後) R');
      expectClose(px31.g, composite(BG.g, FG.g, aStart), 5, 'frame31 (開始直後) G');
      expectClose(px31.b, composite(BG.b, FG.b, aStart), 5, 'frame31 (開始直後) B');
      // frame37（N=7）: min(7/8,1/8)=0.125（frame31 と対称）→ 同じ α255=31。終了直前も可視。
      const px37 = extractBlockAvgRgb(bin, outPath, 37, EDGE.x, EDGE.y);
      expectClose(px37.r, composite(BG.r, FG.r, aStart), 5, 'frame37 (終了直前) R');
      expectClose(px37.g, composite(BG.g, FG.g, aStart), 5, 'frame37 (終了直前) G');
      expectClose(px37.b, composite(BG.b, FG.b, aStart), 5, 'frame37 (終了直前) B');
      // frame38（=end・排他境界）: enable=false → 背景一致（消えている）。
      const px38 = extractBlockAvgRgb(bin, outPath, 38, EDGE.x, EDGE.y);
      expectClose(px38.r, BG.r, 3, 'frame38 (終了=消えている) R');
      expectClose(px38.g, BG.g, 3, 'frame38 (終了=消えている) G');
      expectClose(px38.b, BG.b, 3, 'frame38 (終了=消えている) B');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 実規模回帰（#182 規律）: 図形60個（各 D=8＝geq 経路・区間を2 frame ずつずらして配置）の
   * filter script を実 ffmpeg が受理し出力が生成されることを検証する。geq は全画素式評価で
   * 重いため、D<16 図形を敢えて多数使い性能を観察する（所要時間は report に記録）。
   * ピクセル検証は frame1（shape[0] のみが単独で有効な唯一の窓・N=1）の1点のみ。
   */
  // 60図形・geq 経路の実 ffmpeg 実行は単体で数秒だが、フルスイート並列実行下では既定の
  // 5000ms を超えることがあるため明示的にタイムアウトを延ばす（他 e2e はこの余地を使わず
  // 収まっているため個別指定に留める）。
  it('実規模回帰: 図形60個（geq 経路）の filter script が実 ffmpeg に受理される', () => {
    const bin = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';
    const dir = mkdtempSync(join(tmpdir(), 'native-export-shape-e2e-scale60-'));
    try {
      const mainPath = join(dir, 'main.mp4');
      const shapePngPath = join(dir, 'shape.png');
      const outPath = join(dir, 'out.mp4');
      const scriptPath = join(dir, 'filter.txt');

      // 背景: 640x360・30fps・5秒（150 frame）。最終図形の区間 [118,126) を包含する。
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=0x004400:size=640x360:rate=30:duration=5',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:duration=5',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        mainPath,
      ]);

      // 60 個とも同一ジオメトリ・同一 PNG を使い回す（受理検証が目的で内容の多様性は不要）。
      const shape: ShapeSegment = { id: 1, startFrame: 0, endFrame: 8, ...RECT_SHAPE_BASE };
      writeFileSync(shapePngPath, rasterizeShape(shape, 640, 360));

      const overlays: ShapeOverlay[] = Array.from({ length: 60 }, (_, i) => ({
        startFrame: i * 2,
        endFrame: i * 2 + 8,
        durationFrames: 8,
      }));
      const cutScript = buildCutFilterScript([{ start: 0, end: 150 }], 30);
      const script = applyShapeOverlays(cutScript, overlays, 30, 1);
      writeFileSync(scriptPath, script);

      const target = { width: 640, height: 360 };
      const options = { resolution: 'full' as const, quality: 'high' as const };
      const extraInputs = overlays.map(() => ({
        path: shapePngPath,
        image: { framerate: 30, durationSec: sec(8, 30) },
      }));

      const args = buildFastCutArgs({
        input: mainPath,
        filterScript: scriptPath,
        output: outPath,
        options,
        target,
        hardware: false,
        extraInputs,
      });

      const startedAt = Date.now();
      execFileSync(bin, args, { maxBuffer: 64 * 1024 * 1024 });
      const elapsedMs = Date.now() - startedAt;
      // eslint-disable-next-line no-console
      console.log(`[nativeExportShape.e2e] 実規模回帰(60図形・geq 経路) 所要時間: ${elapsedMs}ms`);

      expect(probeFrameCount(outPath)).toBe(150);

      // frame1: shape[0]（区間[0,8)）だけが有効な窓（shape[1] は開始2で未発火）。N=1。
      // min(1/8,7/8)=0.125→α255=floor(31.875)=31（D=8<16・geq 経路）。
      const px1 = extractBlockAvgRgb(bin, outPath, 1, EDGE.x, EDGE.y);
      const a1 = 31;
      expectClose(px1.r, composite(BG.r, FG.r, a1), 5, 'scale60 frame1 R');
      expectClose(px1.g, composite(BG.g, FG.g, a1), 5, 'scale60 frame1 G');
      expectClose(px1.b, composite(BG.b, FG.b, a1), 5, 'scale60 frame1 B');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  /**
   * 音声併用（SE + 図形）: applyAudioMix の後に applyShapeOverlays を適用したとき、
   * SE の音声添字（[i+1:a]）が図形 PNG 入力の追加で1文字もズレないこと（実写検証）。
   * SE は既存 nativeExportSe.e2e.test.ts と同型（1760Hz・0.5秒・[30,45) frame＝1.0-1.5s）。
   * 図形は case1（D=60・[30,90)）を流用し、frame60 の edge ピクセルも再確認する。
   */
  it('SE と図形を併用しても音声・映像とも実測どおりに合成される（添字ズレの実写検証）', () => {
    const bin = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';
    const dir = mkdtempSync(join(tmpdir(), 'native-export-shape-e2e-audio-'));
    try {
      const mainPath = join(dir, 'main.mp4');
      const sePath = join(dir, 'se.wav');
      const shapePngPath = join(dir, 'shape.png');
      const outPath = join(dir, 'out.mp4');
      const scriptPath = join(dir, 'filter.txt');

      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=0x004400:size=640x360:rate=30:duration=4',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:duration=4',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        mainPath,
      ]);
      execFileSync(bin, [
        '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=1760:duration=0.5',
        sePath,
      ]);

      const shape: ShapeSegment = { id: 1, startFrame: 30, endFrame: 90, ...RECT_SHAPE_BASE };
      writeFileSync(shapePngPath, rasterizeShape(shape, 640, 360));

      const cutScript = buildCutFilterScript([{ start: 0, end: 120 }], 30);
      // 音声側: SE 1個（inputIndexBase を1つ占有）→ inputIndexBase = 1(main) + 1(se) = 2。
      const withSe = applyAudioMix(cutScript, [{ startFrame: 30, endFrame: 45, volume: 1 }], 30);
      const overlays: ShapeOverlay[] = [{ startFrame: 30, endFrame: 90, durationFrames: 60 }];
      const script = applyShapeOverlays(withSe, overlays, 30, 2);
      writeFileSync(scriptPath, script);

      const target = { width: 640, height: 360 };
      const options = { resolution: 'full' as const, quality: 'high' as const };

      execFileSync(bin, buildFastCutArgs({
        input: mainPath,
        filterScript: scriptPath,
        output: outPath,
        options,
        target,
        hardware: false,
        extraInputs: [
          { path: sePath },
          { path: shapePngPath, image: { framerate: 30, durationSec: sec(60, 30) } },
        ],
      }));

      expect(probeFrameCount(outPath)).toBe(120);

      // 音声: SE 窓 [1.0s,1.5s] の RMS が SE 無し窓 [0.2s,0.7s] より 1.15 倍超（既存 SE e2e と同基準）。
      const pcm = execFileSync(
        bin,
        ['-hide_banner', '-i', outPath, '-map', 'a:0', '-f', 's16le', '-ac', '2', '-ar', '48000', '-'],
        { maxBuffer: 512 * 1024 * 1024 },
      );
      const seWindowRms = pcmWindowRms(pcm, 48000, 2, 1.0, 1.5);
      const noSeWindowRms = pcmWindowRms(pcm, 48000, 2, 0.2, 0.7);
      expect(seWindowRms).toBeGreaterThan(noSeWindowRms * 1.15);

      // 映像: frame60 edge は case1 と同じ完全一致（α=1・添字ズレがなければ不変のはず）。
      const px60 = extractBlockAvgRgb(bin, outPath, 60, EDGE.x, EDGE.y);
      expectClose(px60.r, FG.r, 3, 'audio併用 frame60 edge R');
      expectClose(px60.g, FG.g, 3, 'audio併用 frame60 edge G');
      expectClose(px60.b, FG.b, 3, 'audio併用 frame60 edge B');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
