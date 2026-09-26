/**
 * 新画面（native）専用のチュートリアル進行。旧画面の useTutorial は変えない。
 * 開始の種類（初回自動・自動復元・手動再実行）、準備待ち、ページまたぎの再開、前提状態の整え、
 * 体験の判定（本人の追加成功＋追加 ID＋対象文書）、ダイアログ中の非表示をここで持つ。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TutorialOverlayOptions } from './TutorialOverlay';
import { shouldAutoAdvance, takeSnapshot } from './tutorialMachine';
import type { TutorialCtx, TutorialSnapshot } from './tutorialSteps';
import type { TutorialApi } from './useTutorial';
import { NATIVE_TUTORIAL_STEPS, NATIVE_UNAVAILABLE_TEXT, type NativeStepPrep, type NativeTutorialStep } from './nativeTutorialSteps';
import {
  firstEditStepAfter, nativeTutorialView, nextNativeIndex, resumableStepIds,
  type NativeScene, type NativeTelopRecord, type NativeTutorialView,
} from './nativeTutorialFlow';
import {
  clearNativeTutorialResume, isNativeTutorialDone, markNativeTutorialDone, saveNativeTutorialResume, takeNativeTutorialResume,
} from './nativeTutorialStorage';
import { locateUsableTarget, readDialogState, type DialogState } from './nativeTutorialDom';

export type { NativeTelopRecord } from './nativeTutorialFlow';

export interface NativeTutorialInputs {
  scene: NativeScene;
  /** 編集画面の作品 ID（ホームは null）。 */
  projectId: string | null;
  /** いま開いている編集文書の ID（未取得・ホームは null）。 */
  documentId: string | null;
  hasProjects: boolean;
  /** ホーム: 一覧の取得済み。編集: 文書が操作可能。 */
  ready: boolean;
  /** 編集: 文書の読み込みに失敗し、既存のエラー表示が出ている。 */
  loadFailed: boolean;
  dirty: boolean;
  /** 手順に入るとき、対象が見える画面状態へ整える（NativeWorkspace が既存の入力確定処理を通す）。 */
  prepare?: (prep: NativeStepPrep) => Promise<void>;
  /** 体験で本人が追加した1件（と空になったトラック）だけを消す。成功で true。 */
  removeTelop?: (record: NativeTelopRecord) => Promise<boolean>;
}

export interface NativeTutorialApi extends TutorialApi {
  step: NativeTutorialStep | null;
  view: NativeTutorialView;
  overlayOptions: TutorialOverlayOptions;
  /** addText / addElement('title') のコマンド成功時に呼ぶ。体験の手順の間だけ受け付ける。 */
  recordTelopAdded: (record: NativeTelopRecord) => void;
  /**
   * 編集画面へ全ページ遷移する直前に呼ぶ（作成成功・作品カード・作品の切り替え・外部変更の再読み込み）。
   * 案内の表示中なら、遷移先で続ける手順を保存する: 編集画面で再開できる手順ならその手順、
   * それ以外（ホーム・welcome・記録が要る telop-done）はその先で最初の編集画面の手順。無ければ保存しない。
   */
  beforeNavigate: (projectId: string) => void;
}

const STEPS = NATIVE_TUTORIAL_STEPS;
const TICK_MS = 350;

function ctxOf(inputs: NativeTutorialInputs): TutorialCtx {
  return {
    home: inputs.scene === 'home',
    hasProjects: inputs.hasProjects,
    editorReady: inputs.scene === 'edit' && inputs.ready,
    telopCount: 0,
    dirty: inputs.dirty,
    domHas: (selector: string) => document.querySelector(selector) !== null,
  };
}

/** 吹き出し内のボタンにフォーカスが残ると、編集画面のキー処理（[role=dialog] 内は無視）が ⌘S を捨てる。 */
function releaseBubbleFocus(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest('.tut-bubble') !== null) active.blur();
}

