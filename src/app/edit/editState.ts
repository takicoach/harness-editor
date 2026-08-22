import type { CutOrderAnchor, CutRegion, DuckingSettings, EditorProject, EditorBgmClip, EditorImage, EditorSe, EditorShape, EditorTelop, EditorTitle, EditorVideoInsert, MainLayout, SegmentLayout, SceneTransition, TelopPosition } from '../../core/types';
import { DEFAULT_DUCKING } from './duckingSettings';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import type { LayoutKeyframe } from '../../core/layoutKeyframes';

/** インスペクタ・タイムラインで選択中の対象。一度に 1 つだけ。 */
export type Selection =
  | { kind: 'telop'; id: number }
  | { kind: 'se'; id: number }
  | { kind: 'image'; id: number }
  | { kind: 'videoInsert'; id: number }
  | { kind: 'bgm'; id: number }
  | { kind: 'title'; id: number }
  | { kind: 'shape'; id: number }
  | { kind: 'join'; at: 'head' | 'tail' | number }
  | { kind: 'cutSegment'; id: number }
  | { kind: 'mainVideo' };

/**
 * エディタの編集状態（編集の正）。
 * Plan 2A の EditorProject（サーバ由来・不変）から派生し、編集対象だけを保持する。
 * Undo/Redo はこのオブジェクト全体をスナップショットして履歴へ積む。
 */
export interface EditState {
  /** 原本フレームアンカーのテロップ（編集の正）。 */
  telops: EditorTelop[];
  /** 原本タイムラインから削除する区間。 */
  cutRegions: CutRegion[];
  /**
   * 再生順アンカー（cutData.ts の配列順スナップショット・読み取り専用）。
   * カット並び替え編集の順序はここから再導出する（cutRegions は原素材順しか表せない）。
   * 未設定なら従来どおり原素材順（恒等順列）。
   */
  cutOrder?: CutOrderAnchor[];
  /**
   * 原素材の総フレーム数（不変）。並び替え写像を UI 側で再導出するのに必要。
   * createEditState が必ず設定する（未設定なら並び替えは恒等に縮退する）。
   */
  originalTotalFrames?: number;
  /** 原本フレームアンカーの効果音（編集の正）。 */
  se: EditorSe[];
  /** 原本フレームアンカーの挿入画像（編集の正）。 */
  images: EditorImage[];
  /** 原本フレームアンカーのサブ動画インサート（編集の正）。 */
  videoInserts: EditorVideoInsert[];
  /** 原本フレームアンカーの BGM クリップ（編集の正）。 */
  bgm: EditorBgmClip[];
  /** インスペクタ・タイムラインで選択中の対象（未選択は null）。 */
  selection: Selection | null;
  /**
   * テロップの複数選択集合（プライマリ＝`selection` は温存し、その上に重ねる）。
   * 不変条件は {@link normalizeMultiSelection} に集約する。**空、またはサイズ 2 以上で
   * プライマリを含む**のどちらかしか取らない（サイズ 1 の「複数選択」は作らない）。
   * 履歴スナップショットの一部なので selection と同様に Undo/Redo で巻き戻り、
   * dirty 判定（{@link samePersistedContent}）では無視する。
   */
  multiTelopIds: number[];
  /** 分割で新テロップへ割り当てる次の ID。 */
  nextTelopId: number;
  /** 新規 SE へ割り当てる次の ID。 */
  nextSeId: number;
  /** 新規画像へ割り当てる次の ID。 */
  nextImageId: number;
  /** 新規サブ動画インサートへ割り当てる次の ID。 */
  nextVideoInsertId: number;
  /** 新規 BGM クリップへ割り当てる次の ID。 */
  nextBgmId: number;
  /** 原本フレームアンカーのタイトル（編集の正）。 */
  titles: EditorTitle[];
  /** 分割で新タイトルへ割り当てる次の ID。 */
  nextTitleId: number;
  /** ダッキングのグローバル設定（編集の正・Undo/Redo 対象）。 */
  ducking: DuckingSettings;
  /** 原本フレームアンカーの図形オーバーレイ（編集の正）。 */
  shapes: EditorShape[];
  /** 新規図形へ割り当てる次の ID。 */
  nextShapeId: number;
  /** シーン転換設定（編集の正）。 */
  sceneTransitions: SceneTransition[];
  /** 新規シーン転換へ割り当てる次の ID。 */
  nextTransitionId: number;
  /** メイン動画 全体一律の速度（倍率・既定 1.0）。 */
  mainSpeed: number;
  /** 区間 id → 倍率（個別指定のみ）。 */
  segmentSpeeds: Record<number, number>;
  /** メイン動画の自由レイアウト（全区間共通・未設定＝全画面・PiP 風）。 */
  mainLayout?: MainLayout;
  /** 区間 id → レイアウト上書き(個別指定のみ)。 */
  segmentLayouts: Record<number, SegmentLayout>;
  /**
   * メイン動画の大域キーフレーム列（カット非依存・原本フレームアンカー・originalFrame 昇順）。
   * 2 点以上あればカット区間に縛られずメイン動画レイアウトをこれで連続補間駆動する。
   */
  layoutKeyframes: LayoutKeyframe[];
}

