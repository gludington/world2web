// Run with: node --test scripts/collector.test.mjs
//
// collectJournalData() only touches Foundry globals (game, CONST), so it's
// directly testable in plain Node by stubbing those before calling in --
// this pattern is worth keeping across the other *.test.mjs files too.
import { test } from "node:test";
import assert from "node:assert/strict";

const NS = "world2web";

// resolveAssetUrl() in collector.js resolves any Foundry-relative image
// path against `location.href` -- these are the values every such test
// fixture ("portraits/thoric.png" etc.) should come out as once resolved,
// matching FOUNDRY_HREF stubbed in withMockFoundry below.
const FOUNDRY_ORIGIN = "http://localhost:30000";
const FOUNDRY_HREF = `${FOUNDRY_ORIGIN}/game`;
function resolved(path) {
  return `${FOUNDRY_ORIGIN}/${path}`;
}

function fakePage({ uuid, name, published, publishedAt = null, updatedAt = null, html = "<p>hi</p>" }) {
  return {
    uuid,
    name,
    type: "text",
    text: { content: html },
    flags: published ? { [NS]: { published: true, publishedAt, updatedAt } } : {},
  };
}

function fakeFolder({ id, name, parent = null }) {
  return { id, name, folder: parent };
}

function fakeJournalEntry({ uuid, name, folder = null, ownership = {}, pages = [], config = {}, isOwner = false }) {
  // published:true with no explicit publishedAt mirrors what
  // openJournalConfigDialog's save handler actually does on a first-ever
  // publish (stamps publishedAt at the same time) -- lets every existing
  // "published: true" test fixture stay honest against isPublishable()'s
  // sticky, publishedAt-gated semantics without touching each call site by
  // hand. A test specifically about the sticky/unpublish-cascade behavior
  // passes its own explicit publishedAt/published combination instead.
  const resolvedConfig =
    config.published && config.publishedAt === undefined ? { ...config, publishedAt: 1 } : config;
  return {
    uuid,
    name,
    folder,
    ownership,
    // Plain property, not a real Foundry getter -- collectJournalData's
    // scopedToCaller filter just reads entry.isOwner directly (see its
    // own doc comment for why), so a test fixture only needs to set
    // whatever value that filter should see, not replicate how a real
    // ClientDocument actually computes it from ownership + game.user.
    isOwner,
    pages: { contents: pages },
    flags: { [NS]: resolvedConfig },
  };
}

function fakeUser({ id, isGM = false, name, character = null, avatar = null }) {
  return { id, isGM, name, character, avatar };
}

async function withMockFoundry(
  { journalEntries, users, settings = {}, systemId = null, actorsByUuid = {} },
  fn,
) {
  const prevGame = globalThis.game;
  const prevConst = globalThis.CONST;
  const prevFromUuidSync = globalThis.fromUuidSync;
  const prevLocation = globalThis.location;
  // Stubbed so resolveAssetUrl() (collector.js) has something to resolve
  // Foundry-relative paths against, same as a real client would provide.
  globalThis.location = { href: FOUNDRY_HREF };
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 } };
  globalThis.game = {
    journal: { contents: journalEntries },
    users: { contents: users },
    modules: { get: () => ({ version: "1.0.0" }) },
    world: { id: "test-world", title: "Test World" },
    version: "14.364",
    settings: { get: (_ns, key) => settings[key] },
    system: systemId ? { id: systemId } : undefined,
  };
  // fromUuidSync is a Foundry global, not a game.* property -- stubbed the
  // same way, keyed by whatever uuid string a test's fake Actor uses.
  globalThis.fromUuidSync = (uuid) => actorsByUuid[uuid] ?? null;
  try {
    await fn();
  } finally {
    globalThis.game = prevGame;
    globalThis.CONST = prevConst;
    globalThis.fromUuidSync = prevFromUuidSync;
    globalThis.location = prevLocation;
  }
}

test("collectJournalData includes site config (theme/siteName/journalsSegment/allowThemeOverride) so the ingest script can write it without a live game.settings", async () => {
  const { collectJournalData } = await import("./collector.js");

  await withMockFoundry(
    {
      journalEntries: [],
      users: [],
      settings: {
        siteTheme: "parchment",
        siteName: "The Ashwood Chronicle",
        journalsSegment: "chronicles",
        allowThemeOverride: true,
        homepageLinks: [{ label: "Install", href: "https://example.com/module.json" }, { label: "Bad", href: "nope" }],
      },
    },
    async () => {
      const payload = await collectJournalData();
      assert.deepEqual(payload.siteConfig, {
        theme: "parchment",
        siteName: "The Ashwood Chronicle",
        journalsSegment: "chronicles",
        allowThemeOverride: true,
      });
      // Homepage Links are per world, not site-wide: they travel separately,
      // already reduced to valid links.
      assert.deepEqual(payload.worldConfig, {
        homepageLinks: [{ label: "Install", href: "https://example.com/module.json" }],
      });
    },
  );
});

