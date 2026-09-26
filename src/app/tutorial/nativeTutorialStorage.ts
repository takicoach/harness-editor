/**
 * 新画面チュートリアルの記録。完了（「あとで」を含む）＝localStorage、ページまたぎの再開＝sessionStorage。
 * 旧画面のキー sme-tutorial-done とは別キー。キー名は新しい導入体験を作るまで変えない。
 * 保存先は引数で差し替えられる（テストで「使えない保存先」を直接渡すため）。
 */
export const NATIVE_TUTORIAL_DONE_KEY = 'harness-native-tutorial-done';
export const NATIVE_TUTORIAL_RESUME_KEY = 'harness-native-tutorial-resume';

export type TutorialStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function localStore(): TutorialStorage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function sessionStore(): TutorialStorage | null {
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** 完了済みか。localStorage が使えないときは完了扱い（自動で出さない。旧画面と同じ方針）。 */
export function isNativeTutorialDone(storage: TutorialStorage | null = localStore()): boolean {
  if (storage === null) return true;
  try {
    return storage.getItem(NATIVE_TUTORIAL_DONE_KEY) !== null;
  } catch {
    return true;
  }
}

export function markNativeTutorialDone(storage: TutorialStorage | null = localStore()): void {
  try {
    storage?.setItem(NATIVE_TUTORIAL_DONE_KEY, new Date().toISOString());
  } catch {
    /* 保存できなくても致命ではない */
  }
}

export interface NativeTutorialResume {
  projectId: string;
  stepId: string;
}

export function saveNativeTutorialResume(value: NativeTutorialResume, storage: TutorialStorage | null = sessionStore()): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(NATIVE_TUTORIAL_RESUME_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearNativeTutorialResume(storage: TutorialStorage | null = sessionStore()): void {
  try {
    storage?.removeItem(NATIVE_TUTORIAL_RESUME_KEY);
  } catch {
    /* 消せなくても、次に取り出すときに検証して捨てる */
  }
}

/**
 * 再開情報を取り出して消す。同じ作品・既知の手順のときだけ手順 ID を返す。
 * 別の作品・壊れた値・未知の手順は null（どの場合も消す）。
 */
export function takeNativeTutorialResume(
  projectId: string | null,
  validStepIds: readonly string[],
  storage: TutorialStorage | null = sessionStore(),
): string | null {
  if (storage === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(NATIVE_TUTORIAL_RESUME_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  clearNativeTutorialResume(storage);
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const { projectId: saved, stepId } = value as Record<string, unknown>;
    if (typeof saved !== 'string' || saved === '' || saved !== projectId) return null;
    if (typeof stepId !== 'string' || !validStepIds.includes(stepId)) return null;
    return stepId;
  } catch {
    return null;
  }
}
