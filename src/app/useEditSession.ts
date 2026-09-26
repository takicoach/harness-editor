import { useCallback, useMemo, useRef, useState } from 'react';
import type { EditorProject, EditorVideoInsert } from '../core/types';
import { hasTimelinePlacements, sameTimelinePlacement, validTimelinePlacement } from '../core/timelinePlacement';
import {
  EDITOR_RUN_HEADER,
  EDITOR_TOKEN_HEADER,
  type EditorDeliveryGuard,
} from '../shared/editorDeliveryGuard';
import type { ProjectFingerprint, SaveRequest, SaveResponse } from '../shared/types';
import { ApiError, putJson } from './fetchJson';
import { getWriterId } from './writerId';
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

function isFileFingerprint(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.relPath === 'string'
    && typeof candidate.size === 'number'
    && Number.isFinite(candidate.size)
    && typeof candidate.mtimeMs === 'number'
    && Number.isFinite(candidate.mtimeMs);
}

function isNullableFileFingerprint(value: unknown): boolean {
  return value === null || isFileFingerprint(value);
}

/** A successful HTTP status is not enough to prove that the requested revision was saved. */
function isSaveResponse(value: unknown): value is SaveResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  if (response.ok !== true || !response.fingerprint || typeof response.fingerprint !== 'object') {
    return false;
  }
  const fingerprint = response.fingerprint as Record<string, unknown>;
  if (!isFileFingerprint(fingerprint.telopData)) return false;
  for (const key of ['cutData', 'seData', 'insertImageData', 'videoInsertData', 'bgmData', 'titleData']) {
    if (!isNullableFileFingerprint(fingerprint[key])) return false;
  }
  for (const key of ['shapeData', 'transitionData', 'speedData', 'mainLayoutData', 'mainAudioData', 'scriptDocument', 'editorTimeline']) {
    if (fingerprint[key] !== undefined && !isNullableFileFingerprint(fingerprint[key])) return false;
  }
  if (response.backupDir !== undefined && typeof response.backupDir !== 'string') return false;
  if (response.clampedVideoInserts !== undefined && (!Array.isArray(response.clampedVideoInserts)
    || response.clampedVideoInserts.some((item) => !item || typeof item !== 'object'
      || typeof (item as Record<string, unknown>).id !== 'number'
      || typeof (item as Record<string, unknown>).originalEnd !== 'number'
      || ((item as Record<string, unknown>).timelinePlacement !== undefined && !validTimelinePlacement((item as Record<string, unknown>).timelinePlacement))))) return false;
  if (response.unplayableVideoInserts !== undefined && (!Array.isArray(response.unplayableVideoInserts)
    || response.unplayableVideoInserts.some((item) => !item || typeof item !== 'object'
      || typeof (item as Record<string, unknown>).id !== 'number'
      || typeof (item as Record<string, unknown>).file !== 'string'))) return false;
  return true;
}

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

/**
 * D-1: 保存時クランプの計算が依存するフィールドが、送信時のクリップと現在のクリップで
 * 同一か。サーバのクランプは `clampVideoInsertSourceEnd`（file ごとの実長 ×
 * sourceInFrame × playbackRate × originalStart/End）で決まるため、この一致が
 * 「サーバが計算したクランプ値は今もこのクリップに当てはまる」ことの前提になる。
 * originalEnd だけを見ると、往復中の file 差し替え・イン点移動・速度変更を
 * 「未編集」と誤認して、当てはまらないトリムを適用してしまう。
 */
function sameClampPremise(a: EditorVideoInsert, b: EditorVideoInsert): boolean {
  return (
    a.file === b.file &&
    a.sourceInFrame === b.sourceInFrame &&
    (a.playbackRate ?? 1) === (b.playbackRate ?? 1) &&
    a.originalStart === b.originalStart &&
    a.originalEnd === b.originalEnd && sameTimelinePlacement(a.timelinePlacement, b.timelinePlacement)
  );
}

/** 編集セッションが UI へ公開する API。 */
/** 上書き保存の結果。退避先（data-safety-4）を UI の案内に使う。 */
export interface OverwriteSaveResult {
  /** 保存できたか。 */
  ok: boolean;
  /** 消す前の内容を複写した先（プロジェクトからの相対パス）。退避が無ければ null。 */
  backupDir: string | null;
}

