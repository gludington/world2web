/**
 * Minimal GitHub Contents API client: create/update files in a repo over
 * plain REST (PAT bearer auth), no git CLI, no server of ours in the
 * middle. Runs directly in Foundry's browser context via the global fetch.
 *
 * One commit per file, not one atomic multi-file commit -- the Contents API
 * doesn't support atomic multi-file commits without dropping to the
 * lower-level Git Data API (tree/commit/ref plumbing). Fine for a
 * session-notes cadence (a handful of posts at a time); revisit if commit
 * spam in the repo's history becomes annoying.
 */

import { mapWithConcurrency } from "./concurrency.js";

const API_BASE = "https://api.github.com";

// Duplicated from assets.js rather than imported -- keeps this file
// self-contained as "the generic GitHub client," not coupled to the
// image-specific asset pipeline for a two-line utility.
function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(buffer) {
  return bufferToHex(await crypto.subtle.digest("SHA-256", buffer));
}

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

function toBase64Utf8(str) {
  // btoa() only handles Latin1 -- encode as UTF-8 bytes first.
  return btoa(unescape(encodeURIComponent(str)));
}

function fromBase64Utf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ""))));
}

/** The current file's sha + decoded content, or null if it doesn't exist
 * yet. sha is required by the Contents API to update an existing file
 * (omitted when creating a new one); content lets putFile skip writes that
 * wouldn't actually change anything. */
async function getExistingFile({ owner, repo, path, token, branch }) {
  const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodeURI(path)}${branch ? `?ref=${branch}` : ""}`;
  const res = await githubRequest("GET", url, token);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { sha: data.sha, content: fromBase64Utf8(data.content) };
}

async function putOnce({ owner, repo, path, content, message, token, branch, sha }) {
  const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodeURI(path)}`;
  return githubRequest("PUT", url, token, {
    message,
    content: toBase64Utf8(content),
    ...(branch ? { branch } : {}),
    ...(sha ? { sha } : {}),
  });
}

/** Create or update a single file via GitHub's Contents API. Returns null
 * (no-op) if the file already exists with byte-identical content, rather
 * than pushing an empty commit.
 *
 * With multiple users (GM + players) each able to publish, two people
 * editing the *same* post around the same moment is the one real race:
 * updating a file requires its current sha, and if someone else's write
 * landed first, GitHub rejects a stale-sha PUT with 409 rather than
 * silently overwriting it. Handled here with one retry against a freshly
 * re-fetched sha -- if that also 409s (a genuinely simultaneous double
 * publish), it's surfaced as an error rather than silently discarding
 * either person's change. */
