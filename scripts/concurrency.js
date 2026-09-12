/**
 * Runs fn(item) for every item in `items`, at most `limit` at a time,
 * returning results in the same order as `items` regardless of which
 * finishes first. Deliberately minimal (no external dependency) --
 * Foundry's client `fetch` has no concurrency control of its own, and a
 * real publish run doing everything strictly one-at-a-time (one GitHub
 * round trip, or one image fetch, per await) was the dominant cost behind
 * publishes taking 9+ minutes. GitHub's REST API rate-limits abusive
 * concurrency, so this exists to get a real speedup without blasting
 * every request at once.
 *
 * If any single fn(item) call throws, the whole call rejects with that
 * error -- same all-or-nothing failure behavior as the sequential `for`
 * loops this replaces (a hard failure already aborted the whole batch
 * before). Other in-flight workers aren't explicitly cancelled, but
 * nothing here awaits their results afterward either.
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
