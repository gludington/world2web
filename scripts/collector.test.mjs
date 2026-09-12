// Run with: node --test scripts/collector.test.mjs
//
// collectBlogData() only touches Foundry globals (game, CONST), so it's
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

function fakeBlogEntry({ uuid, name, folder = null, ownership = {}, pages = [], config = {}, isOwner = false }) {
  // published:true with no explicit publishedAt mirrors what
  // openBlogConfigDialog's save handler actually does on a first-ever
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
    // Plain property, not a real Foundry getter -- collectBlogData's
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

test("collectBlogData includes site config (theme/siteName/blogsSegment/allowThemeOverride) so the ingest script can write it without a live game.settings", async () => {
  const { collectBlogData } = await import("./collector.js");

  await withMockFoundry(
    {
      journalEntries: [],
      users: [],
      settings: {
        siteTheme: "parchment",
        siteName: "The Ashwood Chronicle",
        blogsSegment: "chronicles",
        allowThemeOverride: true,
      },
    },
    async () => {
      const payload = await collectBlogData();
      assert.deepEqual(payload.siteConfig, {
        theme: "parchment",
        siteName: "The Ashwood Chronicle",
        blogsSegment: "chronicles",
        allowThemeOverride: true,
      });
    },
  );
});

test("site config defaults to 'default' theme, 'World2Web' name, 'journals' segment, and allowThemeOverride: false when unset", async () => {
  const { collectBlogData } = await import("./collector.js");

  await withMockFoundry({ journalEntries: [], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.deepEqual(payload.siteConfig, {
      theme: "default",
      siteName: "World2Web",
      blogsSegment: "journals",
      allowThemeOverride: false,
    });
  });
});

test("published pages become posts; drafts are excluded", async () => {
  const { collectBlogData } = await import("./collector.js");

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [
      fakePage({ uuid: "Page.1", name: "Draft entry", published: false }),
      fakePage({ uuid: "Page.2", name: "Published entry", published: true, publishedAt: 100, updatedAt: 100 }),
    ],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogCount, 1);
    assert.equal(payload.blogs[0].postCount, 1);
    assert.equal(payload.blogs[0].posts[0].title, "Published entry");
  });
});

test("a previously-published, now-unpublished page is still collected, tombstoned with unpublished: true", async () => {
  const { collectBlogData } = await import("./collector.js");

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

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [tombstonedPage],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].posts.length, 1);
    const post = payload.blogs[0].posts[0];
    assert.equal(post.title, "Retracted entry");
    assert.equal(post.unpublished, true);
    assert.equal(post.publishedAt, 100);
    assert.equal(post.updatedAt, 200);
  });
});

test("a page that's never been published at all is excluded, not tombstoned", async () => {
  const { collectBlogData } = await import("./collector.js");

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [fakePage({ uuid: "Page.1", name: "Draft entry", published: false })],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].posts.length, 0);
  });
});

test("a currently-published page has unpublished: false", async () => {
  const { collectBlogData } = await import("./collector.js");

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [fakePage({ uuid: "Page.1", name: "Live entry", published: true, publishedAt: 1, updatedAt: 1 })],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].posts[0].unpublished, false);
  });
});

test("an image page is collected with its src rendered as an <img>", async () => {
  const { collectBlogData } = await import("./collector.js");

  const imagePage = {
    uuid: "Page.image",
    name: "Handout: the sealed letter",
    type: "image",
    src: "worlds/test-world/assets/letter.png",
    image: {},
    flags: { [NS]: { published: true, publishedAt: 100, updatedAt: 100 } },
  };

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [imagePage],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].posts.length, 1);
    assert.equal(
      payload.blogs[0].posts[0].html,
      `<img src="${resolved("worlds/test-world/assets/letter.png")}" alt="">`,
    );
  });
});

