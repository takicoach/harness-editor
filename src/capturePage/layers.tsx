/**
 * 撮影ページのレイヤ描画（M2b T2・R1 修正）。
 *
 * **本番（プレビュー＝書き出し）の描き手と同じ規約で描く**のがこのモジュールの目的。
 * src/preview/EditorComposition.tsx の TelopLayer / InsertImageLayer は、部品そのものではなく
 * その**ラッパー**が位置・拡縮・アニメ位相を決めている。撮影ページが部品を素通しで描くと、
 * transform が落ちる・二重適用される・Ken Burns やフェードの位相がずれる、という形で
 * 無言で本番と食い違う（「描き手は1つにする」の原則）。
 *
 * ラッパー規約はどちらも本番と同じ共有関数から導く（数式をここで再実装しない）:
 *   - テロップ: activeTelopsAt / sampleMotion / motionProgress / telopTransform /
 *     telopScaleOriginY。segment からは position/scale/motion を**外して**渡す
 *     （部品側も同じ値を読んで自分で適用しうるため、二重適用を避ける）
 *   - 画像: `<Sequence from={startFrame} durationInFrames={span}>` で包む
 *     （InsertImage 内の useCurrentFrame はセグメント相対。素の絶対フレームを渡すと
 *      startFrame>0 で登場アニメ・Ken Burns の位相がずれる）。縮退区間（span<=0）は描かない
 *   - タイトル: preview/TitleLayer.tsx を import せず、**capturePage 側に CaptureTitleLayer を
 *     新設**して同じ数式・style を同順で再現する（M2c T2 レビュー由来: preview/TitleLayer.tsx は
 *     'remotion' を直接 import しており、layers.tsx が静的 import すると Node
 *     （captureRunPlanner）で real remotion に解決されて throw する。runtimeFace.ts 経由の
 *     captureRuntime だけに依存させることで Node 解決を成立させる）。TitleClip の数式・style
 *     は preview 側と**同順**で再現し、二重適用はしない。ドリフト検出は
 *     src/server/captureSmoke.e2e.test.ts の「本番ソースの正規化文字列比較 pin」方式
 *     （TelopLayer↔CaptureTelopLayer と同じやり方）を CaptureTitleLayer にも適用する。
 *   - telop+title 統合（設計判断3）: CaptureTelopTitleLayer が CaptureTelopLayer の上に
 *     CaptureTitleLayer を積む（z 順 = EditorComposition.tsx:586-588 と同順・telop 下・title 上）。
 *
 * EditorComposition の TelopLayer / InsertImageLayer は export されていないため直接は
 * 再利用できない（プレビュー本体は無変更の制約）。共有関数を同じ順で呼ぶことで一致させ、
 * layers.test.tsx が本番規約との一致を pin する。
 */
import React from 'react';
import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from './runtimeFace';
import { activeTelopsAt } from '../preview/playbackModel';
import { telopScaleOriginY, telopTransform } from '../preview/telopLayout';
import { motionProgress, sampleMotion } from '../core/motion';
import type { TelopComponent } from '../preview/loadTelopComponent';
import type { InsertImageComponent } from '../preview/loadInsertImageComponent';
import type { ImageSegment, TelopSegment, TitleSegment, TitleStyle } from '../core/types';
import type { CaptureSpec } from './protocol';
import { fontStack, resolveFontByValue } from '../core/fonts';

/** 書体未指定の旧案件が使う既定スタック（プレビュー側 editState.ts と同値）。 */
const TITLE_FALLBACK_FAMILY = '"Noto Sans JP", "Hiragino Kaku Gothic ProN", sans-serif';
/**
 * M-4: 一覧にある書体は telop と同じ fontStack（明朝系なら明朝へ落ちる）を使う。
 * 旧実装は選択に関係なく常にゴシック鎖を後ろに付けていたため、同じ Noto Serif JP を
 * 選んでも title だけ欠落文字がゴシックへ落ちていた。一覧に無い自由入力は従来どおり。
 */
function titleFontFamily(family: string | undefined): string {
  if (!family) return TITLE_FALLBACK_FAMILY;
  const font = resolveFontByValue(family);
  return font ? fontStack(font) : `"${family}", ${TITLE_FALLBACK_FAMILY}`;
}

/** 撮影対象の画像セグメント（本番 InsertImageLayer と同じく imageUrl を注入できる）。 */
export type CaptureImageSegment = ImageSegment & { imageUrl?: string };