export interface SaveOptions {
  /** Save exactly this already-applied state once. A different current state fails before PUT. */
  expectedState?: EditState;
  /** Durable delivery identity used only by an exact agent save. */
  delivery?: EditorDeliveryGuard;
}

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
   * 直近の保存失敗が「別の画面が先に保存した」衝突（HTTP 409）か。
   * true のときだけ saveOverwrite() を出口として案内する（2026-09-04 のデータ損失）。
   */
  saveConflict: boolean;
  /**
   * C-2: 直近の保存でサブ動画の終了位置がソース実長に合わせてクランプされた場合の
   * 通知文言（無ければ null）。保存はディスク上の値を無言で書き換えるため、
   * 利用者へ明示するための出口。dismissSaveClampNotice() で消せる。
   */
  saveClampNotice: string | null;
  // X-2(a): 「再生できる範囲が残っていないサブ動画がある」警告も同じ出口に載る（改行区切り）。
  /** saveClampNotice を消す（利用者が確認して閉じた時に呼ぶ）。 */
  dismissSaveClampNotice: () => void;
  /**
   * 直近の保存失敗が衝突（409）かを **await 直後に読める形**で返す。
   * saveConflict は再レンダーで配られる値なので、`await save()` した側のクロージャからは
   * 更新前の値しか見えない。保存直後の分岐（例: 再読込ガード）はこちらを使う。
   */
  isSaveConflict: () => boolean;
  /**
   * 「保存してから遷移」の着地用: 呼び出し時点のセッション世代を捕まえ、後で「今も同じ
   * セッションか」を返す関数を作る（D-2 の seed 比較と同じ）。保存の往復中に破棄して開き直し→
   * 再編集が起きたとき、古い応答の true で新セッションの編集を再読込・切替で捨てないための照合。
   */
  sessionGuard: () => () => boolean;
  /**
   * 衝突を承知のうえで、この画面の内容で上書き保存する。
   * **利用者が衝突の通知を見て明示的に押したときだけ呼ぶ**。自動保存や再試行からは呼ばない
   * （黙って別の画面の作業を消さないため）。
   */
  saveOverwrite: () => Promise<OverwriteSaveResult>;
  /**
   * ディスクへ保存する。
   * expectedState指定時はその状態が現行であることを同期確認し、一度だけ保存する。
   * 保存往復中に増えた編集は追い保存せずdirtyで残す。
   * @returns 保存が成功したら true。ガード早期 return（history/baseProject 等が無い）と
   *   確定したAPI拒否は false。通常保存は通信失敗も false に保つ。expectedState指定時の
   *   通信切断・5xx・不正な成功本文は保存済みか判別できないためrejectする。
   */
  save: (options?: SaveOptions) => Promise<boolean>;
}

/**
 * 1 プロジェクト分の編集セッションを管理するフック。
 * project / save が変わる（= プロジェクトを開き直す）たびにセッションを作り直す。
 *
 * @param projectId   API id。null のときセッションは無効。
 * @param baseProject 読込時の不変 EditorProject。
 * @param saveMeta    読込時の保存メタ（パス・指紋）。
 * @param telopPackInstalled テロップパック導入済みか（タイトル一本化の変換先テンプレ選択に使う）。
 */
