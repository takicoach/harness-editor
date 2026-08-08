import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './http';
import { VIDEO_EXTENSIONS } from './loadProjectFiles';
import { ffprobeFromFfmpeg, resolveFfmpegBin } from './resolveFfmpeg';
import { moveIntoPlace } from './streamUpload';
import { linkVideoIntoPlace, writeVideoLink, type VideoLinkRecord } from './videoLink';

/** リポ同梱テンプレートの既定パス（SME_TEMPLATE_DIR で差し替え可）。 */
export function defaultTemplateDir(): string {
  const override = process.env.SME_TEMPLATE_DIR?.trim();
  if (override) return override;
  // src/server/ → リポルート直下の project-template/
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'project-template');
}

/**
 * プロジェクト名（＝フォルダ名）を検証して正規化する。
 * パス区切り・親参照・隠しフォルダ・空名を弾き、macOS の NFD を NFC へ揃える。
 */
export function sanitizeProjectName(raw: string): string {
  const name = raw.normalize('NFC').trim();
  if (name === '' || name.length > 80) {
    throw new HttpError(400, 'プロジェクト名は 1〜80 文字で入力してください');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) {
    throw new HttpError(400, `プロジェクト名に使えない文字が含まれています: ${raw}`);
  }
  return name;
}

/** ffprobe で取得した動画の基本情報。 */
export interface ProbedVideo {
  fps: number;
  durationSeconds: number;
  width: number;
  height: number;
}

/** ffprobe の JSON 出力から必要な値を取り出す。 */
export function parseProbeOutput(jsonText: string): ProbedVideo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new HttpError(422, '動画情報の解析に失敗しました（ffprobe 出力が不正）');
  }
  const obj = parsed as {
    streams?: Array<{ width?: number; height?: number; r_frame_rate?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const stream = obj.streams?.[0];
  if (!stream || typeof stream.width !== 'number' || typeof stream.height !== 'number') {
    throw new HttpError(422, 'このファイルは動画として読み込めませんでした（映像ストリームなし）');
  }
  const rate = stream.r_frame_rate ?? '';
  const [num = NaN, den] = rate.split('/').map(Number);
  const fps = den ? num / den : Number(rate);
  const durationSeconds = Number(stream.duration ?? obj.format?.duration ?? NaN);
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new HttpError(422, 'この動画の fps または長さを取得できませんでした');
  }
  return { fps, durationSeconds, width: stream.width, height: stream.height };
}

/** 縦横比からテンプレートの FORMAT（youtube/short/square）を決める。 */
export function detectFormat(width: number, height: number): 'youtube' | 'short' | 'square' {
  const aspect = width / height;
  if (aspect > 1.2) return 'youtube';
  if (aspect < 0.8) return 'short';
  return 'square';
}

/**
 * テンプレートの videoConfig.ts の「/video-harness:init が書き換える」領域を
 * 検出値で書き換える。マーカー行が見つからない場合はテンプレート破損として 500。
 */
export function rewriteVideoConfig(
  source: string,
  v: { format: string; fps: number; durationFrames: number; videoFile: string },
): string {
  const replacements: Array<[RegExp, string]> = [
    [/export const FORMAT: VideoFormat = '[^']*';/, `export const FORMAT: VideoFormat = '${v.format}';`],
    [/export const FPS = [^;]+;/, `export const FPS = ${v.fps};`],
    [/export const DURATION_FRAMES = [^;]+;.*/, `export const DURATION_FRAMES = ${v.durationFrames};`],
    [/export const VIDEO_FILE = '[^']*';/, `export const VIDEO_FILE = '${v.videoFile}';`],
  ];
  let out = source;
  for (const [re, next] of replacements) {
    if (!re.test(out)) {
      throw new HttpError(500, 'テンプレートの videoConfig.ts の形式が想定と異なります');
    }
    out = out.replace(re, next);
  }
  return out;
}

/** ffprobe 実行（ffmpeg と同じ解決手順で ffprobe を探す）。 */
function runFfprobe(videoPath: string): string {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) throw new HttpError(500, ffmpeg.message);
  const ffprobe = ffprobeFromFfmpeg(ffmpeg.bin);
  try {
    return execFileSync(
      ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,duration',
        '-show_entries', 'format=duration',
        '-of', 'json',
        videoPath,
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
  } catch {
    throw new HttpError(422, 'このファイルは動画として読み込めませんでした');
  }
}

/**
 * 名前・拡張子・重複の事前チェック。アップロード本体の受信前に呼ぶことで、
 * 数GBを受け切ってから 400/409 で捨てる無駄を避ける（createProject 内でも再チェックされる）。
 */
export function precheckCreateProject(root: string, rawName: string, videoName: string): void {
  const name = sanitizeProjectName(rawName);
  const ext = extname(videoName).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(ext)) {
    throw new HttpError(400, `動画ファイルを選んでください（対応: ${VIDEO_EXTENSIONS.join(' ')}）`);
  }
  if (existsSync(join(root, name))) {
    throw new HttpError(409, `同じ名前のプロジェクトがすでにあります: ${name}`);
  }
}

export interface CreateProjectDeps {
  templateDir: string;
  probe: (videoPath: string) => ProbedVideo;
  /**
   * `public/main<ext>` に動画を配置する手段。既定はアップロード一時ファイルの移動。
   * リンク取り込みでは symlink 作成へ差し替える（実体をコピーしない）。
   */
  placeVideo: (videoPath: string) => void;
}