test("an image page with a caption is wrapped in <figure>/<figcaption>", async () => {
  const { collectBlogData } = await import("./collector.js");

  const imagePage = {
    uuid: "Page.image",
    name: "Handout: the sealed letter",
    type: "image",
    src: "worlds/test-world/assets/letter.png",
    image: { caption: "A wax-sealed letter, addressed to no one" },
    flags: { [NS]: { published: true, publishedAt: 100, updatedAt: 100 } },
  };

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [imagePage],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    const html = payload.blogs[0].posts[0].html;
    assert.equal(
      html,
      `<figure><img src="${resolved("worlds/test-world/assets/letter.png")}" alt="A wax-sealed letter, addressed to no one"><figcaption>A wax-sealed letter, addressed to no one</figcaption></figure>`,
    );
  });
});

test("an <img> pasted directly into a text page's body has its Foundry-relative src resolved to an absolute URL", async () => {
  const { collectBlogData } = await import("./collector.js");

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
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

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(
      payload.blogs[0].posts[0].html,
      `<p>Look:</p><img src="${resolved("systems/dnd5e/icons/svg/actors/character.svg")}">`,
    );
  });
});

test("an already-absolute <img src> (e.g. Forge-hosted module art) is left completely untouched", async () => {
  const { collectBlogData } = await import("./collector.js");

  const forgeUrl = "https://assets.forge-vtt.com/some-id/Tokens/felix.webp";
  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
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

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].posts[0].html, `<img src="${forgeUrl}">`);
  });
});

test("an already-absolute author image URL is left untouched, not mangled into a nested URL", async () => {
  const { collectBlogData } = await import("./collector.js");

  const npc = { name: "Old Man Willow", img: "https://assets.forge-vtt.com/some-id/willow.webp" };
  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "The Grove's Journal",
    config: { published: true, authorActorUuid: "Actor.willow123" },
    pages: [],
  });

  await withMockFoundry(
    { journalEntries: [blog], users: [], actorsByUuid: { "Actor.willow123": npc } },
    async () => {
      const payload = await collectBlogData();
      assert.equal(payload.blogs[0].author.image, "https://assets.forge-vtt.com/some-id/willow.webp");
    },
  );
});

test("a pdf or video page is excluded entirely, even if flagged published (no publish path exists for these types)", async () => {
  const { collectBlogData } = await import("./collector.js");

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

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Thoric's Journal",
    config: { published: true },
    pages: [pdfPage, videoPage],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].posts.length, 0);
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

test("only entries explicitly marked published are collected as blogs", async () => {
  const { collectBlogData } = await import("./collector.js");

  const published = fakeBlogEntry({ uuid: "JournalEntry.pub", name: "Published", config: { published: true }, pages: [] });
  const unpublished = fakeBlogEntry({ uuid: "JournalEntry.unpub", name: "Not yet", config: { published: false }, pages: [] });
  const unconfigured = fakeBlogEntry({ uuid: "JournalEntry.none", name: "Untouched", config: {}, pages: [] });

  await withMockFoundry({ journalEntries: [published, unpublished, unconfigured], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogCount, 1);
    assert.equal(payload.blogs[0].uuid, "JournalEntry.pub");
  });
});

test("collectBlogData({scopedToCaller: true}) only includes entries the current user owns", async () => {
  const { collectBlogData } = await import("./collector.js");

  const owned = fakeBlogEntry({
    uuid: "JournalEntry.mine",
    name: "My Journal",
    config: { published: true },
    isOwner: true,
    pages: [],
  });
  const notOwned = fakeBlogEntry({
    uuid: "JournalEntry.theirs",
    name: "Someone Else's Journal",
    config: { published: true },
    isOwner: false,
    pages: [],
  });

  await withMockFoundry({ journalEntries: [owned, notOwned], users: [] }, async () => {
    const unscoped = await collectBlogData();
    assert.equal(unscoped.blogCount, 2);

    const scoped = await collectBlogData({ scopedToCaller: true });
    assert.equal(scoped.blogCount, 1);
    assert.equal(scoped.blogs[0].uuid, "JournalEntry.mine");
  });
});

