// Whether something on the page can be seen and clicked, not hidden under a panel or a header: shared by each spec
// that checks nothing covers an element.
import type { Locator } from "@playwright/test";

/** True when the element at `target`'s centre is `target` or inside it, once scrolled into view: nothing covers it. */
export async function isOnTop(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  return target.evaluate((el, point) => el.contains(document.elementFromPoint(point.x, point.y)), {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
}
