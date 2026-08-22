import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { EditorBgmClip, EditorImage, EditorSe, EditorShape, EditorTelop, EditorTitle, EditorVideoInsert, CutSegment } from '../../core/types';
import type { EditState } from '../edit/editState';
import type { Join } from '../../core/joinEngine';
import type { InstallKind, InstallErrors } from '../install';
import { TitleSettingsTab } from './TitleSettingsTab';
import type { TelopComponent } from '../../preview/loadTelopComponent';
export { sliderToRate, rateToSlider } from './inspector/shared';
import { SettingsTab } from './inspector/SettingsTab';
export { SettingsTab } from './inspector/SettingsTab';
import { MultiTelopSettingsTab } from './inspector/MultiTelopSettingsTab';
import { SeSettingsTab } from './inspector/SeSettingsTab';
import { ImageSettingsTab } from './inspector/ImageSettingsTab';
import { VideoInsertSettingsTab } from './inspector/VideoInsertSettingsTab';
import { BgmSettingsTab } from './inspector/BgmSettingsTab';
import { JoinSettings } from './inspector/JoinSettings';
import { ShapeSettingsTab } from './inspector/ShapeSettingsTab';
import { MainVideoSettingsTab } from './inspector/MainVideoSettingsTab';
import { CutSegmentSettingsTab } from './inspector/CutSegmentSettingsTab';

