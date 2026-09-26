import { createContext, useContext, type ReactNode } from 'react';

export interface AssetTimingDisplay { fields: ReactNode; start: number; end: number; label: string; onSplit?: (frame: number) => void }
export const AssetTimingContext = createContext<AssetTimingDisplay | null>(null);
export const useAssetTimingDisplay = () => useContext(AssetTimingContext);

/** Keep every finishing inspector on the same clock as the editing timeline. */
export function AssetTimingSection({ children }: { children: ReactNode }) {
  const timing = useAssetTimingDisplay();
  return <div className="ins-section">{timing ? <>
    <div className="ins-label"><span>表示する時間（完成動画）</span></div>
    {timing.fields}
  </> : children}</div>;
}
