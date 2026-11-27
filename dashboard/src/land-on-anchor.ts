import { useEffect, useRef } from "react";

/**
 * A page opened at an anchor (`/setup#setup-repos`, `/products#product-<id>`) lands on it once its content first shows:
 * the browser's own jump to the anchor came before the page rendered it. When `ready` first turns true, `findTarget`
 * gets the address's anchor (no `#`; empty without one) and gives the element it names on this page, or null for an
 * anchor the page doesn't have; that element comes into view, then `onLanded` gets it. A later read of the page's
 * content never lands again, so it never moves a page the person has scrolled; only a change of the address's anchor
 * (a `hashchange`) while the page is ready and open lands again, the same way (#353).
 */
export function useLandOnAnchor(
  ready: boolean,
  findTarget: (anchor: string) => HTMLElement | null,
  onLanded?: (target: HTMLElement) => void,
) {
  const landed = useRef(false);
  useEffect(() => {
    if (!ready) return;
    function land() {
      const target = findTarget(location.hash.slice(1));
      if (target === null) return;
      target.scrollIntoView();
      onLanded?.(target);
    }
    if (!landed.current) {
      landed.current = true;
      land();
    }
    window.addEventListener("hashchange", land);
    return () => window.removeEventListener("hashchange", land);
  }, [ready, findTarget, onLanded]);
}
