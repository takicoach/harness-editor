/** #rrggbb / #rrggbbaa の色相を degrees 回す。無彩色と 16 進以外はそのまま返す。 */
export function rotateHexHue(color: string, degrees: number): string {
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(color);
  if (!match || !degrees) return color;
  const value = parseInt(match[1]!, 16), r = ((value >> 16) & 255) / 255, g = ((value >> 8) & 255) / 255, b = (value & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), lightness = (max + min) / 2, delta = max - min;
  if (delta === 0) return color;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (((hue * 60 + degrees) % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation, x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1)), m = lightness - chroma / 2;
  const [r1, g1, b1] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  const channel = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, '0');
  return `#${channel(r1)}${channel(g1)}${channel(b1)}${match[2] ?? ''}`;
}
