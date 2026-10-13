import type { TextAppearance } from '../../../core/sequence/model';
import type { ThumbnailCommand } from '../../../core/thumbnail/commands';
import type { ThumbnailColorAdjust, ThumbnailContent, ThumbnailLayer, ThumbnailPage, ThumbnailShape, ThumbnailVisual } from '../../../core/thumbnail/model';
import { thumbnailTextAppearance } from '../../../core/thumbnail/textStyles';

export interface KnobValue { visual: ThumbnailVisual; content: ThumbnailContent }
export interface KnobSpec { id: string; label: string; hint: string; min: number; max: number; step: number; unit: string; initial: number }
export interface NumberKnob extends KnobSpec { kind: 'number'; read(value: KnobValue): number; write(value: KnobValue, next: number): KnobValue }
export interface ColorKnob { kind: 'color'; id: string; label: string; hint: string; initial: string; read(value: KnobValue): string; write(value: KnobValue, next: string): KnobValue }
export type Knob = NumberKnob | ColorKnob;

function withOptional<T extends object, K extends keyof T>(value: T, key: K, next: T[K] | undefined): T {
  const copy: Partial<T> = { ...value };
  if (next === undefined) delete copy[key]; else copy[key] = next;
  return copy as T;
}
const spec = (id: string, label: string, hint: string, min: number, max: number, unit: string, initial: number, step = 1): KnobSpec => ({ id, label, hint, min, max, step, unit, initial });
const visualKnob = (base: KnobSpec, get: (visual: ThumbnailVisual) => number, set: (visual: ThumbnailVisual, next: number) => ThumbnailVisual): NumberKnob =>
  ({ kind: 'number', ...base, read: value => get(value.visual), write: (value, next) => ({ ...value, visual: set(value.visual, next) }) });
const textKnob = (base: KnobSpec, get: (appearance: TextAppearance) => number, set: (appearance: TextAppearance, next: number) => TextAppearance): NumberKnob =>
  ({ kind: 'number', ...base, read: value => value.content.kind === 'text' ? get(value.content.appearance) : base.initial,
    write: (value, next) => value.content.kind === 'text' ? { ...value, content: { ...value.content, appearance: set(value.content.appearance, next) } } : value });
const textColorKnob = (id: string, label: string, hint: string, initial: string, get: (appearance: TextAppearance) => string, set: (appearance: TextAppearance, next: string) => TextAppearance): ColorKnob =>
  ({ kind: 'color', id, label, hint, initial, read: value => value.content.kind === 'text' ? get(value.content.appearance) : initial,
    write: (value, next) => value.content.kind === 'text' ? { ...value, content: { ...value.content, appearance: set(value.content.appearance, next) } } : value });
const shapeKnob = (base: KnobSpec, get: (shape: ThumbnailShape) => number, set: (shape: ThumbnailShape, next: number) => ThumbnailShape): NumberKnob =>
  ({ kind: 'number', ...base, read: value => value.content.kind === 'shape' ? get(value.content.shape) : base.initial,
    write: (value, next) => value.content.kind === 'shape' ? { ...value, content: { ...value.content, shape: set(value.content.shape, next) } } : value });

const ZERO_COLOR: ThumbnailColorAdjust = { brightness: 0, contrast: 0, saturation: 0, temperature: 0 };
const scale = (label: string) => visualKnob(spec('scale', label, '中心を基準に大きさを変えます', 5, 400, '%', 100), visual => Math.round(visual.scale * 100), (visual, next) => ({ ...visual, scale: next / 100 }));
const rotation = visualKnob(spec('rotation', '回転', '右回りが正。キャンバスの回転ハンドルは Shift で 15° 刻み', -180, 180, '°', 0), visual => visual.rotation, (visual, next) => ({ ...visual, rotation: next }));
const opacity = visualKnob(spec('opacity', '透明度', '0% で見えなくなります', 0, 100, '%', 100), visual => Math.round(visual.opacity * 100), (visual, next) => ({ ...visual, opacity: next / 100 }));
const tone = (field: keyof ThumbnailColorAdjust, label: string, hint: string) => visualKnob(spec(field, label, hint, -100, 100, '', 0), visual => visual.color?.[field] ?? 0, (visual, next) => {
  const color = { ...(visual.color ?? ZERO_COLOR), [field]: next };
  return withOptional(visual, 'color', Object.values(color).every(value => value === 0) ? undefined : color);
});
const blur = visualKnob(spec('blur', 'ぼかし', '背景をぼかして文字を目立たせます', 0, 40, 'px', 0), visual => visual.blur ?? 0, (visual, next) => withOptional(visual, 'blur', next > 0 ? next : undefined));
const offset = (axis: 'x' | 'y', label: string) => visualKnob(spec(`position-${axis}`, label, 'キャンバスの中心が 0%、端が ±100%', -150, 150, '%', 0),
  visual => Math.round(visual.position[axis] * 100), (visual, next) => ({ ...visual, position: { ...visual.position, [axis]: next / 100 } }));
