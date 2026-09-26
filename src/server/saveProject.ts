import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { serializeProject } from '../core';
import { hasTimelinePlacements } from '../core/timelinePlacement';
import { buildLegacyMainTimeline } from '../core/sequence/legacyMainTimeline';
import { buildLearningRecord } from '../core/cutLearning';
import { clampVideoInsertsToSourceLength } from '../core/videoInsertEngine';
import type { EditorProject } from '../core/types';
import type { ProjectFingerprint, SaveRequest, SaveResponse } from '../shared/types';
import { fingerprintFile, fingerprintsMatch } from './fileFingerprint';
import { HttpError } from './http';
import { writeFilesAtomic, type AtomicWrite } from './writeFileAtomic';
import { backupProjectFiles } from './backupProject';
import { loadProjectFromDir } from './loadProjectFiles';
import { readCutBaseline } from './cutBaseline';
import { writeCutLearning } from './cutLearning';
import { isSpeedInstalled } from './installSpeed';
import { isMainLayoutInstalled, writeMainLayoutAlways } from './installMainLayout';
import { DEFAULT_MAIN_LAYOUT } from '../core/mainLayout';
import { isIdentityColorWheels } from '../core/colorGrade';
import { isDefaultMainAudio, mainAudioSettingsEqual, normalizeMainAudioSettings } from '../core/mainAudio';
import { MAIN_AUDIO_UNSUPPORTED } from './mainAudioSupport';
import { probeDurationSeconds } from './previewProxyAnalysis';
import { scriptDocumentSchema } from '../core/scriptAlignment';
import { assertLegacySequenceAuthority } from './sequence/authority';

/**
 * サブ動画（videoInserts）が参照するファイルごとのソース長（フレーム）を ffprobe で実測する（R-1）。
 * container の format.duration を見るため音声トラックの有無に依存しない
 * （無音・映像のみのサブ動画でも計測できる）。読めないファイル（テスト用スタブ・破損・
 * ffmpeg 未検出）は結果へ含めない＝呼び出し側は「長さ不明」としてクランプをスキップする。
 * 同一 file は 1 回だけ ffprobe する。
 */
function probeVideoInsertSourceLengths(
  dir: string,
  videoInserts: readonly { file: string }[],
  fps: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  const files = new Set(videoInserts.map((v) => v.file).filter((f) => f !== ''));
  for (const file of files) {
    const sec = probeDurationSeconds(join(dir, 'public', file));
    if (sec !== null) out[file] = Math.round(sec * fps);
  }
  return out;
}

/** 値がプレーンオブジェクト（null でも配列でもない）か。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 編集データへ **null / 非有限数（NaN・±Infinity）が混ざっていないか**を再帰的に検査する。
 *
 * 生成器（`formatTelopArray` 等）は数値を `scale: ${s.scale}` のように素で埋め込むため、
 * ここを素通りすると `scale: null` / `scale: NaN` と書かれたプロジェクトが出来上がる。
 * ファイルとしては読めてしまうので**気づけない**（silent corruption）。保存前に 400 で断る。
 *
 * JSON は NaN / Infinity を表現できず `JSON.stringify` が **null** にするため、
 * 壊れたクライアントから届く実際の形はほぼ null になる。両方を同じ理由で弾く。
 * 省略（undefined）は従来どおり許容する（任意フィールドの未設定）。
 */
