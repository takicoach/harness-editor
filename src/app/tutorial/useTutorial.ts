import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TUTORIAL_DONE_KEY,
  TUTORIAL_STEPS,
  type TutorialCtx,
  type TutorialSnapshot,
  type TutorialStep,
} from './tutorialSteps';
import { firstApplicable, isApplicable, shouldAutoAdvance, takeSnapshot } from './tutorialMachine';

/** App から供給する実状態（domHas はフック側で足す）。 */
export interface TutorialInputs {
  home: boolean;
  hasProjects: boolean;
  editorReady: boolean;
  telopCount: number;
  dirty: boolean;
}

export interface TutorialApi {
  active: boolean;
  step: TutorialStep | null;
  /** 表示用の進捗（1始まり / 総数）。 */
  index: number;
  total: number;
  ctx: TutorialCtx;
  next: () => void;
  skip: () => void;
  close: () => void;
  start: () => void;
}

function isDone(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_DONE_KEY) !== null;
  } catch {
    return true; // localStorage 不可なら自動開始しない（毎回出て煩わせない）
  }
}

function markDone(): void {
  try {
    localStorage.setItem(TUTORIAL_DONE_KEY, new Date().toISOString());
  } catch {
    /* 保存できなくても致命ではない */
  }
}

const TICK_MS = 350;

/**
 * チュートリアルの進行状態。初回起動時（tutorialEnabled かつ未完了かつホーム表示）に自動開始し、
 * ⚙メニューの「チュートリアルをもう一度見る」からは環境設定と無関係に起動できる。
 */
export function useTutorial(inputs: TutorialInputs): TutorialApi {
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  // tick ごとに再レンダーして動的照準・本文・自動前進を反映する。
  const [, setTick] = useState(0);
  const snapRef = useRef<TutorialSnapshot>({ telopCount: 0, dirty: false });
  const autoStartedRef = useRef(false);

  const buildCtx = useCallback(
    (): TutorialCtx => ({
      ...inputs,
      domHas: (selector: string) => document.querySelector(selector) !== null,
    }),
    [inputs],
  );

  // サーバー設定（e2e では SME_TUTORIAL=0 で自動開始を無効化）。
  const [enabled, setEnabled] = useState<boolean | null>(null);
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

  const goTo = useCallback(
    (from: number) => {
      const ctx = buildCtx();
      const i = firstApplicable(TUTORIAL_STEPS, from, ctx);
      if (i >= TUTORIAL_STEPS.length) {
        // 適用できるステップが無い（通常は finish に着地するため到達しない保険）。
        setActive(false);
        markDone();
        return;
      }
      snapRef.current = takeSnapshot(ctx);
      setIndex(i);
    },
    [buildCtx],
  );

  const start = useCallback(() => {
    setActive(true);
    goTo(0);
  }, [goTo]);

  const close = useCallback(() => {
    setActive(false);
    markDone();
  }, []);

  const next = useCallback(() => {
    const step = TUTORIAL_STEPS[index];
    if (step?.id === 'finish') {
      close();
      return;
    }
    goTo(index + 1);
  }, [index, goTo, close]);

  // 初回自動開始: ホーム表示・未完了・サーバー許可のとき1回だけ。
  useEffect(() => {
    if (autoStartedRef.current || active) return;
    if (enabled === true && inputs.home && !isDone()) {
      autoStartedRef.current = true;
      start();
    }
  }, [enabled, inputs.home, active, start]);

  // 進行 tick: 自動前進の検知・現在ステップが表示不能になった場合の再解決・照準追従の再描画。
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const ctx = buildCtx();
      const step = TUTORIAL_STEPS[index];
      if (step === undefined) return;
      if (!isApplicable(step, ctx)) {
        // 画面が変わって現在ステップが出せなくなった（例: エディタ→ホームへ戻った）。
        goTo(index);
        return;
      }
      if (shouldAutoAdvance(step, ctx, snapRef.current)) {
        goTo(index + 1);
        return;
      }
      setTick((t) => t + 1);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [active, index, buildCtx, goTo]);

  return {
    active,
    step: active ? (TUTORIAL_STEPS[index] ?? null) : null,
    index: index + 1,
    total: TUTORIAL_STEPS.length,
    ctx: buildCtx(),
    next,
    skip: next,
    close,
    start,
  };
}
