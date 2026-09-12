/**
 * Read-only session-blog collector.
 *
 * Model: any journal entry can be a "blog" -- there's no folder-scoping
 * setting. An entry becomes one by being explicitly marked published via the
 * "Blog Publishing Settings" dialog on its sheet (see main.js), which stamps
 * `flags['world2web'] = { published, publishedAt, authorName,
 * authorImage, root, tags, postOrder }` on the entry itself -- publishedAt
 * is set once, on the first-ever save with `published` checked, and never
 * cleared after, the same first-publish/sticky pattern pages use (below).
 * That's what lets isPublishable() keep visiting an entry even after
 * `published` is later unchecked: unchecking it doesn't delete anything
 * (there's no way to, on GitHub), it needs one more publish to actually
 * retract what's already live -- see collectBlog()'s forceUnpublished.
 *
 * Each blog's pages are individual posts; a page only counts as a post once
 * explicitly published (via the publish button added to the page sheet):
 * publishing stamps `flags['world2web'] = { published: true,
 * publishedAt, updatedAt }` on the page, first-publish sets both
 * timestamps, every subsequent publish only bumps updatedAt. A page that's
 * never been published (no publishedAt) is a draft and never collected. A
 * page that WAS published and is now unpublished (published: false, but
 * publishedAt is set) IS still collected -- as a soft-deleted tombstone
 * (`unpublished: true`) -- since there's no way to delete an already-pushed
 * file from GitHub; see collectPost() below. The same tombstoning happens
 * to EVERY page under a blog whose own `published` flag is off, regardless
 * of that page's individual state -- the whole container going away should
 * mean everything under it goes away too.
 *
 * A blog's author is either Actor-backed or manual, not both:
 *  - Actor-backed: an explicit Actor override (`authorActorUuid`) if set,
 *    else the first non-GM Owner's own assigned character, if they have
 *    one. Name/portrait come from the Actor; biography comes from
 *    extractBiography() (biography.js) -- a per-system extractor, since
 *    Foundry's core Actor schema has no biography field at all (unlike
 *    name/img, which are universal). Falls back to "" for any system
 *    without a registered extractor, never an error.
 *  - Manual: an explicit `authorName` override with no Actor override --
 *    freeform name/image, no biography at all (there's no Actor to pull
 *    one from). This is what a GM's own posts use by default, unless the
 *    GM explicitly picks an Actor to author as instead (e.g. an NPC).
 *  - If neither applies (no override, and no non-GM Owner with an
 *    assigned character): falls back to that owner's bare Foundry
 *    username, or "Game Master" if there's no owner at all -- also no
 *    biography, same as the manual case, since there's still no Actor.
 *
 * A blog's root defaults to its containing folder's hierarchical path
 * (root-first, "Arc 1/Session Notes"); the dialog can override it with any
 * string. It's a URL path prefix, not just a label: render.js/sync/
 * ingest.js slugify it and prepend it to the blog's own slug (e.g. a root of
 * "Arc 1/Session Notes" makes a blog titled "Loose Ends" live at
 * /blogs/<world>/arc-1/session-notes/loose-ends/ instead of
 * /blogs/<world>/loose-ends/). Tags are a freeform list, entirely
 * user-defined, empty by default. postOrder controls only this blog's own
 * post-archive listing order ("manual", the default -- Foundry's own page
 * list order -- or "newest"/"oldest") -- every other listing site-wide
 * (recent posts, author/tag archives) always shows newest-published-first
 * regardless of a blog's own postOrder.
 *
 * A post can override its blog's author and/or tags individually, via its
 * own "Post Settings" dialog (see main.js) stamping the same
 * authorActorUuid/authorName/authorImage/tags shape onto the PAGE's own
 * flags instead of the entry's. Both are a full replace, not a merge, when
 * set -- there's no way to add one extra tag without retyping the whole
 * list, or to partially override an author. Left blank (the default),
 * both inherit the blog's own resolved value unchanged -- see
 * resolvePostAuthor()/resolvePostTags(). A post's front/featured image
 * (resolvePostFrontImage()) is a page-only concept with no blog-level
 * equivalent to inherit from -- explicit-only, "" when unset, never
 * auto-derived from the post's own body content.
 *
 * No hook wiring here -- this is invoked manually (see main.js) to
 * validate output shape end-to-end.
 */

