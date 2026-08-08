import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { loadProject, validateProject, type ProjectFiles } from '../core';
import type { EditorProject, ValidationResult } from '../core/types';
import type { ProjectFingerprint } from '../shared/types';
import { fingerprintFile, versionToken } from './fileFingerprint';
import { HttpError } from './http';
import { snapshotBaselineIfAbsent } from './cutBaseline';
import { snapshotBaseline, TRACKED_FILES } from '../learning';
import { previewProxyName, resolvePreviewVideoPath } from './previewProxy';
import { isTelopPackInstalled } from './installTelopPack';
import { isVideoInsertInstalled } from './installVideoInsert';
import { isBgmInstalled } from './installBgm';
import { isShapeInstalled } from './installShape';
import { isTransitionInstalled } from './installTransition';
import { isDenoiseApplied } from './denoiseState';
import { inspectVideoLink, type VideoLinkStatus } from './videoLink';

const TELOP_DIR = 'テロップテンプレート';
const TELOP_DATA_REL = `src/${TELOP_DIR}/telopData.ts`;
// cutData.ts は ハーネス形式の出力位置が一定しないため複数候補を探す。無ければカット無し。
const CUT_DATA_CANDIDATES = ['cutData.ts', 'src/cutData.ts', `src/${TELOP_DIR}/cutData.ts`];
const SE_DATA_REL = 'src/SoundEffects/seData.ts';
/** SE 素材として認識する拡張子（uploadMaterial と共有）。 */
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a'];
const INSERT_IMAGE_DATA_REL = 'src/InsertImage/insertImageData.ts';
/** 画像素材として認識する拡張子（uploadMaterial と共有）。 */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const INSERT_VIDEO_DATA_REL = 'src/InsertVideo/insertVideoData.ts';
/** サブ動画素材として認識する拡張子（uploadMaterial と共有）。 */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v'];
const BGM_DATA_REL = 'src/Bgm/bgmData.ts';
const TITLE_DATA_REL = 'src/Title/titleData.ts';
const INSERT_SHAPE_DATA_REL = 'src/InsertShape/shapeData.ts';
const TRANSITION_DATA_REL = 'src/Transition/transitionData.ts';
const SPEED_DATA_REL = 'src/speedData.ts';
const MAIN_LAYOUT_DATA_REL = 'src/mainLayoutData.ts';

function readRequired(dir: string, rel: string, label: string): string {
  const path = join(dir, rel);
  if (!existsSync(path)) {
    throw new HttpError(400, `${label}（${rel}）が見つかりません`);
  }
  return readFileSync(path, 'utf8');
}