const edgeWidth = visualKnob(spec('edge-width', '白フチの太さ', '切り抜いた画像のまわりに縁を付けます', 0, 40, 'px', 0), visual => visual.edge?.width ?? 0,
  (visual, next) => withOptional(visual, 'edge', next > 0 ? { width: next, color: visual.edge?.color ?? '#ffffff' } : undefined));
const edgeColor: ColorKnob = { kind: 'color', id: 'edge-color', label: '白フチの色', hint: '縁の色（太さが 0 のときは 12px で付けます）', initial: '#ffffff',
  read: value => value.visual.edge?.color.slice(0, 7) ?? '#ffffff', write: (value, next) => ({ ...value, visual: { ...value.visual, edge: { width: value.visual.edge?.width || 12, color: next } } }) };
const dropShadow = visualKnob(spec('shadow', '影', '下へ落ちる影の強さ', 0, 40, '', 0), visual => visual.shadow?.blur ?? 0,
  (visual, next) => withOptional(visual, 'shadow', next > 0 ? { x: 0, y: Math.round(next / 2), blur: next, color: '#00000099' } : undefined));

function setOutline(appearance: TextAppearance, index: 0 | 1, width: number): TextAppearance {
  const inner = appearance.outlines?.[0] ?? { width: 0, color: '#000000' }, outer = appearance.outlines?.[1] ?? { width: 0, color: '#ffffff' };
  const next = index === 0 ? [{ ...inner, width }, outer] : [inner, { ...outer, width }];
  return withOptional(appearance, 'outlines', next[1]!.width > 0 ? next : next[0]!.width > 0 ? [next[0]!] : undefined);
}
function setShadow(appearance: TextAppearance, change: { offset?: number; blur?: number; color?: string }): TextAppearance {
  const current = appearance.shadow ?? { x: 0, y: 0, blur: 0, color: '#000000cc' };
  const distance = change.offset ?? current.x, spread = change.blur ?? (change.color !== undefined && !appearance.shadow ? 12 : current.blur), color = change.color ?? current.color;
  return withOptional(appearance, 'shadow', distance === 0 && spread === 0 ? undefined : { x: distance, y: distance, blur: spread, color });
}
function setBand(appearance: TextAppearance, change: { color?: string; pad?: number; radius?: number }): TextAppearance {
  const current = appearance.band ?? { color: '#e60012', padX: 0, padY: 0, radius: 0 }, pad = change.pad ?? current.padY;
  const band = { color: change.color ?? current.color, padX: Math.round(pad * 2.5), padY: pad, radius: change.radius ?? current.radius };
  return withOptional(appearance, 'band', appearance.band || change.color !== undefined || pad > 0 || band.radius > 0 ? band : undefined);
}
const DEFAULT_TEXT = thumbnailTextAppearance();
const PHOTO: Knob[] = [tone('brightness', '明るさ', '写真全体を明るく・暗く'), tone('contrast', 'コントラスト', '明るいところと暗いところの差'),
  tone('saturation', '彩度', '-100 で白黒'), tone('temperature', 'あたたかさ', '+ で暖かい色、- で冷たい色'), blur, scale('拡大'), offset('x', '左右の位置'), offset('y', '上下の位置')];