test("site config defaults to 'default' theme, 'World2Web' name, 'journals' segment, and allowThemeOverride: false when unset", async () => {
  const { collectJournalData } = await import("./collector.js");

  await withMockFoundry({ journalEntries: [], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.deepEqual(payload.siteConfig, {
      theme: "default",
      siteName: "World2Web",
      journalsSegment: "journals",
      allowThemeOverride: false,
    });
    assert.deepEqual(payload.worldConfig, { homepageLinks: [] });
  });
});

test("published pages become posts; drafts are excluded", async () => {
  const { collectJournalData } = await import("./collector.js");

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [
      fakePage({ uuid: "Page.1", name: "Draft entry", published: false }),
      fakePage({ uuid: "Page.2", name: "Published entry", published: true, publishedAt: 100, updatedAt: 100 }),
    ],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journalCount, 1);
    assert.equal(payload.journals[0].postCount, 1);
    assert.equal(payload.journals[0].posts[0].title, "Published entry");
  });
});

test("a previously-published, now-unpublished page is still collected, tombstoned with unpublished: true", async () => {
  const { collectJournalData } = await import("./collector.js");

  // Not fakePage() -- that helper can't express "published: false but
  // publishedAt is set" (its published:false branch always yields empty
  // flags, matching a plain draft that's never been touched at all).
  const tombstonedPage = {
    uuid: "Page.tombstone",
    name: "Retracted entry",
    type: "text",
    text: { content: "<p>oops</p>" },
    flags: { [NS]: { published: false, publishedAt: 100, updatedAt: 200 } },
  };

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [tombstonedPage],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].posts.length, 1);
    const post = payload.journals[0].posts[0];
    assert.equal(post.title, "Retracted entry");
    assert.equal(post.unpublished, true);
    assert.equal(post.publishedAt, 100);
    assert.equal(post.updatedAt, 200);
  });
});

test("a page that's never been published at all is excluded, not tombstoned", async () => {
  const { collectJournalData } = await import("./collector.js");

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [fakePage({ uuid: "Page.1", name: "Draft entry", published: false })],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].posts.length, 0);
  });
});

test("a currently-published page has unpublished: false", async () => {
  const { collectJournalData } = await import("./collector.js");

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [fakePage({ uuid: "Page.1", name: "Live entry", published: true, publishedAt: 1, updatedAt: 1 })],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].posts[0].unpublished, false);
  });
});

test("an image page is collected with its src rendered as an <img>", async () => {
  const { collectJournalData } = await import("./collector.js");

  const imagePage = {
    uuid: "Page.image",
    name: "Handout: the sealed letter",
    type: "image",
    src: "worlds/test-world/assets/letter.png",
    image: {},
    flags: { [NS]: { published: true, publishedAt: 100, updatedAt: 100 } },
  };

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [imagePage],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].posts.length, 1);
    assert.equal(
      payload.journals[0].posts[0].html,
      `<img src="${resolved("worlds/test-world/assets/letter.png")}" alt="">`,
    );
  });
});

test("an image page with a caption is wrapped in <figure>/<figcaption>", async () => {
  const { collectJournalData } = await import("./collector.js");

  const imagePage = {
    uuid: "Page.image",
    name: "Handout: the sealed letter",
    type: "image",
    src: "worlds/test-world/assets/letter.png",
    image: { caption: "A wax-sealed letter, addressed to no one" },
    flags: { [NS]: { published: true, publishedAt: 100, updatedAt: 100 } },
  };

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [imagePage],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    const html = payload.journals[0].posts[0].html;
    assert.equal(
      html,
      `<figure><img src="${resolved("worlds/test-world/assets/letter.png")}" alt="A wax-sealed letter, addressed to no one"><figcaption>A wax-sealed letter, addressed to no one</figcaption></figure>`,
    );
  });
});

test("an <img> pasted directly into a text page's body has its Foundry-relative src resolved to an absolute URL", async () => {
  const { collectJournalData } = await import("./collector.js");

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [
      fakePage({
        uuid: "Page.1",
        name: "Post",
        published: true,
        publishedAt: 1,
        updatedAt: 1,
        html: '<p>Look:</p><img src="systems/dnd5e/icons/svg/actors/character.svg">',
      }),
    ],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(
      payload.journals[0].posts[0].html,
      `<p>Look:</p><img src="${resolved("systems/dnd5e/icons/svg/actors/character.svg")}">`,
    );
  });
});

test("an already-absolute <img src> (e.g. Forge-hosted module art) is left completely untouched", async () => {
  const { collectJournalData } = await import("./collector.js");

  const forgeUrl = "https://assets.forge-vtt.com/some-id/Tokens/felix.webp";
  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [
      fakePage({
        uuid: "Page.1",
        name: "Post",
        published: true,
        publishedAt: 1,
        updatedAt: 1,
        html: `<img src="${forgeUrl}">`,
      }),
    ],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].posts[0].html, `<img src="${forgeUrl}">`);
  });
});

