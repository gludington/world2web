/**
 * Content-addresses images referenced by a `collectJournalData()` payload -- each post's own
 * author portrait, its front image, and any `<img>` pasted into its content -- so the published
 * site doesn't depend on the Foundry server staying online to serve them (directly undermines
 * "readable even when the world isn't running" otherwise, which is the whole point of this
 * project).
 *
 * The extraction/rewrite/hashing logic here is pure string manipulation and Node-testable; only
 * {@link fetchAsset}/{@link collectAssets} need browser APIs (`fetch`, `crypto.subtle`,
 * `atob`/`btoa`), all of which Foundry's client provides natively -- no Node `fs`, since this runs
 * inside Foundry, not the site-template repo's `scripts/ingest.js`.
 *
 * Scope note: this only wires into the direct GitHub-push path (main.js's `publishToGitHub`), not
 * the site-template repo's `scripts/ingest.js` local file-writing path -- `ingest.js` runs as a
 * detached Node script with no access to a live Foundry server to fetch images from.
 */

import { mapWithConcurrency } from "./concurrency.js";

// Deliberately a plain regex, not DOMParser: DOMParser reserializes the
// whole HTML string (attribute quoting/ordering can shift even when
// nothing meaningful changed), which would make github.js's
// content-unchanged no-op detection think every post with an image changed
// on every single publish. A surgical src-only string replace keeps
// untouched HTML byte-identical.
const IMG_SRC_RE = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;

/**
 * @param {string} html
 * @returns {string[]} Every distinct `<img src>` value found, in first-seen order. Never
 *   `null`/`undefined`; `[]` if `html` has no `<img>` tags.
 */
export function extractImageSrcs(html) {
  const srcs = new Set();
  for (const match of html.matchAll(IMG_SRC_RE)) srcs.add(match[1]);
  return [...srcs];
}

/**
 * Replaces only the `src` attribute value for any `<img>` whose current `src` is a key in
 * `urlMap`; everything else (including `<img>` tags not in `urlMap`, e.g. a fetch that failed) is
 * left byte-identical.
 *
 * @param {string} html
 * @param {Map<string, string>} urlMap Original URL -> local `/assets/<hash>.<ext>` path.
 * @returns {string} Never `null`/`undefined`. Returns `html` unchanged (same reference) as a fast
 *   path when it contains no `<img>` at all.
 */
export function rewriteImageSrcs(html, urlMap) {
  if (!html.includes("<img")) return html;
  return html.replace(IMG_SRC_RE, (full, src) => {
    const local = urlMap.get(src);
    return local ? full.replace(src, local) : full;
  });
}

/**
 * Every image URL referenced anywhere in the payload: each post's own (already-resolved, per
 * collector.js's `resolvePostAuthor`) author portrait, its front image (if any), and every
 * `<img src>` in its HTML. Deliberately scanned per-post, not per-journal, off `journal.author` --
 * a post can override its own author (and front image has no journal-level equivalent at all), so
 * `journal.author.image` alone would miss any image reachable only through a post-level override.
 *
 * Skips any post with `unpublished: true` -- collector.js keeps a full post object around for
 * these (html, author, frontImage and all) purely to write its tombstone stub, since there's no
 * way to delete an already-pushed file from GitHub, but that stub is never actually rendered
 * anywhere on the live site (`getPublishedPosts()` filters it out site-side). Fetching and
 * re-uploading its images on every single publish forever, for content nobody can ever see, is
 * pure waste -- skipping them here just leaves whatever image references that post's markdown
 * already has (harmless, since nothing renders it). A URL also used by some other, still-published
 * post is unaffected: it gets collected via that post instead, same as always.
 *
 * @param {object} payload A payload from `collectJournalData()` (see collector.js).
 * @returns {string[]} Every distinct referenced URL. Never `null`/`undefined`; `[]` if the payload
 *   has no published posts with images.
 */
export function collectAssetUrls(payload) {
  const urls = new Set();
  for (const journal of payload.journals ?? []) {
    for (const post of journal.posts ?? []) {
      if (post.unpublished) continue;
      if (post.author?.image) urls.add(post.author.image);
      if (post.frontImage) urls.add(post.frontImage);
      for (const src of extractImageSrcs(post.html ?? "")) urls.add(src);
    }
  }
  return [...urls];
}

/**
 * Rewrites every post's `author.image`, `frontImage`, and `post.html` `<img src>` in the payload
 * **in place**, using `urlMap` (original URL -> local `/assets/<hash>.<ext>` path). References not
 * in `urlMap` (fetch failed, or something we chose not to handle) are left pointing at Foundry
 * unchanged -- same as before this feature existed, not a new failure. Safe even when several
 * posts share the same author object by reference (the common "no override, inherits the
 * journal's" case) -- rewriting one post's `author.image` in place is visible to every post
 * sharing that object, and `urlMap.has()` on an already-rewritten (local) path is simply `false`
 * for the rest, a harmless no-op.
 *
 * @param {object} payload A payload from `collectJournalData()` (see collector.js). Mutated in
 *   place; not returned.
 * @param {Map<string, string>} urlMap Original URL -> local `/assets/<hash>.<ext>` path (see
 *   {@link collectAssets}).
 * @returns {void}
 */
