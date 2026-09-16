// Run with: node --test foundry-module/scripts/ownership.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopedDeletionUuids, _test } from "./ownership.js";

const { ownsSnapshot } = _test;

const OWNER = 3; // matches CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER's real value

test("ownsSnapshot: explicit per-user level wins over the snapshot's default", () => {
  assert.equal(ownsSnapshot({ alice: OWNER, default: 0 }, "alice", OWNER), true);
  assert.equal(ownsSnapshot({ alice: 0, default: OWNER }, "alice", OWNER), false);
});

test("ownsSnapshot: falls back to the snapshot's default when the user has no explicit level", () => {
  assert.equal(ownsSnapshot({ default: OWNER }, "someone-not-listed", OWNER), true);
  assert.equal(ownsSnapshot({ default: 0 }, "someone-not-listed", OWNER), false);
});

test("ownsSnapshot: missing/empty snapshot never owns anything", () => {
  assert.equal(ownsSnapshot({}, "alice", OWNER), false);
  assert.equal(ownsSnapshot(undefined, "alice", OWNER), false);
  assert.equal(ownsSnapshot(null, "alice", OWNER), false);
});

test("scopedDeletionUuids: scopedToCaller false returns every UUID, completely unaffected by ownership", () => {
  // This is the GM guarantee: main.js's retractPendingDeletions and
  // syncButtonColor both call this with scopedToCaller: false for a GM,
  // unconditionally -- a GM's publish/retraction/coloring must cover
  // everyone's pending work, never just their own. Deliberately includes
  // entries a "GM" user owns none of, owns some of, and has an empty/
  // missing ownership snapshot at all, to prove none of that matters.
  const pending = {
    "page.ownedByAlice": { ownership: { alice: OWNER, default: 0 } },
    "page.ownedByBob": { ownership: { bob: OWNER, default: 0 } },
    "page.ownedByNobodyExplicit": { ownership: { default: 0 } },
    "page.noSnapshotAtAll": {},
  };
  const result = scopedDeletionUuids(pending, { scopedToCaller: false, userId: "gm-user", ownerLevel: OWNER });
  assert.deepEqual(new Set(result), new Set(Object.keys(pending)));
});

test("scopedDeletionUuids: scopedToCaller true only returns UUIDs the calling user owns", () => {
  const pending = {
    "page.mine": { ownership: { alice: OWNER, default: 0 } },
    "page.theirs": { ownership: { bob: OWNER, default: 0 } },
    "page.everyonesDefault": { ownership: { default: OWNER } },
  };
  const result = scopedDeletionUuids(pending, { scopedToCaller: true, userId: "alice", ownerLevel: OWNER });
  assert.deepEqual(new Set(result), new Set(["page.mine", "page.everyonesDefault"]));
});

test("scopedDeletionUuids: scopedToCaller true with an empty pending map returns nothing", () => {
  assert.deepEqual(scopedDeletionUuids({}, { scopedToCaller: true, userId: "alice", ownerLevel: OWNER }), []);
});

test("scopedDeletionUuids: scopedToCaller false with an empty pending map also returns nothing (nothing to return)", () => {
  assert.deepEqual(scopedDeletionUuids({}, { scopedToCaller: false, userId: "gm-user", ownerLevel: OWNER }), []);
});
