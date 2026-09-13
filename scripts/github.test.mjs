// Run with: node --test foundry-module/scripts/github.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { putFile, pushFiles, pushBinaryAssets, retractDeletedPost } from "./github.js";

function b64(str) {
  return Buffer.from(str, "utf-8").toString("base64");
}

/** Records every call made through the mocked fetch, and serves canned
 * responses keyed by "METHOD path". */
function mockFetch(responses) {
  const calls = [];
  const fn = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const path = new URL(url).pathname;
    calls.push({ method, url, path, body: options.body ? JSON.parse(options.body) : null });
    const key = `${method} ${path}`;
    const responder = responses[key];
    if (!responder) throw new Error(`No mock response for ${key}`);
    return typeof responder === "function" ? responder() : responder;
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

async function withMockFetch(responses, fn) {
  const prevFetch = globalThis.fetch;
  const mocked = mockFetch(responses);
  globalThis.fetch = mocked;
  try {
    await fn(mocked);
  } finally {
    globalThis.fetch = prevFetch;
  }
}

test("putFile creates a new file when none exists (no sha sent)", async () => {
  await withMockFetch(
    {
      "GET /repos/me/repo/contents/content/worlds/codex/journals/thoric/post.md": jsonResponse(404, {}),
      "PUT /repos/me/repo/contents/content/worlds/codex/journals/thoric/post.md": jsonResponse(201, { commit: { sha: "new" } }),
    },
    async (mocked) => {
      const result = await putFile({
        owner: "me",
        repo: "repo",
        path: "content/worlds/codex/journals/thoric/post.md",
        content: "hello",
        message: "add post",
        token: "tok",
      });
      assert.ok(result);
      const put = mocked.calls.find((c) => c.method === "PUT");
      assert.equal(put.body.content, b64("hello"));
      assert.equal(put.body.sha, undefined);
    },
  );
});

test("putFile updates an existing file, sending its current sha", async () => {
  await withMockFetch(
    {
      "GET /repos/me/repo/contents/content/worlds/codex/journals/thoric/post.md": jsonResponse(200, {
        sha: "abc123",
        content: b64("old content"),
      }),
      "PUT /repos/me/repo/contents/content/worlds/codex/journals/thoric/post.md": jsonResponse(200, { commit: { sha: "def456" } }),
    },
    async (mocked) => {
      const result = await putFile({
        owner: "me",
        repo: "repo",
        path: "content/worlds/codex/journals/thoric/post.md",
        content: "new content",
        message: "update post",
        token: "tok",
      });
      assert.ok(result);
      const put = mocked.calls.find((c) => c.method === "PUT");
      assert.equal(put.body.sha, "abc123");
      assert.equal(put.body.content, b64("new content"));
    },
  );
});

test("putFile skips the write entirely when content is byte-identical", async () => {
  await withMockFetch(
    {
      "GET /repos/me/repo/contents/content/worlds/codex/journals/thoric/post.md": jsonResponse(200, {
        sha: "abc123",
        content: b64("same content"),
      }),
    },
    async (mocked) => {
      const result = await putFile({
        owner: "me",
        repo: "repo",
        path: "content/worlds/codex/journals/thoric/post.md",
        content: "same content",
        message: "no-op",
        token: "tok",
      });
      assert.equal(result, null);
      assert.equal(mocked.calls.filter((c) => c.method === "PUT").length, 0);
    },
  );
});

test("putFile retries once on a 409 conflict (stale sha) using a freshly re-fetched sha", async () => {
  let getCallCount = 0;
  await withMockFetch(
    {
      "GET /repos/me/repo/contents/post.md": () => {
        getCallCount += 1;
        // First GET (before the initial PUT) sees the old sha; second GET
        // (after the 409, retrying) sees what the "other user" just wrote.
        return getCallCount === 1
          ? jsonResponse(200, { sha: "stale-sha", content: b64("original") })
          : jsonResponse(200, { sha: "fresh-sha", content: b64("someone else's edit") });
      },
      "PUT /repos/me/repo/contents/post.md": () => {
        // First PUT attempt (right after the first GET, stale sha) conflicts;
        // retry (after the second GET) succeeds.
        return getCallCount === 1 ? jsonResponse(409, { message: "conflict" }) : jsonResponse(200, { commit: {} });
      },
    },
    async (mocked) => {
      const result = await putFile({
        owner: "me",
        repo: "repo",
        path: "post.md",
        content: "my edit",
        message: "update",
        token: "tok",
      });
      assert.ok(result);
      const puts = mocked.calls.filter((c) => c.method === "PUT");
      assert.equal(puts.length, 2);
      assert.equal(puts[0].body.sha, "stale-sha");
      assert.equal(puts[1].body.sha, "fresh-sha");
    },
  );
});

test("putFile retry finds the exact same content already published and no-ops instead of erroring", async () => {
  let getCallCount = 0;
  await withMockFetch(
    {
      "GET /repos/me/repo/contents/post.md": () => {
        getCallCount += 1;
        return getCallCount === 1
          ? jsonResponse(200, { sha: "stale-sha", content: b64("original") })
          : jsonResponse(200, { sha: "fresh-sha", content: b64("my edit") }); // someone else pushed the same content
      },
      "PUT /repos/me/repo/contents/post.md": jsonResponse(409, { message: "conflict" }),
    },
    async (mocked) => {
      const result = await putFile({
        owner: "me",
        repo: "repo",
        path: "post.md",
        content: "my edit",
        message: "update",
        token: "tok",
      });
      assert.equal(result, null);
      assert.equal(mocked.calls.filter((c) => c.method === "PUT").length, 1);
    },
  );
});

function frontmatterFile(frontmatter, body = "\n<p>hi</p>\n") {
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;
}

test("retractDeletedPost flips unpublished: true and bumps updatedAt, keeping everything else", async () => {
  const original = { title: "Gone", author: { name: "Thoric" }, unpublished: false, updatedAt: 100 };
  await withMockFetch(
    {
      "GET /repos/me/repo/contents/post.md": jsonResponse(200, {
        sha: "abc123",
        content: b64(frontmatterFile(original)),
      }),
      "PUT /repos/me/repo/contents/post.md": jsonResponse(200, { commit: {} }),
    },
    async (mocked) => {
      const result = await retractDeletedPost({ owner: "me", repo: "repo", path: "post.md", token: "tok" });
      assert.equal(result, true);
      const put = mocked.calls.find((c) => c.method === "PUT");
      const pushedContent = Buffer.from(put.body.content, "base64").toString("utf-8");
      const match = pushedContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const pushedFrontmatter = JSON.parse(match[1]);
      assert.equal(pushedFrontmatter.unpublished, true);
      assert.equal(pushedFrontmatter.title, "Gone"); // everything else untouched
      assert.equal(pushedFrontmatter.author.name, "Thoric");
      assert.ok(pushedFrontmatter.updatedAt > 100); // bumped
      assert.equal(match[2], "\n<p>hi</p>\n"); // body untouched, byte-identical
      assert.equal(put.body.sha, "abc123");
    },
  );
});

test("retractDeletedPost is a no-op (returns true, no PUT) when the file's already gone", async () => {
  await withMockFetch(
    { "GET /repos/me/repo/contents/post.md": jsonResponse(404, {}) },
    async (mocked) => {
      const result = await retractDeletedPost({ owner: "me", repo: "repo", path: "post.md", token: "tok" });
      assert.equal(result, true);
      assert.equal(mocked.calls.filter((c) => c.method === "PUT").length, 0);
    },
  );
});

test("retractDeletedPost is a no-op (returns true, no PUT) when the file is already unpublished", async () => {
  await withMockFetch(
    {
      "GET /repos/me/repo/contents/post.md": jsonResponse(200, {
        sha: "abc123",
        content: b64(frontmatterFile({ title: "Already gone", unpublished: true, updatedAt: 100 })),
      }),
    },
    async (mocked) => {
      const result = await retractDeletedPost({ owner: "me", repo: "repo", path: "post.md", token: "tok" });
      assert.equal(result, true);
      assert.equal(mocked.calls.filter((c) => c.method === "PUT").length, 0);
    },
  );
});

test("retractDeletedPost backs off (returns true, no PUT) when expectedUuid no longer matches -- the path was reclaimed by a different, live post", async () => {
  // Regression test for a real race: a brand-new page published with the
  // same resulting slug (same title/journal/root) as a just-deleted one
  // computes the identical file path -- pushFiles() can overwrite that
  // path with the new page's own live content earlier in the very same
  // publish run, before this function ever runs. Without checking the
  // fetched file's own foundryUuid, this would flip the *new* post back
  // to unpublished moments after it went live.
  await withMockFetch(
    {
      "GET /repos/me/repo/contents/post.md": jsonResponse(200, {
        sha: "abc123",
        content: b64(
          frontmatterFile({ foundryUuid: "Page.NEW", title: "Reused slug", unpublished: false, updatedAt: 999 }),
        ),
      }),
    },
    async (mocked) => {
      const result = await retractDeletedPost({
        owner: "me",
        repo: "repo",
        path: "post.md",
        token: "tok",
        expectedUuid: "Page.OLD",
      });
      assert.equal(result, true);
      assert.equal(mocked.calls.filter((c) => c.method === "PUT").length, 0);
    },
  );
});

test("retractDeletedPost returns false (retry later) on a write conflict or unrecognized content", async () => {
  await withMockFetch(
    {
      "GET /repos/me/repo/contents/conflict.md": jsonResponse(200, {
        sha: "abc123",
        content: b64(frontmatterFile({ title: "X", unpublished: false, updatedAt: 100 })),
      }),
      "PUT /repos/me/repo/contents/conflict.md": jsonResponse(409, { message: "conflict" }),
      "GET /repos/me/repo/contents/not-ours.md": jsonResponse(200, {
        sha: "abc123",
        content: b64("not this pipeline's frontmatter shape at all"),
      }),
    },
    async () => {
      assert.equal(
        await retractDeletedPost({ owner: "me", repo: "repo", path: "conflict.md", token: "tok" }),
        false,
      );
      assert.equal(
        await retractDeletedPost({ owner: "me", repo: "repo", path: "not-ours.md", token: "tok" }),
        false,
      );
    },
  );
});

async function sha256HexOfText(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text).buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("pushFiles only reports paths that were actually written, and returns confirmed hashes for both", async () => {
  await withMockFetch(
    {
      "GET /repos/me/repo/contents/a.md": jsonResponse(404, {}),
      "PUT /repos/me/repo/contents/a.md": jsonResponse(201, {}),
      "GET /repos/me/repo/contents/b.md": jsonResponse(200, { sha: "s", content: b64("unchanged") }),
    },
    async () => {
      const { pushed, hashes } = await pushFiles({
        owner: "me",
        repo: "repo",
        token: "tok",
        files: [
          { path: "a.md", content: "new" },
          { path: "b.md", content: "unchanged" },
        ],
      });
      assert.deepEqual(pushed, ["a.md"]);
      // Both confirmed correct now (one just-pushed, one found byte-identical
      // via the live fetch) -- both get recorded as this run's new baseline.
      assert.equal(hashes["a.md"], await sha256HexOfText("new"));
      assert.equal(hashes["b.md"], await sha256HexOfText("unchanged"));
    },
  );
});

test("pushFiles skips a file entirely (no GET, no PUT) when knownHashes already matches its current content", async () => {
  await withMockFetch(
    {
      // Only b.md has a mock response registered -- if pushFiles tried any
      // GitHub call at all for a.md, mockFetch would throw "No mock
      // response for ..." and fail the test.
      "GET /repos/me/repo/contents/b.md": jsonResponse(404, {}),
      "PUT /repos/me/repo/contents/b.md": jsonResponse(201, {}),
    },
    async (mocked) => {
      const { pushed, hashes } = await pushFiles({
        owner: "me",
        repo: "repo",
        token: "tok",
        knownHashes: { "a.md": await sha256HexOfText("unchanged since last time") },
        files: [
          { path: "a.md", content: "unchanged since last time" },
          { path: "b.md", content: "genuinely new" },
        ],
      });
      assert.deepEqual(pushed, ["b.md"]);
      assert.equal(mocked.calls.filter((c) => c.path.endsWith("a.md")).length, 0);
      // a.md's known-good hash carries forward untouched; b.md's newly confirmed.
      assert.equal(hashes["a.md"], await sha256HexOfText("unchanged since last time"));
      assert.equal(hashes["b.md"], await sha256HexOfText("genuinely new"));
    },
  );
});

test("pushFiles falls through to the normal GET-compare-PUT path when knownHashes is stale (content actually changed)", async () => {
  await withMockFetch(
    {
      "GET /repos/me/repo/contents/a.md": jsonResponse(200, { sha: "s", content: b64("old content") }),
      "PUT /repos/me/repo/contents/a.md": jsonResponse(200, { commit: {} }),
    },
    async () => {
      const { pushed, hashes } = await pushFiles({
        owner: "me",
        repo: "repo",
        token: "tok",
        knownHashes: { "a.md": await sha256HexOfText("old content") },
        files: [{ path: "a.md", content: "edited content" }],
      });
      assert.deepEqual(pushed, ["a.md"]);
      assert.equal(hashes["a.md"], await sha256HexOfText("edited content"));
    },
  );
});

// Regression test for a bug that shipped in v0.20.0: pushFiles/
// pushBinaryAssets used to run every file's full GET-then-PUT through
// mapWithConcurrency, including the PUT. Each Contents-API PUT is its own
// commit that has to fast-forward the branch's ref, so N concurrent PUTs
// race that one ref -- only one can land at a time, and every other one
// 409s with "is at <sha> but expected <sha>", where both shas are commit
// shas (confirmed against a real failure), not the per-path content
// conflict putFile's own retry is built to handle. Reads (checking what
// needs writing) stay concurrent; only the actual writes must serialize.
// These tests assert that directly: an artificial delay inside each mocked
// PUT response makes any accidental re-introduction of concurrent writes
// show up as more than one in-flight PUT at once.
function trackingPutResponder(maxInFlight, status, body) {
  let inFlight = 0;
  return async () => {
    inFlight++;
    maxInFlight.count = Math.max(maxInFlight.count, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return jsonResponse(status, body);
  };
}

test("pushFiles never has more than one PUT in flight at a time, even with several files needing a write", async () => {
  const maxInFlight = { count: 0 };
  const paths = ["a.md", "b.md", "c.md", "d.md"];
  const responses = {};
  for (const path of paths) {
    responses[`GET /repos/me/repo/contents/${path}`] = jsonResponse(404, {});
    responses[`PUT /repos/me/repo/contents/${path}`] = trackingPutResponder(maxInFlight, 201, {});
  }

  await withMockFetch(responses, async () => {
    const { pushed } = await pushFiles({
      owner: "me",
      repo: "repo",
      token: "tok",
      files: paths.map((path) => ({ path, content: `content of ${path}` })),
    });
    assert.deepEqual(pushed.sort(), paths);
    assert.equal(maxInFlight.count, 1);
  });
});

test("pushBinaryAssets never has more than one PUT in flight at a time, even with several new assets", async () => {
  const maxInFlight = { count: 0 };
  const paths = ["assets/a.webp", "assets/b.webp", "assets/c.webp", "assets/d.webp"];
  const responses = {};
  for (const path of paths) {
    responses[`GET /repos/me/repo/contents/${path}`] = jsonResponse(404, {});
    responses[`PUT /repos/me/repo/contents/${path}`] = trackingPutResponder(maxInFlight, 201, {});
  }

  await withMockFetch(responses, async () => {
    const pushed = await pushBinaryAssets({
      owner: "me",
      repo: "repo",
      token: "tok",
      files: paths.map((path) => ({ path, buffer: new TextEncoder().encode(path).buffer })),
    });
    assert.deepEqual(pushed.sort(), paths);
    assert.equal(maxInFlight.count, 1);
  });
});
