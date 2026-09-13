// Run with: node --test foundry-module/scripts/assets.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractImageSrcs,
  rewriteImageSrcs,
  collectAssetUrls,
  rewriteAssetReferences,
  guessExtension,
  sha256Hex,
  fetchAsset,
  collectAssets,
} from "./assets.js";

test("extractImageSrcs finds every <img src>, deduped", () => {
  const html = `<p><img src="a.png"> text <img src='b.jpg'/> <img src="a.png"></p>`;
  assert.deepEqual(extractImageSrcs(html), ["a.png", "b.jpg"]);
});

test("extractImageSrcs returns nothing for html with no images", () => {
  assert.deepEqual(extractImageSrcs("<p>just text</p>"), []);
});

test("rewriteImageSrcs replaces only the src value, leaving the rest byte-identical", () => {
  const html = `<p>Before <img class="x" src="a.png" alt="A"> after</p>`;
  const rewritten = rewriteImageSrcs(html, new Map([["a.png", "/assets/abc.png"]]));
  assert.equal(rewritten, `<p>Before <img class="x" src="/assets/abc.png" alt="A"> after</p>`);
});

test("rewriteImageSrcs is a pure no-op fast path when there's no <img> at all", () => {
  const html = "<p>no images here</p>";
  assert.equal(rewriteImageSrcs(html, new Map([["x", "y"]])), html);
});

test("rewriteImageSrcs leaves unmapped src values untouched", () => {
  const html = `<img src="unmapped.png">`;
  assert.equal(rewriteImageSrcs(html, new Map()), html);
});

test("collectAssetUrls gathers each post's own author portrait, front image, and <img> srcs, deduped", () => {
  const sharedJournalAuthor = { image: "portraits/thoric.png" };
  const payload = {
    journals: [
      {
        author: sharedJournalAuthor,
        posts: [
          { author: sharedJournalAuthor, frontImage: "", html: `<img src="map.png">` },
          { author: sharedJournalAuthor, frontImage: "", html: `<img src="map.png"> <img src="handout.jpg">` },
        ],
      },
      { author: { image: null }, posts: [{ author: { image: null }, frontImage: "", html: "<p>no images</p>" }] },
    ],
  };
  const urls = collectAssetUrls(payload);
  assert.deepEqual(new Set(urls), new Set(["portraits/thoric.png", "map.png", "handout.jpg"]));
});

test("collectAssetUrls skips a tombstoned (unpublished: true) post's images entirely", () => {
  // Regression test: collector.js keeps a full post object around for a
  // previously-published, now-unpublished post (html, author, frontImage
  // and all) purely to write its tombstone stub -- there's no way to
  // delete an already-pushed file from GitHub. That stub is never
  // rendered anywhere on the live site, so re-fetching/re-uploading its
  // images on every single publish forever was pure waste.
  const payload = {
    journals: [
      {
        author: { image: "portraits/thoric.png" },
        posts: [
          {
            author: { image: "portraits/thoric.png" },
            frontImage: "worlds/test/live-cover.png",
            html: `<img src="live-inline.png">`,
            unpublished: false,
          },
          {
            author: { image: "actors/retracted-npc.png" },
            frontImage: "worlds/test/retracted-cover.png",
            html: `<img src="retracted-inline.png">`,
            unpublished: true,
          },
        ],
      },
    ],
  };
  const urls = collectAssetUrls(payload);
  assert.deepEqual(
    new Set(urls),
    new Set(["portraits/thoric.png", "worlds/test/live-cover.png", "live-inline.png"]),
  );
});

test("collectAssetUrls finds an image reachable only through a post's own author/front-image override -- not just the journal's default author", () => {
  // Regression test: a real bug where a post-level Actor-authored override
  // (or the post's own front image) was invisible to the real publish
  // pipeline entirely, because this used to only ever look at
  // journal.author.image -- the journal's own default, a different object
  // entirely from a post's override. Reported live: an NPC-authored
  // post's portrait stayed pointing at the GM's own localhost Foundry
  // server on the published site instead of being fetched/rehosted.
  const payload = {
    journals: [
      {
        author: { image: "portraits/thoric.png" }, // the journal's own default -- irrelevant to this post
        posts: [
          {
            author: { image: "http://localhost:30000/systems/dnd5e/icons/svg/actors/npc.svg" },
            frontImage: "http://localhost:30000/worlds/test/cover.png",
            html: "<p>hi</p>",
          },
        ],
      },
    ],
  };
  const urls = collectAssetUrls(payload);
  assert.deepEqual(
    new Set(urls),
    new Set([
      "http://localhost:30000/systems/dnd5e/icons/svg/actors/npc.svg",
      "http://localhost:30000/worlds/test/cover.png",
    ]),
  );
});

