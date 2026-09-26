import { evalDataModule, assertFiniteNumbers } from './dataModule';
import {
  DEFAULT_MAIN_LAYOUT,
  isIdentityMainLayout,
  clampLayoutPos,
  clampLayoutScale,
  clampRotation,
} from './mainLayout';
import { hasPerSegmentLayout, segmentDiffersFromBase } from './segmentLayout';
import { parseMotion, formatMotion } from './motion';
import { parse as parseLayoutKeyframeList, format as formatLayoutKeyframeList, type LayoutKeyframe } from './layoutKeyframes';
import {
  DEFAULT_COLOR_GRADE,
  clampColorGradeValue,
  defaultColorGrade,
  isIdentityColorGrade,
  isIdentityColorWheels,
  normalizeColorWheels,
  type ColorGrade,
} from './colorGrade';
import type { MainLayout, SegmentLayout } from './types';

/** 既定レイアウトの新規コピー（ネスト position も複製）。 */
function defaultCopy(): MainLayout {
  return {
    position: { ...DEFAULT_MAIN_LAYOUT.position },
    scale: DEFAULT_MAIN_LAYOUT.scale,
    background: DEFAULT_MAIN_LAYOUT.background,
    rotation: 0,
    flipH: false,
    flipV: false,
  };
}

/** 評価済みモジュール `m` から MAIN_LAYOUT を取り出す（既定へフォールバック）。 */
function extractMainLayout(m: Record<string, unknown>): MainLayout {
  const raw = m.MAIN_LAYOUT;
  if (typeof raw !== 'object' || raw === null) return defaultCopy();
  const o = raw as Record<string, unknown>;
  const pos =
    typeof o.position === 'object' && o.position !== null
      ? (o.position as Record<string, unknown>)
      : {};
  const x = typeof pos.x === 'number' && Number.isFinite(pos.x) ? clampLayoutPos(pos.x) : 0;
  const y = typeof pos.y === 'number' && Number.isFinite(pos.y) ? clampLayoutPos(pos.y) : 0;
  const scale = typeof o.scale === 'number' && Number.isFinite(o.scale) ? clampLayoutScale(o.scale) : 1;
  const background =
    typeof o.background === 'string' && o.background !== '' ? o.background : DEFAULT_MAIN_LAYOUT.background;
  const rotation = typeof o.rotation === 'number' && Number.isFinite(o.rotation) ? clampRotation(o.rotation) : 0;
  const flipH = o.flipH === true;
  const flipV = o.flipV === true;
  return { position: { x, y }, scale, background, rotation, flipH, flipV };
}

/** 評価済みモジュール `m` から SEGMENT_LAYOUTS を取り出す（NaN/範囲外はガード・不在は空マップ）。 */
function extractSegmentLayouts(m: Record<string, unknown>): Record<number, SegmentLayout> {
  const raw = m.SEGMENT_LAYOUTS;
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<number, SegmentLayout> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(k);
    if (!Number.isFinite(id)) continue;
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    const pos =
      typeof o.position === 'object' && o.position !== null ? (o.position as Record<string, unknown>) : {};
    const x = typeof pos.x === 'number' && Number.isFinite(pos.x) ? clampLayoutPos(pos.x) : 0;
    const y = typeof pos.y === 'number' && Number.isFinite(pos.y) ? clampLayoutPos(pos.y) : 0;
    const scale = typeof o.scale === 'number' && Number.isFinite(o.scale) ? clampLayoutScale(o.scale) : 1;
    const rotation = typeof o.rotation === 'number' && Number.isFinite(o.rotation) ? clampRotation(o.rotation) : 0;
    // メイン動画の区間 motion はキーフレーム非対応。書き出し側の複製
    // （src/server/mainLayoutPayload/layoutSegments.ts）が 2 点アニメしか解釈しないため、
    // keys を通すとプレビューだけ動いて書き出しが静止する（黙って食い違う）。
    // メイン動画の時間変化は大域キーフレーム（LAYOUT_KEYFRAMES）が担当する。
    const parsedMotion = parseMotion(o.motion);
    const motion = parsedMotion === undefined
      ? undefined
      : (() => { const { keys: _drop, ...rest } = parsedMotion; return rest; })();
    out[id] = {
      position: { x, y }, scale, rotation, flipH: o.flipH === true, flipV: o.flipV === true,
      ...(motion !== undefined ? { motion } : {}),
    };
  }
  return out;
}