interface InspectorProps {
  state: EditState;
  fps: number;
  /** public/se/ にある効果音ファイル名（SE 設定のファイル選択用）。 */
  seLibrary: string[];
  /** public/images/ にある画像ファイル相対パス（画像設定のファイル選択用）。 */
  imageLibrary: string[];
  /** public/ にあるサブ動画ファイル（サブ動画設定のファイル選択用）。 */
  videoLibrary: string[];
  /**
   * サブ動画素材の実フレーム長（file → frames）。区間を素材内へクランプ・実尺表示に使う。
   * 未プローブ・読めない素材は**キーごと存在しない**（＝クランプせず実尺も出さない）。
   * **任意にしない**: 渡し忘れるとクランプが silent OFF になるため、tsc に検出させる。
   */
  videoDurations: Record<string, number>;
  /** API id（VideoSyncWaveform の asset URL 用）。 */
  projectId: string;
  /** テロップパックが導入済みかどうか（スタイル一覧 vs 導入 CTA の切り替え用）。 */
  telopPackInstalled: boolean;
  /** サブ動画機能が導入済みかどうか（導入 CTA の切り替え用）。 */
  videoInsertInstalled: boolean;
  /** 導入中の機能種別（null なら非導入中）。ボタン disabled と「導入中…」表示に使う。 */
  installing: InstallKind | null;
  /** kind 別の導入エラー（各 CTA は自分の kind のエラーだけを表示する）。 */
  installErrors: InstallErrors;
  /** 未保存の編集があるか（導入は再読込を伴うため未保存中は無効化する）。 */
  dirty: boolean;
  /** プロジェクト導入済みのテロップ部品（グリッド描画用）。未読込なら null。 */
  telopComponent: TelopComponent | null;
  /** プレビュー解像度（スウォッチの合成サイズ）。 */
  previewWidth: number;
  previewHeight: number;
  /** 機能導入ハンドラ（kind 別の API 呼び出しは App の handleInstall が担う）。 */
  onInstall: (kind: InstallKind) => void;
  /** public/BGM/ にある BGM ファイル名（Task 11 で使用）。 */
  bgmLibrary?: string[];
  /** BGM 機能が導入済みかどうか（Task 11 で使用）。 */
  bgmInstalled?: boolean;
  /** 図形機能が導入済みかどうか（「図形機能を導入」CTA の切り替え用）。 */
  shapeInstalled?: boolean;
  /** シーン転換機能が導入済みかどうか（「シーン転換を導入」CTA の切り替え用）。 */
  transitionInstalled?: boolean;
  /** 現在のつなぎ目一覧（「全カットに一括適用」用）。 */
  joins?: Join[];
  /** 残す区間（大域キーフレームの punch/preset 基点算出用）。 */
  keptSegments?: CutSegment[];
  /** ライブ更新（履歴を積まない・波形ドラッグ追従用）。 */
  onLive: (next: EditState) => void;
  /** 編集操作（履歴へ積む）。 */
  onEdit: (next: EditState) => void;
  /** @remotion/player の ref（タイトル分割の現在フレーム取得用）。 */
  playerRef: RefObject<PlayerRef | null>;
  /** ライブラリ各ファイルの size-mtime トークン。asset URL の &v=（同名差し替えバスト）用。 */
  assetVersions?: Record<string, string>;
  /**
   * 中央スロットに設定を出しているときの「← じまく一覧へ戻る」導線。
   * 押すと選択解除（一覧表示へ戻る）。未指定なら戻るボタンを出さない。
   */
  onBack?: () => void;
}
export function Inspector({ state, fps, seLibrary, imageLibrary, videoLibrary, videoDurations, projectId, telopPackInstalled, videoInsertInstalled, installing, installErrors, dirty, telopComponent, previewWidth, previewHeight, onInstall, bgmLibrary = [], bgmInstalled = false, shapeInstalled = false, transitionInstalled = false, joins = [], keptSegments = [], onLive, onEdit, playerRef, assetVersions, onBack }: InspectorProps) {
  const selectedTelopId =
    state.selection?.kind === 'telop' ? state.selection.id : null;
  const selected: EditorTelop | undefined = state.telops.find(
    (t) => t.id === selectedTelopId,
  );
  const seSelection = state.selection?.kind === 'se' ? state.selection : null;
  const selectedSe: EditorSe | undefined = seSelection
    ? state.se.find((s) => s.id === seSelection.id)
    : undefined;
  const imageSelection = state.selection?.kind === 'image' ? state.selection : null;
  const selectedImage: EditorImage | undefined = imageSelection
    ? state.images.find((i) => i.id === imageSelection.id)
    : undefined;
  const videoInsertSelection = state.selection?.kind === 'videoInsert' ? state.selection : null;
  const selectedVideoInsert: EditorVideoInsert | undefined = videoInsertSelection
    ? state.videoInserts.find((v) => v.id === videoInsertSelection.id)
    : undefined;
  const bgmSelection = state.selection?.kind === 'bgm' ? state.selection : null;
  const selectedBgm: EditorBgmClip | undefined = bgmSelection
    ? state.bgm.find((b) => b.id === bgmSelection.id)
    : undefined;
  const selectedTitleId = state.selection?.kind === 'title' ? state.selection.id : null;
  const selectedTitle: EditorTitle | undefined = selectedTitleId !== null
    ? state.titles.find((t) => t.id === selectedTitleId)
    : undefined;
  const shapeSelection = state.selection?.kind === 'shape' ? state.selection : null;
  const selectedShape: EditorShape | undefined = shapeSelection
    ? state.shapes.find((s) => s.id === shapeSelection.id)
    : undefined;
  const joinSelection = state.selection?.kind === 'join' ? state.selection : null;
  // 複数選択（集合サイズ 2 以上）のときは専用パネルへ切り替える。
  // 不変条件により集合が空でないなら selection は必ずテロップなので、他種の分岐とは競合しない。
  const multiTelopSelected = state.multiTelopIds.length >= 2;

  // 設定ヘッダのタイトル（今なにを編集中か）。中央表示中の道具立てを明確にする。
  const settingsTitle = selectedTitle
    ? 'タイトル設定'
    : selectedBgm
      ? 'BGM 設定'
      : selectedImage
        ? '画像設定'
        : selectedVideoInsert
          ? 'サブ動画設定'
          : selectedSe
            ? '効果音設定'
            : selectedShape
              ? '図形設定'
              : joinSelection
                ? 'シーン転換設定'
                : state.selection?.kind === 'mainVideo'
                  ? 'メイン動画設定'
                  : state.selection?.kind === 'cutSegment'
                    ? 'この区間の速度'
                    : multiTelopSelected
                      ? 'テロップ一括設定'
                      : selected
                        ? 'テロップ設定'
                        : '設定';

  return (
    <div className="ins">
      <div className="ins-tabs">
        {onBack ? (
          <>
            <button className="ins-back" onClick={onBack} title="設定を閉じて文字起こし一覧へ戻る">
              ← 文字起こしに戻る
            </button>
            <span className="ins-title">{settingsTitle}</span>
          </>
        ) : (
          <button className="ins-tab active" disabled>設定</button>
        )}
      </div>
      <div className="ins-body">
        {selectedTitle ? (
          <TitleSettingsTab
            title={selectedTitle}
            state={state}
            fps={fps}
            playerRef={playerRef}
            onEdit={onEdit}
          />
        ) : selectedBgm ? (
          <BgmSettingsTab
            bgm={selectedBgm}
            state={state}
            fps={fps}
            bgmLibrary={bgmLibrary}
            projectId={projectId}
            assetVersions={assetVersions}
            bgmInstalled={bgmInstalled}
            installing={installing}
            installErrors={installErrors}
            dirty={dirty}
            onInstall={onInstall}
            onEdit={onEdit}
          />
        ) : selectedImage ? (
          <ImageSettingsTab
            image={selectedImage}
            state={state}
            fps={fps}
            imageLibrary={imageLibrary}
            onEdit={onEdit}
          />
        ) : selectedVideoInsert ? (
          <VideoInsertSettingsTab
            videoInsert={selectedVideoInsert}
            state={state}
            fps={fps}
            videoLibrary={videoLibrary}
            videoDurations={videoDurations}
            projectId={projectId}
            assetVersions={assetVersions}
            onLive={onLive}
            onEdit={onEdit}
          />
        ) : selectedSe ? (
          <SeSettingsTab
            se={selectedSe}
            state={state}
            fps={fps}
            seLibrary={seLibrary}
            projectId={projectId}
            assetVersions={assetVersions}
            onEdit={onEdit}
          />
        ) : selectedShape ? (
          <ShapeSettingsTab
            shape={selectedShape}
            state={state}
            fps={fps}
            shapeInstalled={shapeInstalled}
            installing={installing}
            installErrors={installErrors}
            dirty={dirty}
            onInstall={onInstall}
            onEdit={onEdit}
          />
        ) : joinSelection ? (
          <JoinSettings
            at={joinSelection.at}
            fps={fps}
            sceneTransitions={state.sceneTransitions ?? []}
            joins={joins}
            state={state}
            onEdit={onEdit}
            transitionInstalled={transitionInstalled}
            onInstall={onInstall}
            installing={installing}
            installErrors={installErrors}
            dirty={dirty}
          />
        ) : state.selection?.kind === 'mainVideo' ? (
          <MainVideoSettingsTab
            state={state}
            onEdit={onEdit}
            installing={installing}
            installErrors={installErrors}
            dirty={dirty}
            onInstall={onInstall}
            getPlaybackFrame={() => Math.round(playerRef.current?.getCurrentFrame() ?? 0)}
            keptSegments={keptSegments}
            fps={fps}
          />
        ) : state.selection?.kind === 'cutSegment' ? (
          <CutSegmentSettingsTab
            state={state}
            segmentId={state.selection.id}
            onEdit={onEdit}
          />
        ) : multiTelopSelected ? (
          <MultiTelopSettingsTab state={state} onEdit={onEdit} />
        ) : selected ? (
          <SettingsTab
            telop={selected}
            state={state}
            fps={fps}
            telopPackInstalled={telopPackInstalled}
            videoInsertInstalled={videoInsertInstalled}
            bgmInstalled={bgmInstalled}
            installing={installing}
            installErrors={installErrors}
            dirty={dirty}
            telopComponent={telopComponent}
            previewWidth={previewWidth}
            previewHeight={previewHeight}
            onInstall={onInstall}
            onEdit={onEdit}
          />
        ) : (
          <div className="ins-empty">編集したい字幕・効果音・画像などを選ぶと、ここに設定が表示されます。</div>
        )}
      </div>
    </div>
  );
}
