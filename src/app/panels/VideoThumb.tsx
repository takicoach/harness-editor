import { useRef, useState, type ReactNode } from 'react';
import { thumbSeekTime } from './materialList';

interface VideoThumbProps {
  src: string;
  /**
   * 読み込めなかったときの表示。**未指定（undefined）のときだけ**既定の「動画」文字を出す。
   * `null` は「何も出さない」という明示指定として尊重する（`??` だと既定へ落ちてしまう）。
   * ゴミ箱カードのように「動画なし」の見た目が別に決まっている場所で差し替える。
   */
  fallback?: ReactNode;
}

/**
 * サブ動画素材・プロジェクト一覧の実フレームサムネ。
 * <video> でメタデータ→代表フレームへシークし、**canvas に転写した静止画（poster）に
 * 置き換えて <video> を破棄する**。Chrome は同一オリジン同時6接続の制限があり、
 * <video> 要素を並べたままにすると1要素1接続を占有し続け、プロジェクト一覧（6件で6要素）だけで
 * 接続枠を食い潰して「動画がくるくる・保存が終わらない」を誘発するため（2026-07-24 実測）。
 * 転写失敗（CORS 等）時は従来どおり <video> のまま、読込不可時は「動画」文字へフォールバック。
 */
export function VideoThumb({ src, fallback }: VideoThumbProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [poster, setPoster] = useState<string | null>(null);

  if (failed) {
    return <>{fallback === undefined ? <span className="ml-thumb-video">動画</span> : fallback}</>;
  }
  if (poster !== null) return <img className="ml-thumb-video-el" src={poster} alt="" />;

  return (
    <video
      ref={ref}
      className="ml-thumb-video-el"
      src={src}
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={() => {
        const v = ref.current;
        if (v) v.currentTime = thumbSeekTime(v.duration);
      }}
      onSeeked={() => {
        const v = ref.current;
        if (!v) return;
        try {
          const w = 120;
          const h = v.videoHeight > 0 ? Math.round((v.videoHeight / v.videoWidth) * w) : 68;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(v, 0, 0, w, h);
            setPoster(canvas.toDataURL('image/jpeg', 0.6));
          }
        } catch {
          // 転写できない環境では <video> のまま表示を維持する
        }
      }}
      onError={() => setFailed(true)}
    />
  );
}