/**
 * EditorProject から初期の EditState を作る。
 * telops / cutRegions / se / images / videoInserts は 1 段スプレッドでコピーする（position 等のネスト値は参照共有）。
 * reducer は必ず新しいオブジェクトを返すため、state を直接書き換えないこと。
 */
/**
 * タイトル一本化（読み込み時マイグレーション）で使う変換テンプレート。
 * 旧タイトル帯は紫グラデのため、近い id5「白文字紫シャドウ」を既定スタイルにする。
 */
export const TITLE_CONVERT_TEMPLATE = 5;

/**
 * 旧タイトルを装飾テロップへ変換する（タイトル機能のテロップ一本化）。
 * 文字・表示区間はそのまま、配置は上・左（旧タイトルの左上配置を踏襲）、スタイルは紫シャドウ。
 * manual:true で装飾テロップ扱いになり、位置/サイズ/スタイルを自由に編集できる。
 * テロップ描画経路に乗るため、保存後は telopData として書き出しにも自動で一致する。
 */
export function titleToTelop(title: EditorTitle, id: number): EditorTelop {
  return {
    id,
    originalStart: title.originalStart,
    originalEnd: title.originalEnd,
    text: title.text,
    manual: true,
    position: { x: -1, y: -1 },
    template: TITLE_CONVERT_TEMPLATE,
  };
}

export function createEditState(project: EditorProject, ducking: DuckingSettings = DEFAULT_DUCKING): EditState {
  const baseTelops = project.telops.map((t) => ({ ...t }));
  const cutRegions = project.cutRegions.map((r) => ({ ...r }));
  const se = project.se.map((s) => ({ ...s }));
  const images = project.images.map((i) => ({ ...i }));
  const videoInserts = (project.videoInserts ?? []).map((v) => ({ ...v }));
  const bgm = (project.bgm ?? []).map((b) => ({ ...b }));
  const shapes = (project.shapes ?? []).map((s) => ({ ...s }));
  const sceneTransitions = (project.sceneTransitions ?? []).map((t) => ({ ...t }));
  // タイトル一本化: 既存タイトルを装飾テロップへ自動変換して telops へ統合する。
  // 新規 id は既存テロップの最大 id の続きから振る（衝突回避）。
  const baseMaxTelopId = baseTelops.reduce((max, t) => Math.max(max, t.id), 0);
  const convertedTitles = project.titles.map((t, i) => titleToTelop(t, baseMaxTelopId + 1 + i));
  const telops = [...baseTelops, ...convertedTitles];
  const maxTelopId = telops.reduce((max, t) => Math.max(max, t.id), 0);
  const maxSeId = se.reduce((max, s) => Math.max(max, s.id), 0);
  const maxImageId = images.reduce((max, i) => Math.max(max, i.id), 0);
  const maxVideoInsertId = videoInserts.reduce((max, v) => Math.max(max, v.id), 0);
  const maxBgmId = bgm.reduce((max, b) => Math.max(max, b.id), 0);
  const maxShapeId = shapes.reduce((max, s) => Math.max(max, s.id), 0);
  const maxTransitionId = sceneTransitions.reduce((max, t) => Math.max(max, t.id), 0);
  return {
    telops,
    cutRegions,
    // 並び替え（再生順）は編集対象ではないが、写像の再導出に必要なので状態へ持ち回す。
    cutOrder: project.cutOrder,
    originalTotalFrames: project.videoConfig.durationFrames,
    se,
    images,
    videoInserts,
    bgm,
    shapes,
    sceneTransitions,
    // タイトルはテロップへ一本化済み。titles は常に空（旧タイトル機能は撤去）。
    titles: [],
    selection: null,
    // 読込・再読込では複数選択を必ず空にする（前プロジェクトの ID を持ち越さない）。
    multiTelopIds: [],
    nextTelopId: maxTelopId + 1,
    nextSeId: maxSeId + 1,
    nextImageId: maxImageId + 1,
    nextVideoInsertId: maxVideoInsertId + 1,
    nextBgmId: maxBgmId + 1,
    nextTitleId: 1,
    nextShapeId: maxShapeId + 1,
    nextTransitionId: maxTransitionId + 1,
    ducking,
    mainSpeed: project.mainSpeed,
    segmentSpeeds: { ...(project.segmentSpeeds ?? {}) },
    mainLayout: project.mainLayout ?? DEFAULT_MAIN_LAYOUT,
    segmentLayouts: { ...(project.segmentLayouts ?? {}) },
    layoutKeyframes: (project.layoutKeyframes ?? []).map((k) => ({ ...k })),
  };
}