test("an entry with published:true but no publishedAt at all is excluded (isPublishable is publishedAt-only, no legacy fallback)", async () => {
  const { collectBlogData } = await import("./collector.js");

  // Not fakeBlogEntry() -- its published:true auto-stamps publishedAt,
  // which is exactly what this test needs to NOT have. This shape can't
  // actually arise from openBlogConfigDialog's save handler (it always
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
    const payload = await collectBlogData();
    assert.equal(payload.blogCount, 0);
  });
});

test("author resolves by default to the first non-GM user with Owner permission, using their character", async () => {
  const { collectBlogData } = await import("./collector.js");

  const gm = fakeUser({ id: "gmUser", isGM: true, name: "GM" });
  const player = fakeUser({
    id: "player1",
    isGM: false,
    name: "Alice",
    character: { name: "Thoric", img: "portraits/thoric.png" },
  });

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Thoric's Journal",
    config: { published: true },
    ownership: { default: 0, gmUser: 3, player1: 3 },
    pages: [fakePage({ uuid: "Page.1", name: "Post", published: true, publishedAt: 1, updatedAt: 1 })],
  });

  await withMockFoundry({ journalEntries: [blog], users: [gm, player] }, async () => {
    const payload = await collectBlogData();
    const author = payload.blogs[0].author;
    assert.equal(author.isGM, false);
    assert.equal(author.name, "Thoric");
    assert.equal(author.image, resolved("portraits/thoric.png"));
    // No .system on this fake character, and no systemId stubbed -- no
    // extractor exists to find a biography with, so "" (never null).
    assert.equal(author.bio, "");
  });
});

test("author falls back to Game Master when no non-GM owner exists", async () => {
  const { collectBlogData } = await import("./collector.js");

  const gm = fakeUser({ id: "gmUser", isGM: true, name: "GM" });
  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "GM Session Log",
    config: { published: true },
    ownership: { default: 0, gmUser: 3 },
    pages: [fakePage({ uuid: "Page.1", name: "Post", published: true, publishedAt: 1, updatedAt: 1 })],
  });

  await withMockFoundry({ journalEntries: [blog], users: [gm] }, async () => {
    const payload = await collectBlogData();
    assert.deepEqual(payload.blogs[0].author, {
      userId: null,
      name: "Game Master",
      image: null,
      isGM: true,
      bio: "",
    });
  });
});

test("an explicit manual author override replaces the computed default entirely, with no biography", async () => {
  const { collectBlogData } = await import("./collector.js");

  const player = fakeUser({
    id: "player1",
    isGM: false,
    name: "Alice",
    character: { name: "Thoric", img: "portraits/thoric.png" },
  });

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Journal",
    config: { published: true, authorName: "The Chronicler", authorImage: "art/chronicler.png" },
    ownership: { default: 0, player1: 3 },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [blog], users: [player] }, async () => {
    const payload = await collectBlogData();
    assert.deepEqual(payload.blogs[0].author, {
      userId: null,
      name: "The Chronicler",
      image: resolved("art/chronicler.png"),
      isGM: false,
      bio: "",
    });
  });
});

test("an explicit Actor override authors as that Actor, pulling name/image/biography from it", async () => {
  const { collectBlogData } = await import("./collector.js");

  const npc = {
    name: "Old Man Willow",
    img: "actors/willow.png",
    system: { details: { biography: { value: "<p>Keeper of the grove.</p>" } } },
  };

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "The Grove's Journal",
    config: { published: true, authorActorUuid: "Actor.willow123" },
    pages: [],
  });

  await withMockFoundry(
    { journalEntries: [blog], users: [], systemId: "dnd5e", actorsByUuid: { "Actor.willow123": npc } },
    async () => {
      const payload = await collectBlogData();
      assert.deepEqual(payload.blogs[0].author, {
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
  const { collectBlogData } = await import("./collector.js");

  const npc = { name: "Old Man Willow", img: "actors/willow.png" };
  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
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
    { journalEntries: [blog], users: [], actorsByUuid: { "Actor.willow123": npc } },
    async () => {
      const payload = await collectBlogData();
      assert.equal(payload.blogs[0].author.name, "Old Man Willow");
      assert.equal(payload.blogs[0].author.image, resolved("actors/willow.png"));
    },
  );
});

test("a stale/invalid authorActorUuid falls through to the next tier instead of erroring", async () => {
  const { collectBlogData } = await import("./collector.js");

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Journal",
    config: { published: true, authorActorUuid: "Actor.deleted", authorName: "Fallback Name" },
    pages: [],
  });

  // actorsByUuid deliberately doesn't include "Actor.deleted" -- fromUuidSync
  // mock returns null, same as a real deleted/invalid Actor reference.
  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].author.name, "Fallback Name");
    assert.equal(payload.blogs[0].author.bio, "");
  });
});