test("an already-absolute author image URL is left untouched, not mangled into a nested URL", async () => {
  const { collectJournalData } = await import("./collector.js");

  const npc = { name: "Old Man Willow", img: "https://assets.forge-vtt.com/some-id/willow.webp" };
  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "The Grove's Journal",
    config: { published: true, authorActorUuid: "Actor.willow123" },
    pages: [],
  });

  await withMockFoundry(
    { journalEntries: [journal], users: [], actorsByUuid: { "Actor.willow123": npc } },
    async () => {
      const payload = await collectJournalData();
      assert.equal(payload.journals[0].author.image, "https://assets.forge-vtt.com/some-id/willow.webp");
    },
  );
});

test("a pdf or video page is excluded entirely, even if flagged published (no publish path exists for these types)", async () => {
  const { collectJournalData } = await import("./collector.js");

  const pdfPage = {
    uuid: "Page.pdf",
    name: "Handout: the treaty",
    type: "pdf",
    src: "worlds/test-world/assets/treaty.pdf",
    flags: { [NS]: { published: true, publishedAt: 100, updatedAt: 100 } },
  };
  const videoPage = {
    uuid: "Page.video",
    name: "Recap clip",
    type: "video",
    src: "worlds/test-world/assets/recap.webm",
    flags: { [NS]: { published: true, publishedAt: 100, updatedAt: 100 } },
  };

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [pdfPage, videoPage],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].posts.length, 0);
  });
});

test("isPageTypePublishable: text and image are publishable, everything else isn't", async () => {
  const { isPageTypePublishable } = await import("./collector.js");

  assert.equal(isPageTypePublishable({ type: "text" }), true);
  assert.equal(isPageTypePublishable({ type: "image" }), true);
  assert.equal(isPageTypePublishable({ type: "pdf" }), false);
  assert.equal(isPageTypePublishable({ type: "video" }), false);
  assert.equal(isPageTypePublishable({ type: "some-system-custom-type" }), false);
});

test("only entries explicitly marked published are collected as journals", async () => {
  const { collectJournalData } = await import("./collector.js");

  const published = fakeJournalEntry({ uuid: "JournalEntry.pub", name: "Published", config: { published: true }, pages: [] });
  const unpublished = fakeJournalEntry({ uuid: "JournalEntry.unpub", name: "Not yet", config: { published: false }, pages: [] });
  const unconfigured = fakeJournalEntry({ uuid: "JournalEntry.none", name: "Untouched", config: {}, pages: [] });

  await withMockFoundry({ journalEntries: [published, unpublished, unconfigured], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journalCount, 1);
    assert.equal(payload.journals[0].uuid, "JournalEntry.pub");
  });
});

test("collectJournalData({scopedToCaller: true}) only includes entries the current user owns", async () => {
  const { collectJournalData } = await import("./collector.js");

  const owned = fakeJournalEntry({
    uuid: "JournalEntry.mine",
    name: "My Journal",
    config: { published: true },
    isOwner: true,
    pages: [],
  });
  const notOwned = fakeJournalEntry({
    uuid: "JournalEntry.theirs",
    name: "Someone Else's Journal",
    config: { published: true },
    isOwner: false,
    pages: [],
  });

  await withMockFoundry({ journalEntries: [owned, notOwned], users: [] }, async () => {
    const unscoped = await collectJournalData();
    assert.equal(unscoped.journalCount, 2);

    const scoped = await collectJournalData({ scopedToCaller: true });
    assert.equal(scoped.journalCount, 1);
    assert.equal(scoped.journals[0].uuid, "JournalEntry.mine");
  });
});

test("an entry with published:true but no publishedAt at all is excluded (isPublishable is publishedAt-only, no legacy fallback)", async () => {
  const { collectJournalData } = await import("./collector.js");

  // Not fakeJournalEntry() -- its published:true auto-stamps publishedAt,
  // which is exactly what this test needs to NOT have. This shape can't
  // actually arise from openJournalConfigDialog's save handler (it always
  // stamps publishedAt in the same save that first sets published:true),
  // so this only documents the deliberate choice not to special-case it.
  const noPublishedAt = {
    uuid: "JournalEntry.a",
    name: "A",
    folder: null,
    ownership: {},
    pages: { contents: [] },
    flags: { [NS]: { published: true } },
  };

  await withMockFoundry({ journalEntries: [noPublishedAt], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journalCount, 0);
  });
});

