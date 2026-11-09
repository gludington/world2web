// Run with: node --test scripts/commit.test.mjs
//
// commitChanges() against a small in-memory imitation of GitHub's Git Data
// API: a branch, commits, trees and blobs, with real git blob ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitChanges, gitBlobSha } from "./github.js";

const enc = (s) => new TextEncoder().encode(s);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

/** A fake repo: path -> text. Returns a fetch implementation plus a log of what happened. */
async function fakeGitHub(files, { moveBranchOnce = false } = {}) {
  const blobs = new Map(); // sha -> base64
  const trees = new Map(); // sha -> Map(path -> blobSha)
  const commits = new Map(); // sha -> {tree, parents, message}
  let counter = 0;
  const id = (p) => `${p}${++counter}`.padEnd(40, "0");
  const putBlob = async (bytes) => {
    const sha = await gitBlobSha(bytes);
    blobs.set(sha, b64(bytes));
    return sha;
  };
  const rootTree = new Map();
  for (const [path, text] of Object.entries(files)) rootTree.set(path, await putBlob(enc(text)));
  const rootTreeSha = id("t");
  trees.set(rootTreeSha, rootTree);
  let head = id("c");
  commits.set(head, { tree: rootTreeSha, parents: [], message: "initial" });
  const log = { commits: [], blobUploads: 0, refUpdates: 0, blobReads: 0 };
  let moved = false;

  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const { pathname } = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    const m = pathname.replace("/repos/o/r", "");
    if (method === "GET" && m === "/git/ref/heads/main") return json(200, { object: { sha: head } });
    if (method === "GET" && m.startsWith("/git/commits/")) return json(200, { tree: { sha: commits.get(m.split("/").pop()).tree } });
    if (method === "GET" && m.startsWith("/git/trees/")) {
      const t = trees.get(m.split("/").pop());
      return json(200, { truncated: false, tree: [...t].map(([path, sha]) => ({ path, sha, type: "blob" })) });
    }
    if (method === "GET" && m.startsWith("/git/blobs/")) {
      log.blobReads++;
      return json(200, { content: blobs.get(m.split("/").pop()), encoding: "base64" });
    }
    if (method === "POST" && m === "/git/blobs") {
      log.blobUploads++;
      return json(201, { sha: await putBlob(Buffer.from(body.content, "base64")) });
    }
    if (method === "POST" && m === "/git/trees") {
      const t = new Map(trees.get(body.base_tree));
      for (const e of body.tree) (e.sha === null ? t.delete(e.path) : t.set(e.path, e.sha));
      const sha = id("t");
      trees.set(sha, t);
      return json(201, { sha });
    }
    if (method === "POST" && m === "/git/commits") {
      const sha = id("c");
      commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return json(201, { sha });
    }
    if (method === "PATCH" && m === "/git/refs/heads/main") {
      log.refUpdates++;
      if (moveBranchOnce && !moved) {
        // Someone else committed meanwhile: the branch has moved on.
        moved = true;
        const other = id("c");
        commits.set(other, { tree: commits.get(head).tree, parents: [head], message: "someone else" });
        head = other;
        return json(422, { message: "Update is not a fast forward" });
      }
      if (commits.get(body.sha).parents[0] !== head) return json(422, { message: "Update is not a fast forward" });
      head = body.sha;
      log.commits.push(commits.get(head).message);
      return json(200, { object: { sha: head } });
    }
    throw new Error(`unexpected ${method} ${m}`);
  };
  const read = (path) => {
    const sha = trees.get(commits.get(head).tree).get(path);
    return sha === undefined ? undefined : Buffer.from(blobs.get(sha), "base64").toString("utf-8");
  };
  return { fetchImpl, log, read };
}