/**
 * テスト・軽量初期化向けの EditState コンストラクタ。
 * `mainSpeed` と `segmentSpeeds` だけを project から引き取り、残りはデフォルト値で埋める。
 * （`createEditState` は telops/se/bgm 等が必須の完全な EditorProject を要求するため分離）
 * @internal テスト・軽量初期化専用。本番コードでは {@link createEditState} を使うこと（全コレクションが空になるため）。
 */
export function initialEditState(project: Pick<EditorProject, 'mainSpeed' | 'segmentSpeeds'>): EditState {
  return {
    telops: [],
    cutRegions: [],
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    selection: null,
    multiTelopIds: [],
    nextTelopId: 1,
    nextSeId: 1,
    nextImageId: 1,
    nextVideoInsertId: 1,
    nextBgmId: 1,
    titles: [],
    nextTitleId: 1,
    shapes: [],
    nextShapeId: 1,
    sceneTransitions: [],
    nextTransitionId: 1,
    ducking: DEFAULT_DUCKING,
    mainSpeed: project.mainSpeed,
    segmentSpeeds: { ...(project.segmentSpeeds ?? {}) },
    mainLayout: DEFAULT_MAIN_LAYOUT,
    segmentLayouts: {},
    layoutKeyframes: [],
  };
}

/**
 * 複数選択集合 `multiTelopIds` の不変条件を強制する中央正規化（設計書 §1）。
 *
 * 1. 集合は空、または**サイズ 2 以上でプライマリ（`selection.id`）を含む**
 * 2. 全 ID が `telops` に実在する（不在 ID は除去・重複も除去）
 * 3. `selection.kind !== 'telop'`（未選択含む）のとき集合は空
 * 4. 上を満たせなくなったら集合を空にする（例: 分割で選択が新断片へ移る → 複数選択解除）
 *
 * テロップ配列や選択を変えうる全経路の後段でこれを通す。整合性維持を個々の op へ
 * 散らすと、新しい op を足したときに不正状態（消えた ID が残る・プライマリが集合外）が
 * 生まれる。`useEditSession` の apply / setTransient でも通しているため、選択種別を
 * 変えるだけの経路（SE や画像のクリック等）も自動的に集合クリアされる。
 *
 * 変更が無ければ **同一 state 参照**を返す（無駄な再レンダー・空 Undo を作らない）。
 */
