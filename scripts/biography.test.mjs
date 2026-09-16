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

test("extractBiography pulls a pf2e Character's biography from system.details.biography.backstory, trimmed", async () => {
  const { extractBiography } = await import("./biography.js");
  const actor = {
    type: "character",
    system: {
      details: {
        biography: {
          backstory: "  <p>Raised by wolves in the Mwangi Expanse.</p>  ",
          appearance: "<p>Should be ignored -- not a bio field</p>",
        },
      },
    },
  };
  await withGameSystem("pf2e", () => {
    assert.equal(extractBiography(actor), "<p>Raised by wolves in the Mwangi Expanse.</p>");
  });
});

test("extractBiography pulls a pf2e NPC's biography from system.details.publicNotes, not .privateNotes or .biography", async () => {
  const { extractBiography } = await import("./biography.js");
  const actor = {
    type: "npc",
    system: {
      details: {
        publicNotes: "  <p>A gruff dockworker.</p>  ",
        privateNotes: "<p>GM-only: is actually a doppelganger.</p>",
        biography: { backstory: "<p>Should be ignored -- NPCs don't use this field</p>" },
      },
    },
  };
  await withGameSystem("pf2e", () => {
    assert.equal(extractBiography(actor), "<p>A gruff dockworker.</p>");
  });
});

test("extractBiography returns '' for a pf2e NPC with no publicNotes, never falling back to .privateNotes", async () => {
  const { extractBiography } = await import("./biography.js");
  const actor = {
    type: "npc",
    system: { details: { privateNotes: "<p>GM-only: is actually a doppelganger.</p>" } },
  };
  await withGameSystem("pf2e", () => {
    assert.equal(extractBiography(actor), "");
  });
});

test("extractBiography pulls a pf2e party actor's biography from system.details.description, trimmed", async () => {
  const { extractBiography } = await import("./biography.js");
  const actor = {
    type: "party",
    system: { details: { description: "  A ragtag band of adventurers.  " } },
  };
  await withGameSystem("pf2e", () => {
    assert.equal(extractBiography(actor), "A ragtag band of adventurers.");
  });
});

test("extractBiography pulls a daggerheart character's biography from system.biography.background, trimmed", async () => {
  const { extractBiography } = await import("./biography.js");
  const actor = {
    type: "character",
    system: {
      biography: {
        background: "  A wandering bard with a mysterious past.  ",
        connections: "Should be ignored -- not a personal bio field",
        characteristics: { pronouns: "she/her", age: "27", faith: "The Beastbound" },
      },
    },
  };
  await withGameSystem("daggerheart", () => {
    assert.equal(extractBiography(actor), "A wandering bard with a mysterious past.");
  });
});

test("extractBiography pulls a daggerheart adversary's biography from system.description, not .notes or .biography", async () => {
  const { extractBiography } = await import("./biography.js");
  const actor = {
    type: "adversary",
    system: {
      description: "  A hulking brute who guards the old bridge.  ",
      notes: "GM-only: secretly bound by a curse to the bridge.",
      biography: { background: "Should be ignored -- adversaries don't use this field" },
    },
  };
  await withGameSystem("daggerheart", () => {
    assert.equal(extractBiography(actor), "A hulking brute who guards the old bridge.");
  });
});

test("extractBiography returns '' for a daggerheart adversary with no description, never falling back to .notes", async () => {
  const { extractBiography } = await import("./biography.js");
  const actor = {
    type: "adversary",
    system: { notes: "GM-only: secretly bound by a curse to the bridge." },
  };
  await withGameSystem("daggerheart", () => {
    assert.equal(extractBiography(actor), "");
  });
});
