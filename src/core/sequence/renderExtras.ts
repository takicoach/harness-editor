import type { ClipContent, ClipVisual, TextAppearance } from './model';

export const HEX_COLOR = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const color = (value: unknown) => typeof value === 'string' && HEX_COLOR.test(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const GRADE_KEYS = ['brightness', 'contrast', 'saturation', 'temperature'] as const;

export function invalidShadow(value: unknown): boolean {
  return !record(value) || !only(value, ['x', 'y', 'blur', 'color']) || !num(value.x, -200, 200) || !num(value.y, -200, 200) || !num(value.blur, 0, 100) || !color(value.color);
}
export function shapeFillIssue(fill: unknown): string | null {
  if (!record(fill)) return '図形の塗りが不正です';
  if (fill.kind === 'solid') return only(fill, ['kind', 'color']) && color(fill.color) ? null : '図形の塗りが不正です';
  if (fill.kind !== 'linear') return '図形の塗りが不正です';
  const stops = fill.stops;
  if (!only(fill, ['kind', 'angle', 'stops']) || !num(fill.angle, -360, 360) || !Array.isArray(stops) || stops.length < 2 || stops.length > 4) return '図形のグラデーションが不正です';
  let previous = -1;
  for (const stop of stops) {
    if (!record(stop) || !only(stop, ['offset', 'color']) || !num(stop.offset, 0, 1) || !color(stop.color) || (stop.offset as number) < previous) return '図形のグラデーションが不正です';
    previous = stop.offset as number;
  }
  return null;
}
/** 強調語 `**語**`（改行・* を含まない 1 語以上）の取り出し。plain は `**` を除いた文字。 */
const EMPHASIS = /\*\*([^*\n]+)\*\*/g;
export type EmphasisPart = { text: string; emphasized: boolean };
export function emphasisParts(text: string): EmphasisPart[] {
  const parts: EmphasisPart[] = []; let last = 0;
  for (const match of text.matchAll(EMPHASIS)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), emphasized: false });
    parts.push({ text: match[1]!, emphasized: true }); last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), emphasized: false });
  return parts;
}
export const stripEmphasis = (text: string): string => text.replace(EMPHASIS, '$1');
export const emphasisCount = (text: string): number => Array.from(text.matchAll(EMPHASIS)).length;
export function textExtrasIssue(appearance: TextAppearance): string | null {
  const a = appearance as unknown as Record<string, unknown>;
  if (a.outlines !== undefined && (!Array.isArray(a.outlines) || a.outlines.length < 1 || a.outlines.length > 2
    || a.outlines.some(outline => !record(outline) || !only(outline, ['width', 'color']) || !num(outline.width, 0, 60) || !color(outline.color)))) return '文字の縁取りが不正です';
  if (a.shadow !== undefined && invalidShadow(a.shadow)) return '文字の影が不正です';
  if (a.skewDeg !== undefined && !num(a.skewDeg, -30, 30)) return '文字の傾きが不正です';
  const band = a.band;
  if (band !== undefined && (!record(band) || !only(band, ['color', 'padX', 'padY', 'radius']) || !color(band.color)
    || !num(band.padX, 0, 200) || !num(band.padY, 0, 200) || !num(band.radius, 0, 200))) return '文字の帯が不正です';
  const box = a.box;
  if (box !== undefined && (!record(box) || !only(box, ['width', 'anchor']) || !num(box.width, .05, 1) || !['bottom', 'center', 'top'].includes(String(box.anchor)))) return '文字枠が不正です';
  const emphasis = a.emphasis;
  if (emphasis !== undefined && (!record(emphasis) || !only(emphasis, ['color']) || !color(emphasis.color))) return '強調語の色が不正です';
  return null;
}
export function visualLookIssue(visual: ClipVisual, kind: ClipContent['kind']): string | null {
  const look = visual.look as unknown;
  if (look === undefined) return null;
  if (!record(look) || !only(look, ['grade', 'blur', 'edge', 'shadow', 'flipX'])) return '見た目の追加設定が不正です';
  if (kind !== 'image' && kind !== 'video') return '見た目の追加設定は画像と映像だけに使えます';
  const grade = look.grade;
  if (grade !== undefined) {
    if (!record(grade) || !only(grade, GRADE_KEYS) || !GRADE_KEYS.every(key => num(grade[key], -100, 100))) return '画像の色調整が不正です';
    if (kind !== 'image') return '映像の色調整は colorGrade を使います';
  }
  if (look.blur !== undefined && !num(look.blur, 0, 40)) return 'ぼかしが不正です';
  const edge = look.edge;
  if (edge !== undefined && (kind !== 'image' || !record(edge) || !only(edge, ['width', 'color']) || !num(edge.width, 0, 40) || !color(edge.color))) return '白フチが不正です';
  if (look.shadow !== undefined && (kind !== 'image' || invalidShadow(look.shadow))) return '画像の影が不正です';
  if (look.flipX !== undefined && (kind !== 'image' || typeof look.flipX !== 'boolean')) return '左右反転が不正です';
  return null;
}
export function shapeExtrasIssue(content: Extract<ClipContent, { kind: 'shape' }>): string | null {
  if (content.strokeWidth !== undefined && !num(content.strokeWidth, 0, 80)) return '図形の線の太さが不正です';
  if (content.cornerRadius !== undefined && !num(content.cornerRadius, 0, 1000)) return '図形の角丸が不正です';
  return content.fill === undefined ? null : shapeFillIssue(content.fill);
}
