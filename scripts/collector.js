/**
 * Read-only session-post collector.
 *
 * Any journal entry can be published, via the "Publishing Settings" dialog on its sheet (see
 * main.js), which stamps `flags['world2web'] = { published, publishedAt, authorName, authorImage,
 * root, tags, postOrder }` on the entry. `publishedAt` is set once, on first publish, and never
 * cleared -- see {@link isPublishable} for why the collector keeps visiting an entry even after
 * `published` is unchecked.
 *
 * A journal's pages are its posts. A page counts as a post only once explicitly published (the
 * publish button on the page sheet stamps `flags['world2web'] = { published: true, publishedAt,
 * updatedAt }`); a never-published page is a draft and is excluded. A previously-published page
 * that's now unpublished is still collected, as a soft-deleted tombstone (`unpublished: true`),
 * since GitHub's Contents API has no delete step -- see {@link collectPost}. Unpublishing the
 * parent journal tombstones every page under it the same way, regardless of each page's own state.
 *
 * A journal's author is either Actor-backed or manual, never both:
 *  - Actor-backed: an explicit Actor override (`authorActorUuid`), else the first non-GM Owner's
 *    assigned character. Biography comes from {@link extractBiography} (per-system extractor,
 *    since Foundry's core Actor schema has no biography field); falls back to `""` for any system
 *    without one.
 *  - Manual: an explicit `authorName` override with no Actor -- freeform name/image, no biography.
 *  - Neither: falls back to the owner's bare Foundry username, or "Game Master" with no owner --
 *    also no biography.
 *
 * A journal's root defaults to its folder path ("Arc 1/Session Notes"), overridable with any
 * string. It's a URL path prefix, not just a label -- render.js/ingest.js slugify it and prepend
 * it to the journal's slug, so a root of "Arc 1/Session Notes" puts a journal at
 * `/journals/<world>/arc-1/session-notes/<slug>/` instead of `/journals/<world>/<slug>/`. Tags are
 * a freeform list. `postOrder` controls only this journal's own post-archive order ("manual" --
 * Foundry's own page order -- or "newest"/"oldest"); every other listing site-wide always shows
 * newest-first regardless.
 *
 * A post can override its journal's author and/or tags individually, via its own "Post Settings"
 * dialog stamping the same shape onto the page's own flags. Both are a full replace, not a merge;
 * left blank, both inherit the journal's resolved value -- see {@link resolvePostAuthor} and
 * {@link resolvePostTags}. A post's front image ({@link resolvePostFrontImage}) is explicit-only,
 * with no journal-level equivalent to inherit from.
 *
 * No hook wiring here -- this is invoked manually (see main.js) to validate output shape
 * end-to-end.
 */

import { extractBiography } from "./biography.js";

const NS = "world2web";

/**
 * A resolved author, as attached to a journal or a post. Never has any field missing -- a
 * not-applicable field is `null`/`""`, not omitted.
 *
 * @typedef {object} Author
 * @property {string|null} userId The Foundry User id this was resolved from, or `null` for a
 *   manual/Actor-backed override (there's no linked user) or the "Game Master" fallback.
 * @property {string} name Never `null`/`undefined`.
 * @property {string|null} image An absolute URL, or `null` if there's no portrait to show.
 * @property {boolean} isGM
 * @property {string} bio Raw HTML, from {@link extractBiography}. `""` (never `null`) if there's
 *   nothing to show.
 */

/**
 * A collected, publish-ready post.
 *
 * @typedef {object} Post
 * @property {string} uuid The page's own Foundry UUID.
 * @property {string} title
 * @property {string} html The rendered body. `""` (never `null`) if the page's type isn't
 *   renderable -- see {@link renderPageHtml}.
 * @property {Author} author
 * @property {string[]} tags Never `null`/`undefined`; can be `[]` only if the parent journal's own
 *   tags are `[]`.
 * @property {string} frontImage An absolute URL, or `""` (never `null`) if unset.
 * @property {number} sortIndex Foundry's own `page.sort` -- native drag-to-reorder position.
 * @property {number} publishedAt
 * @property {number} updatedAt
 * @property {boolean} unpublished Soft-delete tombstone -- see {@link collectPost}.
 */

