import { useEffect, useRef, useState } from 'react';

interface Props { message: string; action?: { label: string; onClick(): void }; onClose(): void; duration?: number;
  /** M-3: 同一文言を続けて出したときにタイマーを数え直すための通し番号。呼び出し側が毎回 +1 する。 */
  id?: number }

/** 一時的なお知らせ（UI 添削 F16）。下中央・3 秒で消える・ホバー中は止まる。対応が要る通知はここではなくバーに出す。 */
export function NativeToast({ message, action, onClose, duration = 3000, id }: Props) {
  const [hover, setHover] = useState(false);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (hover) return;
    const timer = setTimeout(() => close.current(), duration);
    return () => clearTimeout(timer);
  }, [hover, duration, message, id]);
  return <div className="native-toast" role="status" aria-live="polite" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
    <span>{message}</span>
    {action && <button type="button" onClick={() => { action.onClick(); onClose(); }}>{action.label}</button>}
  </div>;
}
