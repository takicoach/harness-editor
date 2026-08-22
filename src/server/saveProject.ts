import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serializeProject } from '../core';
import { buildLearningRecord } from '../core/cutLearning';
import type { EditorProject } from '../core/types';
import type { ProjectFingerprint, SaveRequest, SaveResponse } from '../shared/types';
import { fingerprintFile, fingerprintsMatch } from './fileFingerprint';
import { HttpError } from './http';
import { loadProjectFromDir } from './loadProjectFiles';
import { readCutBaseline } from './cutBaseline';
import { writeCutLearning } from './cutLearning';
import { isSpeedInstalled } from './installSpeed';
import { isMainLayoutInstalled, writeMainLayoutAlways } from './installMainLayout';
import { DEFAULT_MAIN_LAYOUT } from '../core/mainLayout';

/** 値がプレーンオブジェクト（null でも配列でもない）か。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 受信ボディが SaveRequest かを構造検証する。
 * クライアント由来の任意 JSON なので、プロパティアクセス前に必ず通す。
 */
export function validateSaveRequest(body: unknown): SaveRequest {
  if (!isObject(body)) {
    throw new HttpError(400, '保存リクエストの本文が不正です');
  }
  if (!isObject(body.project)) {
    throw new HttpError(400, '保存リクエストに project がありません');
  }
  if (!isObject(body.fingerprint)) {
    throw new HttpError(400, '保存リクエストに fingerprint がありません');
  }
  const fingerprint = body.fingerprint;
  if (!isObject(fingerprint.telopData)) {
    throw new HttpError(400, '保存リクエストの fingerprint.telopData が不正です');
  }
  if (fingerprint.cutData !== null && !isObject(fingerprint.cutData)) {
    throw new HttpError(400, '保存リクエストの fingerprint.cutData が不正です');
  }
  if (fingerprint.seData !== null && !isObject(fingerprint.seData)) {
    throw new HttpError(400, '保存リクエストの fingerprint.seData が不正です');
  }
  if (fingerprint.insertImageData !== null && !isObject(fingerprint.insertImageData)) {
    throw new HttpError(400, '保存リクエストの fingerprint.insertImageData が不正です');
  }
  if (fingerprint.videoInsertData !== null && !isObject(fingerprint.videoInsertData)) {
    throw new HttpError(400, '保存リクエストの fingerprint.videoInsertData が不正です');
  }
  if (fingerprint.bgmData !== null && !isObject(fingerprint.bgmData)) {
    throw new HttpError(400, '保存リクエストの fingerprint.bgmData が不正です');
  }
  if (fingerprint.titleData !== null && !isObject(fingerprint.titleData)) {
    throw new HttpError(400, '保存リクエストの fingerprint.titleData が不正です');
  }
  // shapeData は任意（旧クライアントは送らない）。未設定(undefined)も null と同様に許容する。
  if (fingerprint.shapeData !== undefined && fingerprint.shapeData !== null && !isObject(fingerprint.shapeData)) {
    throw new HttpError(400, '保存リクエストの fingerprint.shapeData が不正です');
  }
  // transitionData は任意（旧クライアントは送らない）。未設定(undefined)も null と同様に許容する。
  if (fingerprint.transitionData !== undefined && fingerprint.transitionData !== null && !isObject(fingerprint.transitionData)) {
    throw new HttpError(400, '保存リクエストの fingerprint.transitionData が不正です');
  }
  // speedData は任意（旧クライアントは送らない）。未設定(undefined)も null と同様に許容する。
  if (fingerprint.speedData !== undefined && fingerprint.speedData !== null && !isObject(fingerprint.speedData)) {
    throw new HttpError(400, '保存リクエストの fingerprint.speedData が不正です');
  }
  // mainLayoutData は任意（旧クライアントは送らない）。undefined も null と同様に許容する。
  if (fingerprint.mainLayoutData !== undefined && fingerprint.mainLayoutData !== null && !isObject(fingerprint.mainLayoutData)) {
    throw new HttpError(400, '保存リクエストの fingerprint.mainLayoutData が不正です');
  }
  const project = body.project;
  if (!Array.isArray(project.telops)) {
    throw new HttpError(400, 'project.telops が配列ではありません');
  }
  if (!Array.isArray(project.cutRegions)) {
    throw new HttpError(400, 'project.cutRegions が配列ではありません');
  }
  if (!Array.isArray(project.se)) {
    throw new HttpError(400, 'project.se が配列ではありません');
  }
  if (project.seDataSource !== null && typeof project.seDataSource !== 'string') {
    throw new HttpError(400, 'project.seDataSource が不正です');
  }
  if (!Array.isArray(project.images)) {
    throw new HttpError(400, 'project.images が配列ではありません');
  }
  if (project.insertImageDataSource !== null && typeof project.insertImageDataSource !== 'string') {
    throw new HttpError(400, 'project.insertImageDataSource が不正です');
  }
  // videoInserts はクライアント EditState 由来の任意配列。未設定(undefined)は許容
  // （EditorProject では任意フィールド・サーバは current のディスク値で補完する）。
  if (project.videoInserts !== undefined && !Array.isArray(project.videoInserts)) {
    throw new HttpError(400, 'project.videoInserts が配列ではありません');
  }
  // videoInsertDataSource は任意。未設定(undefined)は許容し、保存時に current のディスク値で補完する。
  if (
    project.videoInsertDataSource !== undefined &&
    project.videoInsertDataSource !== null &&
    typeof project.videoInsertDataSource !== 'string'
  ) {
    throw new HttpError(400, 'project.videoInsertDataSource が不正です');
  }
  // bgm はクライアント EditState 由来の任意配列。未設定(undefined)は許容。
  if (project.bgm !== undefined && !Array.isArray(project.bgm)) {
    throw new HttpError(400, 'project.bgm が配列ではありません');
  }
  // bgmDataSource は任意。未設定(undefined)は許容し、保存時に current のディスク値で補完する。
  if (
    project.bgmDataSource !== undefined &&
    project.bgmDataSource !== null &&
    typeof project.bgmDataSource !== 'string'
  ) {
    throw new HttpError(400, 'project.bgmDataSource が不正です');
  }
  // serializeProject が必要とする videoConfig / 各 source の最小チェック。
  if (!isObject(project.videoConfig)) {
    throw new HttpError(400, 'project.videoConfig がありません');
  }
  if (typeof project.telopDataSource !== 'string') {
    throw new HttpError(400, 'project.telopDataSource が不正です');
  }
  // 構造が揃ったので EditorProject として扱う（コアの型ガードは serializeProject 側）。
  return body as unknown as SaveRequest;
}