/** レイヤ種別ごとの撮影データ（spec.data の中身）。 */
export interface TelopLayerData {
  telops: TelopSegment[];
}
export interface ImageLayerData {
  images: CaptureImageSegment[];
}
export interface TitleLayerData {
  titles: TitleSegment[];
  titleStyle?: TitleStyle;
}
/** telop+title 統合レイヤ（設計判断3）のデータ。 */
export interface TelopTitleLayerData {
  telops: TelopSegment[];
  titles: TitleSegment[];
  titleStyle?: TitleStyle;
}

/** 撮影ページが描くために解決済みでなければならない部品。 */
export interface LoadedComponents {
  Telop: TelopComponent | null;
  InsertImage: InsertImageComponent | null;
}

/**
 * テロップレイヤ。EditorComposition.tsx の TelopLayer と同じ規約
 * （sampleMotion → telopTransform → ラッパーへ適用 → segment から position/scale/motion を外す）。
 */
export function CaptureTelopLayer({
  Telop,
  telops,
}: {
  Telop: TelopComponent;
  telops: TelopSegment[];
}): React.ReactElement | null {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const active = activeTelopsAt(telops, frame);
  if (active.length === 0) return null;
  return (
    <>
      {active.map((current) => {
        const sampled = sampleMotion(
          current.motion,
          {
            x: current.position?.x ?? 0,
            y: current.position?.y ?? 0,
            scale: current.scale ?? 1,
            opacity: 1,
            rotation: 0,
          },
          motionProgress(frame, current.startFrame, current.endFrame),
        );
        const pos = sampled.x !== 0 || sampled.y !== 0 ? { x: sampled.x, y: sampled.y } : undefined;
        const transform = telopTransform(pos, sampled.scale, width, height);
        const segmentForStyle: TelopSegment = {
          ...current,
          position: undefined,
          scale: undefined,
          motion: undefined,
        };
        const style =
          transform !== undefined || sampled.opacity !== 1
            ? {
                transform,
                transformOrigin: `50% ${telopScaleOriginY(width, height)}%`,
                ...(sampled.opacity !== 1 ? { opacity: sampled.opacity } : {}),
              }
            : undefined;
        return (
          <AbsoluteFill key={current.id} style={style} data-sme-kind="telop" data-sme-id={current.id}>
            <Telop segment={segmentForStyle} />
          </AbsoluteFill>
        );
      })}
    </>
  );
}

/**
 * 画像レイヤ。EditorComposition.tsx の InsertImageLayer と同じ規約
 * （Sequence でセグメント相対フレームにする・縮退区間は描かない）。
 */
export function CaptureInsertImageLayer({
  InsertImage,
  images,
}: {
  InsertImage: InsertImageComponent;
  images: CaptureImageSegment[];
}): React.ReactElement {
  return (
    <>
      {images
        .filter((i) => i.endFrame > i.startFrame)
        .map((i) => (
          <Sequence key={i.id} from={i.startFrame} durationInFrames={i.endFrame - i.startFrame}>
            <AbsoluteFill data-sme-kind="image" data-sme-id={i.id}>
              <InsertImage segment={i} />
            </AbsoluteFill>
          </Sequence>
        ))}
    </>
  );
}

/**
 * titleStyle 未指定時の既定スタイル（解像度から導く）。
 * preview/TitleLayer.tsx の resolveTitleStyle と同一（数式の正本は preview 側・ここは
 * capturePage 側の独立実装。captureSmoke.e2e.test.ts の正規化文字列比較 pin がドリフトを検出する）。
 */
function resolveTitleStyle(titleStyle: TitleStyle | undefined, width: number, height: number): TitleStyle {
  return (
    titleStyle ?? {
      top: Math.round(height * 0.03),
      left: Math.round(width * 0.03),
      fontSize: Math.round(height * 0.022),
    }
  );
}

/**
 * 1 タイトルの表示。preview/TitleLayer.tsx の TitleClip と**同一の数式・style を同順で再現**
 * （二重適用なし）。preview 側の TitleClip はそのまま無変更・本ファイルは 'remotion' を
 * runtimeFace.ts 経由の captureRuntime としてのみ使う独立実装（Node 解決のため）。
 */
