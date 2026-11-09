/**
 * Minimal GitHub client over plain REST (PAT bearer auth), no git CLI, no server of ours in the
 * middle. Runs directly in Foundry's browser context via the global `fetch`.
 *
 * Publishing lands each publish as a single commit through GitHub's Git Data API -- see
 * {@link commitChanges}. Also: reading a single file ({@link readRepoFile}) and a read-only
 * connection check ({@link checkRepoAccess}).
 */

import { mapWithConcurrency } from "./concurrency.js";

const API_BASE = "https://api.github.com";

/**
 * The GitHub repo/auth fields threaded through most functions in this file.
 *
 * @typedef {object} RepoTarget
 * @property {string} owner
 * @property {string} repo
 * @property {string} token A GitHub PAT (fine-grained, "Contents: Read and write").
 * @property {string} [branch] Defaults to the repo's own default branch when omitted.
 */

// Duplicated from assets.js rather than imported -- keeps this file
// self-contained as "the generic GitHub client," not coupled to the
// image-specific asset pipeline for a two-line utility.
/**
 * @param {ArrayBuffer} buffer
 * @returns {string} `buffer`'s bytes as lowercase hex. Never `null`/`undefined`.
 */
function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}


/**
 * @param {string} method
 * @param {string} url
 * @param {string} token A GitHub PAT.
 * @param {object} [body] JSON-serialized as the request body when present; omitted (a GET-style
 *   request) otherwise.
 * @returns {Promise<Response>} The raw `fetch` response -- callers check `.status`/`.ok`
 *   themselves.
 */
async function githubRequest(method, url, token, body) {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}


/**
 * @param {string} b64
 * @returns {string} The decoded UTF-8 text.
 */
function fromBase64Utf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ""))));
}

/**
 * @param {RepoTarget & {path: string}} args
 * @returns {Promise<{sha: string, content: string}|null>} `sha` (required by the Contents API to
 *   update an existing file; omitted when creating a new one) and the decoded content, or `null`
 *   if the file doesn't exist yet (a 404).
 * @throws {Error} On any other non-OK response.
 */
async function getExistingFile({ owner, repo, path, token, branch }) {
  const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodeURI(path)}${branch ? `?ref=${branch}` : ""}`;
  const res = await githubRequest("GET", url, token);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { sha: data.sha, content: fromBase64Utf8(data.content) };
}


/** Splits a post file into its JSON frontmatter (group 1) and body (group 2). */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

/** How many file uploads a publish runs at once. */
const PUSH_CONCURRENCY = 6;

/**
 * @param {ArrayBuffer} buffer
 * @returns {string} `buffer` base64-encoded, chunked to avoid a call-stack blowup from spreading a
 *   huge array into `String.fromCharCode`.
 */
function toBase64Binary(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}




/**
 * Reads one text file from the repo, or `null` if it doesn't exist.
 *
 * @param {RepoTarget & {path: string}} args
 * @returns {Promise<{sha: string, content: string}|null>}
 * @throws {Error} On any non-OK response other than a 404.
 */
export async function readRepoFile(args) {
  return getExistingFile(args);
}

/**
 * Verifies, without writing anything, that `token` can reach `owner/repo` and read `branch` --
 * run when the Setup Wizard saves, so a mistyped repo name, a token that was never granted this
 * repo under "Only select repositories", or a missing Contents permission shows up immediately
 * instead of as a confusing failure on the first Publish to Web.
 *
 * Two read-only calls: `GET /repos/{owner}/{repo}` (any token with access to the repo can make
 * it), then `GET /repos/{owner}/{repo}/branches/{branch}` (needs the token's Contents permission,
 * so a 403 there means the token lacks it). Can't confirm *write* access without writing, but the
 * wizard's token link pre-selects "Contents: Read and write", so read-only is the unlikely case.
 *
 * @param {RepoTarget} args `branch` defaults to `"main"`.
 * @returns {Promise<{ok: true} | {ok: false, reason: "missing-fields"|"bad-token"|"repo-not-found"|"no-contents-permission"|"branch-not-found"|"network"|"unexpected", status?: number}>}
 *   Never throws.
 */
export async function checkRepoAccess({ owner, repo, token, branch = "main" }) {
  if (!owner || !repo || !token) return { ok: false, reason: "missing-fields" };
  const base = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  try {
    const repoRes = await githubRequest("GET", base, token);
    if (repoRes.status === 401) return { ok: false, reason: "bad-token", status: 401 };
    // 404 covers both "no such repo" and "this token wasn't granted it" -- GitHub
    // deliberately doesn't distinguish the two.
    if (repoRes.status === 404 || repoRes.status === 403) {
      return { ok: false, reason: "repo-not-found", status: repoRes.status };
    }
    if (!repoRes.ok) return { ok: false, reason: "unexpected", status: repoRes.status };

    const branchRes = await githubRequest("GET", `${base}/branches/${encodeURIComponent(branch)}`, token);
    if (branchRes.status === 403) return { ok: false, reason: "no-contents-permission", status: 403 };
    if (branchRes.status === 404) return { ok: false, reason: "branch-not-found", status: 404 };
    if (!branchRes.ok) return { ok: false, reason: "unexpected", status: branchRes.status };
    return { ok: true };
  } catch {
    return { ok: false, reason: "network" };
  }
}

// --- Single-commit publishing ---------------------------------------------------
//
// A publish used to write each changed file with its own Contents-API call,
// and every call is its own commit -- so one publish meant dozens or hundreds
// of commits, a host build for each, and visitors could catch the site half-
// published between them. commitChanges() uses GitHub's lower-level Git Data
// API instead: read the branch's current tree once, work out locally which
// files actually differ (git identifies a file by a hash of its content, so
// unchanged files are skipped without downloading anything), upload only
// those, and land everything -- additions, changes and deletions -- as ONE
// commit, moving the branch in a single step.

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} The git blob id git would give these bytes:
 *   SHA-1 of `"blob <length>\0"` followed by the bytes, as lowercase hex.
 */
export async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const data = new Uint8Array(header.length + bytes.length);
  data.set(header, 0);
  data.set(bytes, header.length);
  return bufferToHex(await crypto.subtle.digest("SHA-1", data));
}

/** @returns {Uint8Array} A write's bytes: UTF-8 for `content`, as-is for `buffer`. */
function writeBytes(write) {
  return write.buffer !== undefined ? new Uint8Array(write.buffer) : new TextEncoder().encode(write.content);
}

/** @returns {Promise<any>} The parsed JSON body; throws with GitHub's message on a non-OK status. */
async function githubJson(method, url, token, body, what) {
  const res = await githubRequest(method, url, token, body);
  if (!res.ok) {
    const error = new Error(`GitHub ${what} failed: ${res.status} ${await res.text()}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/**
 * Whether the file at `blobSha` still belongs to the post with `expectedUuid` -- read from its
 * frontmatter. A path can be reclaimed by a different post (renames, title collisions), and that
 * post's file must never be deleted by mistake.
 */
