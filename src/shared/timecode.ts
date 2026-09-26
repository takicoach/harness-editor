/** Frame-count timecode (non-drop-frame). Seconds input uses the actual fps. */
export function formatTimecode(frame: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps));
  const value = Math.max(0, Math.round(frame));
  const seconds = Math.floor(value / rate);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, '0')).join(':')
    + ':' + String(value % rate).padStart(Math.max(2, String(rate - 1).length), '0');
}

export function parseTimecode(value: string, fps: number): number | null {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const text = value.trim();
  let frame: number;
  if (/^\d+f$/i.test(text)) frame = Number(text.slice(0, -1));
  else if (/^\d+(?:\.\d+)?$/.test(text)) frame = Math.round(Number(text) * fps);
  else {
    const parts = text.split(':');
    if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
      const [h, m, s, f] = parts.map(Number) as [number, number, number, number];
      const rate = Math.max(1, Math.round(fps));
      if (m >= 60 || s >= 60 || f >= rate) return null;
      frame = ((h * 60 + m) * 60 + s) * rate + f;
    } else if ((parts.length === 2 || parts.length === 3)
      && parts.slice(0, -1).every((part) => /^\d+$/.test(part))
      && /^\d+(?:\.\d+)?$/.test(parts.at(-1) ?? '')) {
      const numbers = parts.map(Number);
      if (numbers.at(-1)! >= 60 || (parts.length === 3 && numbers[1]! >= 60)) return null;
      frame = Math.round(numbers.reduce((total, part) => total * 60 + part, 0) * fps);
    } else return null;
  }
  return Number.isSafeInteger(frame) && frame >= 0 ? frame : null;
}