/**
 * A collected, publish-ready journal, with its posts already collected.
 *
 * @typedef {object} Journal
 * @property {string} uuid The entry's own Foundry UUID.
 * @property {string} title
 * @property {Author} author
 * @property {string|null} root
 * @property {string[]} tags Never `null`/`undefined`; `[]` if none are set.
 * @property {"newest"|"oldest"|"manual"} postOrder
 * @property {number} postCount `posts.length`, provided directly so consumers don't need to
 *   compute it themselves.
 * @property {Post[]} posts Sorted chronologically by `publishedAt` ascending. `[]` if the journal
 *   has no published pages.
 */

/**
 * Whether this entry has ever been published -- sticky, based on `publishedAt`, not the live
 * `published` boolean. This mirrors {@link collectPost}'s own `publishedAt`-gated inclusion: an
 * entry turned back off still needs visiting so its already-live posts get tombstoned
 * (`unpublished: true`) rather than orphaned on GitHub forever. main.js also uses this to decide
 * whether to keep showing an entry's per-page publish controls, for the same reason.
 *
 * @param {JournalEntry} entry The Foundry native JournalEntry document to check.
 * @returns {boolean} Never `null`/`undefined`.
 */
export function isPublishable(entry) {
  return !!entry?.flags?.[NS]?.publishedAt;
}

// Foundry's built-in JournalEntryPage types this pipeline knows how to render as a post --
// "pdf"/"video" (and any custom type) have no publish path. main.js's per-page publish control
// refuses to publish these and tells the GM why, instead of silently producing an empty post.
const PUBLISHABLE_PAGE_TYPES = new Set(["text", "image"]);

/**
 * @param {JournalEntryPage} page The Foundry native JournalEntryPage document to check.
 * @returns {boolean} Never `null`/`undefined`.
 */
export function isPageTypePublishable(page) {
  return PUBLISHABLE_PAGE_TYPES.has(page?.type);
}

/**
 * @param {string} [str] The raw string to escape. `null`/`undefined` are treated as `""`.
 * @returns {string} `str` with `& < > "` escaped for safe use in an HTML attribute value. Never
 *   `null`/`undefined`; `""` if `str` was empty or absent.
 */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {string} src The path or URL to check.
 * @returns {boolean} Whether `src` already carries a URI scheme (`http:`, `data:`, etc.) --
 *   Foundry-relative Data paths never contain a colon before their first slash. Never
 *   `null`/`undefined`.
 */
function isAbsoluteUrl(src) {
  return /^[a-z][a-z0-9+.-]*:/i.test(src);
}

/**
 * Resolves a Foundry-relative Data path (e.g. "systems/dnd5e/icons/svg/actors/character.svg") to
 * an absolute URL, right here at collection time -- this code runs inside the live Foundry
 * client, the one place in this pipeline that always knows the world's real address. Every
 * downstream consumer (the direct-to-GitHub push, and the site-template repo's local-preview
 * `scripts/ingest.js`) would otherwise have to be told that address separately; `ingest.js` in
 * particular has no way to, since it only ever sees the exported JSON. Resolved against
 * `location.href` (not just `location.origin`) so a subpath-hosted install (a custom
 * ROUTE_PREFIX) still resolves correctly.
 *
 * @param {string|null|undefined} rawPath A Foundry-relative Data path, an already-absolute URL, a
 *   `data:` URI, or a falsy value (no image set).
 * @returns {string|null|undefined} The resolved absolute URL. If `rawPath` was falsy or already
 *   absolute, returns it completely unchanged instead -- so this can return `null`/`undefined` (or
 *   `""`) whenever `rawPath` itself was that same falsy value; it is NOT guaranteed to return a
 *   string.
 */
function resolveAssetUrl(rawPath) {
  if (!rawPath || isAbsoluteUrl(rawPath)) return rawPath;
  return new URL(rawPath, location.href).href;
}

const IMG_SRC_RE = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;