export function rewriteAssetReferences(payload, urlMap) {
  for (const journal of payload.journals ?? []) {
    for (const post of journal.posts ?? []) {
      if (post.author?.image && urlMap.has(post.author.image)) {
        post.author.image = urlMap.get(post.author.image);
      }
      if (post.frontImage && urlMap.has(post.frontImage)) {
        post.frontImage = urlMap.get(post.frontImage);
      }
      post.html = rewriteImageSrcs(post.html ?? "", urlMap);
    }
  }
}

const EXT_BY_CONTENT_TYPE = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * @param {string} url The asset's own URL -- checked first for a plausible extension.
 * @param {string} contentType An HTTP `Content-Type` header value, or `""`/anything unrecognized --
 *   used only if `url` itself has no usable extension.
 * @returns {string} Never `null`/`undefined`; `"bin"` if neither `url` nor `contentType` yields a
 *   usable extension.
 */
export function guessExtension(url, contentType) {
  const fromUrl = url.split("?")[0].split(".").pop()?.toLowerCase();
  if (fromUrl && /^[a-z0-9]{2,5}$/.test(fromUrl)) return fromUrl;
  return EXT_BY_CONTENT_TYPE[contentType] ?? "bin";
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {string} `buffer`'s bytes as lowercase hex. Never `null`/`undefined`; `""` if `buffer`
 *   is empty.
 */
export function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>} `buffer`'s SHA-256 digest as lowercase hex. Never
 *   `null`/`undefined`.
 */
export async function sha256Hex(buffer) {
  return bufferToHex(await crypto.subtle.digest("SHA-256", buffer));
}

/**
 * @param {string} base64
 * @returns {ArrayBuffer} Never `null`/`undefined`.
 */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const DATA_URI_RE = /^data:([^;,]*)(;base64)?,(.*)$/s;

/**
 * Fetches (or decodes, for `data:` URIs pasted directly into ProseMirror -- no network round-trip
 * needed) a single asset's bytes and content type.
 *
 * @param {string} url An absolute URL, or a `data:` URI.
 * @returns {Promise<{buffer: ArrayBuffer, contentType: string}>} `contentType` is the decoded
 *   MIME type for a `data:` URI, or the response's own `Content-Type` header for a real fetch --
 *   `""` (never `null`/`undefined`) if that header is missing.
 * @throws {Error} If a real (non-`data:`) fetch's response isn't OK (non-2xx).
 */
export async function fetchAsset(url) {
  const dataUriMatch = url.match(DATA_URI_RE);
  if (dataUriMatch) {
    const [, contentType, isBase64, data] = dataUriMatch;
    const buffer = isBase64
      ? base64ToArrayBuffer(data)
      : new TextEncoder().encode(decodeURIComponent(data)).buffer;
    return { buffer, contentType };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const buffer = await res.arrayBuffer();
  return { buffer, contentType: res.headers.get("content-type") ?? "" };
}

// A handful at a time -- enough to actually speed up a publish with
// hundreds of images (this was the dominant cost in a real publish
// taking 9+ minutes: fetching, hashing, then existence-checking every
// image strictly one at a time), without hammering either Foundry's own
// server or GitHub hard enough to trip rate limiting.
const ASSET_FETCH_CONCURRENCY = 6;

/**
 * Fetches/decodes and content-addresses every asset URL referenced in the payload, up to
 * {@link ASSET_FETCH_CONCURRENCY} at a time. A failed fetch is logged and simply omitted -- one
 * bad image doesn't fail the whole publish. Deliberately not cached across publishes the way
 * `pushFiles`' text-content hashes are (see github.js) -- an image is fetched from an
 * independently-mutable external source (Foundry's own server, or an external CDN), not generated
 * by this pipeline's own code, so there's no way to know its current bytes without actually
 * fetching them; trusting a cached hash here risks missing a real content change silently.
 *
 * @param {object} payload A payload from `collectJournalData()` (see collector.js).
 * @returns {Promise<{urlMap: Map<string, string>, files: {path: string, buffer: ArrayBuffer}[]}>}
 *   `urlMap` (original URL -> local `/assets/<hash>.<ext>` path) is for
 *   {@link rewriteAssetReferences}; `files` is ready to push (see github.js's
 *   `putBinaryAssetIfMissing`). Both are empty if the payload has no images, or if every fetch
 *   failed -- never `null`/`undefined` themselves.
 */
export async function collectAssets(payload) {
  const urls = collectAssetUrls(payload);
  const urlMap = new Map();
  const files = [];

  const results = await mapWithConcurrency(urls, ASSET_FETCH_CONCURRENCY, async (url) => {
    try {
      const { buffer, contentType } = await fetchAsset(url);
      const hash = await sha256Hex(buffer);
      const ext = guessExtension(url, contentType);
      return { url, filename: `${hash}.${ext}`, buffer };
    } catch (err) {
      console.warn(`world2web | Skipping asset ${url}:`, err);
      return null;
    }
  });

  for (const result of results) {
    if (!result) continue;
    urlMap.set(result.url, `/assets/${result.filename}`);
    files.push({ path: `public/assets/${result.filename}`, buffer: result.buffer });
  }

  return { urlMap, files };
}