export function useEditSession(
  projectId: string | null,
  baseProject: EditorProject | null,
  saveMeta: SaveMeta | null,
  telopPackInstalled = false,
): EditSession | null {
  // baseProject の同一性をセッションのキーにする。プロジェクトを開き直すと
  // useEditorProject が新しい EditorProject オブジェクトを返すため、これで作り直す。
  const initialState = useMemo<EditState | null>(
    () => (baseProject ? createEditState(baseProject, loadDuckingSettings(), telopPackInstalled) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- telopPackInstalled はプロジェクト
    // を開き直すタイミング（baseProject 変化）でしか変わらない前提。deps に足すと導入直後の
    // 楽観更新で意図せずセッションを作り直してしまう。
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
  // 直近の保存失敗が 409（別の画面が先に保存した）か。上書きの出口を出す条件。
  const [saveConflict, setSaveConflict] = useState(false);
  // C-2: 直近の保存でサブ動画の終了位置がクランプされた場合の通知（無ければ null）。
  const [saveClampNotice, setSaveClampNotice] = useState<string | null>(null);
  // 同じ値の ref。await 直後の判断に使う（state は再レンダーまで古い値のまま）。
  const saveConflictRef = useRef(false);

  // 保存中の同時呼び出し（autosave のタイマーと handleGoHome/handleRenderStart の明示呼び出し等）
  // を同期的に 1 本へ集約する in-flight ロック。React state（saveStatus）だけのガードだと
  // 同一レンダー内の連続呼び出しをすり抜けて二重 PUT になったり、進行中の呼び出しへ割り込んだ
  // 側が誤って false（保存失敗）を返して呼び出し元の遷移を阻害したりするため、進行中の
  // Promise をそのまま共有する。
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const inFlightExactRef = useRef(false);

  // in-flight 完了後の「まだ内容が変わっていれば再保存」判定用に、常に最新の
  // history/fingerprint/savedContent を同期的に読めるようにする ref。save() 内の
  // クロージャは呼び出し時点の state を捕まえるため、in-flight を await した後は
  // 呼び出し時ではなく「待ち終えた時点の最新値」を見る必要がある。
  const historyRef = useRef(history);
  const fingerprintRef = useRef(fingerprint);
  const savedContentRef = useRef(savedContent);
  // 直近の PUT がサーバ側で作った退避先（上書き保存のときだけ付く・data-safety-4）。
  const lastBackupDirRef = useRef<string | null>(null);

  // D-2: 「今どのセッションが現行か」を同期的に読むための ref。baseProject の同一性が
  // セッションの世代そのもの（開き直すと useEditorProject が新しいオブジェクトを返す）。
  // 保存の往復中に再読込が起きると、着地時の setHistory は差し替わった後のセッションの
  // history を触ってしまう——送っていない新しい内容を古い応答がトリムしうる。
  // useEditorProject の isCurrent(id) と同型の「着地時に現行か確かめる」ガードを張る。
  const sessionSeedRef = useRef(baseProject);

  // baseProject が差し替わったらセッションを作り直す（プロジェクトの開き直し）。
  if (seedKey !== baseProject) {
    setSeedKey(baseProject);
    setHistory(initialState ? createHistory(initialState) : null);
    setSavedContent(initialState);
    setFingerprint(saveMeta?.fingerprint ?? null);
    setSaveStatus('idle');
    setSaveError(null);
    setSaveClampNotice(null);
    // 前プロジェクトの保存が進行中でも、開き直した新セッションはそれを引き継がない。
    inFlightRef.current = null;
    inFlightExactRef.current = false;
  }

  historyRef.current = history;
  fingerprintRef.current = fingerprint;
  savedContentRef.current = savedContent;
  sessionSeedRef.current = baseProject;

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
  const doPut = useCallback(async (
    overwrite = false,
    expectedState?: EditState,
    delivery?: EditorDeliveryGuard,
  ): Promise<boolean> => {
    const h = historyRef.current;
    const fp = fingerprintRef.current;
    if (!h || !baseProject || !saveMeta || !fp || projectId === null) {
      return false;
    }
    const latestAtStart = current(h);
    if (expectedState && latestAtStart !== expectedState) return false;
    const snapshot = expectedState ?? latestAtStart;
    // D-2: 送信時のセッション世代を捕まえる。着地時に現行でなければ、この応答は
    // 「別のセッションの内容に対する結果」なので画面状態へは一切合流させない。
    const seedAtSubmit = baseProject;
    const isCurrentSession = () => sessionSeedRef.current === seedAtSubmit;
    const editorProject = toEditorProject(snapshot, baseProject);
    setSaveStatus('saving');
    setSaveError(null);
    try {
      // overwrite は利用者が衝突通知を見て選んだときだけ true。既定では鍵を送らない
      // （旧サーバ互換・自動保存が黙って他方の作業を消さない）。
      const req: SaveRequest = overwrite
        ? { project: editorProject, fingerprint: fp, overwrite: true }
        : { project: editorProject, fingerprint: fp };
      const headers: Record<string, string> = { 'X-Harness-Writer': getWriterId() };
      if (expectedState !== undefined && delivery) {
        headers[EDITOR_RUN_HEADER] = delivery.runId;
        headers[EDITOR_TOKEN_HEADER] = delivery.token;
      }
      const response = await putJson<unknown>(
        `/api/project?id=${encodeURIComponent(projectId)}`,
        req,
        // どの画面が書いたかを伝える。サーバは同じ画面の書込だけを外部変更から除く
        // （別画面の保存はこちらへ通知される・data-safety-5）。
        headers,
      );
      if (!isSaveResponse(response)) {
        throw new Error('保存APIから不正な成功レスポンスを受け取りました');
      }
      if ((editorProject.scriptDocument && !isFileFingerprint(response.fingerprint.scriptDocument))
        || (!editorProject.scriptDocument && fp.scriptDocument && response.fingerprint.scriptDocument !== null)) {
        throw new Error('台本の保存結果を確認できませんでした。案件を読み直して確認してください。');
      }
      const res = response;
      if ((hasTimelinePlacements(editorProject) || fp.editorTimeline) && !isFileFingerprint(res.fingerprint.editorTimeline)) {
        throw new Error('素材の配置時刻の保存結果を確認できませんでした。案件を読み直して確認してください。');
      }
      // D-2: 往復中に再読込された（セッションが差し替わった）なら、この応答は現行画面の
      // ものではない。ディスクへの書き込み自体は成功しているので true を返すが、指紋・
      // 保存済み内容・history・通知のいずれも新セッションへは持ち込まない。
      if (!isCurrentSession()) return true;
      lastBackupDirRef.current = res.backupDir ?? null;
      fingerprintRef.current = res.fingerprint;

      // C-2: サブ動画がソース実長を超えていて保存時にクランプされた場合、応答の
      // clampedVideoInserts に正規化後の originalEnd が載る。ディスク上は既にこの値で
      // 保存済みなので、「保存済み内容」の基準（savedContent）はクランプ後の値で作る
      // ——そうしないと次回保存の dirty 判定がディスクの実体とずれる。
      // 保存後に利用者へ伝える通知（クランプ・再生不能）。複数同時に起こりうるので配列で貯める。
      const notices: string[] = [];
      const clamped = res.clampedVideoInserts;
      const clampedSnapshot: EditState =
        clamped && clamped.length > 0
          ? {
              ...snapshot,
              videoInserts: snapshot.videoInserts.map((v) => {
                const c = clamped.find((c) => c.id === v.id);
                return c ? { ...v, originalEnd: c.originalEnd, ...(c.timelinePlacement ? { timelinePlacement: c.timelinePlacement } : {}) } : v;
              }),
            }
          : snapshot;
      savedContentRef.current = clampedSnapshot;
      setSavedContent(clampedSnapshot);

      // 表示中の最新状態へも反映する。ただし PUT の往復中に利用者がそのクリップを
      // さらに編集していた場合は、その編集を消さないよう上書きしない。
      // D-1: 「編集されたか」は originalEnd の一致だけでは測れない。クランプ後の値は
      // 送信時の file / sourceInFrame / playbackRate / originalStart を前提に計算された
      // もので、往復中にどれか一つでも動けばその前提はもう成り立たない
      // （例: イン点を前へ戻して超過を自分で解消したのに、遅れて届いた応答が
      //  クリップを短くし、次の保存で意図しないトリムが永続化される）。
      // クランプ計算が依存する全フィールドを送信時のクリップと突合する。
      if (clamped && clamped.length > 0) {
        setHistory((h) => {
          if (!h) return h;
          const latest = current(h);
          let changed = false;
          const nextVideoInserts = latest.videoInserts.map((v) => {
            const c = clamped.find((c) => c.id === v.id);
            if (!c || (v.originalEnd === c.originalEnd && sameTimelinePlacement(v.timelinePlacement, c.timelinePlacement))) return v;
            const submitted = snapshot.videoInserts.find((sv) => sv.id === v.id);
            if (!submitted || !sameClampPremise(submitted, v)) return v; // 往復中に編集済み＝触らない
            changed = true;
            return { ...v, originalEnd: c.originalEnd, ...(c.timelinePlacement ? { timelinePlacement: c.timelinePlacement } : {}) };
          });
          if (!changed) return h;
          const states = [...h.states];
          states[h.index] = { ...latest, videoInserts: nextVideoInserts };
          return { states, index: h.index };
        });
        notices.push(
          `サブ動画${clamped.length}件の終了位置をソースの実長に合わせて自動調整しました（保存されました）`,
        );
      }

      // X-2(a): クランプでは直せない（再生できるフレームが1枚も残っていない）サブ動画。
      // データは変えずに伝えるだけ——直し方（イン点を戻す / 削除）は利用者が選ぶ。
      const unplayable = res.unplayableVideoInserts;
      if (unplayable && unplayable.length > 0) {
        const files = unplayable.map((u) => `#${u.id} ${u.file}`).join('、');
        notices.push(
          `サブ動画${unplayable.length}件（${files}）は再生できる範囲が残っていません` +
            '（開始位置がソースの終わりより後です）。開始位置を戻すか、クリップを削除してください。',
        );
      }
      setSaveClampNotice(notices.length > 0 ? notices.join('\n') : null);

      setFingerprint(res.fingerprint);
      setSaveStatus('idle');
      saveConflictRef.current = false;
      setSaveConflict(false);
      return true;
    } catch (err) {
      // A 4xx response is a definite rejection: the server states that it did not accept this
      // request. Network failure, 5xx, or an invalid success body cannot prove whether the write
      // happened. Exact agent saves must preserve that uncertainty instead of reporting failure.
      const exactResultUnknown = expectedState !== undefined
        && !(err instanceof ApiError && err.status >= 400 && err.status < 500);
      // D-2: 差し替わったセッションへ、送っていない内容の失敗を持ち込まない。
      if (!isCurrentSession()) {
        if (exactResultUnknown) throw err;
        return false;
      }
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
      // 409 だけは「別の画面が先に保存した」衝突として区別し、上書きの出口を出す。
      const conflict = err instanceof ApiError && err.status === 409;
      saveConflictRef.current = conflict;
      setSaveConflict(conflict);
      if (exactResultUnknown) throw err;
      return false;
    }
  }, [baseProject, saveMeta, projectId]);

  const save = useCallback((options?: SaveOptions): Promise<boolean> => {
    // 進行中の保存があれば新しい PUT は発行せず、進行中の Promise をそのまま返す
    // （呼び出し元は完了を待って結果を受け取れる。誤って false を返し「保存できなかった」
    // 扱いにして遷移を阻害することがない）。in-flight の Promise 自体が、完了後にまだ
    // 内容が変わっていれば最新スナップショットで再度 PUT するため、これを await した
    // 呼び出し元は常に「最終的に保存された内容」の結果を受け取れる（再試行は1回のみ）。
    const runRegularSave = async (): Promise<boolean> => {
      const ok = await doPut();
      // D-2: 往復中に再読込されたら、この save() は差し替わる前のセッションのもの。
      // 新セッションの内容を（利用者が保存を指示していないのに）追い保存しない。
      if (ok && sessionSeedRef.current === baseProject) {
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
    };

    if (inFlightRef.current) {
      const pending = inFlightRef.current;
      // A user save requested while an exact agent save is in flight must still save the user's
      // later edit before navigation may continue. Chain it after the exact PUT without widening
      // the agent delivery itself. Other combinations keep sharing the current save promise.
      if (!options?.expectedState && inFlightExactRef.current) {
        const chained = (async (): Promise<boolean> => {
          let ok: boolean;
          try {
            ok = await pending;
          } catch {
            // The agent request may have committed, but a user-initiated save must keep the
            // established boolean contract. A regular, fingerprint-protected PUT determines
            // whether the user's later edit can now be saved (or returns false on conflict).
            if (sessionSeedRef.current !== baseProject) return false;
            return runRegularSave();
          }
          if (!ok || sessionSeedRef.current !== baseProject) return ok;
          const h = historyRef.current; const latestSaved = savedContentRef.current;
          if (h && latestSaved && samePersistedContent(current(h), latestSaved)) return true;
          return runRegularSave();
        })();
        inFlightRef.current = chained;
        inFlightExactRef.current = false;
        const clearChained = () => {
          if (inFlightRef.current === chained) inFlightRef.current = null;
        };
        void chained.then(clearChained, clearChained);
        return chained;
      }
      return pending;
    }
    if (!history || !baseProject || !saveMeta || !fingerprint || projectId === null) {
      return Promise.resolve(false);
    }
    const exact = options?.expectedState !== undefined;
    const promise = exact
      ? doPut(false, options.expectedState, options.delivery)
      : runRegularSave();
    inFlightRef.current = promise;
    inFlightExactRef.current = exact;
    const clearPromise = () => {
      if (inFlightRef.current === promise) {
        inFlightRef.current = null;
        inFlightExactRef.current = false;
      }
    };
    void promise.then(clearPromise, clearPromise);
    return promise;
  }, [history, baseProject, saveMeta, fingerprint, projectId, doPut]);

  /**
   * 衝突（409）を承知で、この画面の内容を正として上書き保存する。
   * in-flight ロックは通らない（save() の再試行経路と混ぜると、利用者が選んでいない
   * 上書きが起きうるため）。押せるのは saveConflict が true のときだけ（呼び出し側で制御）。
   */
  const saveOverwrite = useCallback(async (): Promise<OverwriteSaveResult> => {
    lastBackupDirRef.current = null;
    const ok = await doPut(true);
    return { ok, backupDir: lastBackupDirRef.current };
  }, [doPut]);

  const dismissSaveClampNotice = useCallback(() => setSaveClampNotice(null), []);

  // sessionGuard の本体。sessionSeedRef は毎レンダーで現行の baseProject に更新される。
  const sessionGuard = useCallback(() => {
    const seed = sessionSeedRef.current;
    return () => sessionSeedRef.current === seed;
  }, []);

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
    saveConflict,
    saveClampNotice,
    dismissSaveClampNotice,
    isSaveConflict: () => saveConflictRef.current,
    sessionGuard,
    saveOverwrite,
    save,
  };
}
