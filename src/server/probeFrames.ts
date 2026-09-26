import { execFileSync } from 'node:child_process';
import { ffprobeFromFfmpeg, resolveFfmpegBin } from './resolveFfmpeg';

/**
 * `-of csv=p=0` の 1 行から nb_read_packets を取り出す（純関数）。
 *
 * **末尾のカンマを落とす**（2026-09-02 実測・ffprobe 8.1.2）: ffmpeg が作った mp4 は `360` と
 * 出るのに、Remotion が焼いた mp4 では同じ問い合わせが **`48,`**（空フィールドが 1 個増える）で
 * 返る。`Number('48,')` は NaN なので、旧実装はこの手の入力を丸ごと「計測不能（null）」に
 * していた＝**フレーム数の検算が黙って無効化される**（T4 の mp4 基準線で発覚）。
 */
export function parsePacketCount(out: string): number | null {
  const first = out.trim().split(/[,\s]+/)[0] ?? '';
  const n = Number(first);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 動画の総フレーム数を ffprobe で数える（パケット数え上げ）。
 * 取得できない場合は null（検算をスキップするだけで、書き出し自体は成功扱い）。
 */
export function probeFrameCount(path: string): number | null {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) return null;
  try {
    const out = execFileSync(
      ffprobeFromFfmpeg(ffmpeg.bin),
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-count_packets',
        '-show_entries', 'stream=nb_read_packets',
        '-of', 'csv=p=0',
        path,
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    return parsePacketCount(out);
  } catch {
    return null;
  }
}

/**
 * 映像の r_frame_rate / avg_frame_rate を返す（読めなければ null）。
 * 両者が乖離していれば VFR の疑い＝nativeExport 非対応として扱う。
 */
export function probeFrameRates(path: string): { r: number; avg: number } | null {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) return null;
  try {
    const out = execFileSync(
      ffprobeFromFfmpeg(ffmpeg.bin),
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=r_frame_rate,avg_frame_rate',
        '-of', 'csv=p=0',
        path,
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    const [rRaw, avgRaw] = out.trim().split(',');
    const parse = (s: string | undefined): number | null => {
      if (!s) return null;
      const [num, den] = s.split('/').map(Number);
      const n = num ?? NaN;
      const d = den ?? NaN;
      if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
      return n / d;
    };
    const r = parse(rRaw);
    const avg = parse(avgRaw);
    return r !== null && avg !== null ? { r, avg } : null;
  } catch {
    return null;
  }
}

/** ffprobe の packet=duration_time CSV 出力を数値配列にする（N/A・空行・非有限は捨てる）。 */
export function parseFrameDurations(out: string): number[] {
  return out
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** 全パケット長が 1/fps ±1ms に収まるか。サンプルが minSamples 未満なら null（判定不能）。 */
export function durationsUniform(
  durations: readonly number[],
  fps: number,
  minSamples = 10,
): boolean | null {
  if (durations.length < minSamples) return null;
  const expected = 1 / fps;
  return durations.every((d) => Math.abs(d - expected) <= 0.001);
}

/**
 * 先頭 ~5 秒のパケット長を実測して CFR らしさを検査する。
 * VFR は平均レートが公称と一致していても個々のフレーム長が揺れるため、r/avg 比較の
 * 素通し（平均一致 VFR）をここで捕まえる。読めない・サンプル不足は null
 * （呼び出し側が安全側 = nativeExport 非対応に倒す）。
 */
export function probeUniformFrameDurations(path: string, fps: number): boolean | null {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) return null;
  try {
    const out = execFileSync(
      ffprobeFromFfmpeg(ffmpeg.bin),
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-read_intervals', '%+5',
        '-show_entries', 'packet=duration_time',
        '-of', 'csv=p=0',
        path,
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    return durationsUniform(parseFrameDurations(out), fps);
  } catch {
    return null;
  }
}

/** 素材の実寸（`exact=false` は「表示寸法を読み切れていない」＝ contain を必ず入れる側へ倒す印）。 */
export interface ProbedVideoSize {
  width: number;
  height: number;
  /**
   * width/height が**実際に復号される表示寸法**として信頼できるか。
   * SAR≠1:1（非正方画素）・rotation が 90 の倍数でない・SAR が読めない場合は false。
   */
  exact: boolean;
  /**
   * 標本アスペクト比（SAR）の数値（C-8）。`1` が正方画素・**読めなければ `null`**。
   * `exact` の真偽だけでは「非正方画素だから表示寸法へ正規化する」のか
   * 「回転が読めないから安全側に倒しただけ」なのかを区別できないので数値で持つ。
   * rotation 90/270 で width/height を swap するときは画素比も逆数になる。
   */
  sar: number | null;
}

/**
 * `-show_entries stream=width,height,sample_aspect_ratio:stream_side_data=rotation -of csv=p=0`
 * の出力を**表示寸法**にする（純関数・不正は null）。
 *
 * 版によって形が揺れる（ffprobe 8.1.2 実測）ので、厳密な列数を仮定しない:
 *   - `1920,1080,1:1` / `1920,1080,1:1,90`（同一行に rotation）
 *   - `1080,1920,`（**末尾に空フィールド**。`parsePacketCount` と同じ現象）
 *   - rotation が**別行**で返る版
 *
 * 厳密 2 列の正規表現に戻すと、回転メタつき素材（iPhone/DJI）で null → native 全退避 +
 * 誤診断ログになる。逆に列を無視して先頭 2 個だけ拾うと、**回転前の codec 寸法**で
 * composition と等値判定され受入 F（出力が素材寸法のまま）が再発する。だから
 * **rotation で swap し、読み切れない要素があれば `exact=false`** に倒す。
 *
 * swap の根拠: ffmpeg CLI は復号時に display matrix を見て自動回転する（実測: 1920×1080 に
 * `-display_rotation 90` を載せた mp4 から 1 フレーム取り出すと 1080×1920 の PNG が出る）。
 * つまりフィルタグラフに流れるのは **swap 後**の絵。
 */
export function parseVideoSize(out: string): ProbedVideoSize | null {
  const fields: string[] = [];
  let dims: string[] | null = null;
  for (const line of out.split('\n').map((s) => s.trim())) {
    if (line.length === 0) continue;
    const cols = line.split(',');
    if (dims === null && /^\d+$/.test(cols[0] ?? '') && /^\d+$/.test(cols[1] ?? '')) {
      dims = cols;
      continue;
    }
    fields.push(...cols);
  }
  if (dims === null) return null;
  const rawW = Number(dims[0]);
  const rawH = Number(dims[1]);
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) return null;

  // SAR: '1:1' だけが「正方画素＝寸法そのままが表示寸法」。空・N/A・0:1（不明）・その他比は不一致扱い。
  const sarRaw = (dims[2] ?? '').trim();
  let exact = sarRaw === '1:1';
  // 数値化（C-8）。'0:1'・空・N/A・分母 0 は「不明」＝ null（0 を SAR 値として扱わない）。
  let sar: number | null = null;
  const sarParts = /^(\d+):(\d+)$/.exec(sarRaw);
  if (sarParts !== null) {
    const num = Number(sarParts[1]);
    const den = Number(sarParts[2]);
    if (num > 0 && den > 0) sar = num / den;
  }

  // rotation: 同一行の 4 列目、または別行（版差）。無ければ 0（回転なし＝通常の素材）。
  const rotRaw = [dims[3] ?? '', ...fields]
    .map((s) => s.trim())
    .find((s) => s.length > 0 && s !== 'N/A');
  let swap = false;
  if (rotRaw !== undefined) {
    const rot = Number(rotRaw);
    if (!Number.isFinite(rot)) {
      exact = false;
    } else {
      const norm = ((Math.round(rot) % 360) + 360) % 360;
      if (norm === 90 || norm === 270) swap = true;
      else if (norm !== 0 && norm !== 180) exact = false; // 90 の倍数でない回転は幾何が読めない
    }
  }
  return swap
    ? { width: rawH, height: rawW, exact, sar: sar === null ? null : 1 / sar }
    : { width: rawW, height: rawH, exact, sar };
}

/**
 * 素材（映像 1 本目）の**実寸**を ffprobe で引く（C-0）。読めなければ null。
 *
 * `videoConfig.resolution` は **composition（合成解像度）**であって素材寸法ではない。
 * 両者が食い違うプロジェクト（DJI ショート: 素材 1728×3072 / composition 1080×1920）で
 * native が素材寸法のまま書き出し、オーバーレイだけ composition 幾何で乗る事故が起きた
 * （受入 F・2026-09-03）。呼び出し側は null を **plan null（Remotion 退避）**として扱う。
 *
 * 同名の `transitionFrameCompare.probeVideoSize` は **e2e 用（読めなければ throw）**。
 * 製品経路は「計測不能なら安全側へ倒す」ため null を返すこちらを使う。
 * **parse と ffprobe 引数はこの 1 箇所が正本**（C-7 M-8）——e2e 側は
 * `videoSizeProbeArgs` と `parseVideoSize` を import して同じ写像を通す（兄弟実装は解消済み）。
 */
export function videoSizeProbeArgs(path: string): string[] {
  return [
    '-v', 'error',
    '-select_streams', 'v:0',
    // 回転メタ（display matrix）と SAR も同時に引く（C-0 I-1）。
    '-show_entries', 'stream=width,height,sample_aspect_ratio:stream_side_data=rotation',
    '-of', 'csv=p=0',
    path,
  ];
}

export function probeVideoSize(path: string): ProbedVideoSize | null {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) return null;
  try {
    const out = execFileSync(
      ffprobeFromFfmpeg(ffmpeg.bin),
      videoSizeProbeArgs(path),
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    return parseVideoSize(out.trim());
  } catch {
    return null;
  }
}

/** サブ動画（videoInserts）の canon 写像に要る素材諸元（I-1 / M-3）。 */
export interface ProbedSubVideo {
  /** time_base の分母（`1/den`）。canon 写像の PTS 量子化はこの粒度で行われる。 */
  timeBaseDen: number;
  /** 標本アスペクト比。`1` が正方画素・**読めなければ `null`**（`parseVideoSize` と同じ規約）。 */
  sar: number | null;
}

/**
 * `-show_entries stream=time_base,sample_aspect_ratio -of default=noprint_wrappers=1` の出力を読む
 * （純関数・不正は null）。
 *
 * **`csv=p=0` は使わない**: ffprobe は列を要求順ではなく内部の並びで出すため（実測: 要求
 * `time_base,sample_aspect_ratio` に対し出力 `N/A,1/15360`）、位置で読むと SAR を time_base として
 * 解釈して全素材が退避する。`key=value` 形式なら並びに依存しない。
 *
 * `time_base` は `1/600` の形（mp4 の timescale）。分子が 1 でない版・読めない版は null にして
 * 呼び出し側を安全側（Remotion 退避）へ倒す——**分からないまま canon 写像を掛けない**。
 * SAR は `N/A`（未指定）だと `null`。ffmpeg は未指定 SAR を正方画素として扱うので、
 * 呼び出し側は `null` を「正方画素」と同じ扱いにしてよい（**既知の非 1:1 だけ**を弾く）。
 */
export function parseSubVideoProbe(out: string): ProbedSubVideo | null {
  const fields = new Map<string, string>();
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const tb = /^(\d+)\/(\d+)$/.exec(fields.get('time_base') ?? '');
  if (tb === null) return null;
  const num = Number(tb[1]);
  const den = Number(tb[2]);
  if (num !== 1 || !Number.isInteger(den) || den <= 0) return null;
  let sar: number | null = null;
  const sarParts = /^(\d+):(\d+)$/.exec(fields.get('sample_aspect_ratio') ?? '');
  if (sarParts !== null) {
    const sn = Number(sarParts[1]);
    const sd = Number(sarParts[2]);
    if (sn > 0 && sd > 0) sar = sn / sd;
  }
  return { timeBaseDen: den, sar };
}

export function subVideoProbeArgs(path: string): string[] {
  return [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=time_base,sample_aspect_ratio',
    '-of', 'default=noprint_wrappers=1',
    path,
  ];
}

/** サブ動画の time_base / SAR を引く（読めなければ null＝呼び出し側は Remotion 退避）。 */
export function probeSubVideo(path: string): ProbedSubVideo | null {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) return null;
  try {
    const out = execFileSync(
      ffprobeFromFfmpeg(ffmpeg.bin),
      subVideoProbeArgs(path),
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    return parseSubVideoProbe(out.trim());
  } catch {
    return null;
  }
}
