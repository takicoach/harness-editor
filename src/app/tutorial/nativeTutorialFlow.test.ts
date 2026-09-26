import { describe, expect, it } from 'vitest';
import type { SequenceDocument } from '../../core/sequence/model';
import { NATIVE_CREATE_BAND_TEXT, NATIVE_TUTORIAL_STEPS as S, NATIVE_WAITING_TEXT } from './nativeTutorialSteps';
import {
  firstEditStepAfter, nativeTutorialView, nextNativeIndex, resumableStepIds, telopRemovalCommand, type NativeViewFacts,
} from './nativeTutorialFlow';

const at = (id: string): number => S.findIndex((s) => s.id === id);
const idAt = (i: number): string => S[i]?.id ?? 'END';
const facts = { hasProjects: true, hasRecord: false };

describe('nextNativeIndex（この画面で出せる次の手順）', () => {
  it('ホームは welcome → home-intro → board → create', () => {
    expect(idAt(nextNativeIndex(S, 0, 'home', facts))).toBe('welcome');
    expect(idAt(nextNativeIndex(S, 1, 'home', facts))).toBe('home-intro');
    expect(idAt(nextNativeIndex(S, at('home-intro') + 1, 'home', facts))).toBe('board');
    expect(idAt(nextNativeIndex(S, at('board') + 1, 'home', facts))).toBe('create');
  });
  it('作品0件なら board を飛ばす', () => {
    expect(idAt(nextNativeIndex(S, at('home-intro') + 1, 'home', { hasProjects: false, hasRecord: false }))).toBe('create');
  });
  it('ホームで作成を飛ばすと、編集の手順を全部飛ばして finish', () => {
    expect(idAt(nextNativeIndex(S, at('create') + 1, 'home', facts))).toBe('finish');
  });
  it('編集画面では welcome の次が modes（ホームの手順を飛ばす）', () => {
    expect(idAt(nextNativeIndex(S, at('welcome') + 1, 'edit', facts))).toBe('modes');
  });
  it('telop-done は本人の追加の記録があるときだけ', () => {
    expect(idAt(nextNativeIndex(S, at('telop-try') + 1, 'edit', { hasProjects: true, hasRecord: false }))).toBe('save');
    expect(idAt(nextNativeIndex(S, at('telop-try') + 1, 'edit', { hasProjects: true, hasRecord: true }))).toBe('telop-done');
  });
  it('finish の先は steps.length', () => {
    expect(nextNativeIndex(S, S.length, 'edit', facts)).toBe(S.length);
  });
});

describe('firstEditStepAfter / resumableStepIds', () => {
  it('作成の次に来る編集画面の手順は modes', () => {
    expect(firstEditStepAfter(S, at('create'))).toBe('modes');
  });
  it('再開できるのは編集画面の手順だけ（記録が要る telop-done と any/home は除く）', () => {
    const ids = resumableStepIds(S);
    expect(ids).toContain('modes');
    expect(ids).toContain('help');
    expect(ids).not.toContain('telop-done');
    expect(ids).not.toContain('welcome');
    expect(ids).not.toContain('create');
    expect(ids).not.toContain('finish');
  });
});

describe('nativeTutorialView（見せ方）', () => {
  const base = (over: Partial<NativeViewFacts> = {}): NativeViewFacts => ({
    active: true, step: S[at('modes')]!, scene: 'edit', ready: true, loadFailed: false,
    dialogOpen: false, createDialogOpen: false, preparing: false, ...over,
  });
  it('停止中・手順なしは off', () => {
    expect(nativeTutorialView(base({ active: false }))).toEqual({ kind: 'off' });
    expect(nativeTutorialView(base({ step: null }))).toEqual({ kind: 'off' });
  });
  it('ふだんは step', () => {
    expect(nativeTutorialView(base())).toEqual({ kind: 'step' });
  });
  it('準備待ち: 自分の画面の手順で文書が未準備なら「読み込み中…」（飛ばさない）', () => {
    expect(nativeTutorialView(base({ ready: false }))).toEqual({ kind: 'waiting', text: NATIVE_WAITING_TEXT });
  });
  it('読み込みに失敗したら既存のエラー表示を優先して隠す', () => {
    expect(nativeTutorialView(base({ ready: false, loadFailed: true }))).toEqual({ kind: 'hidden' });
  });
  it('welcome/finish（any）は準備待ちにしない', () => {
    expect(nativeTutorialView(base({ step: S[at('welcome')]!, ready: false }))).toEqual({ kind: 'step' });
    expect(nativeTutorialView(base({ step: S[at('finish')]!, ready: false }))).toEqual({ kind: 'step' });
  });
  it('編集画面の読み込み失敗では welcome/finish（any）も隠す（エラー表示の上に暗幕と吹き出しを出さない）', () => {
    expect(nativeTutorialView(base({ step: S[at('welcome')]!, ready: false, loadFailed: true }))).toEqual({ kind: 'hidden' });
    expect(nativeTutorialView(base({ step: S[at('finish')]!, ready: false, loadFailed: true }))).toEqual({ kind: 'hidden' });
  });
  it('ダイアログ表示中は隠す', () => {
    expect(nativeTutorialView(base({ dialogOpen: true }))).toEqual({ kind: 'hidden' });
  });
  it('作成手順だけは作成ダイアログの表示中に案内帯', () => {
    const create = S[at('create')]!;
    expect(nativeTutorialView(base({ step: create, scene: 'home', dialogOpen: true, createDialogOpen: true })))
      .toEqual({ kind: 'band', text: NATIVE_CREATE_BAND_TEXT });
    expect(nativeTutorialView(base({ step: create, scene: 'home', dialogOpen: true, createDialogOpen: false })))
      .toEqual({ kind: 'hidden' });
  });
  it('画面を整えている間は隠す', () => {
    expect(nativeTutorialView(base({ preparing: true }))).toEqual({ kind: 'hidden' });
  });
});

describe('telopRemovalCommand（取り除く）', () => {
  const doc = (tracks: Array<{ id: string }>, clips: Array<{ id: string; trackId: string }>, id = 'doc-1') =>
    ({ id, tracks, clips }) as unknown as SequenceDocument;
  const record = { documentId: 'doc-1', clipId: 'c1', trackId: 't1' };
  it('記録した1件と、空になるトラックだけを消す（ほかの編集には触れない）', () => {
    expect(telopRemovalCommand(doc([{ id: 't1' }, { id: 't2' }], [{ id: 'c1', trackId: 't1' }, { id: 'c2', trackId: 't2' }]), record))
      .toEqual({ type: 'batch', commands: [{ type: 'delete', clipIds: ['c1'] }, { type: 'remove-track', trackId: 't1' }] });
  });
  it('同じトラックにほかのクリップがあればトラックは残す', () => {
    expect(telopRemovalCommand(doc([{ id: 't1' }], [{ id: 'c1', trackId: 't1' }, { id: 'c3', trackId: 't1' }]), record))
      .toEqual({ type: 'delete', clipIds: ['c1'] });
  });
  it('本人がもう消していて空のトラックだけが残っていれば、トラックだけ消す', () => {
    expect(telopRemovalCommand(doc([{ id: 't1' }], []), record)).toEqual({ type: 'remove-track', trackId: 't1' });
  });
  it('何も残っていなければ何もしない', () => {
    expect(telopRemovalCommand(doc([], []), record)).toBeNull();
  });
  it('別の文書には何もしない', () => {
    expect(telopRemovalCommand(doc([{ id: 't1' }], [{ id: 'c1', trackId: 't1' }], 'doc-2'), record)).toBeNull();
  });
});