function readOptional(dir: string, rel: string): string | null {
  const path = join(dir, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** cutData.ts の相対パスを決める。存在すればその候補、無ければ先頭候補（新規作成先）。 */
function resolveCutDataRel(dir: string): string {
  for (const rel of CUT_DATA_CANDIDATES) {
    if (existsSync(join(dir, rel))) return rel;
  }
  return CUT_DATA_CANDIDATES[0] ?? 'cutData.ts';
}


/**
 * ライブラリ各ファイルの size-mtime トークンを assetPath（/api/asset の path と同形式）
 * キーで返す。同名差し替えを URL の &v= で検知するキャッシュバスト用。
 * 不在ファイル（列挙直後に消えた等）はトークン無し＝URL は従来通り（配信自体は serveAsset が担う）。
 * ⚠️ prefix はクライアント materialList.ts の assetPathFor と一致必須
 * （loadProjectFiles.test.ts の同期ガードテストで固定）。
 */
function buildAssetVersions(
  dir: string,
  libs: { seLibrary: string[]; imageLibrary: string[]; bgmLibrary: string[]; videoLibrary: string[] },
): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (assetPath: string): void => {
    const fp = fingerprintFile(join(dir, 'public', assetPath), assetPath);
    if (fp !== null) out[assetPath] = versionToken(fp.size, fp.mtimeMs);
  };
  for (const f of libs.seLibrary) add(`se/${f}`);
  for (const f of libs.imageLibrary) add(`images/${f}`);
  for (const f of libs.bgmLibrary) add(`BGM/${f}`);
  for (const f of libs.videoLibrary) add(f);
  return out;
}

/** public/<subdir> 配下のファイル名一覧を返す。ディレクトリが無ければ空配列。 */
function listAssetFiles(dir: string, subdir: string, extensions: string[]): string[] {
  const abs = join(dir, 'public', subdir);
  if (!existsSync(abs)) return [];
  try {
    return readdirSync(abs)
      .filter((f) => extensions.some((ext) => f.toLowerCase().endsWith(ext)))
      .sort();
  } catch (err) {
    console.warn('[sme] SE ライブラリの読み込みに失敗:', err);
    return [];
  }
}

/**
 * public/<subdir>/ 配下のファイルを再帰走査し、拡張子マッチのものを `<subdir>` 起点の
 * 相対パスで返す。ディレクトリが無ければ空配列。
 */
function listAssetFilesRecursive(
  dir: string,
  subdir: string,
  extensions: string[],
): string[] {
  const root = join(dir, 'public', subdir);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      console.warn('[sme] 画像ライブラリの読み込みに失敗:', err);
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        walk(join(current, e.name), prefix === '' ? e.name : `${prefix}/${e.name}`);
      } else if (e.isFile()) {
        // isSymbolicLink() は非対応: シンボリックリンクはスキップ。
        // serveAsset 側は realpath 封じ込めをするためサーブ自体は安全だが、ライブラリ列挙
        // から外れる仕様（実プロジェクトでシンボリックリンクが必要になったら withFileTypes
        // をやめて statSync で実体を見る方式へ切り替える）。
        const lower = e.name.toLowerCase();
        if (extensions.some((ext) => lower.endsWith(ext))) {
          out.push(prefix === '' ? e.name : `${prefix}/${e.name}`);
        }
      }
    }
  };
  walk(root, '');
  out.sort();
  return out;
}

/** プロジェクトディレクトリから loadProject 用の ProjectFiles を読み出す。 */
export function readProjectFiles(dir: string): ProjectFiles {
  let cutDataSource: string | null = null;
  for (const rel of CUT_DATA_CANDIDATES) {
    const path = join(dir, rel);
    if (existsSync(path)) {
      cutDataSource = readFileSync(path, 'utf8');
      break;
    }
  }
  return {
    videoConfigSource: readRequired(dir, join('src', 'videoConfig.ts'), '動画設定 videoConfig.ts'),
    telopDataSource: readRequired(dir, TELOP_DATA_REL, 'テロップデータ telopData.ts'),
    cutDataSource,
    transcriptJson: readRequired(dir, 'transcript.json', '文字起こし transcript.json'),
    projectConfigJson: readOptional(dir, 'project-config.json'),
    seDataSource: readOptional(dir, SE_DATA_REL),
    insertImageDataSource: readOptional(dir, INSERT_IMAGE_DATA_REL),
    videoInsertDataSource: readOptional(dir, INSERT_VIDEO_DATA_REL),
    bgmDataSource: readOptional(dir, BGM_DATA_REL),
    titleDataSource: readOptional(dir, TITLE_DATA_REL),
    shapeDataSource: readOptional(dir, INSERT_SHAPE_DATA_REL),
    transitionDataSource: readOptional(dir, TRANSITION_DATA_REL),
    speedDataSource: readOptional(dir, SPEED_DATA_REL),
    mainLayoutDataSource: readOptional(dir, MAIN_LAYOUT_DATA_REL),
  };
}

/** 保存に必要なメタデータ（書き戻しパスと読込時指紋）。 */
export interface SaveMeta {
  telopDataRelPath: string;
  cutDataRelPath: string;
  seDataRelPath: string;
  insertImageDataRelPath: string;
  videoInsertDataRelPath: string;
  bgmDataRelPath: string;
  titleDataRelPath: string;
  shapeDataRelPath: string;
  transitionDataRelPath: string;
  speedDataRelPath: string;
  mainLayoutDataRelPath: string;
  fingerprint: ProjectFingerprint;
}