test("author resolves by default to the first non-GM user with Owner permission, using their character", async () => {
  const { collectJournalData } = await import("./collector.js");

  const gm = fakeUser({ id: "gmUser", isGM: true, name: "GM" });
  const player = fakeUser({
    id: "player1",
    isGM: false,
    name: "Alice",
    character: { name: "Thoric", img: "portraits/thoric.png" },
  });

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true },
    ownership: { default: 0, gmUser: 3, player1: 3 },
    pages: [fakePage({ uuid: "Page.1", name: "Post", published: true, publishedAt: 1, updatedAt: 1 })],
  });

  await withMockFoundry({ journalEntries: [journal], users: [gm, player] }, async () => {
    const payload = await collectJournalData();
    const author = payload.journals[0].author;
    assert.equal(author.isGM, false);
    assert.equal(author.name, "Thoric");
    assert.equal(author.image, resolved("portraits/thoric.png"));
    // No .system on this fake character, and no systemId stubbed -- no
    // extractor exists to find a biography with, so "" (never null).
    assert.equal(author.bio, "");
  });
});

test("author falls back to Game Master when no non-GM owner exists", async () => {
  const { collectJournalData } = await import("./collector.js");

  const gm = fakeUser({ id: "gmUser", isGM: true, name: "GM" });
  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "GM Session Log",
    config: { published: true },
    ownership: { default: 0, gmUser: 3 },
    pages: [fakePage({ uuid: "Page.1", name: "Post", published: true, publishedAt: 1, updatedAt: 1 })],
  });

  await withMockFoundry({ journalEntries: [journal], users: [gm] }, async () => {
    const payload = await collectJournalData();
    assert.deepEqual(payload.journals[0].author, {
      userId: null,
      name: "Game Master",
      image: null,
      isGM: true,
      bio: "",
    });
  });
});

test("an explicit manual author override replaces the computed default entirely, with no biography", async () => {
  const { collectJournalData } = await import("./collector.js");

  const player = fakeUser({
    id: "player1",
    isGM: false,
    name: "Alice",
    character: { name: "Thoric", img: "portraits/thoric.png" },
  });

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Journal",
    config: { published: true, authorName: "The Chronicler", authorImage: "art/chronicler.png" },
    ownership: { default: 0, player1: 3 },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [journal], users: [player] }, async () => {
    const payload = await collectJournalData();
    assert.deepEqual(payload.journals[0].author, {
      userId: null,
      name: "The Chronicler",
      image: resolved("art/chronicler.png"),
      isGM: false,
      bio: "",
    });
  });
});

test("an explicit Actor override authors as that Actor, pulling name/image/biography from it", async () => {
  const { collectJournalData } = await import("./collector.js");

  const npc = {
    name: "Old Man Willow",
    img: "actors/willow.png",
    system: { details: { biography: { value: "<p>Keeper of the grove.</p>" } } },
  };

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "The Grove's Journal",
    config: { published: true, authorActorUuid: "Actor.willow123" },
    pages: [],
  });

  await withMockFoundry(
    { journalEntries: [journal], users: [], systemId: "dnd5e", actorsByUuid: { "Actor.willow123": npc } },
    async () => {
      const payload = await collectJournalData();
      assert.deepEqual(payload.journals[0].author, {
        userId: null,
        name: "Old Man Willow",
        image: resolved("actors/willow.png"),
        isGM: false,
        bio: "<p>Keeper of the grove.</p>",
      });
    },
  );
});

test("an Actor override wins outright over manual authorName/authorImage text overrides", async () => {
  const { collectJournalData } = await import("./collector.js");

  const npc = { name: "Old Man Willow", img: "actors/willow.png" };
  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "The Grove's Journal",
    config: {
      published: true,
      authorActorUuid: "Actor.willow123",
      authorName: "Should Be Ignored",
      authorImage: "should/be-ignored.png",
    },
    pages: [],
  });

  await withMockFoundry(
    { journalEntries: [journal], users: [], actorsByUuid: { "Actor.willow123": npc } },
    async () => {
      const payload = await collectJournalData();
      assert.equal(payload.journals[0].author.name, "Old Man Willow");
      assert.equal(payload.journals[0].author.image, resolved("actors/willow.png"));
    },
  );
});

test("a stale/invalid authorActorUuid falls through to the next tier instead of erroring", async () => {
  const { collectJournalData } = await import("./collector.js");

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Journal",
    config: { published: true, authorActorUuid: "Actor.deleted", authorName: "Fallback Name" },
    pages: [],
  });

  // actorsByUuid deliberately doesn't include "Actor.deleted" -- fromUuidSync
  // mock returns null, same as a real deleted/invalid Actor reference.
  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].author.name, "Fallback Name");
    assert.equal(payload.journals[0].author.bio, "");
  });
});

test("the default (non-override) owner's-character path also pulls a biography when one exists", async () => {
  const { collectJournalData } = await import("./collector.js");

  const player = fakeUser({
    id: "player1",
    isGM: false,
    name: "Alice",
    character: {
      name: "Thoric",
      img: "portraits/thoric.png",
      system: { details: { biography: { value: "<p>A dwarf far from home.</p>" } } },
    },
  });

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true },
    ownership: { default: 0, player1: 3 },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [journal], users: [player], systemId: "dnd5e" }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].author.bio, "<p>A dwarf far from home.</p>");
  });
});

