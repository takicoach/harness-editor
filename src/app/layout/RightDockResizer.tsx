import { useLayoutEffect, useRef, useState } from 'react';
import './rightDockResize.css';

const STORAGE_KEY = 'sme-right-panel-width';
const DEFAULT_WIDTH = 340;

function initialWidth(): number {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(saved) && saved >= 180 && saved <= 640) return saved;
  } catch { /* Width preferences are optional. */ }
  return DEFAULT_WIDTH;
}

/** A keyboard-accessible splitter; its preference is separate from project edits. */
export function RightDockResizer() {
  const [desired, setDesired] = useState(initialWidth);
  const [maximum, setMaximum] = useState(640);
  const drag = useRef<{ x: number; width: number; desired: number } | null>(null);
  const desiredRef = useRef(desired);
  desiredRef.current = desired;
  const minimum = Math.min(260, maximum);
  const applied = Math.max(minimum, Math.min(maximum, desired));

  function persist(width: number): void {
    try { localStorage.setItem(STORAGE_KEY, String(width)); } catch { /* Keep working without persistence. */ }
  }

  useLayoutEffect(() => {
    const stage = document.querySelector<HTMLElement>('.stage');
    if (!stage) return;
    const folder = stage.querySelector<HTMLElement>(':scope > .fb, :scope > .lc');
    const extra = stage.querySelector<HTMLElement>(':scope > .subpanel');
    const measure = () => {
      const available = stage.clientWidth - (folder?.getBoundingClientRect().width ?? 0)
        - (extra?.getBoundingClientRect().width ?? 0) - 282;
      setMaximum(Math.max(180, Math.min(640, available)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    if (folder) observer.observe(folder);
    if (extra) observer.observe(extra);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--rightdock-w', `${applied}px`);
  }, [applied]);

  useLayoutEffect(() => () => {
    document.documentElement.style.removeProperty('--rightdock-w');
    delete document.documentElement.dataset.resizingRightDock;
  }, []);

  function reset(): void { setDesired(DEFAULT_WIDTH); persist(DEFAULT_WIDTH); }

  return <div
    className="rightdock-resizer"
    role="separator"
    tabIndex={0}
    aria-label="右パネルの幅"
    aria-orientation="vertical"
    aria-valuemin={minimum}
    aria-valuemax={maximum}
    aria-valuenow={applied}
    aria-valuetext={`${Math.round(applied)}ピクセル`}
    title="ドラッグまたは左右キーで幅を調整。ダブルクリックで標準の幅に戻す"
    onDoubleClick={reset}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, width: applied, desired };
      document.documentElement.dataset.resizingRightDock = 'true';
    }}
    onPointerMove={event => {
      if (!drag.current) return;
      setDesired(Math.max(minimum, Math.min(maximum, drag.current.width + drag.current.x - event.clientX)));
    }}
    onPointerUp={event => {
      if (!drag.current) return;
      drag.current = null;
      persist(desiredRef.current);
      delete document.documentElement.dataset.resizingRightDock;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onLostPointerCapture={() => {
      if (drag.current) { setDesired(drag.current.desired); drag.current = null; }
      delete document.documentElement.dataset.resizingRightDock;
    }}
    onKeyDown={event => {
      if (event.key === 'Escape' && drag.current) {
        setDesired(drag.current.desired); drag.current = null;
        delete document.documentElement.dataset.resizingRightDock;
        event.preventDefault();
        return;
      }
      if (event.key === 'Home' || event.key === 'Enter') { event.preventDefault(); reset(); return; }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const delta = (event.shiftKey ? 40 : 16) * (event.key === 'ArrowLeft' ? 1 : -1);
      const next = Math.max(minimum, Math.min(maximum, applied + delta));
      setDesired(next); persist(next);
    }}
  />;
}