const ELEMENT: Knob[] = [scale('大きさ'), rotation, opacity, tone('brightness', '明るさ', '画像を明るく・暗く'), edgeWidth, edgeColor, dropShadow];
const TEXT: Knob[] = [
  textKnob(spec('font-size', '大きさ', '文字の高さ（px）。四隅のハンドルでも変わります', 8, 400, 'px', DEFAULT_TEXT.fontSize), appearance => appearance.fontSize, (appearance, next) => ({ ...appearance, fontSize: next })),
  textKnob(spec('letter-spacing', '字間', '文字と文字の間', -20, 60, 'px', 0), appearance => appearance.letterSpacing, (appearance, next) => ({ ...appearance, letterSpacing: next })),
  textKnob(spec('line-height', '行間', '2 行のときの行の間（文字の高さに対する %）', 80, 250, '%', Math.round(DEFAULT_TEXT.lineHeight * 100), 5),
    appearance => Math.round(appearance.lineHeight * 100), (appearance, next) => ({ ...appearance, lineHeight: next / 100 })),
  textKnob(spec('skew', '傾き', '右へ倒すと勢いが出ます', -30, 30, '°', 0), appearance => appearance.skewDeg ?? 0, (appearance, next) => withOptional(appearance, 'skewDeg', next || undefined)),
  textKnob(spec('outline-inner', '内側の縁', '文字のすぐ外の縁（袋文字の 1 本目）', 0, 40, 'px', 0), appearance => appearance.outlines?.[0]?.width ?? 0, (appearance, next) => setOutline(appearance, 0, next)),
  textKnob(spec('outline-outer', '外側の縁', '内側の縁のさらに外の縁（2 重の袋文字）', 0, 40, 'px', 0), appearance => appearance.outlines?.[1]?.width ?? 0, (appearance, next) => setOutline(appearance, 1, next)),
  textKnob(spec('shadow-offset', '影のずらし', '右下へずらす量', 0, 40, 'px', 0), appearance => appearance.shadow?.x ?? 0, (appearance, next) => setShadow(appearance, { offset: next })),
  textKnob(spec('shadow-blur', '影のぼかし', '影のにじみ', 0, 60, 'px', 0), appearance => appearance.shadow?.blur ?? 0, (appearance, next) => setShadow(appearance, { blur: next })),
  textColorKnob('shadow-color', '影の色', '影の色', '#000000', appearance => (appearance.shadow?.color ?? '#000000').slice(0, 7), (appearance, next) => setShadow(appearance, { color: next })),
  textColorKnob('band-color', '帯の色', '文字の後ろに敷く帯', '#e60012', appearance => (appearance.band?.color ?? '#e60012').slice(0, 7), (appearance, next) => setBand(appearance, { color: next })),
  textKnob(spec('band-pad', '帯の余白', '帯の上下の余白（左右はその 2.5 倍）', 0, 60, 'px', 0), appearance => appearance.band?.padY ?? 0, (appearance, next) => setBand(appearance, { pad: next })),
  textKnob(spec('band-radius', '帯の角丸', '帯の角の丸さ', 0, 60, 'px', 0), appearance => appearance.band?.radius ?? 0, (appearance, next) => setBand(appearance, { radius: next })),
];
const SHAPE: Knob[] = [scale('大きさ'), rotation, opacity,
  shapeKnob(spec('stroke', '線の太さ', '0 にすると線なし（塗りだけ）', 0, 80, 'px', 8), shape => shape.strokeWidth, (shape, next) => ({ ...shape, strokeWidth: next })),
  shapeKnob(spec('corner', '角丸', '四角の角の丸さ', 0, 200, 'px', 0), shape => shape.cornerRadius, (shape, next) => ({ ...shape, cornerRadius: next }))];

export function knobGroupFor(layer: ThumbnailLayer): { title: string; knobs: Knob[] } {
  const content = layer.content;
  if (content.kind === 'video-frame' || (content.kind === 'image' && content.role === 'photo')) return { title: '写真', knobs: PHOTO };
  if (content.kind === 'image') return { title: '画像素材', knobs: ELEMENT };
  if (content.kind === 'text') return { title: '文字', knobs: TEXT };
  if (content.kind === 'shape') return { title: '図形', knobs: content.shape.kind === 'rect' ? SHAPE : SHAPE.filter(item => item.id !== 'corner') };
  return { title: '文字側の暗さ', knobs: [] };
}
/** 縁・影・帯・傾き・色調整・ぼかし・白フチを外し、数値のつまみを初期値にする。左右反転は残す。 */
export function resetKnobs(layer: ThumbnailLayer): KnobValue {
  let value: KnobValue = { visual: layer.visual, content: layer.content };
  if (value.content.kind === 'text') {
    const { outlines: _outlines, shadow: _shadow, band: _band, skewDeg: _skew, ...rest } = value.content.appearance;
    value = { ...value, content: { ...value.content, appearance: rest } };
  }
  if (layer.content.kind === 'image' || layer.content.kind === 'video-frame') {
    const { color: _color, blur: _blur, edge: _edge, shadow: _shadow, ...rest } = value.visual;
    value = { ...value, visual: rest };
  }
  return knobGroupFor(layer).knobs.reduce((current, knob) => knob.kind === 'number' ? knob.write(current, knob.initial) : current, value);
}
/** 「初期値に戻す」の 1 回の操作。選んだ物（1 つ・ロックなし）のつまみと、サムネ全体のつまみ（色の組み合わせ・文字側の暗さ）を戻す。
 *  順番は「選んだ物 → 色の組み合わせ → 暗さの帯を外す」。色の組み合わせは選んだ物の色も回し戻すので、選んだ物を先に戻す。
 *  ロック中の物（暗さの帯を含む）は触らない。戻すものが無ければ null。 */
export function resetCommand(page: ThumbnailPage, layer: ThumbnailLayer | undefined): ThumbnailCommand | null {
  const commands: ThumbnailCommand[] = [];
  if (layer && !layer.locked) {
    const next = resetKnobs(layer);
    if (JSON.stringify(next) !== JSON.stringify({ visual: layer.visual, content: layer.content }))
      commands.push({ type: 'update-layer', pageId: page.id, layerId: layer.id, patch: { visual: next.visual, content: next.content } });
  }
  if (page.hueShift !== 0) commands.push({ type: 'shift-page-hue', pageId: page.id, degrees: 0 });
  const shades = page.layers.filter(item => item.content.kind === 'gradient' && !item.locked).map(item => item.id);
  if (shades.length) commands.push({ type: 'delete-layers', pageId: page.id, layerIds: shades });
  return commands.length === 0 ? null : commands.length === 1 ? commands[0]! : { type: 'batch', commands };
}