test("root defaults to the hierarchical folder path, root-first", async () => {
  const { collectJournalData } = await import("./collector.js");

  const root = fakeFolder({ id: "f1", name: "Campaign" });
  const child = fakeFolder({ id: "f2", name: "Arc 1", parent: root });

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Journal",
    folder: child,
    config: { published: true },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].root, "Campaign/Arc 1");
  });
});

test("root is null when the entry has no folder and no override", async () => {
  const { collectJournalData } = await import("./collector.js");

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Journal",
    folder: null,
    config: { published: true },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].root, null);
  });
});

test("an explicit root override replaces the folder-derived default", async () => {
  const { collectJournalData } = await import("./collector.js");

  const folder = fakeFolder({ id: "f1", name: "Session Notes" });
  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Journal",
    folder,
    config: { published: true, root: "Side Quests" },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].root, "Side Quests");
  });
});

test("tags default to empty and otherwise pass through, trimmed and filtered", async () => {
  const { collectJournalData } = await import("./collector.js");

  const untagged = fakeJournalEntry({ uuid: "JournalEntry.a", name: "A", config: { published: true }, pages: [] });
  const tagged = fakeJournalEntry({
    uuid: "JournalEntry.b",
    name: "B",
    config: { published: true, tags: [" heist ", "waterdeep", "", "  "] },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [untagged, tagged], users: [] }, async () => {
    const payload = await collectJournalData();
    const byUuid = Object.fromEntries(payload.journals.map((b) => [b.uuid, b]));
    assert.deepEqual(byUuid["JournalEntry.a"].tags, []);
    assert.deepEqual(byUuid["JournalEntry.b"].tags, ["heist", "waterdeep"]);
  });
});

test("unchecking a journal's own 'published' flag tombstones every one of its pages, even ones still individually marked published", async () => {
  const { collectJournalData } = await import("./collector.js");

  const stillFlaggedPublished = fakePage({
    uuid: "Page.1",
    name: "Session 1",
    published: true,
    publishedAt: 100,
    updatedAt: 100,
  });

  // The entry was published at some point (publishedAt is set, sticky) but
  // has since been turned off (published: false) -- this is exactly what
  // unchecking "Publish this journal to the web" produces.
  const entry = fakeJournalEntry({
    uuid: "JournalEntry.a",
    name: "Talos Journal",
    config: { published: false, publishedAt: 100 },
    pages: [stillFlaggedPublished],
  });

  await withMockFoundry({ journalEntries: [entry], users: [] }, async () => {
    const payload = await collectJournalData();
    // Collected -- not silently dropped, which would orphan the page's
    // already-live file on GitHub forever (no delete step exists).
    assert.equal(payload.journalCount, 1);
    assert.equal(payload.journals[0].posts.length, 1);
    // Tombstoned, despite the page's own flags still saying published:true.
    assert.equal(payload.journals[0].posts[0].unpublished, true);
  });
});

test("a journal that's currently published collects its pages normally (not force-tombstoned)", async () => {
  const { collectJournalData } = await import("./collector.js");

  const entry = fakeJournalEntry({
    uuid: "JournalEntry.a",
    name: "Talos Journal",
    config: { published: true },
    pages: [fakePage({ uuid: "Page.1", name: "Session 1", published: true, publishedAt: 100, updatedAt: 100 })],
  });

  await withMockFoundry({ journalEntries: [entry], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].posts[0].unpublished, false);
  });
});

test("an entry that was never published at all (no publishedAt ever stamped) is excluded entirely, same as before", async () => {
  const { collectJournalData } = await import("./collector.js");

  const entry = fakeJournalEntry({
    uuid: "JournalEntry.a",
    name: "Never touched",
    config: { published: false },
    pages: [fakePage({ uuid: "Page.1", name: "Draft", published: true, publishedAt: 100, updatedAt: 100 })],
  });

  await withMockFoundry({ journalEntries: [entry], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journalCount, 0);
  });
});

test("postOrder defaults to 'manual' and otherwise passes through an explicit 'newest' or 'oldest'", async () => {
  const { collectJournalData } = await import("./collector.js");

  const defaulted = fakeJournalEntry({ uuid: "JournalEntry.a", name: "A", config: { published: true }, pages: [] });
  const newest = fakeJournalEntry({
    uuid: "JournalEntry.b",
    name: "B",
    config: { published: true, postOrder: "newest" },
    pages: [],
  });
  const oldest = fakeJournalEntry({
    uuid: "JournalEntry.c",
    name: "C",
    config: { published: true, postOrder: "oldest" },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [defaulted, newest, oldest], users: [] }, async () => {
    const payload = await collectJournalData();
    const byUuid = Object.fromEntries(payload.journals.map((b) => [b.uuid, b]));
    assert.equal(byUuid["JournalEntry.a"].postOrder, "manual");
    assert.equal(byUuid["JournalEntry.b"].postOrder, "newest");
    assert.equal(byUuid["JournalEntry.c"].postOrder, "oldest");
  });
});