test("the default (non-override) owner's-character path also pulls a biography when one exists", async () => {
  const { collectBlogData } = await import("./collector.js");

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

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Thoric's Journal",
    config: { published: true },
    ownership: { default: 0, player1: 3 },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [blog], users: [player], systemId: "dnd5e" }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].author.bio, "<p>A dwarf far from home.</p>");
  });
});

test("root defaults to the hierarchical folder path, root-first", async () => {
  const { collectBlogData } = await import("./collector.js");

  const root = fakeFolder({ id: "f1", name: "Campaign" });
  const child = fakeFolder({ id: "f2", name: "Arc 1", parent: root });

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Journal",
    folder: child,
    config: { published: true },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].root, "Campaign/Arc 1");
  });
});

test("root is null when the entry has no folder and no override", async () => {
  const { collectBlogData } = await import("./collector.js");

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Journal",
    folder: null,
    config: { published: true },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].root, null);
  });
});

test("an explicit root override replaces the folder-derived default", async () => {
  const { collectBlogData } = await import("./collector.js");

  const folder = fakeFolder({ id: "f1", name: "Session Notes" });
  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Journal",
    folder,
    config: { published: true, root: "Side Quests" },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].root, "Side Quests");
  });
});

test("tags default to empty and otherwise pass through, trimmed and filtered", async () => {
  const { collectBlogData } = await import("./collector.js");

  const untagged = fakeBlogEntry({ uuid: "JournalEntry.a", name: "A", config: { published: true }, pages: [] });
  const tagged = fakeBlogEntry({
    uuid: "JournalEntry.b",
    name: "B",
    config: { published: true, tags: [" heist ", "waterdeep", "", "  "] },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [untagged, tagged], users: [] }, async () => {
    const payload = await collectBlogData();
    const byUuid = Object.fromEntries(payload.blogs.map((b) => [b.uuid, b]));
    assert.deepEqual(byUuid["JournalEntry.a"].tags, []);
    assert.deepEqual(byUuid["JournalEntry.b"].tags, ["heist", "waterdeep"]);
  });
});

test("unchecking a blog's own 'published' flag tombstones every one of its pages, even ones still individually marked published", async () => {
  const { collectBlogData } = await import("./collector.js");

  const stillFlaggedPublished = fakePage({
    uuid: "Page.1",
    name: "Session 1",
    published: true,
    publishedAt: 100,
    updatedAt: 100,
  });

  // The entry was published at some point (publishedAt is set, sticky) but
  // has since been turned off (published: false) -- this is exactly what
  // unchecking "Publish this journal as a blog" produces.
  const entry = fakeBlogEntry({
    uuid: "JournalEntry.a",
    name: "Talos Journal",
    config: { published: false, publishedAt: 100 },
    pages: [stillFlaggedPublished],
  });

  await withMockFoundry({ journalEntries: [entry], users: [] }, async () => {
    const payload = await collectBlogData();
    // Collected -- not silently dropped, which would orphan the page's
    // already-live file on GitHub forever (no delete step exists).
    assert.equal(payload.blogCount, 1);
    assert.equal(payload.blogs[0].posts.length, 1);
    // Tombstoned, despite the page's own flags still saying published:true.
    assert.equal(payload.blogs[0].posts[0].unpublished, true);
  });
});