const CaptureTitleClip: React.FC<{ segment: TitleSegment; style: TitleStyle; animate?:boolean; measureTitleBox?:boolean }> = ({ segment, style, animate=true, measureTitleBox=false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const duration = segment.endFrame - segment.startFrame;
  // Static native titles also support trims shorter than the legacy animation.
  // Do not evaluate its overlapping fade ranges when animation is disabled.
  const opacity = animate ? interpolate(frame, [0, 8, duration - 8, duration], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  }) : 1;
  const slideIn = animate ? spring({ frame, fps, config: { damping: 20, stiffness: 100, mass: 0.5 } }) : 1;
  const translateX = animate ? interpolate(slideIn, [0, 1], [-50, 0]) : 0;
  return (
    <div
      style={{
        position: 'absolute',
        top: style.top,
        left: style.left,
        opacity: animate?opacity:1,
        transform: animate?`translateX(${translateX}px)`:undefined,
        zIndex: 100,
      }}
    >
      <div
        data-native-title-box={measureTitleBox?'':undefined}
        style={{
          background: 'linear-gradient(90deg, #E8CE9A 0%, #D4B97A 50%, #B8954C 100%)',
          padding: '8px 5px',
          borderRadius: 4,
          display: 'inline-block',
          boxShadow: '0 4px 16px rgba(20, 46, 35, 0.25)',
        }}
      >
        <p
          style={{
            color: '#142E23',
            fontSize: style.fontSize,
            fontWeight: 800,
            // Keep Noto when installed; name the original Mac fallback explicitly
            // so separate preview/export pages do not pick different Hiragino faces.
            // A chosen title font (style.fontFamily, a plain family name from
            // core/fonts.ts) is layered in front of that same fallback chain.
            fontFamily: titleFontFamily(style.fontFamily),
            margin: 0,
            lineHeight: 1.2,
            transform: 'skewX(-8deg)',
            whiteSpace: 'nowrap',
          }}
        >
          {segment.text}
        </p>
      </div>
    </div>
  );
};

/**
 * タイトルレイヤ。preview/TitleLayer.tsx の TitleLayer と同じ規約（可視タイトルを全件
 * Sequence で包む）。preview 側は無変更・本コンポーネントが capturePage 側の独立実装。
 */
export function CaptureTitleLayer({
  titles,
  titleStyle,
  animate=true,
  measureTitleBox=false,
}: {
  titles: TitleSegment[];
  titleStyle?: TitleStyle;
  animate?:boolean;
  measureTitleBox?:boolean;
}): React.ReactElement {
  const { width, height } = useVideoConfig();
  const style = resolveTitleStyle(titleStyle, width, height);
  return (
    <AbsoluteFill>
      {titles.map((t) => (
        <Sequence key={t.id} from={t.startFrame} durationInFrames={Math.max(1, t.endFrame - t.startFrame)}>
          <CaptureTitleClip segment={t} style={style} animate={animate} measureTitleBox={measureTitleBox} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

/**
 * telop+title 統合レイヤ（設計判断3）。z 順は telop 下・title 上
 * （EditorComposition.tsx:586-588 と同順）。
 */
export function CaptureTelopTitleLayer({
  Telop,
  telops,
  titles,
  titleStyle,
}: {
  Telop: TelopComponent;
  telops: TelopSegment[];
  titles: TitleSegment[];
  titleStyle?: TitleStyle;
}): React.ReactElement {
  return (
    <>
      <CaptureTelopLayer Telop={Telop} telops={telops} />
      <CaptureTitleLayer titles={titles} titleStyle={titleStyle} />
    </>
  );
}

/** spec からレイヤを描く。部品未ロードは captureRuntime: 接頭辞で fail-loud。 */
export function renderCaptureLayer(spec: CaptureSpec, loaded: LoadedComponents): React.ReactNode {
  const data = (spec.data ?? {}) as Record<string, unknown>;
  if (spec.layer === 'telop') {
    const Telop = loaded.Telop;
    if (Telop === null) {
      throw new Error('captureRuntime: テロップ部品が未ロードです（init の prepare が失敗しています）');
    }
    return <CaptureTelopLayer Telop={Telop} telops={(data['telops'] ?? []) as TelopSegment[]} />;
  }
  if (spec.layer === 'image') {
    const InsertImage = loaded.InsertImage;
    if (InsertImage === null) {
      throw new Error('captureRuntime: 挿入画像部品が未ロードです（init の prepare が失敗しています）');
    }
    return (
      <CaptureInsertImageLayer
        InsertImage={InsertImage}
        images={(data['images'] ?? []) as CaptureImageSegment[]}
      />
    );
  }
  if (spec.layer === 'title') {
    return (
      <CaptureTitleLayer
        titles={(data['titles'] ?? []) as TitleSegment[]}
        titleStyle={data['titleStyle'] as TitleStyle | undefined}
      />
    );
  }
  // 'telop-title'
  const Telop = loaded.Telop;
  if (Telop === null) {
    throw new Error('captureRuntime: テロップ部品が未ロードです（init の prepare が失敗しています）');
  }
  return (
    <CaptureTelopTitleLayer
      Telop={Telop}
      telops={(data['telops'] ?? []) as TelopSegment[]}
      titles={(data['titles'] ?? []) as TitleSegment[]}
      titleStyle={data['titleStyle'] as TitleStyle | undefined}
    />
  );
}