test("a post's sortIndex comes from Foundry's own page.sort, collected regardless of postOrder", async () => {
  const { collectJournalData } = await import("./collector.js");

  const page = fakePage({ uuid: "Page.1", name: "Session 1", published: true, publishedAt: 100, updatedAt: 100 });
  page.sort = 300000;

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.a",
    name: "A",
    config: { published: true },
    pages: [page],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].posts[0].sortIndex, 300000);
  });
});

test("sortIndex defaults to 0 when a page has no sort field at all", async () => {
  const { collectJournalData } = await import("./collector.js");

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.a",
    name: "A",
    config: { published: true },
    pages: [fakePage({ uuid: "Page.1", name: "Session 1", published: true, publishedAt: 100, updatedAt: 100 })],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].posts[0].sortIndex, 0);
  });
});

test("postOrder falls back to 'manual' for any unrecognized value", async () => {
  const { collectJournalData } = await import("./collector.js");

  const bogus = fakeJournalEntry({
    uuid: "JournalEntry.a",
    name: "A",
    config: { published: true, postOrder: "sideways" },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [bogus], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].postOrder, "manual");
  });
});

test("posts are sorted chronologically by publishedAt", async () => {
  const { collectJournalData } = await import("./collector.js");

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Journal",
    config: { published: true },
    pages: [
      fakePage({ uuid: "Page.later", name: "Later", published: true, publishedAt: 200, updatedAt: 200 }),
      fakePage({ uuid: "Page.earlier", name: "Earlier", published: true, publishedAt: 100, updatedAt: 100 }),
    ],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.deepEqual(
      payload.journals[0].posts.map((p) => p.title),
      ["Earlier", "Later"],
    );
  });
});

test("a post with no override inherits its journal's author and tags unchanged", async () => {
  const { collectJournalData } = await import("./collector.js");

  const player = fakeUser({
    id: "player1",
    isGM: false,
    name: "Alice",
    character: { name: "Thoric", img: "portraits/thoric.png" },
  });

  const page = {
    uuid: "Page.1",
    name: "Post",
    type: "text",
    text: { content: "<p>hi</p>" },
    flags: { [NS]: { published: true, publishedAt: 1, updatedAt: 1 } },
  };

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true, tags: ["campaign"] },
    ownership: { default: 0, player1: 3 },
    pages: [page],
  });

  await withMockFoundry({ journalEntries: [journal], users: [player] }, async () => {
    const payload = await collectJournalData();
    const post = payload.journals[0].posts[0];
    assert.equal(post.author.name, "Thoric");
    assert.equal(post.author.image, resolved("portraits/thoric.png"));
    assert.deepEqual(post.tags, ["campaign"]);
  });
});

test("a post with its own Actor-UUID author override replaces the journal's author for that post only", async () => {
  const { collectJournalData } = await import("./collector.js");

  const player = fakeUser({
    id: "player1",
    isGM: false,
    name: "Alice",
    character: { name: "Thoric", img: "portraits/thoric.png" },
  });

  const overriddenPage = {
    uuid: "Page.1",
    name: "Guest post",
    type: "text",
    text: { content: "<p>hi</p>" },
    flags: { [NS]: { published: true, publishedAt: 1, updatedAt: 1, authorActorUuid: "Actor.willow123" } },
  };
  const plainPage = {
    uuid: "Page.2",
    name: "Regular post",
    type: "text",
    text: { content: "<p>hi</p>" },
    flags: { [NS]: { published: true, publishedAt: 2, updatedAt: 2 } },
  };

  const npc = { name: "Old Man Willow", img: "actors/willow.png" };
  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Thoric's Journal",
    config: { published: true },
    ownership: { default: 0, player1: 3 },
    pages: [overriddenPage, plainPage],
  });

  await withMockFoundry(
    { journalEntries: [journal], users: [player], actorsByUuid: { "Actor.willow123": npc } },
    async () => {
      const payload = await collectJournalData();
      const byUuid = Object.fromEntries(payload.journals[0].posts.map((p) => [p.uuid, p]));
      assert.equal(byUuid["Page.1"].author.name, "Old Man Willow");
      assert.equal(byUuid["Page.2"].author.name, "Thoric");
    },
  );
});

test("a post with its own manual authorName/authorImage override uses that, with no biography", async () => {
  const { collectJournalData } = await import("./collector.js");

  const page = {
    uuid: "Page.1",
    name: "Post",
    type: "text",
    text: { content: "<p>hi</p>" },
    flags: {
      [NS]: {
        published: true,
        publishedAt: 1,
        updatedAt: 1,
        authorName: "Guest Chronicler",
        authorImage: "art/guest.png",
      },
    },
  };

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Journal",
    config: { published: true },
    pages: [page],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    const author = payload.journals[0].posts[0].author;
    assert.equal(author.name, "Guest Chronicler");
    assert.equal(author.image, resolved("art/guest.png"));
    assert.equal(author.bio, "");
  });
});

