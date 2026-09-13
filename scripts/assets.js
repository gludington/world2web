/**
 * Content-addresses images referenced by a collectJournalData() payload --
 * each post's own author portrait, its front image, and any <img> pasted
 * into its content -- so the published site doesn't depend on the
 * Foundry server staying online to serve them (directly undermines
 * "readable even when the world isn't running" otherwise, which is the
 * whole point of this project).
 *
 * The extraction/rewrite/hashing logic here is pure string manipulation and
 * Node-testable; only fetchAsset()/collectAssets() need browser APIs
 * (fetch, crypto.subtle, atob/btoa), all of which Foundry's client provides
 * natively -- no Node fs, since this runs inside Foundry, not the site-template repo's scripts/ingest.js.
 *
 * Scope note: this only wires into the direct GitHub-push path
 * (main.js's publishToGitHub), not the site-template repo's scripts/ingest.js local file-writing
 * path -- ingest.js runs as a detached Node script with no access to a live
 * Foundry server to fetch images from.
 */

import { mapWithConcurrency } from "./concurrency.js";

// Deliberately a plain regex, not DOMParser: DOMParser reserializes the
// whole HTML string (attribute quoting/ordering can shift even when
// nothing meaningful changed), which would make github.js's
// content-unchanged no-op detection think every post with an image changed
// on every single publish. A surgical src-only string replace keeps
// untouched HTML byte-identical.
const IMG_SRC_RE = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;

export function extractImageSrcs(html) {
  const srcs = new Set();
  for (const match of html.matchAll(IMG_SRC_RE)) srcs.add(match[1]);
  return [...srcs];
}

/** Replace only the src attribute value for any <img> whose current src is
 * a key in urlMap; everything else (including <img> tags not in urlMap,
 * e.g. a fetch that failed) is left byte-identical. No-op fast path when
 * there's no <img> at all, for the common no-images case. */
export function rewriteImageSrcs(html, urlMap) {
  if (!html.includes("<img")) return html;
  return html.replace(IMG_SRC_RE, (full, src) => {
    const local = urlMap.get(src);
    return local ? full.replace(src, local) : full;
  });
}

/** Every image URL referenced anywhere in the payload: each post's own
 * (already-resolved, per collector.js's resolvePostAuthor) author
 * portrait, its front image (if any), and every <img src> in its html.
 * Deliberately scanned per-post, not per-journal, off journal.author -- a post
 * can override its own author (and front image has no journal-level
 * equivalent at all), so journal.author.image alone would miss any image
 * reachable only through a post-level override.
 *
 * Skips any post with unpublished: true -- collector.js keeps a full post
 * object around for these (html, author, frontImage and all) purely to
 * write its tombstone stub, since there's no way to delete an
 * already-pushed file from GitHub, but that stub is never actually
 * rendered anywhere on the live site (getPublishedPosts() filters it out
 * site-side). Fetching and re-uploading its images on every single
 * publish forever, for content nobody can ever see, is pure waste --
 * skipping them here just leaves whatever image references that post's
 * markdown already has (harmless, since nothing renders it). A URL also
 * used by some other, still-published post is unaffected: it gets
 * collected via that post instead, same as always. Deduped. */
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

/** Rewrite every post's author.image, frontImage, and post.html <img src>
 * in the payload in-place, using urlMap (original url -> local
 * /assets/<hash>.<ext> path). References not in urlMap (fetch failed, or
 * something we chose not to handle) are left pointing at Foundry
 * unchanged -- same as before this feature existed, not a new failure.
 * Safe even when several posts share the same author object by reference
 * (the common "no override, inherits the journal's" case) -- rewriting one
 * post's author.image in place is visible to every post sharing that
 * object, and urlMap.has() on an already-rewritten (local) path is
 * simply false for the rest, a harmless no-op. */
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

export function guessExtension(url, contentType) {
  const fromUrl = url.split("?")[0].split(".").pop()?.toLowerCase();
  if (fromUrl && /^[a-z0-9]{2,5}$/.test(fromUrl)) return fromUrl;
  return EXT_BY_CONTENT_TYPE[contentType] ?? "bin";
}

export function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(buffer) {
  return bufferToHex(await crypto.subtle.digest("SHA-256", buffer));
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const DATA_URI_RE = /^data:([^;,]*)(;base64)?,(.*)$/s;

/** Fetch (or decode, for data: URIs pasted directly into ProseMirror --
 * no network round-trip needed) a single asset's bytes + content type. */
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

/** Fetch/decode + content-address every asset URL referenced in the
 * payload, up to ASSET_FETCH_CONCURRENCY at a time. Returns
 * { urlMap, files }: urlMap for rewriteAssetReferences, files as
 * [{ path, buffer }] ready to push (see github.js's
 * putBinaryAssetIfMissing). A failed fetch is logged and simply omitted --
 * one bad image doesn't fail the whole publish. Deliberately not cached
 * across publishes the way pushFiles' text-content hashes are (see
 * github.js) -- an image is fetched from an independently-mutable
 * external source (Foundry's own server, or an external CDN), not
 * generated by this pipeline's own code, so there's no way to know its
 * current bytes without actually fetching them; trusting a cached hash
 * here risks missing a real content change silently. */
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