export function useNativeTutorial(inputs: NativeTutorialInputs): NativeTutorialApi {
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const [dialogs, setDialogs] = useState<DialogState>({ dialogOpen: false, createDialogOpen: false });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [, setTick] = useState(0);
  const latest = useRef(inputs);
  latest.current = inputs;
  const activeRef = useRef(false);
  const indexRef = useRef(0);
  /** 手順に入った後の基準値。null の間は未取得（tick が最初の操作可能な描画で取る）。 */
  const snapRef = useRef<TutorialSnapshot | null>(null);
  const recordRef = useRef<NativeTelopRecord | null>(null);
  const autoRef = useRef(false);
  const removingRef = useRef(false);

  const activate = useCallback((value: boolean) => {
    activeRef.current = value;
    setActive(value);
  }, []);

  // 基準値はここでは取らない。「取り除く」の then は削除後の描画より先に走るので、ここで取ると古い描画の値になる。
  const moveTo = useCallback((i: number) => {
    indexRef.current = i;
    snapRef.current = null;
    setIndex(i);
  }, []);

  // サーバー設定（e2e では SME_TUTORIAL=0 で自動経路を無効化）。
  useEffect(() => {
    let alive = true;
    void fetch('/api/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { tutorialEnabled?: boolean } | null) => {
        if (alive) setEnabled(body?.tutorialEnabled === true);
      })
      .catch(() => {
        if (alive) setEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const close = useCallback(() => {
    activate(false);
    recordRef.current = null;
    markNativeTutorialDone();
    clearNativeTutorialResume();
  }, [activate]);

  const goTo = useCallback(
    (from: number) => {
      const current = latest.current;
      const i = nextNativeIndex(STEPS, from, current.scene, { hasProjects: current.hasProjects, hasRecord: recordRef.current !== null });
      if (i >= STEPS.length) {
        close(); // finish は any なので通常は到達しない保険
        return;
      }
      moveTo(i);
    },
    [close, moveTo],
  );

  const start = useCallback(() => {
    clearNativeTutorialResume();
    recordRef.current = null;
    activate(true);
    goTo(0);
  }, [activate, goTo]);

  const next = useCallback(() => {
    const at = indexRef.current;
    if (removingRef.current && STEPS[at]?.id === 'telop-done') return; // 「取り除く」の処理中は「残す」も無視（消えたまま save へ進むのを防ぐ）
    if (STEPS[at]?.id === 'finish') close();
    else goTo(at + 1);
    releaseBubbleFocus();
  }, [close, goTo]);

  const skip = useCallback(() => {
    const at = indexRef.current;
    if (removingRef.current && STEPS[at]?.id === 'telop-done') return; // 「取り除く」の処理中の二重押し
    const record = recordRef.current;
    const remove = latest.current.removeTelop;
    if (STEPS[at]?.id === 'telop-done' && record !== null && remove !== undefined) {
      removingRef.current = true;
      void remove(record)
        .then((ok) => {
          if (ok && activeRef.current && indexRef.current === at) goTo(at + 1);
        })
        .catch(() => undefined)
        .finally(() => {
          removingRef.current = false;
        });
    } else {
      goTo(at + 1);
    }
    releaseBubbleFocus();
  }, [goTo]);

  const recordTelopAdded = useCallback(
    (entry: NativeTelopRecord) => {
      if (!activeRef.current) return;
      const at = indexRef.current;
      if (STEPS[at]?.experience !== 'telop') return;
      if (entry.documentId !== latest.current.documentId) return;
      recordRef.current = entry;
      goTo(at + 1);
    },
    [goTo],
  );

  const beforeNavigate = useCallback((projectId: string) => {
    if (!activeRef.current) return;
    const at = indexRef.current;
    const current = STEPS[at];
    if (current === undefined) return;
    if (current.id === 'finish') {
      markNativeTutorialDone(); // 遷移先で「ようこそ」から出直さない
      return;
    }
    const stepId = resumableStepIds(STEPS).includes(current.id) ? current.id : firstEditStepAfter(STEPS, at);
    if (stepId !== null) saveNativeTutorialResume({ projectId, stepId });
  }, []);

  // 自動経路（初回・復元）は設定の取得後、許可されているときだけ。1 回だけ判定する。
  useEffect(() => {
    if (enabled === null || autoRef.current) return;
    autoRef.current = true;
    if (activeRef.current) return; // 手動で既に始まっている
    const current = latest.current;
    if (!enabled) {
      clearNativeTutorialResume();
      return;
    }
    if (current.scene === 'edit') {
      const stepId = takeNativeTutorialResume(current.projectId, resumableStepIds(STEPS));
      const at = stepId === null ? -1 : STEPS.findIndex((step) => step.id === stepId);
      if (at >= 0) {
        activate(true);
        moveTo(at);
        return;
      }
    } else {
      clearNativeTutorialResume();
    }
    if (!isNativeTutorialDone()) start();
  }, [enabled, activate, moveTo, start]);

  const step = active ? (STEPS[index] ?? null) : null;
  const prep = step?.prep;

  // 手順に入るとき（編集画面・文書が操作可能）に画面状態を整える。整え終わるまでは隠す。
  useEffect(() => {
    if (!active || prep === undefined || inputs.scene !== 'edit' || !inputs.ready) return;
    const prepare = latest.current.prepare;
    if (prepare === undefined) return;
    let alive = true;
    setPreparing(true);
    void prepare(prep)
      .catch(() => undefined)
      .finally(() => {
        if (alive) setPreparing(false);
      });
    return () => {
      alive = false;
      setPreparing(false);
    };
  }, [active, index, prep, inputs.scene, inputs.ready]);

  // 進行 tick: ダイアログの有無・保存の自動前進・照準追従の再描画。
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      const found = readDialogState();
      setDialogs((previous) =>
        previous.dialogOpen === found.dialogOpen && previous.createDialogOpen === found.createDialogOpen ? previous : found,
      );
      const current = latest.current;
      const at = indexRef.current;
      const s = STEPS[at];
      if (s !== undefined && s.scene === current.scene && current.ready) {
        const snap = snapRef.current;
        if (snap === null) {
          snapRef.current = takeSnapshot(ctxOf(current)); // 手順に入った後、最初に操作可能な描画で基準値を取る
        } else if (shouldAutoAdvance(s, ctxOf(current), snap)) {
          goTo(at + 1);
          return;
        }
      }
      setTick((t) => t + 1);
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [active, goTo]);

  const view = nativeTutorialView({
    active,
    step,
    scene: inputs.scene,
    ready: inputs.ready,
    loadFailed: inputs.loadFailed,
    dialogOpen: dialogs.dialogOpen,
    createDialogOpen: dialogs.createDialogOpen,
    preparing,
  });
  const overlayOptions: TutorialOverlayOptions =
    view.kind === 'hidden'
      ? { hidden: true }
      : view.kind === 'band'
        ? { band: view.text }
        : view.kind === 'waiting'
          ? { waiting: view.text }
          : { locate: (selector: string) => locateUsableTarget(selector), unavailableText: NATIVE_UNAVAILABLE_TEXT };

  return {
    active,
    step,
    index: index + 1,
    total: STEPS.length,
    ctx: ctxOf(inputs),
    next,
    skip,
    close,
    start,
    view,
    overlayOptions,
    recordTelopAdded,
    beforeNavigate,
  };
}
