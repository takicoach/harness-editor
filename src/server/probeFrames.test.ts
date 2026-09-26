import { describe, it, expect } from 'vitest';
import { parseFrameDurations, durationsUniform, parsePacketCount, parseSubVideoProbe, parseVideoSize } from './probeFrames';

describe('parsePacketCount', () => {
  it('通常の 1 値', () => {
    expect(parsePacketCount('360\n')).toBe(360);
  });

  /**
   * ffprobe 8.1.2 実測: Remotion が焼いた mp4 では `-of csv=p=0` が `48,`（末尾に空フィールド）で
   * 返る。旧実装は Number('48,')=NaN → null で**検算が黙って無効化**されていた。
   */
  it('末尾カンマつき（Remotion 焼きの mp4 で実測）でも数える', () => {
    expect(parsePacketCount('48,\n')).toBe(48);
  });

  it('N/A・空・0 は null（計測不能を数値に化けさせない）', () => {
    expect(parsePacketCount('N/A\n')).toBeNull();
    expect(parsePacketCount('')).toBeNull();
    expect(parsePacketCount('0\n')).toBeNull();
  });
});

/**
 * C-0 焦点レビュー I-1 / M-1。`probeVideoSize` の問い合わせは
 * `stream=width,height,sample_aspect_ratio:stream_side_data=rotation` で、
 * **1 行に 3〜4 フィールド**（版によっては末尾に空フィールドや別行）で返る。
 *
 * ここが「厳密 2 フィールド」のままだと、回転メタ付き素材（iPhone/DJI）で parse が null →
 * native 全退避＋誤診断ログになり、逆に緩めすぎると**回転前の codec 寸法**で
 * composition と等値判定され受入 F（出力寸法が素材寸法のまま）が再発する。
 */
describe('parseVideoSize', () => {
  it('通常（W,H,SAR）: そのまま・exact', () => {
    expect(parseVideoSize('1920,1080,1:1\n')).toEqual({ width: 1920, height: 1080, exact: true, sar: 1 });
  });

  it('末尾に空フィールド（`1080,1920,`）でも寸法は読む・SAR 不明なので exact=false', () => {
    expect(parseVideoSize('1080,1920,\n')).toEqual({ width: 1080, height: 1920, exact: false, sar: null });
  });

  it('rotation 90/270 は width/height を swap（ffmpeg の自動回転後＝実際に復号される向き）', () => {
    expect(parseVideoSize('1920,1080,1:1,90\n')).toEqual({ width: 1080, height: 1920, exact: true, sar: 1 });
    expect(parseVideoSize('1920,1080,1:1,-90\n')).toEqual({ width: 1080, height: 1920, exact: true, sar: 1 });
    expect(parseVideoSize('1920,1080,1:1,270\n')).toEqual({ width: 1080, height: 1920, exact: true, sar: 1 });
    // 180 は swap しない。
    expect(parseVideoSize('1920,1080,1:1,180\n')).toEqual({ width: 1920, height: 1080, exact: true, sar: 1 });
  });

  it('rotation が別行で返る版でも swap する', () => {
    expect(parseVideoSize('1920,1080,1:1\n90\n')).toEqual({ width: 1080, height: 1920, exact: true, sar: 1 });
  });

  it('SAR≠1:1 / rotation が 90 の倍数でない＝「不一致扱い」（exact=false → contain を必ず入れる）', () => {
    expect(parseVideoSize('1440,1080,4:3\n')).toEqual({ width: 1440, height: 1080, exact: false, sar: 4 / 3 });
    expect(parseVideoSize('1920,1080,0:1\n')).toEqual({ width: 1920, height: 1080, exact: false, sar: null });
    expect(parseVideoSize('1920,1080,1:1,45\n')).toEqual({ width: 1920, height: 1080, exact: false, sar: 1 });
  });

  /**
   * C-8: **SAR の数値を返す**（`exact` の真偽だけでは contain の前段に SAR 正規化を
   * 入れるべきか決められない）。SAR 不明（空・`0:1`・N/A）は `null`＝正規化を入れない
   * （`scale` の `sar` 変数が 0 になり幅 0 の script を焼くため）。
   * rotation 90/270 では表示上の画素比も反転する（swap と同時に `1/sar`）。
   */
  it('SAR を数値で返す（不明は null・90/270 回転では反転）', () => {
    expect(parseVideoSize('1440,1080,4:3\n')?.sar).toBeCloseTo(4 / 3, 10);
    expect(parseVideoSize('1440,1080,3:4\n')?.sar).toBeCloseTo(3 / 4, 10);
    // 90° 回転すると幅と高さが入れ替わるので、画素比も逆数になる。
    expect(parseVideoSize('1440,1080,4:3,90\n')).toEqual({ width: 1080, height: 1440, exact: false, sar: 3 / 4 });
    expect(parseVideoSize('1920,1080,N/A\n')?.sar).toBeNull();
    expect(parseVideoSize('1920,1080,4:0\n')?.sar).toBeNull();
  });

  it('寸法が読めない・0 は null（計測不能を数値に化けさせない）', () => {
    expect(parseVideoSize('N/A,N/A,1:1\n')).toBeNull();
    expect(parseVideoSize('')).toBeNull();
    expect(parseVideoSize('0,1080,1:1\n')).toBeNull();
  });
});