/**
 * Rewrites only `<img>` `src` values that need resolving, leaving everything else -- including
 * `<img>` tags whose `src` is already absolute -- byte-identical. Applied to a text page's raw
 * ProseMirror HTML, since an image pasted straight into the editor (rather than uploaded through
 * Foundry's FilePicker) can carry either shape.
 *
 * @param {string} html The raw HTML to process (a text page's ProseMirror content).
 * @returns {string} The same HTML with any resolvable `<img src>` rewritten. Never
 *   `null`/`undefined`; returns the exact same string if it contains no `<img>` tag at all.
 */
function resolveImageSrcsInHtml(html) {
  if (!html.includes("<img")) return html;
  return html.replace(IMG_SRC_RE, (full, src) => {
    const resolved = resolveAssetUrl(src);
    return resolved === src ? full : full.replace(src, resolved);
  });
}

/**
 * Renders a page's body to the site's raw-HTML-passthrough model. Text pages are already
 * ProseMirror-authored HTML, used verbatim apart from resolving `<img src>` (see
 * {@link resolveImageSrcsInHtml}). Image pages become a single `<img>` (wrapped in
 * `<figure>`/`<figcaption>` when a caption is set).
 *
 * @param {JournalEntryPage} page The Foundry native JournalEntryPage document to render.
 * @returns {string} The rendered HTML body. Never `null`/`undefined`; `""` if the page's type is
 *   neither "text" nor "image" -- a defensive fallback only, since {@link collectPost} never calls
 *   this for a non-publishable type.
 */
function renderPageHtml(page) {
  if (page.type === "text") return resolveImageSrcsInHtml(page.text?.content ?? "");
  if (page.type === "image") {
    const caption = page.image?.caption?.trim?.() || "";
    const img = `<img src="${escapeHtml(resolveAssetUrl(page.src))}" alt="${escapeHtml(caption)}">`;
    return caption ? `<figure>${img}<figcaption>${escapeHtml(caption)}</figcaption></figure>` : img;
  }
  return "";
}

/**
 * The computed default author, ignoring any override -- exported so main.js's config dialog can
 * show it as a placeholder.
 *
 * @param {JournalEntry} entry The Foundry native JournalEntry document to resolve an author for.
 * @returns {{userId: string|null, name: string, image: string|null, isGM: boolean, actor: Actor|null}}
 *   Same shape as {@link Author}, but with `actor` (the resolved Foundry native Actor document, or
 *   `null` if there's none to pull a biography from) instead of a pre-extracted `bio` -- so
 *   {@link resolveJournalAuthor} can extract one from it without re-resolving the same
 *   owner/character lookup. Never `null`/`undefined` as a whole; falls back to a Game-Master
 *   placeholder (`userId: null, name: "Game Master", image: null, isGM: true, actor: null`) when
 *   no qualifying owner is found.
 */
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

/**
 * Shared by {@link resolveJournalAuthor} and {@link resolvePostAuthor}: an explicit author
 * override from a flags config object, in priority order:
 *  1. An explicit Actor override (`authorActorUuid`) -- authors as any Actor, not just the entry
 *     owner's own assigned character (e.g. a GM writing in an NPC's voice). Wins outright over
 *     the manual text override below -- either specify an Actor or type a name/image, not both. A
 *     stale/invalid UUID (the Actor was since deleted) falls through to the next tier.
 *  2. An explicit manual `authorName` override (paired with `authorImage`, if any) -- no Actor, so
 *     no biography.
 *
 * @param {object} config An entry's or page's own `flags['world2web']` object, which may contain
 *   `authorActorUuid`/`authorName`/`authorImage` override fields.
 * @returns {Author|null} The resolved override (`userId` always `null`, `isGM` always `false`), or
 *   `null` if neither an Actor UUID nor a manual name override is set -- what "no override" means
 *   is left up to the caller ({@link resolveJournalAuthor}'s default chain, or a post inheriting
 *   its journal's already-resolved author).
 */
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

/**
 * Override-aware author, in priority order: {@link resolveAuthorOverride}'s two tiers, then
 * {@link resolveDefaultAuthor}'s own fallback chain (owner's assigned character, owner's bare
 * username, "Game Master").
 *
 * @param {JournalEntry} entry The Foundry native JournalEntry document to resolve an author for.
 * @returns {Author} Never `null`/`undefined` -- always a full author object.
 */
