import { useCallback, useMemo, useRef, useState } from 'react';
import type { EditorProject } from '../core/types';
import type { ProjectFingerprint, SaveRequest, SaveResponse } from '../shared/types';
import { putJson } from './fetchJson';
import { createEditState, toEditorProject, samePersistedContent, normalizeMultiSelection, type EditState } from './edit/editState';
import { loadDuckingSettings } from './edit/duckingSettings';
import {
  canRedo,
  canUndo,
  createHistory,
  current,
  pushState,
  redo,
  undo,
  type History,
} from './edit/history';
import type { SaveMeta } from './useEditorProject';

/** 保存処理の状態。 */
type SaveStatus = 'idle' | 'saving' | 'error';

/**
 * 次の状態そのもの、または「直前の状態から次の状態を作る関数」。
 *
 * 呼び出し側の多くは `apply(someOp(state, ...))` のようにレンダー時クロージャの `state` を
 * 素材にする。これは同一レンダー中に複数回状態を更新する経路（例: pointerdown で
 * setTransient して選択を変え、pointerup で apply する）では、再レンダーが挟まる保証が
 * ない限り「古い state で上書きして直前の更新を取り消す」危険がある。
 * 関数形を渡せば常に履歴の最新状態を素材にできるので、その不整合を構造的に断てる。
 *
 * **関数形は純関数であること**（React の setState updater と同じ契約。StrictMode の
 * 開発ビルドでは 2 回呼ばれるため、副作用を書くと二重に走る）。
 */
export type EditStateOrUpdater = EditState | ((prev: EditState) => EditState);

/**
 * 関数形なら最新状態へ適用し、値形ならそのまま返す。
 *
 * 併せて複数選択集合の不変条件を中央で強制する（`normalizeMultiSelection`）。
 * 選択種別を変えるだけの経路（SE・画像・BGM クリック等）は多数あり、そのすべてへ
 * 「集合をクリアする」を書き足すと必ず取りこぼす。ここを通せば apply / setTransient の
 * どちらから来ても不正状態（他種選択なのに集合が残る／消えた ID が残る）にならない。
 * 正規化は冪等で、変化が無ければ同一参照を返すため二重適用しても副作用はない。
 */
function resolveNext(next: EditStateOrUpdater, prev: EditState): EditState {
  return normalizeMultiSelection(typeof next === 'function' ? next(prev) : next);
}

/** 編集セッションが UI へ公開する API。 */
export interface EditSession {
  /** 現在の編集状態。 */
  state: EditState;
  /**
   * 履歴へ積みながら状態を更新する（編集操作はすべてこれを通す）。
   * 同一レンダー中に複数回更新しうる経路では関数形 `apply((s) => op(s, ...))` を使うこと。
   */
  apply: (next: EditStateOrUpdater) => void;
  /**
   * 履歴を積まずに状態を更新する（選択変更などの非編集操作用）。
   * 同上、関数形を渡せば古いクロージャで上書きする事故を防げる。
   */
  setTransient: (next: EditStateOrUpdater) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** 未保存の変更があるか。 */
  dirty: boolean;
  /** 保存処理の状態。 */
  saveStatus: SaveStatus;
  /** 直近の保存エラーメッセージ（無ければ null）。 */
  saveError: string | null;
  /**
   * ディスクへ保存する。
   * @returns 保存が成功したら true。ガード早期 return（history/baseProject 等が無い・
   *   saving 中の再入）・API 失敗のいずれも false を返す。呼び出し側は戻り値で
   *   「保存できた内容が確定した」ことを確認してから後続処理（render 開始等）に進めること。
   */
  save: () => Promise<boolean>;
}

/**
 * 1 プロジェクト分の編集セッションを管理するフック。
 * project / save が変わる（= プロジェクトを開き直す）たびにセッションを作り直す。
 *
 * @param projectId   API id。null のときセッションは無効。
 * @param baseProject 読込時の不変 EditorProject。
 * @param saveMeta    読込時の保存メタ（パス・指紋）。
 */