/**
 * 編集済み EditorProject をプロジェクトディレクトリへ保存する。
 * 1. 現在のディスク指紋を読込時指紋と照合（外部変更検知 → 409）。
 * 2. serializeProject で telopData.ts / cutData.ts のソースを再生成。
 * 3. ディスクへ書き戻し、新しい指紋を返す。
 */
export function saveProjectToDir(dir: string, req: SaveRequest): SaveResponse {
  // 現在のディスク指紋を取り直す（読込時のメタを再計算するため loadProjectFromDir を使う）。
  const current = loadProjectFromDir(dir);
  const telopRel = current.save.telopDataRelPath;
  const cutRel = current.save.cutDataRelPath;
  const seRel = current.save.seDataRelPath;
  const insertImageRel = current.save.insertImageDataRelPath;
  const videoInsertRel = current.save.videoInsertDataRelPath;
  const bgmRel = current.save.bgmDataRelPath;
  const titleRel = current.save.titleDataRelPath;
  const shapeRel = current.save.shapeDataRelPath;
  const transitionRel = current.save.transitionDataRelPath;
  const speedRel = current.save.speedDataRelPath;
  const mainLayoutRel = current.save.mainLayoutDataRelPath;

  // 外部変更検知。
  const diskTelop = fingerprintFile(join(dir, telopRel), telopRel);
  const diskCut = fingerprintFile(join(dir, cutRel), cutRel);
  const diskSe = fingerprintFile(join(dir, seRel), seRel);
  const diskInsertImage = fingerprintFile(join(dir, insertImageRel), insertImageRel);
  const diskVideoInsert = fingerprintFile(join(dir, videoInsertRel), videoInsertRel);
  const diskBgm = fingerprintFile(join(dir, bgmRel), bgmRel);
  const diskTitle = fingerprintFile(join(dir, titleRel), titleRel);
  const diskShape = fingerprintFile(join(dir, shapeRel), shapeRel);
  const diskTransition = fingerprintFile(join(dir, transitionRel), transitionRel);
  const diskSpeed = fingerprintFile(join(dir, speedRel), speedRel);
  const diskMainLayout = fingerprintFile(join(dir, mainLayoutRel), mainLayoutRel);
  if (!fingerprintsMatch(diskTelop, req.fingerprint.telopData)) {
    throw new HttpError(
      409,
      `${telopRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
    );
  }
  if (!fingerprintsMatch(diskCut, req.fingerprint.cutData)) {
    throw new HttpError(
      409,
      `${cutRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
    );
  }
  if (!fingerprintsMatch(diskSe, req.fingerprint.seData)) {
    throw new HttpError(
      409,
      `${seRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
    );
  }
  // 不在からの新規作成と外部作成が競合した場合も 409 になる（fingerprintsMatch: null ≠ 非null）。
  // 例: 読込時 insertImageData.ts が無く（fingerprint.insertImageData=null）、保存前に
  // 第三者ツールがファイルを作った（diskInsertImage=非null）→ 競合とみなし 409。
  if (!fingerprintsMatch(diskInsertImage, req.fingerprint.insertImageData)) {
    throw new HttpError(
      409,
      `${insertImageRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
    );
  }
  if (!fingerprintsMatch(diskVideoInsert, req.fingerprint.videoInsertData)) {
    throw new HttpError(
      409,
      `${videoInsertRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
    );
  }
  if (!fingerprintsMatch(diskBgm, req.fingerprint.bgmData)) {
    throw new HttpError(
      409,
      `${bgmRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
    );
  }
  if (!fingerprintsMatch(diskTitle, req.fingerprint.titleData)) {
    throw new HttpError(
      409,
      `${titleRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
    );
  }
  // shapeData は任意（旧クライアントは undefined を送る）。undefined は null（ファイル不在）として扱う。
  if (!fingerprintsMatch(diskShape, req.fingerprint.shapeData ?? null)) {
    throw new HttpError(
      409,
      `${shapeRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
    );
  }
  // transitionData は任意（旧クライアントは undefined を送る）。undefined は null（ファイル不在）として扱う。
  if (!fingerprintsMatch(diskTransition, req.fingerprint.transitionData ?? null)) {
    throw new HttpError(
      409,
      `${transitionRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
    );
  }
  // speedData は任意（旧クライアントは undefined を送る）。undefined は null（mainSpeed=1・ファイル不在）として扱う。
  if (!fingerprintsMatch(diskSpeed, req.fingerprint.speedData ?? null)) {
    throw new HttpError(
      409,
      `${speedRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
    );
  }
  // mainLayoutData は任意（旧クライアントは undefined を送る）。undefined は null（既定・ファイル不在）として扱う。
  if (!fingerprintsMatch(diskMainLayout, req.fingerprint.mainLayoutData ?? null)) {
    throw new HttpError(
      409,
      `${mainLayoutRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
    );
  }

  // Codex P2-1 教訓: クライアントの読込時スナップショット（req.project.<source>）ではなく、
  // サーバ現行 disk 状態から serialize する。新規作成後にクライアント baseProject が
  // 更新されないため、stale な null を真にしてしまうとデータ損失が起きる。
  const projectForSerialize: EditorProject = {
    ...(req.project as EditorProject),
    // 再生順アンカー（並び替え）はクライアントが編集しない読み取り専用の情報。
    // 上と同じ理由でサーバ側の disk 再読込値を正とし、旧クライアントの未送信で
    // 並び順が失われないようにする。
    cutOrder: current.project.cutOrder,
    seDataSource: current.project.seDataSource,
    insertImageDataSource: current.project.insertImageDataSource,
    videoInsertDataSource: current.project.videoInsertDataSource,
    bgmDataSource: current.project.bgmDataSource,
    // I-1 修正: titleDataSource も disk 再読込値で上書きし、クライアントの stale 値を排除する。
    titleDataSource: current.project.titleDataSource,
    // shapeDataSource も disk 再読込値で上書き（bgm/title と対称）。
    shapeDataSource: current.project.shapeDataSource,
    // transitionDataSource も disk 再読込値で上書き（shape と対称）。
    transitionDataSource: current.project.transitionDataSource,
  };
  let sources: {
    telopDataSource: string;
    cutDataSource: string;
    seDataSource: string | null;
    insertImageDataSource: string | null;
    videoInsertDataSource: string | null;
    bgmDataSource: string | null;
    /** I-2: 0 件かつ元ファイル不在なら null（孤立ファイル防止）。 */
    titleDataSource: string | null;
    /** 0 件かつ元ファイル不在なら null（孤立ファイル防止）。 */
    shapeDataSource: string | null;
    /** 0 件かつ元ファイル不在なら null（孤立ファイル防止）。 */
    transitionDataSource: string | null;
    /** mainSpeed=1 なら null（ファイル不要）、それ以外は speedData.ts ソース。 */
    speedDataSource: string | null;
    /** 完全既定なら null（ファイル不要）、それ以外は mainLayoutData.ts ソース。 */
    mainLayoutDataSource: string | null;
  };
  try {
    sources = serializeProject(projectForSerialize);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(400, `保存データの生成に失敗しました: ${message}`);
  }

  // 書き戻し。
  writeFileSync(join(dir, telopRel), sources.telopDataSource, 'utf8');
  writeFileSync(join(dir, cutRel), sources.cutDataSource, 'utf8');
  if (sources.seDataSource !== null) {
    const seAbs = join(dir, seRel);
    mkdirSync(dirname(seAbs), { recursive: true });
    writeFileSync(seAbs, sources.seDataSource, 'utf8');
  }
  if (sources.insertImageDataSource !== null) {
    const insAbs = join(dir, insertImageRel);
    mkdirSync(dirname(insAbs), { recursive: true });
    writeFileSync(insAbs, sources.insertImageDataSource, 'utf8');
  }
  if (sources.videoInsertDataSource !== null) {
    const vidAbs = join(dir, videoInsertRel);
    mkdirSync(dirname(vidAbs), { recursive: true });
    writeFileSync(vidAbs, sources.videoInsertDataSource, 'utf8');
  }
  if (sources.bgmDataSource !== null) {
    const bgmAbs = join(dir, bgmRel);
    mkdirSync(dirname(bgmAbs), { recursive: true });
    writeFileSync(bgmAbs, sources.bgmDataSource, 'utf8');
  }

  // I-2 修正: タイトル0件かつ元ファイル不在なら書き込まない（孤立ファイル防止・bgm と対称）。
  if (sources.titleDataSource !== null) {
    const titleAbs = join(dir, titleRel);
    mkdirSync(dirname(titleAbs), { recursive: true });
    writeFileSync(titleAbs, sources.titleDataSource, 'utf8');
  }

  // 図形0件かつ元ファイル不在なら書き込まない（孤立ファイル防止・title と対称）。
  if (sources.shapeDataSource !== null) {
    const shapeAbs = join(dir, shapeRel);
    mkdirSync(dirname(shapeAbs), { recursive: true });
    writeFileSync(shapeAbs, sources.shapeDataSource, 'utf8');
  }

  // トランジション0件かつ元ファイル不在なら書き込まない（孤立ファイル防止・shape と対称）。
  if (sources.transitionDataSource !== null) {
    const transitionAbs = join(dir, transitionRel);
    mkdirSync(dirname(transitionAbs), { recursive: true });
    writeFileSync(transitionAbs, sources.transitionDataSource, 'utf8');
  }

  // 速度導入済み（src/Speed/speed.json）またはレイアウト導入済み（src/MainLayout/main-layout.json）
  // なら Root/SpeedPlayer/CutPlayer（frame 対応 payload）が MAIN_SPEED／SEGMENT_SPEEDS を import
  // するため、1x でも speedData.ts を残し両 export を書く（削除しない）。両方未導入は従来どおり。
  const speedAbs = join(dir, speedRel);
  if (sources.speedDataSource !== null) {
    mkdirSync(dirname(speedAbs), { recursive: true });
    writeFileSync(speedAbs, sources.speedDataSource, 'utf8');
  } else if (isSpeedInstalled(dir) || isMainLayoutInstalled(dir)) {
    // 導入済みは Root/SpeedPlayer/CutPlayer の import 解決のため両 export を常在させる（個別ゼロでも空マップ）。
    mkdirSync(dirname(speedAbs), { recursive: true });
    writeFileSync(
      speedAbs,
      `// Harness Editor が生成・更新します（メイン動画の速度）\n\nexport const MAIN_SPEED = 1;\nexport const SEGMENT_SPEEDS: Record<number, number> = {  };\n`,
      'utf8',
    );
  } else if (existsSync(speedAbs)) {
    unlinkSync(speedAbs);
  }

  // mainLayoutData: 非 null なら書く／導入済みは恒等でも常在（MAIN_LAYOUT import 解決）／未導入 & 既定は削除。
  const mainLayoutAbs = join(dir, mainLayoutRel);
  if (sources.mainLayoutDataSource !== null) {
    mkdirSync(dirname(mainLayoutAbs), { recursive: true });
    writeFileSync(mainLayoutAbs, sources.mainLayoutDataSource, 'utf8');
  } else if (isMainLayoutInstalled(dir)) {
    // 導入済みは payload の MainLayout が MAIN_LAYOUT を import するため、恒等でも常在させる。
    mkdirSync(dirname(mainLayoutAbs), { recursive: true });
    writeFileSync(mainLayoutAbs, writeMainLayoutAlways(DEFAULT_MAIN_LAYOUT), 'utf8');
  } else if (existsSync(mainLayoutAbs)) {
    unlinkSync(mainLayoutAbs);
  }

  // 新しい指紋。
  const newTelop = fingerprintFile(join(dir, telopRel), telopRel);
  const newCut = fingerprintFile(join(dir, cutRel), cutRel);
  if (newTelop === null) {
    throw new HttpError(500, `${telopRel} の書き戻し後に指紋を取得できません`);
  }
  if (newCut === null) {
    throw new HttpError(500, `${cutRel} の書き戻し後に指紋を取得できません`);
  }
  const fingerprint: ProjectFingerprint = {
    telopData: newTelop,
    cutData: newCut,
    seData: fingerprintFile(join(dir, seRel), seRel),
    insertImageData: fingerprintFile(join(dir, insertImageRel), insertImageRel),
    videoInsertData: fingerprintFile(join(dir, videoInsertRel), videoInsertRel),
    bgmData: fingerprintFile(join(dir, bgmRel), bgmRel),
    titleData: fingerprintFile(join(dir, titleRel), titleRel),
    shapeData: fingerprintFile(join(dir, shapeRel), shapeRel),
    transitionData: fingerprintFile(join(dir, transitionRel), transitionRel),
    speedData: fingerprintFile(join(dir, speedRel), speedRel),
    mainLayoutData: fingerprintFile(join(dir, mainLayoutRel), mainLayoutRel),
  };
  // 学習データ記録（ベストエフォート）。失敗しても保存は成立させる。
  // baseline 不在ならスキップ（自動カットの初期状態が無いと差分が取れないため）。
  try {
    const baseline = readCutBaseline(dir);
    if (baseline !== null) {
      const finalCutRegions = (req.project as EditorProject).cutRegions;
      const record = buildLearningRecord({
        auto: baseline.autoCutRegions,
        final: finalCutRegions,
        transcript: current.project.transcript,
        video: {
          file: current.project.videoConfig.videoFile,
          fps: current.project.videoConfig.fps,
          durationFrames: current.project.videoConfig.durationFrames,
        },
        savedAt: new Date().toISOString(),
        transcriptDigest: baseline.transcriptDigest,
      });
      writeCutLearning(dir, record);
    }
  } catch (err) {
    console.warn('[sme] 学習レコードの記録に失敗（保存は成立）:', err);
  }

  return { ok: true, fingerprint };
}