test("a blog that's currently published collects its pages normally (not force-tombstoned)", async () => {
  const { collectBlogData } = await import("./collector.js");

  const entry = fakeBlogEntry({
    uuid: "JournalEntry.a",
    name: "Talos Journal",
    config: { published: true },
    pages: [fakePage({ uuid: "Page.1", name: "Session 1", published: true, publishedAt: 100, updatedAt: 100 })],
  });

  await withMockFoundry({ journalEntries: [entry], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].posts[0].unpublished, false);
  });
});

test("an entry that was never published at all (no publishedAt ever stamped) is excluded entirely, same as before", async () => {
  const { collectBlogData } = await import("./collector.js");

  const entry = fakeBlogEntry({
    uuid: "JournalEntry.a",
    name: "Never touched",
    config: { published: false },
    pages: [fakePage({ uuid: "Page.1", name: "Draft", published: true, publishedAt: 100, updatedAt: 100 })],
  });

  await withMockFoundry({ journalEntries: [entry], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogCount, 0);
  });
});

test("postOrder defaults to 'manual' and otherwise passes through an explicit 'newest' or 'oldest'", async () => {
  const { collectBlogData } = await import("./collector.js");

  const defaulted = fakeBlogEntry({ uuid: "JournalEntry.a", name: "A", config: { published: true }, pages: [] });
  const newest = fakeBlogEntry({
    uuid: "JournalEntry.b",
    name: "B",
    config: { published: true, postOrder: "newest" },
    pages: [],
  });
  const oldest = fakeBlogEntry({
    uuid: "JournalEntry.c",
    name: "C",
    config: { published: true, postOrder: "oldest" },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [defaulted, newest, oldest], users: [] }, async () => {
    const payload = await collectBlogData();
    const byUuid = Object.fromEntries(payload.blogs.map((b) => [b.uuid, b]));
    assert.equal(byUuid["JournalEntry.a"].postOrder, "manual");
    assert.equal(byUuid["JournalEntry.b"].postOrder, "newest");
    assert.equal(byUuid["JournalEntry.c"].postOrder, "oldest");
  });
});

test("a post's sortIndex comes from Foundry's own page.sort, collected regardless of postOrder", async () => {
  const { collectBlogData } = await import("./collector.js");

  const page = fakePage({ uuid: "Page.1", name: "Session 1", published: true, publishedAt: 100, updatedAt: 100 });
  page.sort = 300000;

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.a",
    name: "A",
    config: { published: true },
    pages: [page],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].posts[0].sortIndex, 300000);
  });
});

test("sortIndex defaults to 0 when a page has no sort field at all", async () => {
  const { collectBlogData } = await import("./collector.js");

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.a",
    name: "A",
    config: { published: true },
    pages: [fakePage({ uuid: "Page.1", name: "Session 1", published: true, publishedAt: 100, updatedAt: 100 })],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].posts[0].sortIndex, 0);
  });
});

test("postOrder falls back to 'manual' for any unrecognized value", async () => {
  const { collectBlogData } = await import("./collector.js");

  const bogus = fakeBlogEntry({
    uuid: "JournalEntry.a",
    name: "A",
    config: { published: true, postOrder: "sideways" },
    pages: [],
  });

  await withMockFoundry({ journalEntries: [bogus], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].postOrder, "manual");
  });
});

test("posts are sorted chronologically by publishedAt", async () => {
  const { collectBlogData } = await import("./collector.js");

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Blog",
    config: { published: true },
    pages: [
      fakePage({ uuid: "Page.later", name: "Later", published: true, publishedAt: 200, updatedAt: 200 }),
      fakePage({ uuid: "Page.earlier", name: "Earlier", published: true, publishedAt: 100, updatedAt: 100 }),
    ],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.deepEqual(
      payload.blogs[0].posts.map((p) => p.title),
      ["Earlier", "Later"],
    );
  });
});