export function normalizeMultiSelection(state: EditState): EditState {
  // 部分オブジェクトを EditState へキャストする既存テストがあるため防御的に読む。
  const ids: number[] = state.multiTelopIds ?? [];
  if (ids.length === 0) return state;
  const primary = state.selection?.kind === 'telop' ? state.selection.id : null;
  if (primary === null) return { ...state, multiTelopIds: [] };
  const existing = new Set(state.telops.map((t) => t.id));
  const seen = new Set<number>();
  const next: number[] = [];
  for (const id of ids) {
    if (!existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  if (next.length < 2 || !seen.has(primary)) return { ...state, multiTelopIds: [] };
  const unchanged = next.length === ids.length && next.every((id, i) => id === ids[i]);
  return unchanged ? state : { ...state, multiTelopIds: next };
}

/** 複数選択を解除する（もともと空なら同一参照）。 */
export function clearMultiSelection(state: EditState): EditState {
  if ((state.multiTelopIds ?? []).length === 0) return state;
  return { ...state, multiTelopIds: [] };
}

/**
 * 修飾キー＋クリックによる複数選択のトグル（設計書 §1）。
 * 最後にクリックしたテロップがプライマリ（`selection`）になる。
 *
 * - テロップ未選択・他種選択中なら、修飾キー付きでも単なる単一選択として扱う。
 * - 唯一の選択テロップを解除しようとした場合は何もしない（未選択状態は作らない）。
 * - 解除でサイズ 1 になったら不変条件により集合は空へ落ちる（＝単一選択へ戻る）。
 */
export function toggleMultiTelopSelection(state: EditState, telopId: number): EditState {
  if (!state.telops.some((t) => t.id === telopId)) return state;
  const primary = state.selection?.kind === 'telop' ? state.selection.id : null;
  if (primary === null) {
    return normalizeMultiSelection({
      ...state,
      selection: { kind: 'telop', id: telopId },
      multiTelopIds: [],
    });
  }
  // 集合が空のときは「プライマリ 1 個だけが選ばれている」とみなして開始する。
  const current = (state.multiTelopIds ?? []).length === 0 ? [primary] : [...state.multiTelopIds];
  if (!current.includes(telopId)) {
    return normalizeMultiSelection({
      ...state,
      selection: { kind: 'telop', id: telopId },
      multiTelopIds: [...current, telopId],
    });
  }
  const rest = current.filter((id) => id !== telopId);
  const last = rest[rest.length - 1];
  if (last === undefined) return state; // 唯一の選択の解除 → 何もしない
  return normalizeMultiSelection({
    ...state,
    selection: { kind: 'telop', id: telopId === primary ? last : primary },
    multiTelopIds: rest,
  });
}

/** 区間速度マップの浅い等値比較。 */
function sameSpeedMap(a: Record<number, number>, b: Record<number, number>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[Number(k)] === b[Number(k)]);
}

/** MainLayout の深い等値比較（未設定は既定とみなす）。 */
function sameMainLayout(a: MainLayout | undefined, b: MainLayout | undefined): boolean {
  const x = a ?? DEFAULT_MAIN_LAYOUT;
  const y = b ?? DEFAULT_MAIN_LAYOUT;
  return (
    x.scale === y.scale &&
    x.position.x === y.position.x &&
    x.position.y === y.position.y &&
    x.background === y.background &&
    (x.rotation ?? 0) === (y.rotation ?? 0) &&
    !!x.flipH === !!y.flipH &&
    !!x.flipV === !!y.flipV
  );
}

/** 区間レイアウトマップの深い等値比較。 */
function sameSegmentLayoutMap(a: Record<number, SegmentLayout>, b: Record<number, SegmentLayout>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const x = a[Number(k)];
    const y = b[Number(k)];
    if (x === undefined || y === undefined) return false;
    if (
      x.scale !== y.scale ||
      x.position.x !== y.position.x ||
      x.position.y !== y.position.y ||
      (x.rotation ?? 0) !== (y.rotation ?? 0) ||
      !!x.flipH !== !!y.flipH ||
      !!x.flipV !== !!y.flipV ||
      !sameMotion(x.motion, y.motion)
    ) return false;
  }
  return true;
}

/** LayoutKeyframe[] の等値比較（長さ・originalFrame 含む全フィールド一致）。 */
function sameLayoutKeyframeList(a: LayoutKeyframe[], b: LayoutKeyframe[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (
      x.originalFrame !== y.originalFrame ||
      x.x !== y.x ||
      x.y !== y.y ||
      x.scale !== y.scale ||
      x.rotation !== y.rotation
    ) return false;
  }
  return true;
}

/** TelopPosition の深い等値比較（両方 undefined → true、片方のみ → false）。 */
function samePosition(a: TelopPosition | undefined, b: TelopPosition | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.x === b.x && a.y === b.y;
}

/** EditorTelop の永続化フィールドを比較する。 */
/** Motion（2点アニメ）の等値比較。小さな入れ子オブジェクトのため素朴に全キー比較。 */
function sameMotion(
  a: import('../../core/motion').Motion | undefined,
  b: import('../../core/motion').Motion | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.preset === b.preset &&
    a.intensity === b.intensity &&
    sameMotionState(a.from, b.from) &&
    sameMotionState(a.to, b.to)
  );
}