test("a post's own tags fully replace the journal's tags, not merge with them", async () => {
  const { collectJournalData } = await import("./collector.js");

  const page = {
    uuid: "Page.1",
    name: "Post",
    type: "text",
    text: { content: "<p>hi</p>" },
    flags: { [NS]: { published: true, publishedAt: 1, updatedAt: 1, tags: ["spooky", "npc"] } },
  };

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Journal",
    config: { published: true, tags: ["campaign"] },
    pages: [page],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.deepEqual(payload.journals[0].posts[0].tags, ["spooky", "npc"]);
  });
});

test("a post with a blank/empty tags override still inherits the journal's tags, rather than having none", async () => {
  const { collectJournalData } = await import("./collector.js");

  const page = {
    uuid: "Page.1",
    name: "Post",
    type: "text",
    text: { content: "<p>hi</p>" },
    flags: { [NS]: { published: true, publishedAt: 1, updatedAt: 1, tags: ["  ", ""] } },
  };

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Journal",
    config: { published: true, tags: ["campaign"] },
    pages: [page],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.deepEqual(payload.journals[0].posts[0].tags, ["campaign"]);
  });
});

test("a post's frontImage is '' when unset", async () => {
  const { collectJournalData } = await import("./collector.js");

  const page = {
    uuid: "Page.1",
    name: "Post",
    type: "text",
    text: { content: "<p>hi</p>" },
    flags: { [NS]: { published: true, publishedAt: 1, updatedAt: 1 } },
  };

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Journal",
    config: { published: true },
    pages: [page],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].posts[0].frontImage, "");
  });
});

test("a post's frontImage resolves a Foundry-relative path to an absolute URL, and leaves an already-absolute one untouched", async () => {
  const { collectJournalData } = await import("./collector.js");

  const relativePage = {
    uuid: "Page.1",
    name: "Post A",
    type: "text",
    text: { content: "<p>hi</p>" },
    flags: { [NS]: { published: true, publishedAt: 1, updatedAt: 1, frontImage: "worlds/test-world/assets/cover.png" } },
  };
  const absolutePage = {
    uuid: "Page.2",
    name: "Post B",
    type: "text",
    text: { content: "<p>hi</p>" },
    flags: {
      [NS]: {
        published: true,
        publishedAt: 2,
        updatedAt: 2,
        frontImage: "https://assets.forge-vtt.com/some-id/cover.webp",
      },
    },
  };

  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Journal",
    config: { published: true },
    pages: [relativePage, absolutePage],
  });

  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    const byUuid = Object.fromEntries(payload.journals[0].posts.map((p) => [p.uuid, p]));
    assert.equal(byUuid["Page.1"].frontImage, resolved("worlds/test-world/assets/cover.png"));
    assert.equal(byUuid["Page.2"].frontImage, "https://assets.forge-vtt.com/some-id/cover.webp");
  });
});

test("resolveRelativeUuids: a sibling-page link (.pageId) becomes an absolute page UUID", async () => {
  const { resolveRelativeUuids } = await import("./collector.js");
  const html = "<p>See @UUID[.YJgINFmlwzaLHjbo]{Module Setup}.</p>";
  assert.equal(
    resolveRelativeUuids(html, "JournalEntry.abc.JournalEntryPage.p1"),
    "<p>See @UUID[JournalEntry.abc.JournalEntryPage.YJgINFmlwzaLHjbo]{Module Setup}.</p>",
  );
});

test("resolveRelativeUuids: an even-part relative link resolves against the page itself, as Foundry does", async () => {
  const { resolveRelativeUuids } = await import("./collector.js");
  // Foundry reads this as something embedded in page p1 (so it's a broken
  // link there); the site has to agree rather than turn it into a link to p2.
  assert.equal(
    resolveRelativeUuids("@UUID[.JournalEntryPage.p2]", "JournalEntry.abc.JournalEntryPage.p1"),
    "@UUID[JournalEntry.abc.JournalEntryPage.p1.JournalEntryPage.p2]",
  );
});

test("resolveRelativeUuids: works for a compendium page, keeping the Compendium prefix", async () => {
  const { resolveRelativeUuids } = await import("./collector.js");
  assert.equal(
    resolveRelativeUuids(
      "@UUID[.p2]{Two}",
      "Compendium.world2web.documentation.JournalEntry.abc.JournalEntryPage.p1",
    ),
    "@UUID[Compendium.world2web.documentation.JournalEntry.abc.JournalEntryPage.p2]{Two}",
  );
});

test("resolveRelativeUuids: absolute links, and pages with no resolvable parent, are left untouched", async () => {
  const { resolveRelativeUuids } = await import("./collector.js");
  const abs = "@UUID[JournalEntry.x.JournalEntryPage.y]{Y}";
  assert.equal(resolveRelativeUuids(abs, "JournalEntry.abc.JournalEntryPage.p1"), abs);
  assert.equal(resolveRelativeUuids("@UUID[.p2]", "Page.1"), "@UUID[.p2]");
});