export function resolveJournalAuthor(entry) {
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

/**
 * A post's own author if its page has an explicit override (same two tiers as
 * {@link resolveAuthorOverride}, set via a "Post Settings" dialog mirroring the journal's own);
 * otherwise inherits the journal's already-resolved author unchanged. Deliberately doesn't
 * re-derive {@link resolveDefaultAuthor} per page -- "the entry owner's assigned character" is a
 * per-journal concept (ownership lives on the JournalEntry, not the page).
 *
 * @param {JournalEntryPage} page The Foundry native JournalEntryPage document to resolve an author
 *   for.
 * @param {Author} journalAuthor The parent journal's already-resolved author (see
 *   {@link resolveJournalAuthor}).
 * @returns {Author} Never `null`/`undefined` -- either the page's own override, or `journalAuthor`
 *   passed through unchanged.
 */
function resolvePostAuthor(page, journalAuthor) {
  const config = page.flags?.[NS] ?? {};
  return resolveAuthorOverride(config) ?? journalAuthor;
}

// Guards against a corrupt/cyclic folder chain rather than looping forever.
const MAX_FOLDER_DEPTH = 20;

/**
 * The computed default root: the entry's folder chain, root-first ("Arc 1/Session Notes"),
 * ignoring any override -- still raw folder names, not yet slugified (that happens downstream,
 * alongside the journal's own title -- see render.js's/ingest.js's `assignSlugs`). Foundry
 * resolves a Folder's own `folder` field to the parent Folder document directly, so no separate
 * lookup is needed. Exported so main.js's config dialog can show it as a placeholder.
 *
 * @param {JournalEntry} entry The Foundry native JournalEntry document to resolve a root for.
 * @returns {string|null} The joined folder path (e.g. "Arc 1/Session Notes"), or `null` if the
 *   entry isn't inside any folder.
 */
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

/**
 * Override-aware root: an explicit `root` on the entry's flags replaces the computed default
 * entirely; otherwise falls back to {@link resolveDefaultRoot}.
 *
 * @param {JournalEntry} entry The Foundry native JournalEntry document to resolve a root for.
 * @returns {string|null} The override if one is set; otherwise {@link resolveDefaultRoot}'s
 *   result -- so this can still be `null` when there's no override and the entry isn't in a
 *   folder.
 */
export function resolveRoot(entry) {
  const config = entry.flags?.[NS] ?? {};
  const override = config.root?.trim?.() || "";
  return override || resolveDefaultRoot(entry);
}

/**
 * @param {JournalEntry} entry The Foundry native JournalEntry document to read tags from.
 * @returns {string[]} The entry's own tags, trimmed and with blanks dropped. Never
 *   `null`/`undefined`; `[]` if unset or empty.
 */
export function resolveTags(entry) {
  const tags = entry.flags?.[NS]?.tags;
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t).trim()).filter(Boolean);
}

/**
 * A post's own tag list, if its page set one -- fully replaces the journal's tags, doesn't merge
 * with them (simpler to reason about than a union, consistent with the author override also being
 * a full replace). A page whose tags resolve to empty (unset, or a blank field) inherits the
 * journal's tags unchanged -- the same "blank = inherit" convention every override in this module
 * uses, so there's deliberately no way to give one specific post zero tags while its journal has
 * some (github.com/gludington/world2web/issues/2).
 *
 * @param {JournalEntryPage} page The Foundry native JournalEntryPage document to resolve tags for.
 * @param {string[]} journalTags The parent journal's already-resolved tags (see
 *   {@link resolveTags}).
 * @returns {string[]} Never `null`/`undefined`. The page's own trimmed, non-blank tags if it has
 *   any; otherwise `journalTags` passed through unchanged -- so this can only be `[]` if
 *   `journalTags` itself is `[]`, never as a way to explicitly zero out one post's tags.
 */
function resolvePostTags(page, journalTags) {
  const tags = page.flags?.[NS]?.tags;
  if (!Array.isArray(tags)) return journalTags;
  const resolved = tags.map((t) => String(t).trim()).filter(Boolean);
  return resolved.length ? resolved : journalTags;
}

