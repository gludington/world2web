// Run with: node --test foundry-module/scripts/concurrency.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "./concurrency.js";

test("mapWithConcurrency returns results in input order regardless of completion order", async () => {
  const delays = [30, 10, 20, 0];
  const results = await mapWithConcurrency(delays, 4, async (ms, i) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return i;
  });
  assert.deepEqual(results, [0, 1, 2, 3]);
});

test("mapWithConcurrency never runs more than `limit` at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await mapWithConcurrency(items, 3, async (i) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return i * 2;
  });
  assert.ok(maxInFlight <= 3, `expected at most 3 concurrent, saw ${maxInFlight}`);
});

test("mapWithConcurrency processes every item exactly once", async () => {
  const seen = [];
  const items = Array.from({ length: 20 }, (_, i) => i);
  await mapWithConcurrency(items, 5, async (i) => {
    seen.push(i);
    return i;
  });
  assert.deepEqual([...seen].sort((a, b) => a - b), items);
});

test("mapWithConcurrency handles an empty array without error", async () => {
  const results = await mapWithConcurrency([], 5, async (i) => i);
  assert.deepEqual(results, []);
});

test("mapWithConcurrency handles limit larger than the item count", async () => {
  const results = await mapWithConcurrency([1, 2], 100, async (i) => i * 10);
  assert.deepEqual(results, [10, 20]);
});

test("mapWithConcurrency rejects if any single call throws", async () => {
  await assert.rejects(
    () =>
      mapWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    /boom/,
  );
});
