export interface TextChangeSegment { before: string; after: string; changed: boolean }

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
const graphemes = (text: string) => Array.from(segmenter.segment(text), ({ segment }) => segment);

/** A bounded, display-only alignment. Never normalizes or edits the stored text. */
export function textChangeSegments(before: string, after: string): TextChangeSegment[] {
  if (before === after) return [{ before, after, changed: false }];
  const a = graphemes(before); const b = graphemes(after);
  let start = 0; let aEnd = a.length; let bEnd = b.length;
  while (start < aEnd && start < bEnd && a[start] === b[start]) start++;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd--; }
  const result: TextChangeSegment[] = [];
  const append = (old: string, next: string, changed: boolean) => {
    if (!old && !next) return;
    const last = result.at(-1);
    if (last?.changed === changed) { last.before += old; last.after += next; }
    else result.push({ before: old, after: next, changed });
  };
  append(a.slice(0, start).join(''), b.slice(0, start).join(''), false);
  const rows = aEnd - start + 1; const columns = bEnd - start + 1;
  // Large replacements retain exact text but use one coarse changed span.
  if (rows * columns > 250_000) {
    append(a.slice(start, aEnd).join(''), b.slice(start, bEnd).join(''), true);
  } else {
    const lengths = new Uint32Array(rows * columns);
    for (let i = rows - 2; i >= 0; i--) for (let j = columns - 2; j >= 0; j--) {
      lengths[i * columns + j] = a[start + i] === b[start + j]
        ? 1 + lengths[(i + 1) * columns + j + 1]!
        : Math.max(lengths[(i + 1) * columns + j]!, lengths[i * columns + j + 1]!);
    }
    let i = 0; let j = 0;
    while (i < rows - 1 || j < columns - 1) {
      if (i < rows - 1 && j < columns - 1 && a[start + i] === b[start + j]) {
        append(a[start + i++]!, b[start + j++]!, false);
      } else if (i < rows - 1 && (j === columns - 1 || lengths[(i + 1) * columns + j]! >= lengths[i * columns + j + 1]!)) {
        append(a[start + i++]!, '', true);
      } else { append('', b[start + j++]!, true); }
    }
  }
  append(a.slice(aEnd).join(''), b.slice(bEnd).join(''), false);
  return result;
}