function assertFiniteEditData(value: unknown, path: string): void {
  if (value === null) {
    throw new HttpError(400, `保存リクエストの ${path} が null です（数値として保存できません）`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new HttpError(400, `保存リクエストの ${path} が数値として不正です: ${String(value)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertFiniteEditData(v, `${path}[${i}]`));
    return;
  }
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) assertFiniteEditData(v, `${path}.${k}`);
  }
}

/** 検査対象は「編集で書き換わり、生成ソースへ数値が素で埋め込まれる」フィールドだけ。 */
const NUMERIC_EDIT_FIELDS = [
  'telops', 'cutRegions', 'cutOrder', 'se', 'images', 'videoInserts', 'bgm', 'titles', 'shapes',
  'sceneTransitions', 'layoutKeyframes', 'segmentSpeeds', 'segmentLayouts', 'mainLayout', 'mainSpeed', 'mainAudio',
] as const;

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
  if (fingerprint.mainAudioData !== undefined && fingerprint.mainAudioData !== null && !isObject(fingerprint.mainAudioData)) {
    throw new HttpError(400, '保存リクエストの fingerprint.mainAudioData が不正です');
  }
  if (fingerprint.scriptDocument !== undefined && fingerprint.scriptDocument !== null && !isObject(fingerprint.scriptDocument)) {
    throw new HttpError(400, '保存リクエストの fingerprint.scriptDocument が不正です');
  }
  if (fingerprint.editorTimeline !== undefined && fingerprint.editorTimeline !== null && !isObject(fingerprint.editorTimeline)) {
    throw new HttpError(400, '保存リクエストの fingerprint.editorTimeline が不正です');
  }
  const project = body.project;
  if (!Array.isArray(project.telops)) {
    throw new HttpError(400, 'project.telops が配列ではありません');
  }
  if (!Array.isArray(project.cutRegions)) {
    throw new HttpError(400, 'project.cutRegions が配列ではありません');
  }
  if (project.cutOrder !== undefined) {
    if (!Array.isArray(project.cutOrder)) {
      throw new HttpError(400, 'project.cutOrder が配列ではありません');
    }
    const duration = isObject(project.videoConfig) ? project.videoConfig['durationFrames'] : undefined;
    const ranges: Array<{ start: number; end: number }> = [];
    for (const [index, anchor] of project.cutOrder.entries()) {
      if (!isObject(anchor)) throw new HttpError(400, `project.cutOrder[${index}] が不正です`);
      const start = anchor['originalStart'];
      const end = anchor['originalEnd'];
      if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) <= (start as number)) {
        throw new HttpError(400, `project.cutOrder[${index}] の範囲が不正です`);
      }
      if (Number.isFinite(duration) && (end as number) > (duration as number)) {
        throw new HttpError(400, `project.cutOrder[${index}] が動画尺を超えています`);
      }
      ranges.push({ start: start as number, end: end as number });
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 1; index < ranges.length; index++) {
      if (ranges[index]!.start < ranges[index - 1]!.end) {
        throw new HttpError(400, 'project.cutOrder の原素材範囲が重複しています');
      }
    }
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
  if (project.mainAudio !== undefined) {
    try {
      normalizeMainAudioSettings(project.mainAudio);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(400, `保存リクエストの project.mainAudio が不正です: ${message}`);
    }
  }
  if (project.scriptDocument !== undefined && project.scriptDocument !== null) {
    try {
      scriptDocumentSchema.parse(project.scriptDocument);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(400, `保存リクエストの project.scriptDocument が不正です: ${message}`);
    }
  }
  // 数値の健全性検査（null / NaN / Infinity が生成ソースへ書かれるのを防ぐ）。
  for (const field of NUMERIC_EDIT_FIELDS) {
    if (project[field] !== undefined) assertFiniteEditData(project[field], `project.${field}`);
  }
  // 構造が揃ったので EditorProject として扱う（コアの型ガードは serializeProject 側）。
  if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') {
    throw new HttpError(400, '保存リクエストの overwrite が不正です');
  }
  return body as unknown as SaveRequest;
}

/**
 * 編集済み EditorProject をプロジェクトディレクトリへ保存する。
 * 1. 現在のディスク指紋を読込時指紋と照合（外部変更検知 → 409）。
 * 2. serializeProject で telopData.ts / cutData.ts のソースを再生成。
 * 3. ディスクへ書き戻し、新しい指紋を返す。
 */
export function saveProjectToDir(dir: string, req: SaveRequest): SaveResponse {
  assertLegacySequenceAuthority(dir);
  // 現在のディスク指紋を取り直す（読込時のメタを再計算するため loadProjectFromDir を使う）。
  const current = loadProjectFromDir(dir);
  if (req.project.images.some(image => image.type === 'plain') && !current.imageRendering.supported) {
    throw new HttpError(409, '静止画像を保存する前に「画像表示を更新」で対応する表示に更新してください。');
  }
  if (hasTimelinePlacements(current.project) && req.fingerprint.editorTimeline === undefined) {
    // An old editor cannot interpret final-clock assets, even if its overwrite
    // button bypasses ordinary external-change conflicts.
    throw new HttpError(409, '独立素材の配置に対応した画面でプロジェクトを開き直してください');
  }
  let requestedMainAudio = current.project.mainAudio;
  if (req.project.mainAudio !== undefined) {
    try {
      requestedMainAudio = normalizeMainAudioSettings(req.project.mainAudio);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(400, `保存リクエストの project.mainAudio が不正です: ${message}`);
    }
  }
  // Unrelated saves retain custom projects' existing settings. New audio edits
  // require a composition that the owned render snapshot can prepare faithfully.
  if (!mainAudioSettingsEqual(requestedMainAudio, current.project.mainAudio) && !current.mainAudioSupported) {
    throw new HttpError(409, MAIN_AUDIO_UNSUPPORTED);
  }
  if (!isIdentityColorWheels(req.project.colorGrade?.wheels) && !current.colorWheelsSupported) {
    throw new HttpError(409, 'カラーホイールを保存する前に「レイアウトを書き出しに導入」で更新してください。');
  }
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
  const mainAudioRel = current.save.mainAudioDataRelPath;
  const scriptDocumentRel = current.save.scriptDocumentRelPath;
  const editorTimelineRel = current.save.editorTimelineRelPath;
  /** 保存が書き換えうるデータファイル（上書き前の退避対象）。 */
  const allRelPaths = [
    telopRel, cutRel, seRel, insertImageRel, videoInsertRel, bgmRel,
    titleRel, shapeRel, transitionRel, speedRel, mainLayoutRel, mainAudioRel, scriptDocumentRel, editorTimelineRel,
  ];

  // 外部変更検知。overwrite（利用者が衝突通知を見て明示的に選んだ上書き）なら丸ごと飛ばす。
  // 飛ばすのは照合だけで、書き戻しと指紋の返し方は通常保存とまったく同じ経路を通る。
  if (req.overwrite !== true) {
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
    const diskMainAudio = fingerprintFile(join(dir, mainAudioRel), mainAudioRel);
    const diskScriptDocument = fingerprintFile(join(dir, scriptDocumentRel), scriptDocumentRel);
    const diskEditorTimeline = fingerprintFile(join(dir, editorTimelineRel), editorTimelineRel);
    if (!fingerprintsMatch(diskEditorTimeline, req.fingerprint.editorTimeline ?? null)) {
      throw new HttpError(409, `${editorTimelineRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`);
    }
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
    // mainAudioData未送信の旧クライアントは、diskにファイルがあれば競合として止める。
    // 設定本体fieldの省略による保持と、外部変更検知の省略は別の契約。
    if (!fingerprintsMatch(diskMainAudio, req.fingerprint.mainAudioData ?? null)) {
      throw new HttpError(
        409,
        `${mainAudioRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
      );
    }
    // 旧payloadは台本を送らず、disk byteをそのまま維持するため競合対象にしない。
    // 明示更新・削除するときだけ読込時fingerprintとの一致を必須にする。
    if (req.project.scriptDocument !== undefined
      && !fingerprintsMatch(diskScriptDocument, req.fingerprint.scriptDocument ?? null)) {
      throw new HttpError(
        409,
        `${scriptDocumentRel} が読み込み後に外部で変更されています。プロジェクトを開き直してください`,
      );
    }
  }

  // Codex P2-1 教訓: クライアントの読込時スナップショット（req.project.<source>）ではなく、
  // サーバ現行 disk 状態から serialize する。新規作成後にクライアント baseProject が
  // 更新されないため、stale な null を真にしてしまうとデータ損失が起きる。
  const projectForSerialize: EditorProject = {
    ...(req.project as EditorProject),
    // 明示された再生順は編集結果として保存する。旧クライアントのfield省略時だけ
    // disk値を維持し、既存の並び順を意図せず消さない。
    cutOrder: req.project.cutOrder === undefined ? current.project.cutOrder : req.project.cutOrder,
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
    mainAudio: requestedMainAudio,
    mainAudioDataSource: current.project.mainAudioDataSource,
    scriptDocument: req.project.scriptDocument === undefined
      ? current.project.scriptDocument
      : req.project.scriptDocument,
  };

  // R-1: サブ動画の endAt がソース実長を超えないよう保存時にクランプする。
  // ffprobe で実測できたファイルだけをクランプ対象にし、計測不能なら無変更（安全側）。
  // C-2: クランプで originalEnd が変わったクリップは clampedVideoInserts として応答へ載せる
  // （画面がディスクと無言で食い違わないようにするため。saveProjectToDir 末尾で使う）。
  // X-2(a): クランプでは直せない（再生できるソースフレームが1枚も残っていない）クリップは
  // unplayableVideoInserts として応答へ載せる。従来は unplayableIds を集めながら破棄しており、
  // 利用者には何も伝わらず、書き出しで初めて壊れているのが分かる状態だった。
  let clampedVideoInserts: SaveResponse['clampedVideoInserts'];
  let unplayableVideoInserts: { id: number; file: string }[] | undefined;
  if ((projectForSerialize.videoInserts ?? []).length > 0) {
    const sourceLengths = probeVideoInsertSourceLengths(
      dir,
      projectForSerialize.videoInserts ?? [],
      projectForSerialize.videoConfig.fps,
    );
    const { videoInserts: clamped, clampedIds, unplayableIds } = clampVideoInsertsToSourceLength(
      projectForSerialize.videoInserts ?? [],
      sourceLengths,
    );
    projectForSerialize.videoInserts = clamped;
    if (clampedIds.length > 0) {
      clampedVideoInserts = clamped
        .filter((v) => clampedIds.includes(v.id))
        .map((v) => ({ id: v.id, originalEnd: v.originalEnd, ...(v.timelinePlacement ? { timelinePlacement: v.timelinePlacement } : {}) }));
    }
    if (unplayableIds.length > 0) {
      unplayableVideoInserts = clamped
        .filter((v) => unplayableIds.includes(v.id))
        .map((v) => ({ id: v.id, file: v.file }));
    }
  }
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
    /** 完全既定ならnull（ファイル不要）、それ以外はmainAudioData.tsソース。 */
    mainAudioDataSource: string | null;
    scriptDocumentJson: string | null;
    editorTimelineJson: string | null;
  };
  try {
    sources = serializeProject(projectForSerialize);
    if (!isDefaultMainAudio(requestedMainAudio) && current.mainAudioSupported) {
      // Validate against the current projection, while retaining the existing
      // unsupported save boundary: legacy serialization does not combine
      // piecewise speed and transitions, and overlap speed has an end-time gap.
      const { model } = buildLegacyMainTimeline(projectForSerialize);
      const hasIndependentRate = model.speedSegments?.some(segment => segment.rate !== model.mainSpeed);
      const hasTransition = model.sceneTransitions.some(transition => typeof transition.at !== 'number'
        || model.joins.some(join => join.atOriginal === transition.at));
      if (hasIndependentRate && hasTransition) {
        throw new Error('区間ごとの速度と場面転換を併用した元音声の保存は未対応です。設定は変更せず保持しています。');
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(400, `保存データの生成に失敗しました: ${message}`);
  }

  // 上書き保存（data-safety-4）の退避。相手（別画面や AI）がディスクに書いた内容を
  // 消す前に、いま在るファイルを `.sme/backup/<日時>/` へ丸ごと複写しておく。
  // 退避に失敗したら保存自体を中止する（「取り返しがつかない」状態を作らない）。
  const backupDir = req.overwrite === true ? backupProjectFiles(dir, allRelPaths) : null;

  // 書き戻し（data-safety-7: 全ファイルを .tmp へ書き終えてから順に rename する）。
  // ここでは「何を書くか」だけを集め、実際の書き込みは writeFilesAtomic に一括で任せる。
  // 途中失敗しても「テロップだけ新しくカットは古い」状態を残さない。
  const writes: AtomicWrite[] = [
    { path: join(dir, telopRel), source: sources.telopDataSource },
    { path: join(dir, cutRel), source: sources.cutDataSource },
  ];
  // 削除は書き込みがすべて済んでから最後にまとめて行う（先に消して書けない事故を防ぐ）。
  const deletes: string[] = [];
  if (sources.seDataSource !== null) {
    writes.push({ path: join(dir, seRel), source: sources.seDataSource });
  }
  if (sources.insertImageDataSource !== null) {
    writes.push({ path: join(dir, insertImageRel), source: sources.insertImageDataSource });
  }
  if (sources.videoInsertDataSource !== null) {
    writes.push({ path: join(dir, videoInsertRel), source: sources.videoInsertDataSource });
  }
  if (sources.bgmDataSource !== null) {
    writes.push({ path: join(dir, bgmRel), source: sources.bgmDataSource });
  }

  // I-2 修正: タイトル0件かつ元ファイル不在なら書き込まない（孤立ファイル防止・bgm と対称）。
  if (sources.titleDataSource !== null) {
    writes.push({ path: join(dir, titleRel), source: sources.titleDataSource });
  }

  // 図形0件かつ元ファイル不在なら書き込まない（孤立ファイル防止・title と対称）。
  if (sources.shapeDataSource !== null) {
    writes.push({ path: join(dir, shapeRel), source: sources.shapeDataSource });
  }

  // トランジション0件かつ元ファイル不在なら書き込まない（孤立ファイル防止・shape と対称）。
  if (sources.transitionDataSource !== null) {
    writes.push({ path: join(dir, transitionRel), source: sources.transitionDataSource });
  }

  // Native packs require these exports even at defaults. Legacy markers also
  // retain them because existing project runtime may still import the data.
  const speedAbs = join(dir, speedRel);
  if (sources.speedDataSource !== null) {
    writes.push({ path: speedAbs, source: sources.speedDataSource });
  } else if (isSpeedInstalled(dir) || isMainLayoutInstalled(dir)
    || existsSync(join(dir, 'src/Speed/speed.json')) || existsSync(join(dir, 'src/MainLayout/main-layout.json'))) {
    // Keep both exports, including an empty per-segment map at default speed.
    writes.push({
      path: speedAbs,
      source: `// Harness Editor が生成・更新します（メイン動画の速度）\n\nexport const MAIN_SPEED = 1;\nexport const SEGMENT_SPEEDS: Record<number, number> = {  };\n`,
    });
  } else if (existsSync(speedAbs)) {
    deletes.push(speedAbs);
  }

  // mainLayoutData: 非 null なら書く／導入済みは恒等でも常在（MAIN_LAYOUT import 解決）／未導入 & 既定は削除。
  const mainLayoutAbs = join(dir, mainLayoutRel);
  if (sources.mainLayoutDataSource !== null) {
    writes.push({ path: mainLayoutAbs, source: sources.mainLayoutDataSource });
  } else if (isMainLayoutInstalled(dir) || existsSync(join(dir, 'src/MainLayout/main-layout.json'))) {
    // Preserve native required exports and legacy imports at identity layout.
    writes.push({ path: mainLayoutAbs, source: writeMainLayoutAlways(DEFAULT_MAIN_LAYOUT) });
  } else if (existsSync(mainLayoutAbs)) {
    deletes.push(mainLayoutAbs);
  }

  const mainAudioAbs = join(dir, mainAudioRel);
  if (sources.mainAudioDataSource !== null) {
    writes.push({ path: mainAudioAbs, source: sources.mainAudioDataSource });
  } else if (existsSync(mainAudioAbs)) {
    deletes.push(mainAudioAbs);
  }

  const scriptDocumentAbs = join(dir, scriptDocumentRel);
  const editorTimelineAbs = join(dir, editorTimelineRel);
  // Once created, an empty binding file is also written in the atomic batch.
  // Never delete it separately while saved asset times use the new clock.
  if (sources.editorTimelineJson !== null || existsSync(editorTimelineAbs)) {
    const source = sources.editorTimelineJson ?? '{"version":1,"placements":[]}\n';
    if (!existsSync(editorTimelineAbs) || readFileSync(editorTimelineAbs, 'utf8') !== source) {
      writes.push({ path: editorTimelineAbs, source });
    }
  }
  if (req.project.scriptDocument === undefined) {
    // 旧payloadはこのファイルを所有しない。現在値を読み直して書き戻すこともせず、
    // collector/UIなど別の書き手による同時更新を上書きしない。
  } else if (sources.scriptDocumentJson === null) {
    if (existsSync(scriptDocumentAbs)) deletes.push(scriptDocumentAbs);
  } else if (JSON.stringify(projectForSerialize.scriptDocument) !== JSON.stringify(current.project.scriptDocument)) {
    writes.push({ path: scriptDocumentAbs, source: sources.scriptDocumentJson });
  }

  writeFilesAtomic(writes);
  for (const path of deletes) {
    unlinkSync(path);
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
    mainAudioData: fingerprintFile(join(dir, mainAudioRel), mainAudioRel),
    scriptDocument: fingerprintFile(join(dir, scriptDocumentRel), scriptDocumentRel),
    editorTimeline: fingerprintFile(join(dir, editorTimelineRel), editorTimelineRel),
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

  return {
    ok: true,
    fingerprint,
    ...(clampedVideoInserts !== undefined ? { clampedVideoInserts } : {}),
    ...(unplayableVideoInserts !== undefined ? { unplayableVideoInserts } : {}),
    // 上書き保存で消した内容の退避先（data-safety-4）。通常保存では付かない。
    ...(backupDir === null ? {} : { backupDir }),
  };
}