async function withFetch(impl, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

const target = { owner: "o", repo: "r", token: "t", branch: "main", message: "world2web: publish" };
const post = (uuid, body) => `---\n${JSON.stringify({ foundryUuid: uuid }, null, 2)}\n---\n${body}`;

test("gitBlobSha matches git's own blob ids", async () => {
  // `printf 'hello\n' | git hash-object --stdin`
  assert.equal(await gitBlobSha(enc("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("everything changed in a publish lands as ONE commit; unchanged files are skipped", async () => {
  const gh = await fakeGitHub({ "a.md": "same", "b.md": "old" });
  const result = await withFetch(gh.fetchImpl, () =>
    commitChanges({ ...target, writes: [{ path: "a.md", content: "same" }, { path: "b.md", content: "new" }, { path: "c.md", content: "added" }] }),
  );
  assert.deepEqual(result.written.sort(), ["b.md", "c.md"]);
  assert.equal(gh.log.commits.length, 1, "one commit");
  assert.equal(gh.log.blobUploads, 2, "only changed files uploaded");
  assert.equal(gh.read("b.md"), "new");
  assert.equal(gh.read("c.md"), "added");
});

test("nothing changed: no commit at all", async () => {
  const gh = await fakeGitHub({ "a.md": "same" });
  const result = await withFetch(gh.fetchImpl, () => commitChanges({ ...target, writes: [{ path: "a.md", content: "same" }] }));
  assert.deepEqual(result, { commit: null, written: [], deleted: [] });
  assert.equal(gh.log.refUpdates, 0);
});

test("binary writes, and ifMissing skips a content-addressed image that's already there", async () => {
  const gh = await fakeGitHub({ "public/assets/abc.png": "existing" });
  const result = await withFetch(gh.fetchImpl, () =>
    commitChanges({
      ...target,
      writes: [
        { path: "public/assets/abc.png", buffer: enc("different bytes").buffer, ifMissing: true },
        { path: "public/assets/new.png", buffer: new Uint8Array([0, 255, 1, 2]).buffer, ifMissing: true },
      ],
    }),
  );
  assert.deepEqual(result.written, ["public/assets/new.png"]);
});

test("deletions: removed in the same commit, but only when the file still belongs to that post", async () => {
  const gh = await fakeGitHub({ "gone.md": post("JournalEntry.j.JournalEntryPage.gone", "x"), "reclaimed.md": post("JournalEntry.j.JournalEntryPage.other", "y"), "keep.md": "k" });
  const result = await withFetch(gh.fetchImpl, () =>
    commitChanges({
      ...target,
      writes: [{ path: "keep.md", content: "k2" }],
      deletions: [
        { path: "gone.md", expectedUuid: "JournalEntry.j.JournalEntryPage.gone" },
        { path: "reclaimed.md", expectedUuid: "JournalEntry.j.JournalEntryPage.gone2" },
        { path: "never-existed.md", expectedUuid: "x" },
        { path: "keep.md", expectedUuid: "x" }, // written in this same commit: not deleted
      ],
    }),
  );
  assert.deepEqual(result.deleted, ["gone.md"]);
  assert.equal(gh.read("gone.md"), undefined);
  assert.ok(gh.read("reclaimed.md"), "a path another post now owns is left alone");
  assert.equal(gh.read("keep.md"), "k2");
  assert.equal(gh.log.commits.length, 1);
});

test("if the branch moves while building the commit, it's redone on top -- never overwriting", async () => {
  const gh = await fakeGitHub({ "a.md": "old" }, { moveBranchOnce: true });
  const result = await withFetch(gh.fetchImpl, () => commitChanges({ ...target, writes: [{ path: "a.md", content: "new" }] }));
  assert.ok(result.commit);
  assert.equal(gh.log.refUpdates, 2, "first attempt refused, second landed");
  assert.equal(gh.read("a.md"), "new");
});

test("a truncated tree (repo too large) fails clearly instead of publishing blind", async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const p = new URL(url).pathname;
    if (p.endsWith("/git/ref/heads/main")) return json(200, { object: { sha: "c1" } });
    if (p.includes("/git/commits/")) return json(200, { tree: { sha: "t1" } });
    return json(200, { truncated: true, tree: [] });
  };
  try {
    await assert.rejects(commitChanges({ ...target, writes: [{ path: "a.md", content: "x" }] }), /too large/);
  } finally {
    globalThis.fetch = prev;
  }
});