import { extractBiography } from "./biography.js";

const NS = "world2web";

/** Whether this entry has ever been made a blog -- sticky, based on
 * publishedAt (stamped once, on the entry's first-ever "Publish this
 * journal as a blog" save; see main.js's openBlogConfigDialog), NOT the
 * live `published` boolean. This mirrors collectPost()'s own
 * publishedAt-gated inclusion: an entry that's since been turned back off
 * still needs to be visited by collectBlogData() so its already-live posts
 * on GitHub get tombstoned (unpublished: true) rather than silently
 * orphaned there forever (GitHub's Contents API has no delete step -- see
 * collectPost()). main.js also uses this to decide whether to keep showing
 * this entry's per-page publish controls at all, for the same reason -- an
 * unpublished-but-previously-published blog shouldn't lock the GM out of
 * managing its pages. */
export function isPublishable(entry) {
  return !!entry?.flags?.[NS]?.publishedAt;
}

// Foundry's built-in JournalEntryPage types this pipeline actually knows how
// to render as a post -- "pdf" and "video" (and any system/module-registered
// custom type) have no publish path at all. See main.js's per-page publish
// control, which refuses to publish these and tells the GM why instead of
// silently producing an empty post.
const PUBLISHABLE_PAGE_TYPES = new Set(["text", "image"]);