function sameMotionState(
  a: import('../../core/motion').MotionState | undefined,
  b: import('../../core/motion').MotionState | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.x === b.x && a.y === b.y && a.scale === b.scale &&
    a.opacity === b.opacity && a.rotation === b.rotation
  );
}

function sameTelop(a: EditorTelop, b: EditorTelop): boolean {
  return (
    a.id === b.id &&
    a.originalStart === b.originalStart &&
    a.originalEnd === b.originalEnd &&
    a.text === b.text &&
    a.highlight === b.highlight &&
    a.style === b.style &&
    a.template === b.template &&
    a.animation === b.animation &&
    samePosition(a.position, b.position) &&
    a.scale === b.scale &&
    sameMotion(a.motion, b.motion) &&
    a.manual === b.manual
  );
}

/** CutRegion の等値比較。 */
function sameCutRegion(a: CutRegion, b: CutRegion): boolean {
  return a.start === b.start && a.end === b.end;
}

/** EditorSe の永続化フィールドを比較する。 */
function sameSe(a: EditorSe, b: EditorSe): boolean {
  return (
    a.id === b.id &&
    a.originalStart === b.originalStart &&
    a.file === b.file &&
    a.volume === b.volume
  );
}

/** EditorImage の永続化フィールドを比較する。 */
function sameImage(a: EditorImage, b: EditorImage): boolean {
  return (
    a.id === b.id &&
    a.originalStart === b.originalStart &&
    a.originalEnd === b.originalEnd &&
    a.file === b.file &&
    a.type === b.type &&
    a.scale === b.scale &&
    sameMotion(a.motion, b.motion)
  );
}

/** EditorVideoInsert の永続化フィールドを比較する。 */
function sameVideoInsert(a: EditorVideoInsert, b: EditorVideoInsert): boolean {
  return (
    a.id === b.id &&
    a.originalStart === b.originalStart &&
    a.originalEnd === b.originalEnd &&
    a.file === b.file &&
    a.sourceInFrame === b.sourceInFrame &&
    samePosition(a.position, b.position) &&
    a.scale === b.scale &&
    a.playbackRate === b.playbackRate
  );
}

/** EditorShape の永続化フィールドを比較する。 */
function sameShape(a: EditorShape, b: EditorShape): boolean {
  return (
    a.id === b.id &&
    a.originalStart === b.originalStart &&
    a.originalEnd === b.originalEnd &&
    a.kind === b.kind &&
    a.x1 === b.x1 &&
    a.y1 === b.y1 &&
    a.x2 === b.x2 &&
    a.y2 === b.y2 &&
    a.color === b.color &&
    a.thickness === b.thickness &&
    a.opacity === b.opacity
  );
}

/** EditorBgmClip の永続化フィールドを比較する。 */
function sameBgmClip(a: EditorBgmClip, b: EditorBgmClip): boolean {
  return (
    a.id === b.id &&
    a.originalStart === b.originalStart &&
    a.originalEnd === b.originalEnd &&
    a.file === b.file &&
    a.volume === b.volume &&
    a.fadeInFrames === b.fadeInFrames &&
    a.fadeOutFrames === b.fadeOutFrames
  );
}

/**
 * 2 つの EditState の「ディスクへ永続化される内容」が等しいかを返す純関数。
 * telops・cutRegions・se・images・videoInserts・bgm・titles を比較し、selection・nextTelopId・nextSeId・nextImageId・nextVideoInsertId・nextBgmId・nextTitleId は無視する。
 * Undo/Redo 後の dirty 判定に使用する。
 */