/**
 * 評価済みモジュール `m` から COLOR_GRADE を取り出す（不在/不正は無補正へフォールバック）。
 * 旧プロジェクト（COLOR_GRADE を持たない mainLayoutData.ts）は必ず無補正になる。
 */
function extractColorGrade(m: Record<string, unknown>): ColorGrade {
  const raw = m.COLOR_GRADE;
  if (typeof raw !== 'object' || raw === null) return defaultColorGrade();
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? clampColorGradeValue(v) : 0;
  return {
    brightness: num(o.brightness),
    contrast: num(o.contrast),
    saturation: num(o.saturation),
    temperature: num(o.temperature),
    ...(!isIdentityColorWheels(o.wheels) ? { wheels: normalizeColorWheels(o.wheels) } : {}),
  };
}

/** 評価済みモジュール `m` から LAYOUT_KEYFRAMES を取り出す（大域配列・不正/不在は空配列）。 */
function extractLayoutKeyframes(m: Record<string, unknown>): LayoutKeyframe[] {
  return parseLayoutKeyframeList(m.LAYOUT_KEYFRAMES) ?? [];
}

/**
 * `mainLayoutData.ts` の `LAYOUT_KEYFRAMES` を parse する（不在/不正は空配列）。
 * `parseMainLayoutFile` の戻り値（既存呼び出し元・既存テストとの後方互換のため）には含めず、
 * layoutKeyframes だけが必要な呼び出し元向けの独立 API として提供する。
 */
export function parseLayoutKeyframesData(source: string | null): LayoutKeyframe[] {
  if (source === null) return [];
  let m: Record<string, unknown>;
  try {
    m = evalDataModule(source, {});
  } catch {
    // 評価できない（構文エラー等）＝キーフレーム無しとして扱う（従来どおり）。
    return [];
  }
  // 評価は通るが値が壊れている場合は握り潰さない（catch の外で投げる）。
  assertMainLayoutFinite(m);
  return extractLayoutKeyframes(m);
}

/**
 * 評価済みモジュールの数値が有限か検査する（壊れた数値だけを fail-loud にする）。
 *
 * このファイルのパーサは「型が違う・欠けている」を既定へフォールバックする設計だが、
 * **NaN/±Infinity は型が正しいまま壊れている**ため、そのフォールバックに巻き込むと
 * ユーザーの指定したレイアウト・キーフレームが黙って恒等値へ倒れる（見た目は正常に開き、
 * 次の保存でその既定が確定して元の値は永久に失われる）。型違いのフォールバックは
 * 後方互換のため残し、壊れた数値だけをここで止める。
 */
function assertMainLayoutFinite(m: Record<string, unknown>): void {
  assertFiniteNumbers('mainLayoutData.ts', 'MAIN_LAYOUT', m.MAIN_LAYOUT);
  assertFiniteNumbers('mainLayoutData.ts', 'SEGMENT_LAYOUTS', m.SEGMENT_LAYOUTS);
  assertFiniteNumbers('mainLayoutData.ts', 'LAYOUT_KEYFRAMES', m.LAYOUT_KEYFRAMES);
  const grade = m.COLOR_GRADE;
  if (grade !== null && typeof grade === 'object' && !Array.isArray(grade)) {
    // Legacy scalar corruption still fails loudly; the new optional wheel
    // contract explicitly normalizes malformed/non-finite coordinates to zero.
    const { wheels: _wheels, ...legacy } = grade as Record<string, unknown>;
    assertFiniteNumbers('mainLayoutData.ts', 'COLOR_GRADE', legacy);
  } else {
    assertFiniteNumbers('mainLayoutData.ts', 'COLOR_GRADE', grade);
  }
}

/**
 * `mainLayoutData.ts` を1回の eval で MAIN_LAYOUT と SEGMENT_LAYOUTS 両方に parse する。
 * `parseMainLayoutData` / `parseSegmentLayoutsData` を個別に呼ぶと同じソースを2回 eval
 * してしまう（esbuild transform + vm 実行の二重コスト）ため、呼び出し元はこちらを使う。
 */