export function isPageTypePublishable(page) {
  return PUBLISHABLE_PAGE_TYPES.has(page?.type);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Any URI scheme prefix (http:, https:, data:, etc.) -- Foundry-relative
// Data paths never contain a colon before their first slash, so this is
// enough to tell "already absolute, leave alone" from "needs resolving".
function isAbsoluteUrl(src) {
  return /^[a-z][a-z0-9+.-]*:/i.test(src);
}

/** Resolves a Foundry-relative Data path (e.g.
 * "systems/dnd5e/icons/svg/actors/character.svg") to an absolute URL,
 * right here at collection time -- this code runs inside the live Foundry
 * client, so it's the one place in this whole pipeline that always knows
 * this world's real address for certain. Every consumer downstream (the
 * direct-to-GitHub push, and the site-template repo's scripts/ingest.js
 * local-preview path) would otherwise have to guess or be told that
 * address separately, and ingest.js in particular has no way to -- it
 * only ever sees the exported JSON, never a live `game`/`location`.
 * Resolved against `location.href` (not just `location.origin`) so a
 * subpath-hosted install (a custom ROUTE_PREFIX) still resolves
 * correctly, the same way the browser itself already resolves a bare
 * relative `<img src>` rendered directly inside Foundry's own UI.
 * Already-absolute URLs (external CDNs -- e.g. Forge-hosted module art at
 * assets.forge-vtt.com) and data: URIs pass through completely unchanged,
 * and so does a missing/empty path. */
function resolveAssetUrl(rawPath) {
  if (!rawPath || isAbsoluteUrl(rawPath)) return rawPath;
  return new URL(rawPath, location.href).href;
}

const IMG_SRC_RE = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;

/** Rewrites only <img> src values that need resolving, leaving everything
 * else -- including <img> tags whose src is already absolute -- entirely
 * byte-identical. Applied to a text page's raw ProseMirror HTML, since an
 * image pasted straight into the editor (rather than uploaded through
 * Foundry's own FilePicker) can carry either shape. */
function resolveImageSrcsInHtml(html) {
  if (!html.includes("<img")) return html;
  return html.replace(IMG_SRC_RE, (full, src) => {
    const resolved = resolveAssetUrl(src);
    return resolved === src ? full : full.replace(src, resolved);
  });
}

/** Renders a page's body to the site's raw-HTML-passthrough model. Text
 * pages are already ProseMirror-authored HTML, used verbatim apart from
 * resolving any <img src> in it (see resolveImageSrcsInHtml). Image pages
 * become a single <img> (wrapped in <figure>/<figcaption> when a caption is
 * set), src resolved the same way. Any other type returns "" --
 * collectPost() below never calls this for one (a page whose type isn't
 * publishable is excluded before rendering), so this is just a defensive
 * fallback, not a real path. */
function renderPageHtml(page) {
  if (page.type === "text") return resolveImageSrcsInHtml(page.text?.content ?? "");
  if (page.type === "image") {
    const caption = page.image?.caption?.trim?.() || "";
    const img = `<img src="${escapeHtml(resolveAssetUrl(page.src))}" alt="${escapeHtml(caption)}">`;
    return caption ? `<figure>${img}<figcaption>${escapeHtml(caption)}</figcaption></figure>` : img;
  }
  return "";
}

/** The computed default author, ignoring any override -- exported so
 * main.js's config dialog can show it as a placeholder. Includes the
 * resolved Actor itself (`actor`, null if none) alongside the
 * already-extracted name/image, so resolveBlogAuthor() below can pull a
 * biography from it without re-resolving the same owner/character
 * lookup. */
export function resolveDefaultAuthor(entry) {
  const ownership = entry.ownership ?? {};
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;

  for (const user of game.users.contents) {
    if (user.isGM) continue;
    const level = ownership[user.id] ?? ownership.default ?? 0;
    if (level < OWNER) continue;

    const character = user.character;
    return {
      userId: user.id,
      name: character?.name ?? user.name,
      image: resolveAssetUrl(character?.img ?? user.avatar ?? null),
      isGM: false,
      actor: character ?? null,
    };
  }

  return { userId: null, name: "Game Master", image: null, isGM: true, actor: null };
}

/** Shared by resolveBlogAuthor() and resolvePostAuthor() below -- an
 * explicit author override from a flags config object, in priority order:
 *  1. An explicit Actor override (`authorActorUuid`) -- authors as any
 *     Actor, not just the entry owner's own assigned character (e.g. a GM
 *     writing in an NPC's voice). Wins outright over the manual text
 *     override below; either specify an Actor or type a name/image, not
 *     both, keeping the two modes simple to reason about. A stale/invalid
 *     UUID (e.g. the Actor was since deleted) falls through to the next
 *     tier rather than erroring.
 *  2. An explicit manual `authorName` override (paired with `authorImage`,
 *     if any) -- no Actor, so no biography.
 * Returns null if neither is set, leaving what "no override" means up to
 * the caller (resolveBlogAuthor's own default chain, or a post inheriting
 * its blog's already-resolved author). Biography (biography.js's
 * extractBiography()) is populated only for the Actor-backed case -- ""
 * otherwise, always, never null/undefined. */
function resolveAuthorOverride(config) {
  const overrideUuid = config.authorActorUuid?.trim?.();
  if (overrideUuid) {
    const actor = fromUuidSync(overrideUuid);
    if (actor) {
      return {
        userId: null,
        name: actor.name,
        image: resolveAssetUrl(actor.img ?? null),
        isGM: false,
        bio: extractBiography(actor),
      };
    }
  }

  const overrideName = config.authorName?.trim?.() || "";
  if (overrideName) {
    return {
      userId: null,
      name: overrideName,
      image: resolveAssetUrl(config.authorImage?.trim?.() || null),
      isGM: false,
      bio: "",
    };
  }

  return null;
}

/** Override-aware author, in priority order:
 *  1. resolveAuthorOverride()'s two tiers (Actor UUID, then manual name/
 *     image).
 *  2. resolveDefaultAuthor()'s own fallback chain (owner's assigned
 *     character, then owner's bare username, then "Game Master"). */
export function resolveBlogAuthor(entry) {
  const config = entry.flags?.[NS] ?? {};
  const override = resolveAuthorOverride(config);
  if (override) return override;

  const defaultAuthor = resolveDefaultAuthor(entry);
  return {
    userId: defaultAuthor.userId,
    name: defaultAuthor.name,
    image: defaultAuthor.image,
    isGM: defaultAuthor.isGM,
    bio: extractBiography(defaultAuthor.actor),
  };
}

/** A post's own author, if its page has an explicit override (same two
 * tiers as resolveAuthorOverride, set via a "Post Settings" dialog
 * mirroring the blog's own -- see main.js); otherwise inherits the blog's
 * own already-resolved author entirely unchanged. Deliberately doesn't
 * re-derive resolveDefaultAuthor() per page -- "the entry owner's assigned
 * character" is a per-blog concept (ownership lives on the JournalEntry,
 * not the page), not something that varies post to post. */
function resolvePostAuthor(page, blogAuthor) {
  const config = page.flags?.[NS] ?? {};
  return resolveAuthorOverride(config) ?? blogAuthor;
}

// Guards against a corrupt/cyclic folder chain rather than looping forever.
const MAX_FOLDER_DEPTH = 20;

/** The computed default root: the entry's folder chain, root-first
 * ("Arc 1/Session Notes"), ignoring any override -- still raw folder names
 * here, not yet slugified (that happens downstream, at the same point the
 * blog's own title becomes its slug -- see render.js (here) or the site-template repo's scripts/ingest.js
 * assignSlugs). Foundry resolves a Folder's own `folder` field to the
 * parent Folder document directly (same ForeignDocumentField behavior
 * already relied on for entry.folder itself), so no separate folder lookup/
 * collection is needed. Exported so main.js's config dialog can show it as
 * a placeholder. */
export function resolveDefaultRoot(entry) {
  const names = [];
  let folder = entry.folder;
  let depth = 0;
  while (folder && depth < MAX_FOLDER_DEPTH) {
    names.push(folder.name);
    folder = folder.folder;
    depth += 1;
  }
  return names.reverse().join("/") || null;
}

/** Override-aware root: an explicit `root` on the entry's flags replaces
 * the computed default entirely; otherwise falls back to
 * resolveDefaultRoot(). */
export function resolveRoot(entry) {
  const config = entry.flags?.[NS] ?? {};
  const override = config.root?.trim?.() || "";
  return override || resolveDefaultRoot(entry);
}

export function resolveTags(entry) {
  const tags = entry.flags?.[NS]?.tags;
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t).trim()).filter(Boolean);
}