/**
 * A post's own explicit front/featured image -- a Foundry-relative path or an already-absolute
 * URL, resolved the same way as every other image reference in this pipeline (see
 * {@link resolveAssetUrl}). Deliberately explicit-only: never auto-derived from the post's own
 * body content (which could easily pick an unintended image, e.g. a small inline icon). No
 * journal-level equivalent -- unlike author/tags, a journal doesn't have a front image to inherit
 * from.
 *
 * @param {JournalEntryPage} page The Foundry native JournalEntryPage document to read a front
 *   image from.
 * @returns {string} The resolved absolute URL. Never `null`/`undefined`; `""` if unset (unlike
 *   {@link resolveAssetUrl} in general, this is guaranteed to be a string, since the empty-string
 *   fallback is applied before calling it).
 */
function resolvePostFrontImage(page) {
  return resolveAssetUrl(page.flags?.[NS]?.frontImage?.trim?.() || "");
}

const POST_ORDERS = new Set(["newest", "oldest", "manual"]);

/**
 * How this journal's own post-archive page orders its posts -- independent of every other listing
 * site-wide (recent posts, author/tag archives), which always show newest-published-first
 * regardless. "manual" (the default) means the exact order pages appear in Foundry's own page
 * list (drag-to-reorder, `page.sort`) -- see {@link collectPost}'s `sortIndex`.
 *
 * @param {JournalEntry} entry The Foundry native JournalEntry document to read a post order from.
 * @returns {"newest"|"oldest"|"manual"} Never `null`/`undefined`; falls back to `"manual"` for any
 *   unset or unrecognized value (unset, or bad input from outside the dialog).
 */
export function resolvePostOrder(entry) {
  const order = entry.flags?.[NS]?.postOrder;
  return POST_ORDERS.has(order) ? order : "manual";
}

/**
 * Collects one page as a post, or returns `null` if it isn't collectible.
 *
 * A never-published page (no `publishedAt`) is a plain draft and excluded. A previously-published,
 * now-unpublished page is still collected -- with `unpublished: true` -- rather than dropped,
 * since there's no way to delete an already-pushed file from GitHub (`putFile` in github.js only
 * ever creates or updates). This is a soft delete: render.js and the site-template repo's
 * `scripts/ingest.js` still write the file (a tombstone, still in git history), and the site's own
 * content queries filter out anything with that flag set.
 *
 * A page whose type isn't publishable (see {@link isPageTypePublishable}) is excluded the same as
 * a draft, even if `publishedAt` is somehow set -- covers a page whose type changed after
 * publishing under an older rule.
 *
 * @param {JournalEntryPage} page The Foundry native JournalEntryPage document to collect.
 * @param {boolean} forceUnpublished Set by {@link collectJournal} when the parent entry's own
 *   `published` flag is currently off -- tombstones every page under it, not just ones already
 *   individually unpublished, so unchecking "Publish this journal to the web" doesn't silently
 *   orphan already-live posts on GitHub forever (see {@link isPublishable}).
 * @param {Author} journalAuthor The parent journal's already-resolved author (see
 *   {@link resolvePostAuthor}), passed down so it's resolved once per journal, not once per post.
 * @param {string[]} journalTags The parent journal's already-resolved tags (see
 *   {@link resolvePostTags}), same reasoning.
 * @returns {Post|null} `null` if the page has never been published or its type isn't publishable;
 *   otherwise a fully-populated {@link Post} -- none of its own fields are ever `null`/`undefined`.
 */
function collectPost(page, forceUnpublished, journalAuthor, journalTags) {
  const publish = page.flags?.[NS];
  if (!publish?.publishedAt) return null;
  if (!isPageTypePublishable(page)) return null;

  return {
    uuid: page.uuid,
    title: page.name,
    html: renderPageHtml(page),
    author: resolvePostAuthor(page, journalAuthor),
    tags: resolvePostTags(page, journalTags),
    frontImage: resolvePostFrontImage(page),
    sortIndex: page.sort ?? 0,
    publishedAt: publish.publishedAt,
    updatedAt: publish.updatedAt ?? publish.publishedAt,
    unpublished: forceUnpublished || !publish.published,
  };
}