test("a post with no override inherits its blog's author and tags unchanged", async () => {
  const { collectBlogData } = await import("./collector.js");

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

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Thoric's Journal",
    config: { published: true, tags: ["campaign"] },
    ownership: { default: 0, player1: 3 },
    pages: [page],
  });

  await withMockFoundry({ journalEntries: [blog], users: [player] }, async () => {
    const payload = await collectBlogData();
    const post = payload.blogs[0].posts[0];
    assert.equal(post.author.name, "Thoric");
    assert.equal(post.author.image, resolved("portraits/thoric.png"));
    assert.deepEqual(post.tags, ["campaign"]);
  });
});

test("a post with its own Actor-UUID author override replaces the blog's author for that post only", async () => {
  const { collectBlogData } = await import("./collector.js");

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
  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Thoric's Journal",
    config: { published: true },
    ownership: { default: 0, player1: 3 },
    pages: [overriddenPage, plainPage],
  });

  await withMockFoundry(
    { journalEntries: [blog], users: [player], actorsByUuid: { "Actor.willow123": npc } },
    async () => {
      const payload = await collectBlogData();
      const byUuid = Object.fromEntries(payload.blogs[0].posts.map((p) => [p.uuid, p]));
      assert.equal(byUuid["Page.1"].author.name, "Old Man Willow");
      assert.equal(byUuid["Page.2"].author.name, "Thoric");
    },
  );
});

test("a post with its own manual authorName/authorImage override uses that, with no biography", async () => {
  const { collectBlogData } = await import("./collector.js");

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

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Journal",
    config: { published: true },
    pages: [page],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    const author = payload.blogs[0].posts[0].author;
    assert.equal(author.name, "Guest Chronicler");
    assert.equal(author.image, resolved("art/guest.png"));
    assert.equal(author.bio, "");
  });
});

test("a post's own tags fully replace the blog's tags, not merge with them", async () => {
  const { collectBlogData } = await import("./collector.js");

  const page = {
    uuid: "Page.1",
    name: "Post",
    type: "text",
    text: { content: "<p>hi</p>" },
    flags: { [NS]: { published: true, publishedAt: 1, updatedAt: 1, tags: ["spooky", "npc"] } },
  };

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Journal",
    config: { published: true, tags: ["campaign"] },
    pages: [page],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.deepEqual(payload.blogs[0].posts[0].tags, ["spooky", "npc"]);
  });
});

test("a post with a blank/empty tags override still inherits the blog's tags, rather than having none", async () => {
  const { collectBlogData } = await import("./collector.js");

  const page = {
    uuid: "Page.1",
    name: "Post",
    type: "text",
    text: { content: "<p>hi</p>" },
    flags: { [NS]: { published: true, publishedAt: 1, updatedAt: 1, tags: ["  ", ""] } },
  };

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Journal",
    config: { published: true, tags: ["campaign"] },
    pages: [page],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.deepEqual(payload.blogs[0].posts[0].tags, ["campaign"]);
  });
});

test("a post's frontImage is '' when unset", async () => {
  const { collectBlogData } = await import("./collector.js");

  const page = {
    uuid: "Page.1",
    name: "Post",
    type: "text",
    text: { content: "<p>hi</p>" },
    flags: { [NS]: { published: true, publishedAt: 1, updatedAt: 1 } },
  };

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Journal",
    config: { published: true },
    pages: [page],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    assert.equal(payload.blogs[0].posts[0].frontImage, "");
  });
});

test("a post's frontImage resolves a Foundry-relative path to an absolute URL, and leaves an already-absolute one untouched", async () => {
  const { collectBlogData } = await import("./collector.js");

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

  const blog = fakeBlogEntry({
    uuid: "JournalEntry.blogA",
    name: "Journal",
    config: { published: true },
    pages: [relativePage, absolutePage],
  });

  await withMockFoundry({ journalEntries: [blog], users: [] }, async () => {
    const payload = await collectBlogData();
    const byUuid = Object.fromEntries(payload.blogs[0].posts.map((p) => [p.uuid, p]));
    assert.equal(byUuid["Page.1"].frontImage, resolved("worlds/test-world/assets/cover.png"));
    assert.equal(byUuid["Page.2"].frontImage, "https://assets.forge-vtt.com/some-id/cover.webp");
  });
});