/** A post's own tag list, if its page set one -- fully replaces the
 * blog's tags for this post, doesn't merge with them (an explicit design
 * choice: simpler to reason about than a union, consistent with how the
 * author override is a full replace too). A page whose tags resolve to
 * empty (unset, or a blank field) inherits the blog's tags unchanged --
 * same "blank = inherit the blog-level default" convention every other
 * override in this module already uses, so there's deliberately no way to
 * give one specific post zero tags while its blog has some. */
function resolvePostTags(page, blogTags) {
  const tags = page.flags?.[NS]?.tags;
  if (!Array.isArray(tags)) return blogTags;
  const resolved = tags.map((t) => String(t).trim()).filter(Boolean);
  return resolved.length ? resolved : blogTags;
}

/** A post's own explicit front/featured image -- a Foundry-relative path
 * or an already-absolute URL, resolved to an absolute URL the same way as
 * every other image reference in this pipeline (see resolveAssetUrl).
 * Deliberately explicit-only: never auto-derived from the post's own body
 * content (which could easily pick an unintended image, e.g. a small
 * inline icon, as the "featured" one). "" (never null) when unset, same
 * empty-string convention as biography.js. No blog-level equivalent --
 * unlike author/tags, a "blog's front image" isn't a concept this model
 * has, so there's nothing to inherit from. */