export function parseMainLayoutFile(source: string | null): {
  layout: MainLayout;
  segmentLayouts: Record<number, SegmentLayout>;
  layoutKeyframes: LayoutKeyframe[];
  colorGrade: ColorGrade;
} {
  const empty = (): {
    layout: MainLayout;
    segmentLayouts: Record<number, SegmentLayout>;
    layoutKeyframes: LayoutKeyframe[];
    colorGrade: ColorGrade;
  } => ({ layout: defaultCopy(), segmentLayouts: {}, layoutKeyframes: [], colorGrade: defaultColorGrade() });
  if (source === null) return empty();
  let m: Record<string, unknown>;
  try {
    m = evalDataModule(source, {});
  } catch {
    return empty();
  }
  assertMainLayoutFinite(m);
  return {
    layout: extractMainLayout(m),
    segmentLayouts: extractSegmentLayouts(m),
    layoutKeyframes: extractLayoutKeyframes(m),
    colorGrade: extractColorGrade(m),
  };
}

/**
 * `mainLayoutData.ts`（`export const MAIN_LAYOUT = {...}`）を parse する。
 * 不在 / 不正 / 欠損フィールドは既定へフォールバック（後方互換・安全側）。
 * 内部的には `parseMainLayoutFile` への薄い委譲（他呼び出し元・既存テストとの互換のため残置）。
 */
export function parseMainLayoutData(source: string | null): MainLayout {
  return parseMainLayoutFile(source).layout;
}

/** 1 区間分のフィールド列（skip-when-default）。 */
function segLayoutFields(s: SegmentLayout): string {
  const x = clampLayoutPos(s.position.x);
  const y = clampLayoutPos(s.position.y);
  const scale = clampLayoutScale(s.scale);
  const parts = [`position: { x: ${x}, y: ${y} }`, `scale: ${scale}`];
  const rotation = clampRotation(s.rotation ?? 0);
  if (rotation !== 0) parts.push(`rotation: ${rotation}`);
  if (s.flipH) parts.push(`flipH: true`);
  if (s.flipV) parts.push(`flipV: true`);
  if (s.motion !== undefined) parts.push(`motion: ${formatMotion(s.motion)}`);
  return `{ ${parts.join(', ')} }`;
}

/** SEGMENT_LAYOUTS のオブジェクトリテラル（全体と実質同一の冗長エントリは落とす・id 昇順）。 */
function formatSegmentLayouts(base: MainLayout, segmentLayouts: Record<number, SegmentLayout>): string {
  const ids = Object.keys(segmentLayouts)
    .map(Number)
    .filter((id) => {
      const s = segmentLayouts[id];
      if (s === undefined) return false;
      // hasPerSegmentLayout と同じ「全体と実質異なるか」の判定（segmentDiffersFromBase が単一ソース）。
      return segmentDiffersFromBase(base, s);
    })
    .sort((a, b) => a - b);
  if (ids.length === 0) return '{  }';
  return `{ ${ids.map((id) => `${id}: ${segLayoutFields(segmentLayouts[id]!)}`).join(', ')} }`;
}

/** LAYOUT_KEYFRAMES の配列リテラル（2 点未満なら空配列）。 */
function formatLayoutKeyframes(layoutKeyframes: LayoutKeyframe[]): string {
  return layoutKeyframes.length >= 2 ? formatLayoutKeyframeList(layoutKeyframes) : '[]';
}

/**
 * `mainLayoutData.ts` ソースを生成（速度 speedData.ts と同型）。
 * 完全既定（恒等＋既定背景＋個別ゼロ＋キーフレーム無し）なら null（ファイル不要・後方互換）。
 * それ以外は MAIN_LAYOUT ＋ SEGMENT_LAYOUTS（＋ 2 点以上あれば LAYOUT_KEYFRAMES）を出力
 * （frame 対応 payload の import 解決のため）。
 */
