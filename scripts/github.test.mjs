// Run with: node --test scripts/github.test.mjs
// (commitChanges, the publish commit, is tested in commit.test.mjs.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRepoAccess } from "./github.js";

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

async function withFetch(fn, impl) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

test("checkRepoAccess: ok when the repo and branch are both readable", async () => {
  const { checkRepoAccess } = await import("./github.js");
  const fetchMock = mockFetch({
    "GET /repos/alice/site": jsonResponse(200, {}),
    "GET /repos/alice/site/branches/main": jsonResponse(200, {}),
  });
  const result = await withFetch(() => checkRepoAccess({ owner: "alice", repo: "site", token: "t" }), fetchMock);
  assert.deepEqual(result, { ok: true });
  assert.ok(fetchMock.calls.every((c) => c.method === "GET"), "never writes");
});

test("checkRepoAccess: maps each failure to a specific reason", async () => {
  const { checkRepoAccess } = await import("./github.js");
  const args = { owner: "alice", repo: "site", token: "t", branch: "main" };
  const cases = [
    [{ "GET /repos/alice/site": jsonResponse(401, {}) }, "bad-token"],
    [{ "GET /repos/alice/site": jsonResponse(404, {}) }, "repo-not-found"],
    [
      { "GET /repos/alice/site": jsonResponse(200, {}), "GET /repos/alice/site/branches/main": jsonResponse(403, {}) },
      "no-contents-permission",
    ],
    [
      { "GET /repos/alice/site": jsonResponse(200, {}), "GET /repos/alice/site/branches/main": jsonResponse(404, {}) },
      "branch-not-found",
    ],
    [{ "GET /repos/alice/site": jsonResponse(500, {}) }, "unexpected"],
  ];
  for (const [responses, reason] of cases) {
    const result = await withFetch(() => checkRepoAccess(args), mockFetch(responses));
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
  }
});

test("checkRepoAccess: missing fields and network errors never throw", async () => {
  const { checkRepoAccess } = await import("./github.js");
  assert.equal((await checkRepoAccess({ owner: "", repo: "site", token: "t" })).reason, "missing-fields");
  const result = await withFetch(
    () => checkRepoAccess({ owner: "a", repo: "b", token: "t" }),
    async () => {
      throw new TypeError("Failed to fetch");
    },
  );
  assert.equal(result.reason, "network");
});