async function blobBelongsTo({ base, token, blobSha, expectedUuid }) {
  const blob = await githubJson("GET", `${base}/git/blobs/${blobSha}`, token, undefined, "read blob");
  const text = fromBase64Utf8(String(blob.content ?? "").replace(/\s/g, ""));
  const match = text.match(FRONTMATTER_RE);
  if (!match) return false;
  try {
    return JSON.parse(match[1]).foundryUuid === expectedUuid;
  } catch {
    return false;
  }
}

const COMMIT_ATTEMPTS = 3;

/**
 * Lands a set of writes and deletions as a single commit on `branch`.
 *
 * - **writes**: `{path, content}` (text) or `{path, buffer}` (binary). Skipped when the repo already
 *   has identical bytes at that path. With `ifMissing: true` (content-addressed images, whose name
 *   *is* their content hash), skipped whenever the path exists at all.
 * - **deletions**: `{path, expectedUuid?}`. Skipped when the path doesn't exist, when this same
 *   commit writes to it, or -- given `expectedUuid` -- when the file there now belongs to a
 *   different post.
 *
 * If another commit lands on the branch while this one is being built, the whole thing is redone
 * against the new state, up to {@link COMMIT_ATTEMPTS} times.
 *
 * @param {RepoTarget & {writes?: object[], deletions?: object[], message: string}} args
 * @returns {Promise<{commit: string|null, written: string[], deleted: string[]}>} `commit` is
 *   `null` when nothing differed, so no commit was made.
 * @throws {Error} When GitHub refuses a step, or the branch kept moving for every attempt.
 */
export async function commitChanges({ owner, repo, token, branch = "main", writes = [], deletions = [], message }) {
  const base = `${API_BASE}/repos/${owner}/${repo}`;
  const refPath = `heads/${branch}`;

  for (let attempt = 1; ; attempt++) {
    const ref = await githubJson("GET", `${base}/git/ref/${refPath}`, token, undefined, "read branch");
    const headSha = ref.object.sha;
    const head = await githubJson("GET", `${base}/git/commits/${headSha}`, token, undefined, "read commit");
    const tree = await githubJson("GET", `${base}/git/trees/${head.tree.sha}?recursive=1`, token, undefined, "read tree");
    if (tree.truncated) throw new Error("GitHub returned a truncated file list for this repository; it's too large to publish to.");
    const existing = new Map(tree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));

    const changed = [];
    const writtenPaths = new Set();
    for (const write of writes) {
      writtenPaths.add(write.path);
      const current = existing.get(write.path);
      if (write.ifMissing && current) continue;
      const bytes = writeBytes(write);
      if (current && current === (await gitBlobSha(bytes))) continue;
      changed.push({ path: write.path, bytes });
    }

    const removed = [];
    for (const { path, expectedUuid } of deletions) {
      const current = existing.get(path);
      if (!current || writtenPaths.has(path)) continue;
      if (expectedUuid && !(await blobBelongsTo({ base, token, blobSha: current, expectedUuid }))) continue;
      removed.push(path);
    }

    if (!changed.length && !removed.length) return { commit: null, written: [], deleted: [] };

    const blobs = await mapWithConcurrency(changed, PUSH_CONCURRENCY, async ({ path, bytes }) => {
      const blob = await githubJson(
        "POST",
        `${base}/git/blobs`,
        token,
        { content: toBase64Binary(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), encoding: "base64" },
        `upload ${path}`,
      );
      return { path, mode: "100644", type: "blob", sha: blob.sha };
    });
    const newTree = await githubJson(
      "POST",
      `${base}/git/trees`,
      token,
      { base_tree: head.tree.sha, tree: [...blobs, ...removed.map((path) => ({ path, mode: "100644", type: "blob", sha: null }))] },
      "build tree",
    );
    const commit = await githubJson(
      "POST",
      `${base}/git/commits`,
      token,
      { message, tree: newTree.sha, parents: [headSha] },
      "create commit",
    );

    // Moves the branch only if it's still where we started (no force), so a
    // commit that landed meanwhile is never overwritten -- we redo against it.
    const res = await githubRequest("PATCH", `${base}/git/refs/${refPath}`, token, { sha: commit.sha, force: false });
    if (res.ok) return { commit: commit.sha, written: changed.map((c) => c.path), deleted: removed };
    if ((res.status === 422 || res.status === 409) && attempt < COMMIT_ATTEMPTS) continue;
    throw new Error(`GitHub update branch failed: ${res.status} ${await res.text()}`);
  }
}