export interface LoadedProject {
  project: EditorProject;
  validation: ValidationResult;
  save: SaveMeta;
  /**
   * プレビューできる動画があるか（原本 or 軽量プロキシ）。false なら動画レイヤを描かない。
   * リンク型で外付けを外していても、720p プロキシがあれば true のまま編集を続けられる。
   */
  hasVideo: boolean;
  /**
   * 原本（public/<videoFile> の実体）が読めるか。書き出し・波形の再生成はこれが true の時だけ。
   * リンク切れ中は false になり、hasVideo（プレビュー可否）と別に扱う。
   */
  sourceAvailable: boolean;
  /** メイン動画が外部実体への symlink の場合の接続先と状態。通常のコピー取り込みなら null。 */
  videoLink: VideoLinkStatus | null;
  /** public/<videoFile> のサイズ＋mtime トークン。存在しない場合は null。波形キャッシュバスト用。 */
  videoVersion: string | null;
  /** public/se/ 配下の効果音ファイル名一覧（新規追加ピッカー用）。 */
  seLibrary: string[];
  /** public/images/ 配下の画像ファイル名一覧（サブディレクトリ含む相対パス）。 */
  imageLibrary: string[];
  /** src/テロップテンプレート/telop-pack.json が存在するか（パック導入済み判定）。 */
  telopPackInstalled: boolean;
  /** public/ 配下のサブ動画ファイル（メインを除く・新規追加ピッカー用）。 */
  videoLibrary: string[];
  /** src/InsertVideo/insert-video.json が存在するか（導入済み判定）。 */
  videoInsertInstalled: boolean;
  /** public/BGM/ 配下の音声ファイル名一覧（新規追加ピッカー用）。 */
  bgmLibrary: string[];
  /**
   * ライブラリ各ファイルの size-mtime トークン（assetPath キー）。
   * asset URL の &v= に付けて同名差し替え時の stale キャッシュを無効化する。
   */
  assetVersions: Record<string, string>;
  /** src/Bgm/bgm-track.json が存在するか（BGM 導入済み判定）。 */
  bgmInstalled: boolean;
  /** src/Transition/transition.json が存在するか（シーン転換導入済み判定）。 */
  transitionInstalled: boolean;
  /** src/InsertShape/insert-shape.json が存在するか（図形導入済み判定）。 */
  shapeInstalled: boolean;
  /** denoise.json marker が applied=true か（ノイズ除去適用済み判定）。 */
  denoiseApplied: boolean;
}

