import { AbsoluteFill, OffthreadVideo, staticFile } from 'remotion';
import { TelopPlayer } from './テロップテンプレート';
import { SESequence } from './SoundEffects/SESequence';
import { ImageSequence } from './InsertImage';
import { TitleSequence } from './Title';
import { ZoomFrame } from './ZoomFrame';
import { VIDEO_FILE } from './videoConfig';

export const MainVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* ズーム/クロップ（zoomData 空なら Fragment 素通しで従来と同一描画） */}
      <ZoomFrame>
        {/* ベース動画 */}
        <OffthreadVideo
          src={staticFile(VIDEO_FILE)}
          volume={1.0}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
          }}
        />

        {/* 挿入画像 */}
        <ImageSequence />
      </ZoomFrame>

      {/* テロップ（ズーム対象外＝フレーム固定UI） */}
      <TelopPlayer />

      {/* タイトル（ズーム対象外＝フレーム固定UI） */}
      <TitleSequence />

      {/* 効果音（ズーム対象外＝音声のみ） */}
      <SESequence />
    </AbsoluteFill>
  );
};
