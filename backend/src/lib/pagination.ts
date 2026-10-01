import { z } from "zod";

// ============================================================
// Shared pagination helpers (Phase 7).
//
// Firestore note: every list query in this phase uses a SINGLE
// equality filter (userId == uid) and sorts IN MEMORY. That keeps
// us on Firestore's automatic single-field indexes — no composite
// index provisioning needed — at the cost of reading the user's own
// (bounded) result set and slicing it here. `startAfter` is the id
// of the last item of the previous page.
// ============================================================

/** ?limit= (default 20, max 100) & ?startAfter= (a document id). */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  startAfter: z.string().min(1).max(256).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Slice an already-sorted array into a page. `getId` extracts the
 * document id used as the `startAfter` cursor. When the cursor is
 * unknown (e.g. the doc was deleted), paging restarts from the top
 * rather than failing — honest and simple.
 */
export function paginate<T>(
  sorted: T[],
  getId: (item: T) => string | undefined,
  query: PaginationQuery,
): Page<T> {
  let start = 0;
  if (query.startAfter !== undefined) {
    const idx = sorted.findIndex((item) => getId(item) === query.startAfter);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const items = sorted.slice(start, start + query.limit);
  const hasMore = start + query.limit < sorted.length;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? (getId(last) ?? null) : null,
  };
}