/** プロジェクトを読み込み、コアの検証と保存メタデータを併せて返す。失敗は HttpError(400)。 */
export function loadProjectFromDir(dir: string): LoadedProject {
  const files = readProjectFiles(dir);
  let project: EditorProject;
  try {
    project = loadProject(files);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(400, `プロジェクトを読み込めません: ${message}`);
  }
  const validation = validateProject({
    originalTotalFrames: project.videoConfig.durationFrames,
    cutRegions: project.cutRegions,
    telops: project.telops,
  });

  // 自動カットの初期状態を初回のみ退避する（学習データ収集の前提）。
  // 不在時のみ書込むので、保存処理から再度呼ばれても安全。
  snapshotBaselineIfAbsent(
    dir,
    project.cutRegions,
    {
      file: project.videoConfig.videoFile,
      fps: project.videoConfig.fps,
      durationFrames: project.videoConfig.durationFrames,
    },
    { durationMs: project.transcript.durationMs, wordCount: project.transcript.words.length },
  );

  // transcript-fix 学習用ベースラインも初回のみ退避（冪等・失敗は編集を止めない）。
  try {
    snapshotBaseline(dir, TRACKED_FILES);
  } catch (err) {
    console.warn('[sme] transcript baseline 退避に失敗:', err);
  }

  const cutDataRelPath = resolveCutDataRel(dir);
  const telopFp = fingerprintFile(join(dir, TELOP_DATA_REL), TELOP_DATA_REL);
  if (telopFp === null) {
    // readRequired を通過済みなので通常起こらない。防御的に明示エラー。
    throw new HttpError(400, `テロップデータ telopData.ts の指紋を取得できません`);
  }
  const save: SaveMeta = {
    telopDataRelPath: TELOP_DATA_REL,
    cutDataRelPath,
    seDataRelPath: SE_DATA_REL,
    insertImageDataRelPath: INSERT_IMAGE_DATA_REL,
    videoInsertDataRelPath: INSERT_VIDEO_DATA_REL,
    bgmDataRelPath: BGM_DATA_REL,
    titleDataRelPath: TITLE_DATA_REL,
    shapeDataRelPath: INSERT_SHAPE_DATA_REL,
    transitionDataRelPath: TRANSITION_DATA_REL,
    speedDataRelPath: SPEED_DATA_REL,
    mainLayoutDataRelPath: MAIN_LAYOUT_DATA_REL,
    fingerprint: {
      telopData: telopFp,
      cutData: fingerprintFile(join(dir, cutDataRelPath), cutDataRelPath),
      seData: fingerprintFile(join(dir, SE_DATA_REL), SE_DATA_REL),
      insertImageData: fingerprintFile(join(dir, INSERT_IMAGE_DATA_REL), INSERT_IMAGE_DATA_REL),
      videoInsertData: fingerprintFile(join(dir, INSERT_VIDEO_DATA_REL), INSERT_VIDEO_DATA_REL),
      bgmData: fingerprintFile(join(dir, BGM_DATA_REL), BGM_DATA_REL),
      titleData: fingerprintFile(join(dir, TITLE_DATA_REL), TITLE_DATA_REL),
      shapeData: fingerprintFile(join(dir, INSERT_SHAPE_DATA_REL), INSERT_SHAPE_DATA_REL),
      transitionData: fingerprintFile(join(dir, TRANSITION_DATA_REL), TRANSITION_DATA_REL),
      speedData: fingerprintFile(join(dir, SPEED_DATA_REL), SPEED_DATA_REL),
      mainLayoutData: fingerprintFile(join(dir, MAIN_LAYOUT_DATA_REL), MAIN_LAYOUT_DATA_REL),
    },
  };
  // 原本の有無と「プレビューできる動画の有無」を分ける。原本が外付け上にあり未接続でも、
  // 軽量プロキシ（public/<base>.preview.mp4）があればプレビューとテロップ作業は続けられる。
  const sourceAvailable = existsSync(join(dir, 'public', project.videoConfig.videoFile));
  const videoLink = inspectVideoLink(dir, project.videoConfig.videoFile);
  // 波形キャッシュのバージョン鍵。サイズ＋mtime で同名差し替え（同サイズでも）を検知する。
  // /api/video は軽量プレビュープロキシがあればそちらを配信するため、フィンガープリントも
  // 「実際に配信されるファイル」で取る（プロキシ生成完了→再読込で URL が変わり切り替わる）。
  const servedVideoPath = resolvePreviewVideoPath(join(dir, 'public'), project.videoConfig.videoFile);
  const hasVideo = existsSync(servedVideoPath);
  const videoStat = hasVideo ? statSync(servedVideoPath) : null;
  const videoVersion =
    videoStat === null ? null : versionToken(videoStat.size, videoStat.mtimeMs);
  const seLibrary = listAssetFiles(dir, 'se', AUDIO_EXTENSIONS);
  const imageLibrary = listAssetFilesRecursive(dir, 'images', IMAGE_EXTENSIONS);
  const telopPackInstalled = isTelopPackInstalled(dir);
  // メイン動画本体と、その軽量プレビュープロキシは素材一覧に出さない。
  const videoLibrary = listAssetFilesRecursive(dir, '', VIDEO_EXTENSIONS).filter(
    (f) => f !== project.videoConfig.videoFile && f !== previewProxyName(project.videoConfig.videoFile),
  );
  const videoInsertInstalled = isVideoInsertInstalled(dir);
  const bgmLibrary = listAssetFiles(dir, 'BGM', AUDIO_EXTENSIONS);
  const assetVersions = buildAssetVersions(dir, { seLibrary, imageLibrary, bgmLibrary, videoLibrary });
  const bgmInstalled = isBgmInstalled(dir);
  const transitionInstalled = isTransitionInstalled(dir);
  const shapeInstalled = isShapeInstalled(dir);
  const denoiseApplied = isDenoiseApplied(dir);
  return { project, validation, save, hasVideo, sourceAvailable, videoLink, videoVersion, seLibrary, imageLibrary, telopPackInstalled, videoLibrary, videoInsertInstalled, bgmLibrary, assetVersions, bgmInstalled, transitionInstalled, shapeInstalled, denoiseApplied };
}