test("a relative @UUID link in a published text page is made absolute in the collected html", async () => {
  const { collectJournalData } = await import("./collector.js");
  const journal = fakeJournalEntry({
    uuid: "JournalEntry.journalA",
    name: "Docs",
    config: { published: true },
    pages: [
      fakePage({
        uuid: "JournalEntry.journalA.JournalEntryPage.p1",
        name: "Post",
        published: true,
        publishedAt: 1,
        updatedAt: 1,
        html: "<p>@UUID[.p2]{Other}</p>",
      }),
    ],
  });
  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const payload = await collectJournalData();
    assert.equal(payload.journals[0].posts[0].html, "<p>@UUID[JournalEntry.journalA.JournalEntryPage.p2]{Other}</p>");
  });
});

test("journal homepage mode: defaults to 'none', passes 'above'/'replace' through, rejects anything else", async () => {
  const { collectJournalData } = await import("./collector.js");
  const page = () =>
    fakePage({ uuid: `JournalEntry.j.JournalEntryPage.${Math.random()}`, name: "P", published: true, publishedAt: 1, updatedAt: 1 });
  const journals = [
    fakeJournalEntry({ uuid: "JournalEntry.a", name: "A", config: { published: true }, pages: [page()] }),
    fakeJournalEntry({ uuid: "JournalEntry.b", name: "B", config: { published: true, homepage: "above" }, pages: [page()] }),
    fakeJournalEntry({ uuid: "JournalEntry.c", name: "C", config: { published: true, homepage: "replace" }, pages: [page()] }),
    fakeJournalEntry({ uuid: "JournalEntry.d", name: "D", config: { published: true, homepage: "bogus" }, pages: [page()] }),
  ];
  await withMockFoundry({ journalEntries: journals, users: [] }, async () => {
    const payload = await collectJournalData();
    const byTitle = Object.fromEntries(payload.journals.map((j) => [j.title, j.homepage]));
    assert.deepEqual(byTitle, { A: "none", B: "above", C: "replace", D: "none" });
  });
});

test("checkHomepageLink: accepts http(s) links, trims spaces, and uses the address when there's no name", async () => {
  const { checkHomepageLink } = await import("./collector.js");
  assert.deepEqual(checkHomepageLink({ label: "  Discord ", href: " https://discord.gg/abc " }), {
    ok: true,
    link: { label: "Discord", href: "https://discord.gg/abc" },
  });
  assert.deepEqual(checkHomepageLink({ label: "", href: "https://example.com" }), {
    ok: true,
    link: { label: "https://example.com/", href: "https://example.com/" },
  });
});

test("checkHomepageLink: empty rows are skipped, anything but an http(s) address is invalid", async () => {
  const { checkHomepageLink } = await import("./collector.js");
  assert.deepEqual(checkHomepageLink({ label: " ", href: "" }), { ok: false, reason: "empty" });
  for (const href of ["example.com", "javascript:alert(1)", "file:///etc/passwd", ""]) {
    assert.deepEqual(checkHomepageLink({ label: "X", href }), { ok: false, reason: "invalid" }, href);
  }
});

test("normalizeHomepageLinks: keeps only valid links, at most 10, and never throws", async () => {
  const { normalizeHomepageLinks } = await import("./collector.js");
  assert.deepEqual(normalizeHomepageLinks([{ label: "A", href: "https://a.example" }, { label: "B", href: "bad" }]), [
    { label: "A", href: "https://a.example/" },
  ]);
  const many = Array.from({ length: 15 }, (_, i) => ({ label: `L${i}`, href: `https://example.com/${i}` }));
  assert.equal(normalizeHomepageLinks(many).length, 10);
  for (const junk of [null, undefined, "https://example.com", {}, 7]) assert.deepEqual(normalizeHomepageLinks(junk), []);
});

test("a published text page's unrevealed secret blocks never reach the payload", async () => {
  const { collectJournalData } = await import("./collector.js");
  const journal = fakeJournalEntry({
    uuid: "JournalEntry.j",
    name: "Notes",
    config: { published: true },
    pages: [
      fakePage({
        uuid: "JournalEntry.j.JournalEntryPage.p",
        name: "Inn",
        published: true,
        publishedAt: 1,
        updatedAt: 1,
        html: '<p>The inn.</p><section class="secret" id="secret-1"><p>The innkeeper is a vampire.</p></section><section class="secret revealed" id="secret-2"><p>Revealed clue.</p></section>',
      }),
    ],
  });
  await withMockFoundry({ journalEntries: [journal], users: [] }, async () => {
    const html = (await collectJournalData()).journals[0].posts[0].html;
    assert.ok(!html.includes("vampire"), "unrevealed secret removed");
    assert.ok(html.includes("Revealed clue."), "revealed secret kept");
    assert.ok(html.includes("<p>The inn.</p>"));
  });
});