/** ffprobe で動画の基本情報を取る（既定の検出手段）。 */
export function probeVideo(videoPath: string): ProbedVideo {
  return parseProbeOutput(runFfprobe(videoPath));
}

const defaultDeps: Omit<CreateProjectDeps, 'placeVideo'> = {
  templateDir: '',
  probe: probeVideo,
};

/**
 * 新規プロジェクトを作成する。
 * テンプレートコピー → 動画配置 → ffprobe 検出 → videoConfig.ts 反映。
 * 途中で失敗した場合は作りかけのフォルダを削除してロールバックする。
 *
 * 動画の「配置」だけを差し替えられる（アップロードの移動 / 外部実体への symlink）。
 * ffprobe 以降はどちらの経路でも同じ（リンク越しでも実体を読める）。
 */
export function createProjectWith(
  root: string,
  input: { name: string; videoName: string },
  deps: Partial<CreateProjectDeps> & Pick<CreateProjectDeps, 'placeVideo'>,
): { id: string; dir: string; probed: ProbedVideo; videoFile: string } {
  const d = { ...defaultDeps, ...deps };
  const templateDir = d.templateDir || defaultTemplateDir();
  const name = sanitizeProjectName(input.name);
  const ext = extname(input.videoName).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(ext)) {
    throw new HttpError(400, `動画ファイルを選んでください（対応: ${VIDEO_EXTENSIONS.join(' ')}）`);
  }
  if (!existsSync(join(templateDir, 'src', 'videoConfig.ts'))) {
    throw new HttpError(500, `プロジェクトテンプレートが見つかりません: ${templateDir}`);
  }
  const dir = join(root, name);
  if (existsSync(dir)) {
    throw new HttpError(409, `同じ名前のプロジェクトがすでにあります: ${name}`);
  }

  try {
    cpSync(templateDir, dir, { recursive: true });
    const videoFile = `main${ext}`;
    const publicDir = join(dir, 'public');
    // テンプレートの public/ は空ディレクトリのみのことがある（git は空 dir を追跡しない）。
    mkdirSync(publicDir, { recursive: true });
    const videoPath = join(publicDir, videoFile);
    d.placeVideo(videoPath);

    const probed = d.probe(videoPath);
    const fps = Math.round(probed.fps * 1000) / 1000;
    const durationFrames = Math.max(1, Math.round(probed.durationSeconds * fps));
    const format = detectFormat(probed.width, probed.height);

    const vcPath = join(dir, 'src', 'videoConfig.ts');
    const vcSource = readFileSync(vcPath, 'utf8');
    writeFileSync(vcPath, rewriteVideoConfig(vcSource, { format, fps, durationFrames, videoFile }));

    // 文字起こし前でもエディタで開けるよう、空の transcript.json を置く
    // （エディタ内の「文字起こし」実行時にバックアップの上で上書きされる）。
    writeFileSync(
      join(dir, 'transcript.json'),
      JSON.stringify(
        { engine: 'none', language: 'ja', duration_ms: Math.round(probed.durationSeconds * 1000), words: [], segments: [] },
        null,
        2,
      ),
    );

    // 軽量プレビュー（preview proxy）はここでは作らない。エディタで開いたときに
    // /api/preview-proxy/status の推奨判定 → ユーザー承諾で生成する（進捗バー付き）。
    return { id: name, dir, probed, videoFile };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** アップロードされた一時ファイルを移動して作る、従来の新規作成。 */
export function createProject(
  root: string,
  input: { name: string; videoName: string; videoTmpPath: string },
  deps: Partial<Omit<CreateProjectDeps, 'placeVideo'>> = {},
): { id: string } {
  const { id } = createProjectWith(root, input, {
    ...deps,
    placeVideo: (videoPath) => moveIntoPlace(input.videoTmpPath, videoPath),
  });
  return { id };
}

/**
 * 外部（外付けストレージ等）の実体へ symlink を張って作る新規作成。
 * 実体はコピーしないので 19GB 級の素材でも内蔵を消費しない。
 * 作成後、接続先と素材の指紋を `.sme/videoLink.json` に残す（別動画への差し替え検出用）。
 */
export function createProjectLinked(
  root: string,
  input: { name: string; targetPath: string },
  deps: Partial<Omit<CreateProjectDeps, 'placeVideo'>> & {
    link?: (target: string, linkPath: string) => void;
    stat?: (p: string) => { size: number; mtimeMs: number };
    writeLink?: (dir: string, record: VideoLinkRecord) => void;
  } = {},
): { id: string } {
  const link = deps.link ?? ((t: string, p: string) => linkVideoIntoPlace(t, p));
  const stat = deps.stat ?? ((p: string) => statSync(p));
  const writeLink = deps.writeLink ?? writeVideoLink;
  const { id, dir, probed, videoFile } = createProjectWith(
    root,
    { name: input.name, videoName: input.targetPath },
    { ...deps, placeVideo: (videoPath) => link(input.targetPath, videoPath) },
  );
  try {
    const st = stat(join(dir, 'public', videoFile));
    writeLink(dir, {
      target: input.targetPath,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      width: probed.width,
      height: probed.height,
      fps: Math.round(probed.fps * 1000) / 1000,
    });
  } catch (err) {
    // 記録に失敗したらプロジェクトごと巻き戻す（記録なしのリンク型は検出できず危険）。
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { id };
}