/**
 * @param {JournalEntry} entry The Foundry native JournalEntry document to collect.
 * @returns {Journal} Never `null`/`undefined`.
 */
function collectJournal(entry) {
  // See collectPost()'s forceUnpublished doc comment.
  const journalCurrentlyOff = !entry.flags?.[NS]?.published;
  const journalAuthor = resolveJournalAuthor(entry);
  const journalTags = resolveTags(entry);
  const posts = entry.pages.contents
    .map((page) => collectPost(page, journalCurrentlyOff, journalAuthor, journalTags))
    .filter(Boolean);
  posts.sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0));

  return {
    uuid: entry.uuid,
    title: entry.name,
    author: journalAuthor,
    root: resolveRoot(entry),
    tags: journalTags,
    postOrder: resolvePostOrder(entry),
    postCount: posts.length,
    posts,
  };
}

/**
 * Site-wide settings (theme, site name, journals URL segment), read the same way main.js's
 * `publishToGitHub()` reads them for `buildSiteConfigFile()` -- included here too so "Dev Sync"
 * (and the site-template repo's `scripts/ingest.js`, which only ever sees the downloaded JSON,
 * never a live `game.settings`) has a way to produce `content/site-config.json` too.
 *
 * @returns {{theme: string, siteName: string, journalsSegment: string, allowThemeOverride: boolean}}
 *   Never `null`/`undefined`; every field falls back to a default when its underlying Foundry
 *   setting is unset.
 */
function collectSiteConfig() {
  return {
    theme: game.settings.get(NS, "siteTheme") || "default",
    siteName: game.settings.get(NS, "siteName") || "World2Web",
    journalsSegment: game.settings.get(NS, "journalsSegment") || "journals",
    allowThemeOverride: !!game.settings.get(NS, "allowThemeOverride"),
  };
}

/**
 * Collects every published journal entry (see the "Publishing Settings" dialog in main.js) as a
 * {@link Journal} with its published pages as posts, and returns a JSON-serializable payload.
 * Read-only: touches nothing.
 *
 * @param {object} [options]
 * @param {boolean} [options.scopedToCaller] For a player's own "Publish to Web" (see main.js's
 *   "Player self-publish" section; never set for the GM's, which always means everything):
 *   restricts collection to entries the *current* user actually owns, via `entry.isOwner`
 *   (Foundry's own always-correct-for-this-client permission getter) -- deliberately not a userId
 *   parameter resolved against a raw ownership map, since this only ever needs "does the browser
 *   calling this own it," without reimplementing Foundry's own permission-inheritance rules.
 * @returns {{generatedAt: string, world: {id: string, title: string}, foundryVersion: string,
 *   collectorVersion: string|null, siteConfig: object, journalCount: number, journals: Journal[]}}
 *   The full collected payload. Never `null`/`undefined`. `journals` is `[]` if nothing qualifies
 *   (nothing published at all, or -- when scoped -- the calling user owns nothing published).
 *   `collectorVersion` is `null` only if this module's own version can't be looked up.
 */
export function collectJournalData({ scopedToCaller = false } = {}) {
  let entries = game.journal.contents.filter(isPublishable);
  if (scopedToCaller) entries = entries.filter((entry) => entry.isOwner);
  const journals = entries.map(collectJournal);

  return {
    generatedAt: new Date().toISOString(),
    world: { id: game.world.id, title: game.world.title },
    foundryVersion: game.version,
    collectorVersion: game.modules.get(NS)?.version ?? null,
    siteConfig: collectSiteConfig(),
    journalCount: journals.length,
    journals,
  };
}

/**
 * Triggers a file download of the collected payload as JSON, via Foundry's own
 * `saveDataToFile()` helper -- see README.md for why this is used over a hand-rolled Blob/anchor
 * download.
 *
 * @returns {object} The collected payload -- see {@link collectJournalData} for its exact shape
 *   and nullability. Never `null`/`undefined`.
 */
export function downloadJournalData() {
  const payload = collectJournalData();
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