export async function putFile({ owner, repo, path, content, message, token, branch }) {
  const existing = await getExistingFile({ owner, repo, path, token, branch });
  if (existing?.content === content) return null;

  let res = await putOnce({ owner, repo, path, content, message, token, branch, sha: existing?.sha });
  if (res.status === 409) {
    const retryExisting = await getExistingFile({ owner, repo, path, token, branch });
    if (retryExisting?.content === content) return null; // someone else already wrote this exact content
    res = await putOnce({ owner, repo, path, content, message, token, branch, sha: retryExisting?.sha });
  }
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// A single JSON flow-style object between --- fences, same shape as the
// site-template repo's scripts/ingest.js's toFrontmatter() writes -- kept
// in sync by hand if that shape ever changes.
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

/** Retracts an already-published post whose source *page was deleted* in
 * Foundry (as opposed to just unpublished via the checkbox -- see
 * collector.js's own tombstone handling for that case, which the
 * collector can do on its own since the document still exists there to
 * read a flag off of). A deleted page leaves nothing for collector.js to
 * ever visit again, so main.js instead fetches this file's own
 * already-correct frontmatter straight off GitHub and flips
 * `unpublished: true` (bumping `updatedAt`) directly -- there's no need
 * to reconstruct title/author/tags/anything else about the post, since
 * it's all already sitting right there.
 *
 * expectedUuid guards against a real race: a brand-new page published
 * with the same title (same journal/root) computes the identical slug/path
 * as whatever used to live there, and path disambiguation only ever
 * checks the *current* payload, never GitHub's history -- so if a
 * deletion and a same-slug republish land in the same publish run,
 * pushFiles() may have already overwritten this exact path with the new
 * page's fresh content by the time this runs. Checking the fetched
 * file's own `foundryUuid` against expectedUuid catches that: a mismatch
 * means the path's been reclaimed by unrelated, live content, not the
 * page being retracted, so this backs off entirely rather than
 * unpublishing someone else's post the moment it went live.
 *
 * Returns true on success, including the three "nothing left to do"
 * cases: the file's already gone entirely (someone/something removed it
 * some other way), it's already marked unpublished, or its UUID no
 * longer matches (see above). Returns false if the file doesn't parse as
 * this pipeline's own frontmatter shape (don't guess at a file we don't
 * recognize) or a write races another one (409) -- both meant to be
 * retried on the next publish, not treated as a hard failure that aborts
 * the whole run. */
export async function retractDeletedPost({ owner, repo, path, token, branch, expectedUuid }) {
  const existing = await getExistingFile({ owner, repo, path, token, branch });
  if (!existing) return true;

  const match = existing.content.match(FRONTMATTER_RE);
  if (!match) return false;
  let frontmatter;
  try {
    frontmatter = JSON.parse(match[1]);
  } catch {
    return false;
  }
  if (expectedUuid && frontmatter.foundryUuid !== expectedUuid) return true;
  if (frontmatter.unpublished) return true;

  const updated = {
    ...frontmatter,
    unpublished: true,
    updatedAt: Date.now(),
  };
  const content = `---\n${JSON.stringify(updated, null, 2)}\n---\n${match[2]}`;

  const res = await putOnce({
    owner,
    repo,
    path,
    content,
    message: `world2web: retract deleted page (${path})`,
    token,
    branch,
    sha: existing.sha,
  });
  if (res.status === 409) return false;
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  return true;
}

// A handful at a time for the read-only phase below -- see assets.js's
// ASSET_FETCH_CONCURRENCY for the same reasoning. NOT used for the actual
// writes -- see pushFiles' own doc comment for why concurrent writes are
// unsafe here in a way concurrent reads aren't.
const PUSH_CONCURRENCY = 6;

/** Push every {path, content} file to the repo. Returns { pushed, hashes }:
 * pushed is the list of paths actually created/updated (files already
 * confirmed up to date -- via knownHashes or a live fetch -- don't appear
 * here); hashes is knownHashes updated with every file this run confirmed
 * correct (pushed successfully, or found byte-identical), meant to be
 * persisted by the caller as this run's new baseline for next time.
 *
 * Two phases, deliberately not one: figuring out *which* files need
 * writing (a hash-cache check, or else a live GET+content-compare) is
 * read-only and safe to run up to PUSH_CONCURRENCY at a time. Actually
 * *writing* them is not -- each Contents-API PUT is its own commit that
 * has to fast-forward the branch's ref, and only one commit can advance a
 * given ref at a time. Running those concurrently doesn't produce a
 * *content* conflict on any single path (putFile's own 409 retry already
 * handles that one), it produces a *ref* conflict: file B's commit can
 * land while file A's PUT is still in flight, so by the time A's PUT
 * reaches GitHub, the ref has already moved out from under it -- 409,
 * "is at <B's new commit> but expected <the commit A started from>" (both
 * values are commit shas, not blob shas -- confirmed live against a real
 * 409 after this bug shipped in v0.20.0's concurrency change). A's own
 * retry doesn't help, since by the time it re-fetches and retries, yet
 * another sibling may have advanced the ref again. So: reads stay
 * concurrent, writes go back to strictly one at a time.
 *
 * knownHashes (optional, default {}): a { path: sha256hex(content) } map
 * of what was confirmed correct as of the last publish. A path whose
 * *current* content hashes the same as its entry here skips past putFile
 * entirely -- no GET to check, since there's nothing to check: this
 * pipeline is the only thing that ever writes these files (unlike an
 * asset fetched from an independently-mutable external source, see
 * assets.js's collectAssets for why that one isn't cached the same way),
 * so our own record of "I successfully wrote exactly this" is
 * authoritative. A path with no entry, or a changed hash, falls through
 * to putFile's existing GET-compare-PUT-retry dance unchanged -- this is
 * purely a fast path for "definitely already right," never a substitute
 * for actually checking when it isn't sure. */
export async function pushFiles({ owner, repo, token, branch, files, commitMessage, knownHashes = {} }) {
  const nextHashes = { ...knownHashes };
  const pushed = [];

  const candidates = await mapWithConcurrency(files, PUSH_CONCURRENCY, async (file) => {
    const hash = await sha256Hex(new TextEncoder().encode(file.content).buffer);
    if (knownHashes[file.path] === hash) return null; // already confirmed correct -- nothing to check
    return { file, hash };
  });

  for (const candidate of candidates) {
    if (!candidate) continue;
    const { file, hash } = candidate;
    const result = await putFile({
      owner,
      repo,
      path: file.path,
      content: file.content,
      message: commitMessage ?? `world2web: update ${file.path}`,
      token,
      branch,
    });
    nextHashes[file.path] = hash; // confirmed correct now, whether just-pushed or found unchanged
    if (result) pushed.push(file.path);
  }

  return { pushed, hashes: nextHashes };
}

function toBase64Binary(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000; // avoid a call-stack blowup from spreading a huge array into String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fileExists({ owner, repo, path, token, branch }) {
  const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodeURI(path)}${branch ? `?ref=${branch}` : ""}`;
  const res = await githubRequest("GET", url, token);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  return true;
}

/** Push a content-addressed binary asset (path includes its own hash --
 * see assets.js) if it doesn't already exist. Content-addressed paths are
 * immutable by construction: the same path always means the same bytes, so
 * this only ever needs an existence check, never the content-comparison or
 * sha-conflict-retry dance putFile does for text files that really can
 * change. A 409 here means someone else's publish created the exact same
 * hash-path a moment ago -- also a no-op, not an error, since by
 * construction it's the identical content. */
export async function putBinaryAssetIfMissing({ owner, repo, path, buffer, message, token, branch }) {
  if (await fileExists({ owner, repo, path, token, branch })) return null;

  const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodeURI(path)}`;
  const res = await githubRequest("PUT", url, token, {
    message,
    content: toBase64Binary(buffer),
    ...(branch ? { branch } : {}),
  });
  if (res.status === 409) return null;
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Push every {path, buffer} binary asset. Returns paths actually created
 * -- assets already present (by hash) are skipped.
 *
 * Same two-phase split as pushFiles, for the same reason: checking
 * existence is read-only and safe up to PUSH_CONCURRENCY at a time, but
 * each *creation* is its own commit racing to fast-forward the branch's
 * ref, so those go one at a time. This one used to be concurrent
 * end-to-end on the theory that content-addressed paths can't conflict --
 * true for *content*, but the ref race isn't a content conflict: two
 * different (unrelated) new assets landing at once still race the same
 * ref, and putBinaryAssetIfMissing's 409 handling treats any 409 as "must
 * already exist by construction" and silently no-ops -- which was
 * silently *dropping* assets that lost that race and were never actually
 * written, not just retrying slowly. Serializing writes removes the race
 * that made that assumption wrong. */
export async function pushBinaryAssets({ owner, repo, token, branch, files, commitMessage }) {
  const toCreate = await mapWithConcurrency(files, PUSH_CONCURRENCY, async (file) => {
    const exists = await fileExists({ owner, repo, path: file.path, token, branch });
    return exists ? null : file;
  });

  const pushed = [];
  for (const file of toCreate) {
    if (!file) continue;
    const result = await putBinaryAssetIfMissing({
      owner,
      repo,
      path: file.path,
      buffer: file.buffer,
      message: commitMessage ?? `world2web: add asset ${file.path}`,
      token,
      branch,
    });
    if (result) pushed.push(file.path);
  }
  return pushed;
}