function resolvePostFrontImage(page) {
  return resolveAssetUrl(page.flags?.[NS]?.frontImage?.trim?.() || "");
}

const POST_ORDERS = new Set(["newest", "oldest", "manual"]);

/** How this blog's own post-archive page orders its posts -- independent
 * of every other listing site-wide (recent posts, author/tag archives),
 * which always show newest-published-first regardless of this setting.
 * "manual" (the default) means the exact order pages appear in Foundry's
 * own page list (drag-to-reorder, page.sort) -- see collectPost()'s
 * sortIndex field. Anything other than a recognized value (unset, or a
 * bad value from outside the dialog) falls back to "manual" too. */
export function resolvePostOrder(entry) {
  const order = entry.flags?.[NS]?.postOrder;
  return POST_ORDERS.has(order) ? order : "manual";
}

/** A page that's never been published at all (no publishedAt on record) is
 * a plain draft and is excluded entirely, same as before. A page that WAS
 * published but is now unpublished is still collected -- with
 * `unpublished: true` -- rather than dropped, because there's no way to
 * delete an already-pushed file from GitHub (github.js's putFile only ever
 * creates or updates). This is a soft delete: render.js (here) and the site-template repo's scripts/ingest.js
 * still write the file (a tombstone, content and all, still in git
 * history), and the site's content-collection queries
 * (the site repo's src/lib/posts.ts's getPublishedPosts()) filter out anything with
 * that flag set, so it never actually renders anywhere on the live site.
 *
 * A page whose type isn't publishable (see isPageTypePublishable) is
 * excluded the same as a draft, even if publishedAt is somehow set -- the
 * per-page publish control in main.js refuses to publish these going
 * forward, so this only matters for a page whose type changed after being
 * published under an older rule; better to drop it silently than push an
 * empty-body post.
 *
 * forceUnpublished is set by collectBlog() when the *parent entry's* own
 * `published` flag is currently off -- the whole blog container
 * disappearing should mean everything under it disappears from the site
 * too, not just whichever pages happen to already be individually
 * unpublished. Without this, unchecking "Publish this journal as a blog"
 * would silently orphan every already-live post under it on GitHub
 * forever (see isPublishable()'s doc comment).
 *
 * sortIndex is Foundry's own page.sort -- its native drag-to-reorder
 * position within the entry's page list, entirely independent of
 * publishedAt/updatedAt. Only consumed site-side when a blog's postOrder
 * is "manual" (see resolvePostOrder()); collected unconditionally here
 * since it costs nothing to include. Read fresh on every publish, so
 * reordering pages in Foundry and clicking Publish to Web again is enough
 * to pick up the new order -- no need to re-touch each page's own publish
 * state.
 *
 * author/tags/frontImage: see resolvePostAuthor()/resolvePostTags()/
 * resolvePostFrontImage() above -- author and tags fall back to the
 * blog's own already-resolved values (blogAuthor/blogTags, passed down
 * from collectBlog() so they're only resolved once per blog, not once per
 * post) when the page has no override of its own; frontImage has no
 * blog-level equivalent to fall back to, so it's just "" when unset. */
function collectPost(page, forceUnpublished, blogAuthor, blogTags) {
  const publish = page.flags?.[NS];
  if (!publish?.publishedAt) return null;
  if (!isPageTypePublishable(page)) return null;

  return {
    uuid: page.uuid,
    title: page.name,
    html: renderPageHtml(page),
    author: resolvePostAuthor(page, blogAuthor),
    tags: resolvePostTags(page, blogTags),
    frontImage: resolvePostFrontImage(page),
    sortIndex: page.sort ?? 0,
    publishedAt: publish.publishedAt,
    updatedAt: publish.updatedAt ?? publish.publishedAt,
    unpublished: forceUnpublished || !publish.published,
  };
}