export function serializeMainLayoutData(
  layout: MainLayout,
  segmentLayouts: Record<number, SegmentLayout> = {},
  layoutKeyframes: LayoutKeyframe[] = [],
  colorGrade: ColorGrade = DEFAULT_COLOR_GRADE,
): string | null {
  const perSeg = hasPerSegmentLayout(layout, segmentLayouts);
  const hasKeyframes = layoutKeyframes.length >= 2;
  const hasColor = !isIdentityColorGrade(colorGrade);
  if (
    isIdentityMainLayout(layout) &&
    layout.background === DEFAULT_MAIN_LAYOUT.background &&
    !perSeg &&
    !hasKeyframes &&
    !hasColor
  ) {
    return null;
  }
  const x = clampLayoutPos(layout.position.x);
  const y = clampLayoutPos(layout.position.y);
  const scale = clampLayoutScale(layout.scale);
  const bg = JSON.stringify(layout.background);
  const parts = [`position: { x: ${x}, y: ${y} }`, `scale: ${scale}`, `background: ${bg}`];
  const rotation = clampRotation(layout.rotation ?? 0);
  if (rotation !== 0) parts.push(`rotation: ${rotation}`);
  if (layout.flipH) parts.push(`flipH: true`);
  if (layout.flipV) parts.push(`flipV: true`);
  // motion の型はパック（MainLayout/types.ts の Motion）と構造一致させる。
  // unknown にすると導入済みプロジェクトで SEGMENT_LAYOUTS が SegmentLayout へ代入不能になり tsc が落ちる。
  const motionState = '{ x?: number; y?: number; scale?: number; opacity?: number; rotation?: number }';
  const motionType = `{ preset: 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'fadeIn' | 'custom'; intensity?: number; from?: ${motionState}; to?: ${motionState} }`;
  const segType = `{ position: { x: number; y: number }; scale: number; rotation?: number; flipH?: boolean; flipV?: boolean; motion?: ${motionType} }`;
  const kfType = '{ originalFrame: number; x: number; y: number; scale: number; rotation: number }[]';
  return (
    `// Harness Editor が生成・更新します（メイン動画のレイアウト）\n\n` +
    `export const MAIN_LAYOUT = { ${parts.join(', ')} };\n` +
    `export const SEGMENT_LAYOUTS: Record<number, ${segType}> = ${formatSegmentLayouts(layout, segmentLayouts)};\n` +
    `export const LAYOUT_KEYFRAMES: ${kfType} = ${formatLayoutKeyframes(layoutKeyframes)};\n` +
    formatColorGradeExport(colorGrade)
  );
}

/**
 * COLOR_GRADE の export 行。**ファイルを出すときは無補正でも必ず出す**。
 *
 * 導入済み案件の `MainVideo.tsx` は `import { COLOR_GRADE } from './mainLayoutData'` を
 * 静的に持つ。無補正のときだけ export を落とすと「レイアウトは非既定・色は無補正」の
 * 案件で import が解決できず **`remotion render` がビルドで落ちる**（＝書き出せない）。
 * 出す/出さないの分岐を持たず、常在させる。
 *
 * ファイルそのものを出さない条件（完全既定 → null）は `serializeMainLayoutData` 側にある。
 * 旧案件（mainLayoutData.ts を持たない）は従来どおり 1 バイトも生えない。
 */
export function formatColorGradeExport(colorGrade: ColorGrade): string {
  const g = colorGrade;
  return (
    `export const COLOR_GRADE = { brightness: ${clampColorGradeValue(g.brightness)}, ` +
    `contrast: ${clampColorGradeValue(g.contrast)}, ` +
    `saturation: ${clampColorGradeValue(g.saturation)}, ` +
    `temperature: ${clampColorGradeValue(g.temperature)}` +
    (!isIdentityColorWheels(g.wheels) ? `, wheels: ${JSON.stringify(normalizeColorWheels(g.wheels))}` : '') +
    ` };\n`
  );
}


/**
 * `mainLayoutData.ts` の `SEGMENT_LAYOUTS` を parse する（NaN/範囲外はガード・不在は空マップ）。
 * 背景は持たない（全体共通）。parseMainLayoutData は従来どおり MainLayout（MAIN_LAYOUT）のみを返す。
 * 内部的には `parseMainLayoutFile` への薄い委譲（他呼び出し元・既存テストとの互換のため残置）。
 */
export function parseSegmentLayoutsData(source: string | null): Record<number, SegmentLayout> {
  return parseMainLayoutFile(source).segmentLayouts;
}
