import {SequenceError} from './errors';
import {isMediaContent, type SequenceDocument, type SequenceClip} from './model';
import {compareTime, isRational, rational, type Rational} from './time';
import {adoptSpeedSourceCaptions, captionLedgers, refreshCaptionBaselines, speedProjectionForDocument, upgradeNativeSpeedMetadata} from './speedCaptionLedger';

function fail(message: string, id: string): never {
  throw new SequenceError('INVALID_DOCUMENT', message, [id]);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRational(value) && Object.keys(value).length === 2) {
    const r = rational(value.num, value.den);
    return {num: r.num, den: r.den};
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => [k, canonical(v)]));
  return value;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const equalTime = (a: Rational, b: Rational) => compareTime(a, b) === 0;
function sameClock(a: SequenceClip['visual'], b: SequenceClip['visual']): boolean {
  const x = a?.keyframeClock, y = b?.keyframeClock;
  return !x && !y || !!x && !!y && equalTime(x.offset, y.offset) && equalTime(x.rate, y.rate) && equalTime(x.duration, y.duration);
}
function hasSourceProvider(doc: SequenceDocument, clip: SequenceClip): boolean {
  const anchor = clip.anchor;
  return anchor?.kind === 'source' && doc.clips.some(provider => provider.id === anchor.clipOccurrenceId && provider.speed);
}
function rebindEnd(before: SequenceDocument, next: SequenceDocument): boolean {
  if (!next.speed || next.sequenceEndFrame === before.sequenceEndFrame) return false;
  const end = next.speed.sequenceEndBasis;
  if (end.kind === 'empty-fixed') end.endFrame = next.sequenceEndFrame;
  else end.offsetFrames = next.sequenceEndFrame - speedProjectionForDocument(before).mainEndFrame;
  return true;
}
/** Ordinary insert remains fixed; source captions explicitly reference an existing provider. */
export function rebindSpeedInsert(before: SequenceDocument, next: SequenceDocument, ids: readonly string[]): SequenceDocument {
  if (!before.speed) return next;
  const inserted = next.clips.filter(c => ids.includes(c.id));
  for (const c of inserted) if (c.speed !== undefined) fail('速度の役割を持つ挿入には専用登録コマンドが必要です', c.id);
  const changedEnd = rebindEnd(before, next);
  const sourceIds = inserted.filter(c => hasSourceProvider(next, c)).map(c => c.id);
  if (sourceIds.length) {
    if (next.speed!.version === 1) return upgradeNativeSpeedMetadata(next);
    adoptSpeedSourceCaptions(next, sourceIds);
    refreshCaptionBaselines(next);
  } else if (changedEnd && next.speed!.version === 2) refreshCaptionBaselines(next);
  return next;
}
/** Property edits update presentation only, never recover source intent from live time. */
export function rebindSpeedProperty(before: SequenceDocument, next: SequenceDocument, id: string): SequenceDocument {
  if (!before.speed) return next;
  const original = before.clips.find(c => c.id === id)!, edited = next.clips.find(c => c.id === id)!;
  // Do not validate an intermediate document while its presentation ledger is stale.
  if (equal([original.name, original.content, original.visual], [edited.name, edited.content, edited.visual])) return next;
  if (original.speed) {
    const a = original.content, b = edited.content;
    if (!isMediaContent(a) || !isMediaContent(b) || a.kind !== b.kind || a.assetId !== b.assetId || a.streamIndex !== b.streamIndex || !equalTime(a.sourceIn, b.sourceIn) || !equalTime(a.rate, b.rate)) {
      fail('登録素材の種類・素材・stream・開始・速度は専用コマンドで変更してください', id);
    }
  }
  const source = hasSourceProvider(before, original);
  const peer = captionLedgers(before).some(l => l.detachedContinuations?.some(p => p.clipId === id));
  if ((original.speed || source || peer) && !sameClock(original.visual, edited.visual)) fail('登録済みの専用キー時計は専用再結合コマンドで変更してください', id);
  if (!source) return next;
  if (edited.content.kind !== 'telop') fail('登録字幕の種類変更には専用コマンドが必要です', id);
  if (before.speed.version === 1) {
    // Capture the old templates before replacing only the explicitly selected part.
    next = structuredClone(upgradeNativeSpeedMetadata(before));
    next.clips[next.clips.findIndex(c => c.id === id)] = edited;
  }
  const ledger = captionLedgers(next).find(l => l.parts.some(p => p.reservedRenderId === id));
  if (!ledger) return fail('登録字幕の表示partがありません', id);
  const part = ledger.parts.find(p => p.reservedRenderId === id)!;
  const template = structuredClone(part.presentation?.template ?? ledger.template);
  template.name = edited.name;
  template.content = structuredClone(edited.content);
  if (edited.visual) {
    template.visual = structuredClone(edited.visual);
    delete template.visual.keyframeClock;
  } else delete template.visual;
  part.presentation = {template};
  return next;
}
