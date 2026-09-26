/**
 * Declarative binding — one call to `bind()` wires up every element
 * carrying a `data-cuelume-*` attribute:
 *
 *   data-cuelume-hover    → plays on pointerenter (fine mouse, throttled)
 *   data-cuelume-press    → plays on pointerdown  (mouse-only)
 *   data-cuelume-release  → plays on pointerup    (mouse-only)
 *   data-cuelume-toggle   → plays on click
 *
 * Delegated listeners resolve attributes when each event fires, so later
 * DOM additions, removals, and clones work without rescanning.
 */
/**
 * Delegates `data-cuelume-*` interactions under `root` (default: the whole
 * document). Safe during SSR and safe to call repeatedly for the same root.
 */
export declare function bind(root?: ParentNode): void;
