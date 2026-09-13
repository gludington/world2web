// Run with: node --test foundry-module/scripts/render.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPayloadToFiles, buildSiteConfigFile } from "./render.js";

function samplePayload(overrides = {}) {
  return {
    world: { id: "codex", title: "codex" },
    journals: [
      {
        uuid: "JournalEntry.journalA",
        title: "Thoric's Journal",
        author: { userId: "u1", name: "Thoric", image: null, isGM: false },
        posts: [
          {
            uuid: "JournalEntry.journalA.JournalEntryPage.p1",
            title: "The Bandit King's Lair",
            html: "<p>hi</p>",
            // Same shape collector.js's collectPost() actually produces --
            // post.author, already fully resolved (inherited from the
            // journal here, since nothing overrides it in this fixture).
            author: { userId: "u1", name: "Thoric", image: null, isGM: false },
            tags: [],
            publishedAt: 100,
            updatedAt: 100,
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("renders one file per post, with the expected path and frontmatter", () => {
  const { worldSlug, files } = renderPayloadToFiles(samplePayload());
  assert.equal(worldSlug, "codex");
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "content/worlds/codex/journals/thoric-s-journal/the-bandit-king-s-lair.md");
  assert.match(files[0].content, /^---\n\{/);
  assert.match(files[0].content, /"title": "The Bandit King's Lair"/);
  assert.match(files[0].content, /"journalSlug": "thoric-s-journal"/);
  assert.match(files[0].content, /"authorSlug": "thoric"/);
  assert.match(files[0].content, /"unpublished": false/);
  assert.match(files[0].content, /<p>hi<\/p>/);
});

test("postOrder defaults to 'manual' in frontmatter when the journal doesn't set one", () => {
  const { files } = renderPayloadToFiles(samplePayload());
  assert.match(files[0].content, /"postOrder": "manual"/);
});

test("an explicit postOrder of 'newest' or 'oldest' passes through to frontmatter", () => {
  const newest = samplePayload();
  newest.journals[0].postOrder = "newest";
  assert.match(renderPayloadToFiles(newest).files[0].content, /"postOrder": "newest"/);

  const oldest = samplePayload();
  oldest.journals[0].postOrder = "oldest";
  assert.match(renderPayloadToFiles(oldest).files[0].content, /"postOrder": "oldest"/);
});

test("sortIndex passes through to frontmatter, defaulting to 0 when unset", () => {
  const { files } = renderPayloadToFiles(samplePayload());
  assert.match(files[0].content, /"sortIndex": 0/);

  const payload = samplePayload();
  payload.journals[0].posts[0].sortIndex = 42;
  assert.match(renderPayloadToFiles(payload).files[0].content, /"sortIndex": 42/);
});

test("a soft-deleted (tombstoned) post still gets its file written, with unpublished: true", () => {
  const payload = samplePayload();
  payload.journals[0].posts[0].unpublished = true;
  const { files } = renderPayloadToFiles(payload);
  assert.equal(files.length, 1); // still written, not skipped
  assert.match(files[0].content, /"unpublished": true/);
});

test("two different journals with the same title get disambiguated journal slugs", () => {
  const payload = samplePayload();
  payload.journals.push({
    uuid: "JournalEntry.journalB",
    title: "Thoric's Journal", // same title, different journal/author
    author: { userId: null, name: "Game Master", image: null, isGM: true },
    posts: [
      {
        uuid: "JournalEntry.journalB.JournalEntryPage.p1",
        title: "GM notes",
        html: "<p>gm version</p>",
        author: { userId: null, name: "Game Master", image: null, isGM: true },
        tags: [],
        publishedAt: 200,
        updatedAt: 200,
      },
    ],
  });
  const { files } = renderPayloadToFiles(payload);
  const journalDirs = files.map((f) => f.path.split("/")[4]);
  assert.notEqual(journalDirs[0], journalDirs[1]);
  assert.equal(journalDirs[0], "thoric-s-journal");
  assert.match(journalDirs[1], /^thoric-s-journal-[a-z0-9]+$/);
});

test("two journals with the same author name keep separate journal slugs but share one author slug", () => {
  const payload = {
    world: { id: "codex", title: "codex" },
    journals: [
      {
        uuid: "JournalEntry.gm1",
        title: "GM Log 1",
        author: { userId: null, name: "Game Master", image: null, isGM: true },
        posts: [
          {
            uuid: "p1",
            title: "Post One",
            html: "<p>1</p>",
            author: { userId: null, name: "Game Master", image: null, isGM: true },
            tags: [],
            publishedAt: 1,
            updatedAt: 1,
          },
        ],
      },
      {
        uuid: "JournalEntry.gm2",
        title: "GM Log 2",
        author: { userId: null, name: "Game Master", image: null, isGM: true },
        posts: [
          {
            uuid: "p2",
            title: "Post Two",
            html: "<p>2</p>",
            author: { userId: null, name: "Game Master", image: null, isGM: true },
            tags: [],
            publishedAt: 2,
            updatedAt: 2,
          },
        ],
      },
    ],
  };
  const { files } = renderPayloadToFiles(payload);
  const journalDirs = files.map((f) => f.path.split("/")[4]);
  // Different journal entries -> different journal directories/slugs, even
  // though both display "Game Master" as the author...
  assert.notEqual(journalDirs[0], journalDirs[1]);
  assert.equal(journalDirs[0], "gm-log-1");
  assert.equal(journalDirs[1], "gm-log-2");
  // ...but both frontmatter records carry the *same* authorSlug, which is
  // what merges them onto one cross-journal author archive page on the site.
  const authorSlugs = files.map((f) => JSON.parse(f.content.split("---")[1]).authorSlug);
  assert.deepEqual(authorSlugs, ["game-master", "game-master"]);
});

test("a root path is slugified segment-by-segment and prepended to the journal's own slug", () => {
  const payload = samplePayload();
  payload.journals[0].root = "Arc 1/Session Notes";
  const { files } = renderPayloadToFiles(payload);
  assert.equal(files[0].path, "content/worlds/codex/journals/arc-1/session-notes/thoric-s-journal/the-bandit-king-s-lair.md");
  assert.match(files[0].content, /"journalSlug": "arc-1\/session-notes\/thoric-s-journal"/);
  // The raw (unslugified) text survives separately in frontmatter too --
  // the site needs it for human-readable breadcrumb/section labels.
  assert.match(files[0].content, /"root": "Arc 1\/Session Notes"/);
});

test("root is null in frontmatter when the journal has none", () => {
  const { files } = renderPayloadToFiles(samplePayload());
  assert.match(files[0].content, /"root": null/);
});

test("a root path with leading/trailing/doubled slashes and mixed case still slugifies cleanly", () => {
  const payload = samplePayload();
  payload.journals[0].root = "/Foo Bar//Baz Qux/";
  const { files } = renderPayloadToFiles(payload);
  assert.equal(files[0].path, "content/worlds/codex/journals/foo-bar/baz-qux/thoric-s-journal/the-bandit-king-s-lair.md");
});

test("no root leaves the journal slug as just the title slug (unchanged from before roots existed)", () => {
  const payload = samplePayload();
  payload.journals[0].root = null;
  const { files } = renderPayloadToFiles(payload);
  assert.equal(files[0].path, "content/worlds/codex/journals/thoric-s-journal/the-bandit-king-s-lair.md");
});

test("two journals with the same root AND title still get disambiguated (collision checked on the full combined path)", () => {
  const payload = samplePayload();
  payload.journals[0].root = "Arc 1";
  payload.journals.push({
    uuid: "JournalEntry.journalB",
    title: "Thoric's Journal",
    root: "Arc 1", // same root AND same title -> would collide without disambiguation
    author: { userId: null, name: "Someone Else", image: null, isGM: false },
    posts: [
      {
        uuid: "p2",
        title: "Other post",
        html: "<p>o</p>",
        author: { userId: null, name: "Someone Else", image: null, isGM: false },
        tags: [],
        publishedAt: 2,
        updatedAt: 2,
      },
    ],
  });
  const { files } = renderPayloadToFiles(payload);
  const journalSlugs = files.map((f) => JSON.parse(f.content.split("---")[1]).journalSlug);
  assert.equal(journalSlugs[0], "arc-1/thoric-s-journal");
  assert.match(journalSlugs[1], /^arc-1\/thoric-s-journal-[a-z0-9]+$/);
});

test("buildSiteConfigFile writes the theme, site name, journals segment, and allowThemeOverride to a fixed path", () => {
  const file = buildSiteConfigFile({
    theme: "parchment",
    siteName: "The Ashwood Chronicle",
    journalsSegment: "chronicles",
    allowThemeOverride: true,
  });
  assert.equal(file.path, "content/site-config.json");
  assert.deepEqual(JSON.parse(file.content), {
    theme: "parchment",
    siteName: "The Ashwood Chronicle",
    journalsSegment: "chronicles",
    allowThemeOverride: true,
  });
});

test("buildSiteConfigFile defaults theme to 'default', siteName to 'World2Web', journalsSegment to 'journals', and allowThemeOverride to false when empty/missing", () => {
  assert.deepEqual(
    JSON.parse(buildSiteConfigFile({ theme: "", siteName: "", journalsSegment: "", allowThemeOverride: false }).content),
    {
      theme: "default",
      siteName: "World2Web",
      journalsSegment: "journals",
      allowThemeOverride: false,
    },
  );
  assert.deepEqual(JSON.parse(buildSiteConfigFile({}).content), {
    theme: "default",
    siteName: "World2Web",
    journalsSegment: "journals",
    allowThemeOverride: false,
  });
});

test("a post's own author (already resolved by collector.js, may differ from its journal's) drives its authorSlug, not the journal's", () => {
  const payload = samplePayload();
  payload.journals[0].posts.push({
    uuid: "JournalEntry.journalA.JournalEntryPage.p2",
    title: "Guest Post",
    html: "<p>guest</p>",
    author: { userId: null, name: "Old Man Willow", image: null, isGM: false },
    tags: [],
    publishedAt: 200,
    updatedAt: 200,
  });
  const { files } = renderPayloadToFiles(payload);
  const byTitle = Object.fromEntries(
    files.map((f) => [JSON.parse(f.content.split("---")[1]).title, JSON.parse(f.content.split("---")[1])]),
  );
  assert.equal(byTitle["The Bandit King's Lair"].authorSlug, "thoric");
  assert.equal(byTitle["Guest Post"].authorSlug, "old-man-willow");
  assert.equal(byTitle["Guest Post"].author.name, "Old Man Willow");
});

test("a post's own tags pass through to frontmatter", () => {
  const payload = samplePayload();
  payload.journals[0].posts[0].tags = ["spooky", "npc"];
  const { files } = renderPayloadToFiles(payload);
  assert.deepEqual(JSON.parse(files[0].content.split("---")[1]).tags, ["spooky", "npc"]);
});

test("frontImage passes through to frontmatter, defaulting to '' when unset", () => {
  const { files } = renderPayloadToFiles(samplePayload());
  assert.equal(JSON.parse(files[0].content.split("---")[1]).frontImage, "");

  const payload = samplePayload();
  payload.journals[0].posts[0].frontImage = "https://example.com/cover.png";
  const withImage = renderPayloadToFiles(payload);
  assert.equal(JSON.parse(withImage.files[0].content.split("---")[1]).frontImage, "https://example.com/cover.png");
});