describe('parseFrameDurations', () => {
  it('CSV正常系を数値配列にする', () => {
    expect(parseFrameDurations('0.033333\n0.033333\n0.033333\n')).toEqual([
      0.033333, 0.033333, 0.033333,
    ]);
  });

  it('N/A・空行混入を捨てる', () => {
    expect(parseFrameDurations('0.033333\nN/A\n\n0.033333\n')).toEqual([0.033333, 0.033333]);
  });

  it('全滅なら空配列', () => {
    expect(parseFrameDurations('N/A\nN/A\n\n')).toEqual([]);
  });
});

describe('durationsUniform', () => {
  it('一様な系列は true', () => {
    const d = Array.from({ length: 10 }, () => 1 / 30);
    expect(durationsUniform(d, 30)).toBe(true);
  });

  it('1つでも ±1ms を超えるずれがあれば false', () => {
    const d = Array.from({ length: 9 }, () => 1 / 30).concat([1 / 30 + 0.02]);
    expect(durationsUniform(d, 30)).toBe(false);
  });

  it('サンプルが minSamples 未満なら null（判定不能）', () => {
    const d = Array.from({ length: 9 }, () => 1 / 30);
    expect(durationsUniform(d, 30)).toBeNull();
  });

  it('端数fps（29.97）でも 1/29.97 近傍は true', () => {
    const fps = 30000 / 1001;
    const d = Array.from({ length: 10 }, () => 1 / fps);
    expect(durationsUniform(d, fps)).toBe(true);
  });
});

/**
 * サブ動画（videoInserts）の素材諸元（I-1 / M-3）。
 *
 * **ffprobe は列を要求順に出さない**（実測 8.1.2: 要求 `time_base,sample_aspect_ratio` に対し
 * `csv=p=0` の出力は `N/A,1/15360`）。位置で読むと SAR を time_base として解釈して
 * **全素材が退避**する（実装中に実際に踏んだ）。`key=value` 形式で並びに依存させない。
 */
describe('parseSubVideoProbe', () => {
  it('libx264 で焼いた mp4（SAR 未指定）: time_base を読み・SAR は null（＝正方画素扱い）', () => {
    expect(parseSubVideoProbe('sample_aspect_ratio=N/A\ntime_base=1/15360')).toEqual({
      timeBaseDen: 15360,
      sar: null,
    });
  });

  it('並びが逆でも同じ（位置ではなくキーで読む）', () => {
    expect(parseSubVideoProbe('time_base=1/600\nsample_aspect_ratio=1:1')).toEqual({
      timeBaseDen: 600,
      sar: 1,
    });
  });

  it('アナモルフィック（SAR 2:1）は数値で返る（M-3 の退避判定の入力）', () => {
    expect(parseSubVideoProbe('sample_aspect_ratio=2:1\ntime_base=1/12800')).toEqual({
      timeBaseDen: 12800,
      sar: 2,
    });
  });

  it('time_base が読めない・分子が 1 でないなら null（分からないまま canon 写像を掛けない）', () => {
    expect(parseSubVideoProbe('time_base=N/A')).toBeNull();
    expect(parseSubVideoProbe('time_base=1001/30000')).toBeNull();
    expect(parseSubVideoProbe('')).toBeNull();
  });
});
