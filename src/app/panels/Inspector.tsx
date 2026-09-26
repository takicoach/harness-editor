import type { RefObject } from 'react';
import type { EditorPlaybackRef as PlayerRef } from '../preview/editorPlayback';
import type { EditorBgmClip, EditorImage, EditorSe, EditorShape, EditorTelop, EditorTitle, EditorVideoInsert, CutSegment } from '../../core/types';
import type { EditState } from '../edit/editState';
import type { Join } from '../../core/joinEngine';
import type { InstallKind, InstallErrors } from '../install';
import { TitleSettingsTab } from './TitleSettingsTab';
import type { NativeTelopRevision } from '../../preview/nativeTelopCache';
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
import { InstallCtaButton } from './inspector/shared';
import { AssetTimingContext } from './inspector/AssetTimingSection';
import { FrameRangeFields } from './FrameRangeFields';
import { ASSET_KEYS, assetFinalRange, placeAsset, splitPlacedText, type AssetKind } from '../edit/assetPlacementOps';
import type { PlaybackModel } from '../../preview/playbackModel';

interface InspectorProps {
  finalModel?: PlaybackModel;
  state: EditState;
  fps: number;
  /** public/se/ にある効果音ファイル名（SE 設定のファイル選択用）。 */
  seLibrary: string[];
  /** public/images/ にある画像ファイル相対パス（画像設定のファイル選択用）。 */
  imageLibrary: string[];
  /** public/ にあるサブ動画ファイル（サブ動画設定のファイル選択用）。 */
  videoLibrary: string[];
  /** API id（VideoSyncWaveform の asset URL 用）。 */
  projectId: string;
  /** テロップパックが導入済みかどうか（30スタイル一覧 vs 導入 CTA の切り替え用）。 */
  telopPackInstalled: boolean;
  /** キーフレームが書き出しへ反映されるか（部品の版で決まる・F-1）。未指定＝対応済みとして扱う。 */
  motionKeysSupport?: { telop: boolean; image: boolean };
  imageRendering?: { supported: boolean; canUpgrade: boolean };
  /** カラー補正が書き出しへ反映されるか（未対応なら注意書きを出す・F-2）。 */
  colorGradeSupported?: boolean;
  colorWheelsSupported?: boolean;
  mainAudioSupported?: boolean;
  /** サブ動画機能が導入済みかどうか（導入 CTA の切り替え用）。 */
  videoInsertInstalled: boolean;
  /** 導入中の機能種別（null なら非導入中）。ボタン disabled と「導入中…」表示に使う。 */
  installing: InstallKind | null;
  /** kind 別の導入エラー（各 CTA は自分の kind のエラーだけを表示する）。 */
  installErrors: InstallErrors;
  /** 未保存の編集があるか（導入は再読込を伴うため未保存中は無効化する）。 */
  dirty: boolean;
  /** 成功した案件読込の識別子。見本のキャッシュ更新用で、未読込なら null。 */
  componentRevision: NativeTelopRevision | null;
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
export function Inspector({ state, fps, finalModel, seLibrary, imageLibrary, videoLibrary, projectId, telopPackInstalled, motionKeysSupport = { telop: true, image: true }, imageRendering, colorGradeSupported = true, colorWheelsSupported = false, mainAudioSupported = false, videoInsertInstalled, installing, installErrors, dirty, componentRevision, previewWidth, previewHeight, onInstall, bgmLibrary = [], bgmInstalled = false, shapeInstalled = false, transitionInstalled = false, joins = [], keptSegments = [], onLive, onEdit, playerRef, assetVersions, onBack }: InspectorProps) {
  const asset = state.selection && state.selection.kind in ASSET_KEYS && 'id' in state.selection ? { kind: state.selection.kind as AssetKind, id: state.selection.id } : null;
  const range = finalModel && asset ? assetFinalRange(finalModel, asset.kind, asset.id) : null;
  const timing = range && finalModel && asset ? { ...range,
    onSplit: asset.kind === 'title' ? (frame: number) => onEdit(splitPlacedText(state, finalModel, 'title', asset.id, frame)) : undefined,
    label: `完成動画 ${Number((range.start / fps).toFixed(6))}–${Number((range.end / fps).toFixed(6))} 秒（${range.start}–${range.end} フレーム）`,
    fields: <FrameRangeFields key={`${asset.kind}:${asset.id}`} start={range.start} end={range.end} fps={fps} max={finalModel.durationInFrames} clock="final"
      onCommit={(start, end) => onEdit(placeAsset(state, finalModel, asset.kind, asset.id, start, end))} />,
  } : null;
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
    <AssetTimingContext.Provider value={timing}><div className="ins">
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
            keyframesSupported={motionKeysSupport.image}
            renderingSupport={imageRendering}
            installing={installing}
            installErrors={installErrors}
            dirty={dirty}
            onInstall={onInstall}
            onEdit={onEdit}
          />
        ) : selectedVideoInsert ? (
          <VideoInsertSettingsTab
            videoInsert={selectedVideoInsert}
            effectivePlaybackRate={finalModel?.videoInserts.find(v => v.id === selectedVideoInsert.id)?.playbackRate}
            state={state}
            fps={fps}
            videoLibrary={videoLibrary}
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
            onLive={onLive}
            onEdit={onEdit}
            installing={installing}
            installErrors={installErrors}
            dirty={dirty}
            onInstall={onInstall}
            getPlaybackFrame={() => Math.round(playerRef.current?.getCurrentFrame() ?? 0)}
            keptSegments={keptSegments}
            fps={fps}
            colorGradeSupported={colorGradeSupported}
            colorWheelsSupported={colorWheelsSupported}
            mainAudioSupported={mainAudioSupported}
          />
        ) : state.selection?.kind === 'cutSegment' ? (
          <CutSegmentSettingsTab
            state={state}
            segmentId={state.selection.id}
            fps={fps}
            onEdit={onEdit}
          />
        ) : multiTelopSelected ? (
          <MultiTelopSettingsTab state={state} onEdit={onEdit} />
        ) : selected ? (
          <SettingsTab
            projectId={projectId}
            telop={selected}
            state={state}
            fps={fps}
            telopPackInstalled={telopPackInstalled}
            keyframesSupported={motionKeysSupport.telop}
            bgmInstalled={bgmInstalled}
            installing={installing}
            installErrors={installErrors}
            dirty={dirty}
            componentRevision={componentRevision}
            previewWidth={previewWidth}
            previewHeight={previewHeight}
            onInstall={onInstall}
            onEdit={onEdit}
          />
        ) : (
          <div className="ins-empty">編集したい字幕・効果音・画像などを選ぶと、ここに設定が表示されます。</div>
        )}
        {/* Selection-independent installation stays available below editing controls.
          Its dirty-state hint must not move the controls the user is operating. */}
        {!videoInsertInstalled && (
          <div className="ins-section ins-persistent-install">
            <div className="ins-label"><span>サブ動画機能</span></div>
            <div className="ins-pack-cta">
              <p>サブ動画（インサート動画）をプレビューに表示できます。</p>
              <InstallCtaButton
                kind="videoInsert"
                label="サブ動画機能を導入"
                className="ins-video-install"
                installing={installing}
                installErrors={installErrors}
                dirty={dirty}
                onInstall={onInstall}
              />
            </div>
          </div>
        )}
      </div>
    </div></AssetTimingContext.Provider>
  );
}