function collectBlog(entry) {
  // See collectPost()'s forceUnpublished doc comment.
  const blogCurrentlyOff = !entry.flags?.[NS]?.published;
  const blogAuthor = resolveBlogAuthor(entry);
  const blogTags = resolveTags(entry);
  const posts = entry.pages.contents
    .map((page) => collectPost(page, blogCurrentlyOff, blogAuthor, blogTags))
    .filter(Boolean);
  posts.sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0));

  return {
    uuid: entry.uuid,
    title: entry.name,
    author: blogAuthor,
    root: resolveRoot(entry),
    tags: blogTags,
    postOrder: resolvePostOrder(entry),
    postCount: posts.length,
    posts,
  };
}

/** Site-wide settings (theme, site name, blogs URL segment), read the same
 * way main.js's publishToGitHub() reads them for buildSiteConfigFile() --
 * included here too so the "Dev Sync" download (and the site-template repo's scripts/ingest.js, which
 * only ever sees that downloaded JSON, never a live game.settings) has a
 * way to reach content/site-config.json at all, not just the
 * direct-to-GitHub path. */
function collectSiteConfig() {
  return {
    theme: game.settings.get(NS, "siteTheme") || "default",
    siteName: game.settings.get(NS, "siteName") || "World2Web",
    blogsSegment: game.settings.get(NS, "blogsSegment") || "journals",
    allowThemeOverride: !!game.settings.get(NS, "allowThemeOverride"),
  };
}

/** Collect every journal entry explicitly marked published (via the "Blog
 * Publishing Settings" dialog on the entry sheet, see main.js) as a blog
 * with its published pages as posts, and return a JSON-serializable
 * payload. Read-only: touches nothing.
 *
 * scopedToCaller (for a player's own "Publish to Web," see main.js's
 * "Player self-publish" section -- never set for the GM's, which always
 * means everything): restricts this to entries the *current* user
 * (`entry.isOwner`, Foundry's own always-correct-for-this-client
 * permission getter) actually owns. Deliberately not a userId parameter
 * resolved against a raw ownership map -- this only ever needs to answer
 * "does the browser calling this own it," which is exactly what
 * `isOwner` already computes correctly, without this file reimplementing
 * Foundry's own permission-level-inheritance rules (ownership[userId] ??
 * ownership.default, and whatever else a future Foundry version adds to
 * that) itself. */
export function collectBlogData({ scopedToCaller = false } = {}) {
  let entries = game.journal.contents.filter(isPublishable);
  if (scopedToCaller) entries = entries.filter((entry) => entry.isOwner);
  const blogs = entries.map(collectBlog);

  return {
    generatedAt: new Date().toISOString(),
    world: { id: game.world.id, title: game.world.title },
    foundryVersion: game.version,
    collectorVersion: game.modules.get(NS)?.version ?? null,
    siteConfig: collectSiteConfig(),
    blogCount: blogs.length,
    blogs,
  };
}

/** Trigger a file download of the collected payload as JSON, via Foundry's
 * own saveDataToFile() helper -- see foundry-module/README.md for why this
 * is used over a hand-rolled Blob/anchor download. */
export function downloadBlogData() {
  const payload = collectBlogData();
  const json = JSON.stringify(payload, null, 2);
  const stamp = payload.generatedAt.replace(/[:.]/g, "-");
  const filename = `world2web-${payload.world.id}-${stamp}.json`;

  const saveDataToFile = foundry?.utils?.saveDataToFile ?? globalThis.saveDataToFile;
  if (typeof saveDataToFile !== "function") {
    throw new Error("world2web | saveDataToFile() is unavailable in this Foundry version");
  }
  saveDataToFile(json, "application/json", filename);

  return payload;
}