export function samePersistedContent(a: EditState, b: EditState): boolean {
  if (a.telops.length !== b.telops.length) return false;
  if (a.cutRegions.length !== b.cutRegions.length) return false;
  if (a.se.length !== b.se.length) return false;
  if (a.images.length !== b.images.length) return false;
  if (a.videoInserts.length !== b.videoInserts.length) return false;
  if (a.bgm.length !== b.bgm.length) return false;
  if (a.titles.length !== b.titles.length) return false;
  if (a.shapes.length !== b.shapes.length) return false;
  if (a.sceneTransitions.length !== b.sceneTransitions.length) return false;
  for (let i = 0; i < a.telops.length; i++) {
    const ta = a.telops[i];
    const tb = b.telops[i];
    if (ta === undefined || tb === undefined) return false;
    if (!sameTelop(ta, tb)) return false;
  }
  for (let i = 0; i < a.cutRegions.length; i++) {
    const ra = a.cutRegions[i];
    const rb = b.cutRegions[i];
    if (ra === undefined || rb === undefined) return false;
    if (!sameCutRegion(ra, rb)) return false;
  }
  for (let i = 0; i < a.se.length; i++) {
    const sa = a.se[i];
    const sb = b.se[i];
    if (sa === undefined || sb === undefined) return false;
    if (!sameSe(sa, sb)) return false;
  }
  for (let i = 0; i < a.images.length; i++) {
    const ia = a.images[i];
    const ib = b.images[i];
    if (ia === undefined || ib === undefined) return false;
    if (!sameImage(ia, ib)) return false;
  }
  for (let i = 0; i < a.videoInserts.length; i++) {
    const va = a.videoInserts[i];
    const vb = b.videoInserts[i];
    if (va === undefined || vb === undefined) return false;
    if (!sameVideoInsert(va, vb)) return false;
  }
  for (let i = 0; i < a.bgm.length; i++) {
    const ba = a.bgm[i];
    const bb = b.bgm[i];
    if (ba === undefined || bb === undefined) return false;
    if (!sameBgmClip(ba, bb)) return false;
  }
  for (let i = 0; i < a.titles.length; i++) {
    const ta = a.titles[i];
    const tb = b.titles[i];
    if (ta === undefined || tb === undefined) return false;
    if (ta.id !== tb.id || ta.originalStart !== tb.originalStart || ta.originalEnd !== tb.originalEnd || ta.text !== tb.text) return false;
  }
  for (let i = 0; i < a.shapes.length; i++) {
    const sa = a.shapes[i];
    const sb = b.shapes[i];
    if (sa === undefined || sb === undefined) return false;
    if (!sameShape(sa, sb)) return false;
  }
  for (let i = 0; i < a.sceneTransitions.length; i++) {
    const ta = a.sceneTransitions[i];
    const tb = b.sceneTransitions[i];
    if (ta === undefined || tb === undefined) return false;
    if (ta.id !== tb.id || ta.at !== tb.at || ta.kind !== tb.kind || ta.durationFrames !== tb.durationFrames || ta.color !== tb.color) return false;
  }
  if (a.ducking.enabled !== b.ducking.enabled || a.ducking.strength !== b.ducking.strength) return false;
  if (a.mainSpeed !== b.mainSpeed) return false;
  if (!sameSpeedMap(a.segmentSpeeds, b.segmentSpeeds)) return false;
  if (!sameMainLayout(a.mainLayout, b.mainLayout)) return false;
  if (!sameSegmentLayoutMap(a.segmentLayouts, b.segmentLayouts)) return false;
  if (!sameLayoutKeyframeList(a.layoutKeyframes, b.layoutKeyframes)) return false;
  return true;
}

/**
 * EditState と不変の base EditorProject から「現在の EditorProject」を合成する。
 * 編集されない部分（videoConfig / transcript / 各 source）は base から引き継ぐ。
 * 保存・プレビュー用のスナップショット生成に使う。
 */
export function toEditorProject(state: EditState, base: EditorProject): EditorProject {
  return {
    videoConfig: base.videoConfig,
    projectConfig: base.projectConfig,
    transcript: base.transcript,
    telops: state.telops,
    cutRegions: state.cutRegions,
    cutOrder: base.cutOrder,
    se: state.se,
    images: state.images,
    videoInserts: state.videoInserts,
    bgm: state.bgm,
    telopDataSource: base.telopDataSource,
    cutDataSource: base.cutDataSource,
    seDataSource: base.seDataSource,
    insertImageDataSource: base.insertImageDataSource,
    videoInsertDataSource: base.videoInsertDataSource ?? null,
    bgmDataSource: base.bgmDataSource ?? null,
    titles: state.titles,
    titleDataSource: base.titleDataSource,
    ducking: state.ducking,
    shapes: state.shapes,
    shapeDataSource: base.shapeDataSource ?? null,
    sceneTransitions: state.sceneTransitions,
    mainSpeed: state.mainSpeed,
    segmentSpeeds: state.segmentSpeeds,
    mainLayout: state.mainLayout,
    segmentLayouts: state.segmentLayouts,
    layoutKeyframes: state.layoutKeyframes,
  };
}
