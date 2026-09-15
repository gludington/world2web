/**
 * Runs `fn(item)` for every item in `items`, at most `limit` at a time. Deliberately minimal (no
 * external dependency) -- Foundry's client `fetch` has no concurrency control of its own, and a
 * real publish run doing everything strictly one-at-a-time (one GitHub round trip, or one image
 * fetch, per await) was the dominant cost behind publishes taking 9+ minutes. GitHub's REST API
 * rate-limits abusive concurrency, so this exists to get a real speedup without blasting every
 * request at once.
 *
 * @template T, R
 * @param {T[]} items The items to process. `[]` is valid and resolves immediately to `[]`.
 * @param {number} limit The maximum number of `fn` calls in flight at once. Clamped to at least 1
 *   and at most `items.length` -- a value larger than `items.length` doesn't spawn idle workers.
 * @param {(item: T, index: number) => Promise<R>} fn Called once per item; may reject.
 * @returns {Promise<R[]>} Resolves with results in the same order as `items`, regardless of which
 *   `fn` call actually finishes first. Rejects with whatever the first-to-throw `fn` call threw --
 *   same all-or-nothing failure behavior as the sequential `for` loops this replaces (a hard
 *   failure already aborted the whole batch before). Other in-flight workers aren't explicitly
 *   cancelled on rejection, but nothing here awaits their results afterward either.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