test("rewriteAssetReferences rewrites each post's own author.image, frontImage, and post.html in place, leaves unmapped alone", () => {
  const payload = {
    journals: [
      {
        author: { image: "portraits/thoric.png" },
        posts: [
          {
            author: { image: "actors/willow.png" },
            frontImage: "worlds/test/cover.png",
            html: `<img src="map.png">`,
          },
          {
            author: { image: "unmapped-author.png" },
            frontImage: "",
            html: `<img src="unmapped.png">`,
          },
        ],
      },
    ],
  };
  const urlMap = new Map([
    ["actors/willow.png", "/assets/aaa.png"],
    ["worlds/test/cover.png", "/assets/ccc.png"],
    ["map.png", "/assets/bbb.png"],
  ]);
  rewriteAssetReferences(payload, urlMap);
  assert.equal(payload.journals[0].posts[0].author.image, "/assets/aaa.png");
  assert.equal(payload.journals[0].posts[0].frontImage, "/assets/ccc.png");
  assert.equal(payload.journals[0].posts[0].html, `<img src="/assets/bbb.png">`);
  assert.equal(payload.journals[0].posts[1].author.image, "unmapped-author.png"); // left alone
  assert.equal(payload.journals[0].posts[1].frontImage, ""); // left alone
  assert.equal(payload.journals[0].posts[1].html, `<img src="unmapped.png">`); // left alone
});

test("guessExtension prefers the URL's own extension, falls back to content-type", () => {
  assert.equal(guessExtension("icons/thing.webp", "image/png"), "webp");
  assert.equal(guessExtension("icons/thing", "image/png"), "png");
  assert.equal(guessExtension("data:image/jpeg;base64,...", "image/jpeg"), "jpg"); // no real url extension, falls back to content-type
});

test("sha256Hex matches a known vector", async () => {
  const buffer = new TextEncoder().encode("hello world").buffer;
  const hex = await sha256Hex(buffer);
  assert.equal(hex, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
});

test("fetchAsset decodes a base64 data: URI without any network call", async () => {
  const b64 = Buffer.from("hi there").toString("base64");
  const { buffer, contentType } = await fetchAsset(`data:image/png;base64,${b64}`);
  assert.equal(contentType, "image/png");
  assert.equal(Buffer.from(buffer).toString("utf-8"), "hi there");
});

test("collectAssets fetches each unique url once (including an actor-sourced author portrait), content-addresses it, and skips failures", async () => {
  // Full integration through the real entry point (not just
  // collectAssetUrls in isolation): an Actor-sourced author.image goes
  // through fetch -> sha256 -> /assets/<hash>.<ext>, the exact same
  // treatment as any other image, no special-casing anywhere. Also
  // exercises dedup across two different *sources* of the same URL (the
  // post's own author.image and a separate <img> in its body), not just
  // two <img> tags -- collectAssetUrls' Set covers both.
  const prevFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url === "broken.png") return { ok: false, status: 404 };
    return {
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => new TextEncoder().encode(`bytes-for-${url}`).buffer,
    };
  };
  try {
    const payload = {
      journals: [
        {
          posts: [
            {
              author: { image: "actors/willow-portrait.png" },
              html: `<img src="actors/willow-portrait.png"><img src="broken.png">`, // same portrait, also embedded inline
            },
          ],
        },
      ],
    };
    const { urlMap, files } = await collectAssets(payload);
    assert.equal(calls.length, 2); // fetched each unique url once, not twice for the repeated one
    assert.equal(urlMap.has("actors/willow-portrait.png"), true);
    assert.equal(urlMap.has("broken.png"), false); // failed fetch omitted, not thrown
    assert.equal(files.length, 1);
    assert.match(files[0].path, /^public\/assets\/[0-9a-f]{64}\.png$/);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
