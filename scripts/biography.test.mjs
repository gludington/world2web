// Run with: node --test foundry-module/scripts/biography.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

async function withGameSystem(systemId, fn) {
  const prevGame = globalThis.game;
  globalThis.game = { system: systemId ? { id: systemId } : undefined };
  try {
    await fn();
  } finally {
    globalThis.game = prevGame;
  }
}

test("extractBiography returns '' for a null/undefined actor", async () => {
  const { extractBiography } = await import("./biography.js");
  await withGameSystem("dnd5e", () => {
    assert.equal(extractBiography(null), "");
    assert.equal(extractBiography(undefined), "");
  });
});

test("extractBiography returns '' for a system with no registered extractor", async () => {
  const { extractBiography } = await import("./biography.js");
  const actor = { system: { details: { biography: { value: "<p>Hi</p>" } } } };
  await withGameSystem("some-unregistered-system", () => {
    assert.equal(extractBiography(actor), "");
  });
});

test("extractBiography pulls a PC's dnd5e biography from system.details.biography.value, trimmed", async () => {
  const { extractBiography } = await import("./biography.js");
  const actor = {
    type: "character",
    system: { details: { biography: { value: "  <p>A dwarf far from home.</p>  ", public: "<p>Should be ignored</p>" } } },
  };
  await withGameSystem("dnd5e", () => {
    assert.equal(extractBiography(actor), "<p>A dwarf far from home.</p>");
  });
});

test("extractBiography pulls an NPC's dnd5e biography from system.details.biography.public, not .value", async () => {
  const { extractBiography } = await import("./biography.js");
  const actor = {
    type: "npc",
    system: {
      details: {
        biography: {
          value: "<p>GM-only: secretly a vampire spawn.</p>",
          public: "  <p>A quiet innkeeper.</p>  ",
        },
      },
    },
  };
  await withGameSystem("dnd5e", () => {
    assert.equal(extractBiography(actor), "<p>A quiet innkeeper.</p>");
  });
});

test("extractBiography returns '' for an NPC with no public biography, never falling back to the GM-only .value", async () => {
  const { extractBiography } = await import("./biography.js");
  const actor = {
    type: "npc",
    system: { details: { biography: { value: "<p>GM-only: secretly a vampire spawn.</p>" } } },
  };
  await withGameSystem("dnd5e", () => {
    assert.equal(extractBiography(actor), "");
  });
});

test("extractBiography returns '' rather than throwing when the expected shape is missing", async () => {
  const { extractBiography } = await import("./biography.js");
  await withGameSystem("dnd5e", () => {
    assert.equal(extractBiography({}), "");
    assert.equal(extractBiography({ system: {} }), "");
    assert.equal(extractBiography({ system: { details: {} } }), "");
  });
});
