// Same algorithm as server/src/lib/ordering.js, so optimistic drops land where the server will put them.
// Keep the two files in sync.

export const GAP = 1024;
export const MIN_GAP = 1e-6;

/**
 * siblings: [{ id, position }] sorted ascending, NOT including the item being placed.
 * afterId / beforeId: the neighbours the user dropped the item between.
 *   - afterId is tried first, then beforeId.
 *   - If neither is found any more (someone deleted or moved them), the item goes to the end.
 * Returns { position, rebalanced } where rebalanced is the renumbered siblings, or null.
 */
export function computePosition(siblings, { afterId = null, beforeId = null } = {}) {
  let list = siblings;
  let rebalanced = null;

  const locate = () => {
    if (afterId != null) {
      const i = list.findIndex((s) => s.id === afterId);
      if (i >= 0) return i;
    }
    if (beforeId != null) {
      const i = list.findIndex((s) => s.id === beforeId);
      if (i >= 0) return i - 1;
    }
    return list.length - 1;
  };

  let i = locate();
  let prev = i >= 0 ? list[i] : null;
  let next = list[i + 1] ?? null;

  if (prev && next && next.position - prev.position < MIN_GAP) {
    list = siblings.map((s, k) => ({ ...s, position: (k + 1) * GAP }));
    rebalanced = list;
    i = locate();
    prev = i >= 0 ? list[i] : null;
    next = list[i + 1] ?? null;
  }

  let position;
  if (prev && next) position = (prev.position + next.position) / 2;
  else if (prev) position = prev.position + GAP;
  else if (next) position = next.position - GAP;
  else position = GAP;

  return { position, rebalanced };
}