export function useEditSession(
  projectId: string | null,
  baseProject: EditorProject | null,
  saveMeta: SaveMeta | null,
): EditSession | null {
  // baseProject の同一性をセッションのキーにする。プロジェクトを開き直すと
  // useEditorProject が新しい EditorProject オブジェクトを返すため、これで作り直す。
  const initialState = useMemo<EditState | null>(
    () => (baseProject ? createEditState(baseProject, loadDuckingSettings()) : null),
    [baseProject],
  );

  const [history, setHistory] = useState<History | null>(() =>
    initialState ? createHistory(initialState) : null,
  );
  // 「保存済みの内容」。現在の EditState と内容が一致していれば dirty=false。
  // インデックスではなく内容で比較するため、undo→分岐編集後の誤 dirty=false を防ぐ。
  const [savedContent, setSavedContent] = useState<EditState | null>(initialState);
  // 最後に保存（または読込）した時点の指紋。次回保存リクエストへ載せる。
  const [fingerprint, setFingerprint] = useState<ProjectFingerprint | null>(
    saveMeta?.fingerprint ?? null,
  );
  const [seedKey, setSeedKey] = useState<EditorProject | null>(baseProject);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  // 保存中の同時呼び出し（autosave のタイマーと handleGoHome/handleRenderStart の明示呼び出し等）
  // を同期的に 1 本へ集約する in-flight ロック。React state（saveStatus）だけのガードだと
  // 同一レンダー内の連続呼び出しをすり抜けて二重 PUT になったり、進行中の呼び出しへ割り込んだ
  // 側が誤って false（保存失敗）を返して呼び出し元の遷移を阻害したりするため、進行中の
  // Promise をそのまま共有する。
  const inFlightRef = useRef<Promise<boolean> | null>(null);

  // in-flight 完了後の「まだ内容が変わっていれば再保存」判定用に、常に最新の
  // history/fingerprint/savedContent を同期的に読めるようにする ref。save() 内の
  // クロージャは呼び出し時点の state を捕まえるため、in-flight を await した後は
  // 呼び出し時ではなく「待ち終えた時点の最新値」を見る必要がある。
  const historyRef = useRef(history);
  const fingerprintRef = useRef(fingerprint);
  const savedContentRef = useRef(savedContent);

  // baseProject が差し替わったらセッションを作り直す（プロジェクトの開き直し）。
  if (seedKey !== baseProject) {
    setSeedKey(baseProject);
    setHistory(initialState ? createHistory(initialState) : null);
    setSavedContent(initialState);
    setFingerprint(saveMeta?.fingerprint ?? null);
    setSaveStatus('idle');
    setSaveError(null);
    // 前プロジェクトの保存が進行中でも、開き直した新セッションはそれを引き継がない。
    inFlightRef.current = null;
  }

  historyRef.current = history;
  fingerprintRef.current = fingerprint;
  savedContentRef.current = savedContent;

  const apply = useCallback((next: EditStateOrUpdater) => {
    setHistory((h) => (h ? pushState(h, resolveNext(next, current(h))) : h));
    setSaveError(null);
    // 直近の保存が失敗（error）していても、新しい編集は「新しい保存対象」であり
    // 同じ失敗コンテンツへの盲目的リトライではない。次の自動保存/手動保存が
    // 再挑戦できるよう、ここで idle へ戻す（保存中に編集された場合は 'saving' のまま据え置く）。
    setSaveStatus((s) => (s === 'error' ? 'idle' : s));
  }, []);

  const setTransient = useCallback((next: EditStateOrUpdater) => {
    // 履歴の現在状態だけを差し替える（index は動かさない）。選択変更などに使う。
    setHistory((h) => {
      if (!h) return h;
      const states = [...h.states];
      states[h.index] = resolveNext(next, current(h));
      return { states, index: h.index };
    });
  }, []);

  const doUndo = useCallback(() => setHistory((h) => (h ? undo(h) : h)), []);
  const doRedo = useCallback(() => setHistory((h) => (h ? redo(h) : h)), []);

  // 1 回分の PUT を実行する。常に ref 経由で「その時点の最新」history/fingerprint を読む
  // ため、in-flight の再試行（await 後の再実行）でも古いクロージャの内容で PUT しない。
  const doPut = useCallback(async (): Promise<boolean> => {
    const h = historyRef.current;
    const fp = fingerprintRef.current;
    if (!h || !baseProject || !saveMeta || !fp || projectId === null) {
      return false;
    }
    const snapshot = current(h);
    const editorProject = toEditorProject(snapshot, baseProject);
    setSaveStatus('saving');
    setSaveError(null);
    try {
      const req: SaveRequest = { project: editorProject, fingerprint: fp };
      const res = await putJson<SaveResponse>(
        `/api/project?id=${encodeURIComponent(projectId)}`,
        req,
      );
      fingerprintRef.current = res.fingerprint;
      savedContentRef.current = snapshot;
      setFingerprint(res.fingerprint);
      setSavedContent(snapshot);
      setSaveStatus('idle');
      return true;
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [baseProject, saveMeta, projectId]);

  const save = useCallback((): Promise<boolean> => {
    // 進行中の保存があれば新しい PUT は発行せず、進行中の Promise をそのまま返す
    // （呼び出し元は完了を待って結果を受け取れる。誤って false を返し「保存できなかった」
    // 扱いにして遷移を阻害することがない）。in-flight の Promise 自体が、完了後にまだ
    // 内容が変わっていれば最新スナップショットで再度 PUT するため、これを await した
    // 呼び出し元は常に「最終的に保存された内容」の結果を受け取れる（再試行は1回のみ）。
    if (inFlightRef.current) return inFlightRef.current;
    if (!history || !baseProject || !saveMeta || !fingerprint || projectId === null) {
      return Promise.resolve(false);
    }
    const promise = (async (): Promise<boolean> => {
      const ok = await doPut();
      if (ok) {
        const h = historyRef.current;
        const latestSaved = savedContentRef.current;
        if (h && latestSaved) {
          const latestSnapshot = current(h);
          if (!samePersistedContent(latestSnapshot, latestSaved)) {
            // 保存中に別の編集が入っていた（in-flight スナップショットは古い）。
            // 最新内容で1回だけ再保存し、その結果を最終結果として返す。
            return doPut();
          }
        }
      }
      return ok;
    })();
    inFlightRef.current = promise;
    promise.finally(() => {
      inFlightRef.current = null;
    });
    return promise;
  }, [history, baseProject, saveMeta, fingerprint, projectId, doPut]);

  if (!history) return null;

  return {
    state: current(history),
    apply,
    setTransient,
    undo: doUndo,
    redo: doRedo,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    dirty: savedContent === null ? true : !samePersistedContent(current(history), savedContent),
    saveStatus,
    saveError,
    save,
  };
}
