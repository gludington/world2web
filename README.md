# World2Web

Publishes in-character session blogs from Foundry VTT to a static site, readable even when the
world isn't running.

Neither the Astro site nor the local `scripts/ingest.js` "Dev Sync" companion script lives in
this repo — both moved to
[`world2web-site-template`](https://github.com/gludington/world2web-site-template) (a clonable
template — "Use this template" to start a new campaign site), so anyone working on the Astro
templates only needs that one checkout, not this repo too; `wikiworld-site` is one live example
created from it. Site-code changes happen in a local checkout of the template repo and get pushed
there directly, not developed here.

## Model

- **Blog** = any journal entry explicitly marked published via the **Blog Publishing Settings**
  dialog on its sheet (gear icon in the header) — no folder scoping, any entry anywhere can opt
  in. Every blog/post control is GM-only by default; a GM can opt into letting an owning player
  control (and self-publish) their own blogs too — see **Player self-publish** below. That dialog
  also sets three more things, each with a sensible default that can be overridden:
  - **Author** — defaults to the first non-GM user with **Owner** permission on the entry,
    resolved to their assigned character (name + portrait); falls back to "Game Master" if no
    player owns it. The dialog can override this with an explicit name/image instead.
  - **Root** — a URL path prefix, not just a label. Defaults to the entry's containing folder,
    walked hierarchically up to the root (e.g. `Arc 1/Session Notes`), overridable with any
    string. Slugified segment-by-segment and prepended to the blog's own slug -- a root of
    `Arc 1/Session Notes` makes a blog end up at
    `/<world>/<blogs segment>/arc-1/session-notes/<blog-slug>/` instead of
    `/<world>/<blogs segment>/<blog-slug>/` (see **Site settings** below for `<blogs segment>`).
  - **Tags** — a freeform, user-defined list. Empty by default.
- **Post** = a page within a published blog's journal entry, but only once **explicitly
  published** — draft pages are never collected. Publishing is a manual per-page action (see
  below); it stamps `publishedAt` (set once, on first publish) and `updatedAt` (bumped every
  republish) onto the page's own flags. Chronological order comes from `publishedAt`, not any
  in-story date field — there isn't one, deliberately. A post can also override its own author and/or tags via its own **Post Settings**
  dialog (gear icon next to the publish icon) — each independently, either falls back to the
  blog's own resolved value when left blank, and a post has its own optional **front image** too
  (a direct path/URL, no blog-level equivalent). Deleting a page or an entire journal entry (as
  opposed to unpublishing it) is handled separately — see **Deleted pages/entries** below.

## Install (dev symlink)

```sh
ln -s /home/gludington/workspace/world2web ~/foundries/data/14.364/Data/modules/world2web
```

Then in Foundry: **Setup → Manage Modules** (per world) → enable **World2Web**.

## Use

1. Open any journal entry you want to publish as a blog. Click the gear-icon **Blog Publishing
   Settings** button in its header, check **Publish this journal as a blog**, optionally fill in
   an author/root/tag override, and save. Foundry ownership (Owner permission) on the entry
   determines the default author if you don't override it: the entry's owning player's assigned
   character (name, portrait, and -- system permitting -- biography, all pulled live from that
   Actor), or "Game Master" with no biography if no player owns it. Two ways to override that:
   **Author Actor override** (drag an Actor onto the field from the sidebar, a compendium, or a
   scene token, or type/paste its UUID -- "Copy Document UUID" from its sidebar/token
   context menu -- authors as that Actor instead, e.g. a GM writing in an NPC's voice; wins
   outright over the next option) or **Author name/image override** (freeform text, no biography,
   since there's no Actor to pull one from). See `scripts/biography.js` for the per-system
   biography lookup -- only `dnd5e` is wired up right now, add more systems there as needed.
2. Write pages in that entry as usual. Once the entry itself is published, each page in the
   sidebar's page-navigation list gets its own small publish icon right next to its title.
   Clicking it does one of three things depending on state: **publish** it (if never published),
   **republish** it (if edited since its last publish — bumps `updatedAt`), or **unpublish** it
   (if already published and current — there's nothing left to "republish" there, so this is
   where clicking instead removes it from what gets collected/pushed). It's deliberately placed
   per-page rather than as a single header button: a header button reads as acting on the whole
   entry, when it only ever affects whichever one page is currently shown. Entries not marked
   published in step 1 show only the gear icon, no per-page publish controls. The one exception:
   a page popped out into its own separate window (not shown in a list alongside other pages)
   keeps a header button instead, since there the whole window unambiguously is that one page.

   The icon itself is upload (never published, or edited since last publish) or checkmark
   (published and current) — but its *color* answers a different question: has this local state
   actually been confirmed by a successful **sync** yet (Publish to Web, or Dev Sync if dev mode
   is on)? Amber means no (an "uncommitted" local change — publish, republish, or unpublish —
   still waiting on your next sync click); green means yes (confirmed synced). Both sync buttons
   pick up the same coloring themselves too, amber if anything anywhere is waiting to go out, so
   you can tell at a glance whether there's anything to sync without opening every journal — and
   clicking either one resets it back to green (they share one "last synced at" timestamp; from
   the GM's perspective either one means "I've taken care of this"). One caveat specific to
   Publish to Web: for an *unpublish*, green means "the soft-delete has been pushed," not
   "the file is gone from GitHub" -- `pushFiles`/`putFile` in `github.js` only ever create or
   update files, never delete. Instead it's a soft delete: the post's own frontmatter gets
   `unpublished: true` stamped on it and pushed like any other update, and the site's own content
   queries filter those out (see "Output shape" below) -- so green here means "confirmed hidden
   on the live site," not "confirmed gone from the repo." The underlying `.md` file (and its
   content) stays in git history. Dev Sync doesn't push anywhere at all, so for it green only
   ever means "downloaded," nothing about GitHub.
3. Each page also gets a second small icon next to its publish icon: a gear, opening **Post
   Settings** for that one page -- author, tags, and front image, all scoped to this post only.
   Author and tags each mirror the blog-level dialog's own fields (Author Actor override /
   Author name+image override / Tags), and work the same "blank = inherit" way: leave them blank
   and the post uses its blog's own already-resolved author/tags unchanged; fill one in and it
   fully replaces the blog's value for this post alone (tags especially: it's a full replace, not
   an add-to-the-blog's-list). **Front image** has no blog-level equivalent at all -- a direct
   path or URL only (not an Actor UUID), shown as this post's featured image on the site, blank by
   default and never auto-derived from the post's own body content. Changing any of these on a
   post that's already been published bumps its dirty state, same as editing the post's own text
   would -- Publish to Web (or Dev Sync) again to push the change.
4. As GM, one or two buttons in the Journal sidebar header:
   - **Publish to Web** collects, renders, and pushes directly to a GitHub repo over its Contents
     API — no local script, no download. Requires the GitHub owner/repo/token/branch settings
     below to be filled in first (**Configure Settings → World2Web**); if they're not, it
     shows an error and does nothing rather than failing confusingly.
   - **Dev Sync** downloads `world2web-<world>-<timestamp>.json` — for local/manual use with
     `scripts/ingest.js` in the site-template repo (see that repo's `scripts/README.md`). Hidden
     unless **Enable Dev Mode** is checked in **Configure Settings → World2Web**; most GMs never
     need it, since Publish to Web covers the actual publishing path end to end.
6. Or from the console: `game.modules.get("world2web").api.collect()` / `.download()` /
   `.publish()`.

## Publish to Web

Pushes rendered markdown files straight to a GitHub repo via its Contents API (PAT bearer auth),
so there's no local script to run and no server of ours in the middle — see
[`world2web-site-template`](https://github.com/gludington/world2web-site-template)'s own README
for the full turnkey walkthrough (create a repo from that template, generate a token, connect a
host). Settings needed:

- **GitHub Repo Owner** / **GitHub Repo Name** — e.g. `alice` / `my-campaign-blog`.
- **GitHub Branch** — whatever your host builds from (`main` by default).
- **GitHub Personal Access Token** — a fine-grained token scoped to just that repo, `Contents:
  Read and write` permission. Not encrypted at rest by Foundry's settings storage, which is why
  the setup guide has you scope it to exactly one repo and one permission rather than reusing a
  broad token.

Safe to click repeatedly and safe with multiple publishers (GM + players all able to click
Publish): each file is pushed independently, `putFile` (in `github.js`) skips any file whose
content hasn't actually changed (so publishing your own new post doesn't also re-commit
everyone else's unchanged posts), and a genuine same-file race (two people editing/publishing
the identical post within moments of each other) is handled via GitHub's own optimistic
concurrency — a stale-`sha` write gets rejected with `409`, and `putFile` retries once against a
freshly re-fetched `sha` before surfacing an actual error.

### Player self-publish

Every blog/post control (Blog Settings, Post Settings, the publish icons) is GM-only by default.
**Allow Player Self-Publish** (a world setting, off by default) lets a player who owns a journal
entry — Foundry's own Owner permission level, the same one `resolveDefaultAuthor()` already uses
for author attribution — see and use that entry's controls themselves, with no GM involved.
`canControlBlog()` in `main.js` is the single gate everything else routes through: the GM always
passes, a player passes only for an entry they own and only once this setting is on.

A player's own "Publish to Web" click is **scoped**, not a smaller version of the GM's global one:
`collectBlogData({ scopedToCaller: true })` (`collector.js`) restricts collection to entries the
calling user owns via that same `isOwner` check, and `retractPendingDeletions({ scopedToCaller:
true })` (`main.js`) only retracts a deletion whose *captured ownership snapshot* (taken at the
moment it was deleted, since the document itself won't exist anymore to check directly --
`trackDeletedPage()`) shows the calling user as an owner. The deletion side of that decision is
factored into `scripts/ownership.js`'s `scopedDeletionUuids` -- a small pure function with no
Foundry dependency, shared by both `retractPendingDeletions` and `syncButtonColor` below, so
"a GM's publish/retraction/coloring always means *everyone's* pending work, never scoped" is one
single, directly-tested guarantee (see "Testing" below) rather than something each call site has
to independently get right. Between the collector-side and deletion-side scoping, a player's
publish can only ever touch blogs -- and deletions of blogs -- they actually own; the GM's own
publish is untouched by any of this and still means everything, as it always has. The sync-button
coloring (`syncButtonColor()`) is scoped the same way for a non-GM viewer, so a player's button
doesn't sit amber over someone else's pending work their own publish would never resolve. Dev Sync
stays GM-only regardless of this setting -- downloading the raw collected payload isn't something
this feature is meant to grant a self-publishing player.

**Before turning this on**, know what it actually exposes: a player's own browser needs to read
the GitHub token to publish at all, and Foundry's `game.settings.get()` has no access control on
reads for world-scoped settings -- being GM-only in the Configure Settings *menu* doesn't stop a
player from reading the raw value via their own browser console. The blast radius is whatever that
token itself can do; a fine-grained token scoped to just this one repo's `Contents` permission
(already the setup guidance above) keeps the worst case limited to that one repo, not your whole
GitHub account.

**Unverified against a live instance**: the entire ownership-based gating and publish-scoping
model above (`canControlBlog`, `collectBlogData`'s `scopedToCaller`, the scoped
`retractPendingDeletions`, and the scoped `syncButtonColor`) is new and hasn't been exercised
against a real multi-user Foundry session yet. If a player with Owner permission on an entry
doesn't see its controls once the setting's on, or a player's publish touches something it
shouldn't, check the console and `entry.isOwner`/`entry.ownership` directly first.

### Publish performance

A publish used to push every file strictly one at a time, and check whether each currently-
published post had actually changed by fetching its existing content from GitHub -- for every
post, every single publish, regardless of whether anything about it changed at all. On a world
with hundreds of posts (and, worse, hundreds of new images in one run), that was the dominant
cost behind a publish taking 9+ minutes. Two independent fixes:

- **Concurrency.** `scripts/concurrency.js`'s `mapWithConcurrency` runs up to a handful of
  operations at once (`PUSH_CONCURRENCY`/`ASSET_FETCH_CONCURRENCY`, both `6` -- picked to get a
  real speedup without tripping GitHub's abuse-rate-limiting or hammering a modest local Foundry
  server) instead of strictly one-at-a-time, for both `github.js`'s `pushFiles`/`pushBinaryAssets`
  and `assets.js`'s `collectAssets`. Failure semantics are unchanged either way: one hard failure
  still aborts the whole batch, same as the sequential `for` loops it replaced.
- **A content-hash manifest, text posts only.** `pushFiles` now accepts `knownHashes` (a
  `{ path: sha256hex(content) }` map, persisted as the `contentHashes` world setting) and skips a
  file's GitHub round trip *entirely* when its current content hashes the same as last time --
  this pipeline is the only thing that ever writes these files, so its own record of "I
  successfully wrote exactly this" is authoritative, no need to ask GitHub to confirm what's
  already certain. Deliberately **not** applied to images (`assets.js`'s `collectAssets`): an
  image is fetched from an independently-mutable external source (Foundry's own server, or an
  external CDN), not generated by this pipeline's own code, so there's no way to know its current
  bytes without actually fetching them -- trusting a cached hash there risks silently missing a
  real content change. Images only get the concurrency speedup, not the cache-skip.

### Images

Author portraits and any `<img>` (pasted into post content, or an image-type journal page) come
out of Foundry as paths relative to Foundry's own Data directory (e.g.
`systems/dnd5e/icons/svg/actors/character.svg`) -- which only resolve correctly against Foundry's
own address, not wherever the payload ends up being read from. `collector.js` resolves every one
of these to an absolute URL (`resolveAssetUrl`, against `location.href`) at collection time,
since it's the one place in the whole pipeline that's guaranteed to be running inside the live
Foundry client and so always knows that address for certain -- every consumer downstream (a real
GitHub push, or the site-template repo's `scripts/ingest.js` local-preview path) would otherwise
have to be told it separately, and `ingest.js` in particular has no way to. An already-absolute
`src` (an external CDN -- e.g. Forge-hosted module art at `assets.forge-vtt.com`) is left
completely untouched, since it doesn't need Foundry running at all.

That still leaves those absolute URLs depending on Foundry (or the external CDN) staying
reachable, which directly undermines "readable even when the world isn't running." Before
pushing markdown, `publishToGitHub()` (via `assets.js`) fetches every image referenced by a
currently-published post (a tombstoned, `unpublished: true` post's images are skipped -- nothing
renders it on the live site, so there's nothing to fetch for), or decodes it directly for a
`data:` URI pasted straight into ProseMirror (no network round-trip needed), content-addresses it
(`sha256(bytes).ext`), pushes it to `public/assets/<hash>.<ext>` (served by Astro's static-file
convention at `/assets/<hash>.<ext>`, zero site-side config needed), and rewrites the payload to
reference the local copy instead. A failed fetch is logged and that one reference is left as the
absolute URL rather than failing the whole publish. `github.js`'s `putBinaryAssetIfMissing` only
needs an existence check, never a content comparison or conflict retry, since a content-addressed
path can't meaningfully change -- the same hash always means the same bytes.

The local "Dev Sync" + `ingest.js` preview path never runs this content-addressing step (see
`ingest.js`'s own header comment) -- images there stay as whatever absolute URL `collector.js`
already resolved them to, loaded directly from Foundry (or the external CDN) rather than copied
locally. That's fine for local preview (Foundry's presumably running right then anyway) but means
those specific `<img>` references won't survive Foundry going offline the way a real
Publish-to-Web push's copies do.

### Site settings

Four settings get pushed as `content/site-config.json` alongside every publish, and the Astro
site (`src/lib/config.ts`) reads them at build time. This is the mechanism for reaching an
*already-deployed* site without any git action: changing any of them is just a Foundry setting
change and a click of Publish, same as everything else.

- **Site Theme** (`default`, or a name like `midnight`) -- read by `Layout.astro` and set as
  `<html data-theme="...">`, which selects a matching `[data-theme="..."]` block already compiled
  into the site repo's own `src/styles/tokens.css`. New named themes are added directly to that
  file (in the site repo, not here) -- there's no separate hosted theme collection or custom-URL
  option; see that repo's `src/styles/README.md` for the current set and why they live there
  instead of as separate files.

- **Allow Visitor Theme Override** (off by default) -- lets a site visitor pick their own theme
  from a dropdown, saved in their own browser, overriding Site Theme just for them. When off, the
  dropdown doesn't render on the site at all (not just hidden) and Site Theme applies to everyone.

- **Site Name** -- replaces "World2Web" as the site's branding (page title, homepage heading,
  breadcrumbs).

- **Blogs URL Segment** (default `journals`) -- URLs are world-first:
  `/<world>/<this>/<blog-slug>/...`, `/<world>/authors/...`, `/<world>/tags/...`. This is the
  one segment that's configurable; `authors`/`tags` are fixed. Gets slugified automatically (the
  site repo's `src/lib/config.ts`), so typing e.g. `My Blogs` is fine -- it becomes `my-blogs` in
  actual URLs. Changing it moves every blog/post URL on the site (old links 404 after the next
  deploy), so it's meant to be set once early on, not changed casually.

## Output shape

```jsonc
{
  "generatedAt": "2026-08-21T...",
  "world": { "id": "...", "title": "..." },
  "foundryVersion": "14.364",
  "collectorVersion": "0.5.0",
  "siteConfig": { "theme": "default", "siteName": "World2Web", "blogsSegment": "journals", "allowThemeOverride": false },
  "blogCount": 2,
  "blogs": [
    {
      "uuid": "JournalEntry.abc123",
      "title": "Thoric's Journal",
      "author": { "userId": "...", "name": "Thoric", "image": "https://<your-foundry-host>/portraits/thoric.png", "isGM": false, "bio": "<p>...</p>" },
      "root": "Arc 1/Session Notes",
      "tags": ["heist", "waterdeep"],
      "postCount": 3,
      "posts": [
        {
          "uuid": "JournalEntry.abc123.JournalEntryPage.xyz",
          "title": "The Bandit King's Lair",
          "html": "<p>...</p>",
          // Already fully resolved with inheritance baked in -- this
          // post's own override if it set one, otherwise the blog's
          // author/tags above, verbatim. See "The blog config dialog"
          // section below for the per-post Post Settings dialog.
          "author": { "userId": "...", "name": "Thoric", "image": "https://<your-foundry-host>/portraits/thoric.png", "isGM": false, "bio": "<p>...</p>" },
          "tags": ["heist", "waterdeep"],
          // "" (never null) when this post has no explicit front image --
          // no blog-level equivalent to fall back to.
          "frontImage": "",
          "publishedAt": 1755600000000,
          "updatedAt": 1755600000000,
          "unpublished": false
        }
      ]
    }
  ]
}
```

Posts within a blog are sorted chronologically by `publishedAt` ascending.

A page that's never been published at all (no `publishedAt` on record) is excluded from `posts`
entirely, same as always. A page that WAS published and is now unpublished is still included --
with `unpublished: true` -- rather than dropped, because there's no way to delete an
already-pushed file from GitHub (`github.js`'s `putFile` only ever creates or updates). This is a
soft delete: `render.js` (this repo) and `scripts/ingest.js` (site-template repo) still write that
post's file (a tombstone, content and
all, still in git history), and the site repo's own content queries
(`src/lib/posts.ts`'s `getPublishedPosts()`) filter out anything with that flag set, so it
never actually renders anywhere -- including its own permalink, which 404s on the next deploy
since `getStaticPaths()` for that page is filtered too, not just the listings.

`siteConfig` mirrors the **Site Theme**/**Site Name**/**Blogs URL Segment** module settings --
included here (not just pushed directly by `publishToGitHub()`) so the "Dev Sync" download, and
`scripts/ingest.js` (site-template repo) which only ever sees that downloaded JSON, can also
produce `content/site-config.json` without a live `game.settings`.

## Deleted pages/entries

The tombstone mechanism above only works because the document is still there for
`collectBlogData()` to visit and see a flag flip -- **deleting** a page (or a whole journal entry,
which takes every one of its pages with it) removes it from Foundry's own collections entirely,
so the collector has nothing left to visit. Without anything else, that would silently leave the
already-published file live on the site forever, with no way to notice it should be retracted.

Two `config: false` world-scoped settings close that gap:

- **`publishedPaths`** (`{ pageUuid: itsGitHubFilePath }`) -- kept in sync with every post actually
  in the payload after each successful Publish to Web (`recordPublishedPaths()` in `main.js`). The
  only reliable record of "where does this UUID's file live," since path disambiguation depends on
  sibling posts at collect time and can't be cheaply recomputed later from a deleted page alone.
- **`pendingDeletions`** (`{ pageUuid: true }`) -- populated the instant a previously-published
  page or entry is deleted, by the `deleteJournalEntryPage`/`deleteJournalEntry` hooks
  (`trackDeletedPage()` in `main.js`). This is what actually drives the amber sync-button color the
  moment it happens -- nothing else could notice a deletion in time, since by the next render
  there's no document left for the usual per-page scan to see at all.

On the next Publish to Web, `retractPendingDeletions()` looks up each pending UUID's path and
patches that file directly on GitHub (`github.js`'s `retractDeletedPost`) -- fetching its
already-correct frontmatter, flipping `unpublished: true` and bumping `updatedAt`, and pushing it
back, rather than trying to reconstruct a post from a document that no longer exists. A UUID is
only dropped from tracking once its retraction actually succeeds; a failure (or a UUID with no
recorded path at all -- never actually published, or predating this feature) is left for the next
publish to sort out, same "one bad item doesn't fail the batch" pattern `assets.js` already uses
for a failed image fetch. Dev Sync doesn't touch GitHub at all, so it never records paths or
retracts anything -- purely a local preview tool, same as its existing limitations.

`retractDeletedPost` also guards against a real race, not just a hypothetical one: path
disambiguation only ever checks the *current* payload, never GitHub's history, so a brand-new page
published with the same title (same blog/root) as a just-deleted one computes the identical
file path. If that republish and the deletion's retraction land in the same publish run,
`pushFiles()` (which runs first) may have already overwritten that exact path with the new page's
own live content by the time retraction gets to it. `retractDeletedPost` takes an `expectedUuid`
and checks it against the fetched file's own `foundryUuid` before touching anything -- a mismatch
means the path's been reclaimed by unrelated, live content, so it backs off (treated as "already
handled," same as the file being gone entirely) rather than unpublishing that post the moment it
went live.

**Unverified against a live instance**: whether deleting a whole journal entry also independently
fires `deleteJournalEntryPage` for each of its child pages, or only `deleteJournalEntry` for the
parent. `trackDeletedPage()` is written to be safe either way (a plain "already tracked?" check,
so a duplicate call is harmless) -- but if pages *aren't* still populated on `entry.pages.contents`
by the time the `deleteJournalEntry` hook fires, this needs a different approach for the
whole-entry-deleted case specifically.

## The publish button

Confirmed working against a live Foundry v14 world running dnd5e, 2026-08-21. Foundry v13+ moved
journal sheets to ApplicationV2, which does **not** fire the old `getJournalSheetHeaderButtons`
hook (that's ApplicationV1-only) — the first version of this button silently never appeared
because of that, not a selector/timing bug. AppV2 header buttons are just plain
`<button class="header-control icon ...">` elements in `.window-header`; there's no
buttons-array hook, so `main.js` inserts one directly via DOM injection on render, the same
pattern already used for the Journal Directory's Publish to Web/Dev Sync buttons.

Two sheet classes matter: `JournalEntrySheet5e` (the observed dnd5e-system subclass of the core
`JournalEntrySheet` — exposes `app.pageId` directly for "which page is currently shown"), and
`JournalEntryPageProseMirrorSheet` (a single page popped into its own window, where the page
*is* `app.document`). Foundry fires a render hook for every class in the instance's prototype
chain, not just the leaf subclass, so hooking the core base names should work regardless of game
system — the exact observed subclass name is also hooked directly as a fallback. If this breaks
on a different system/version, check the console for which hook name actually fired (or didn't)
— `main.js` logs every one it's listening for.

The per-page publish button (`injectPagePublishButtons`) reuses the same
`[data-page-id="..."] .page-title` selector the earlier (already-working) status dot relied on.
Confirmed working live, 2026-09-10: clicking a page's publish icon (nested inside the page list's
own clickable row) stays on whatever page is currently shown rather than also switching the sheet
to the clicked page (`event.stopPropagation()` doing its job), and the multi-page entry sheet's
own header shows no publish button at all -- that's kept only for the popped-out single-page
editor, where the whole window unambiguously is one page.

## The blog config dialog

`openBlogConfigDialog` in `main.js` uses `foundry.applications.api.DialogV2.wait` with a custom
HTML form, reading values back off the raw DOM form elements by name (deliberately avoiding
`FormDataExtended`, whose exact location/behavior has moved around across the ApplicationV2
migration). Confirmed working against a live Foundry instance, 2026-09-10.

`openPostConfigDialog`, the per-post sibling of the dialog above (author/tags/front-image
overrides scoped to one page, see "Use" step 3) -- same DialogV2 pattern -- is confirmed working
live too, as of the same date. Its two gear-icon triggers: a second `<a>` next to the existing
per-page publish icon in the multi-page entry sheet's page list (`injectPagePublishButtons`), and
a second header-control `<button>` next to the publish button in the popped-out single-page
editor (`injectPublishButton`).

The Author Actor override field in both dialogs accepts a dragged Actor (from the sidebar, a
compendium, or a scene token) as well as a typed/pasted UUID -- also confirmed working live,
2026-09-10. Implemented as a `dragover`/`drop` listener delegated on `document` (filtered to
`input[name="authorActorUuid"]`) rather than attached per-dialog-render, specifically to sidestep
needing a confirmed post-render hook on DialogV2 -- see the drag-drop section of `main.js` for
why. Expects Foundry's standard document-drag payload shape (`{type: "Actor", uuid}` from the
sidebar/compendium, or `{type: "Token", uuid}` from a scene token, resolved to that token's own
actor). If dropping an Actor ever does nothing, check the console for a JSON-parse failure on
`event.dataTransfer` (a
different payload shape than expected) before assuming the listener itself never fired.

## Testing

`scripts/collector.js` only touches Foundry globals (`game`, `CONST`), so it's directly testable
in plain Node by stubbing those before calling in, no real Foundry instance needed:

```sh
npm test   # node --test scripts/*.test.mjs
```

Covers: draft-vs-published filtering, entry-level publish gating, author resolution (default
player-owner/GM-fallback, explicit Actor override winning over manual text overrides, a stale/
invalid Actor UUID falling through gracefully, and per-system biography extraction -- see
`biography.test.mjs` for that in isolation), root resolution (default hierarchical folder path
and explicit override), tags, chronological post ordering, per-post author/tags/front-image
overrides -- a post with none of its own inherits its blog's author/tags unchanged; one with its
own Actor override, manual override, or tag list replaces them for that post only (a full
replace, not a merge, for tags); front image resolves the same absolute-URL treatment as every
other image reference (see "Images" above) and has no blog-level equivalent to fall back to --
and `collectBlogData`'s `scopedToCaller` (see "Player self-publish" above), which only includes
entries with `isOwner: true` on the fake document, leaving the raw permission-level math itself
to Foundry's own (already-trusted) `isOwner` getter rather than reimplementing it here.
`render.js`'s own tests additionally cover root-path slugification (segment-by-segment, stray
slashes collapsed), its disambiguation once prepended to a blog's own slug, and a post's own
(already-resolved) author driving its `authorSlug` rather than its blog's.

`render.js` (pure transform, no Foundry/network dependency), `github.js` (mocks `fetch`, same
pattern as mocking `game`/`CONST`), `assets.js` (mixes pure string/hash functions with a
mocked-`fetch` integration test), `biography.js` (mocks just `game.system.id`), `concurrency.js`
(no mocking at all -- pure, timer-based), and `ownership.js` (also no mocking -- pure, no Foundry
dependency at all) each have their own test file, same `npm test` command.
`ownership.js`'s tests cover `scopedDeletionUuids` -- the exact function `retractPendingDeletions`
and `syncButtonColor` (`main.js`) both call -- proving directly that `scopedToCaller: false`
always returns every UUID completely unaffected by any ownership snapshot (the GM guarantee: a
GM's publish/retraction/coloring means everyone's pending work, never scoped, regardless of what
they personally own), while `scopedToCaller: true` returns only the ones a given user owns; plus
`ownsSnapshot`'s own fallback chain (explicit per-user level, else the snapshot's `default`) and
its behavior on a missing/empty snapshot.
`concurrency.js`'s tests cover: results come back in input order regardless of which finishes
first, never more than `limit` run at once, every item gets processed exactly once, an empty
array and a limit larger than the item count both work, and any single call throwing rejects the
whole batch (matching the sequential `for` loops it replaced -- one hard failure already aborted
everything before).
`github.js`'s tests cover: new-file creation, existing-file update, no-op on identical content,
the 409-conflict retry path, `pushFiles`' `knownHashes` fast path (a file whose current content
hashes the same as its recorded entry skips any GitHub call at all; a stale or missing entry
falls through to the normal check unchanged; both a just-pushed and a found-unchanged file get
their hash recorded in the returned map), and `retractDeletedPost` (flips `unpublished`/bumps
`updatedAt` while leaving everything else in a deleted page's already-published frontmatter and
body untouched; no-ops rather than erroring when the file's already gone, already unpublished, or
its `expectedUuid` no longer matches what's actually at that path -- the same-run-race guard
above; returns false, meaning "retry next publish," on a write conflict or content that doesn't
parse as this pipeline's own frontmatter shape). `assets.js`'s cover: `<img>` extraction/rewriting (including the
byte-identical no-op fast path for images-free HTML), deduping repeated image URLs across a
payload, `data:` URI decoding without a network call, a known SHA-256 vector, a failed fetch
being skipped rather than failing the whole batch, and -- two real regressions, both caught live
-- that `collectAssetUrls`/`rewriteAssetReferences` scan each *post's own* author.image/frontImage,
not just the blog's default author (scanning only the latter left any post-level override's image
-- an Actor-authored post, or a front image -- unreachable by the real fetch/content-address step
entirely, so it stayed pointing at the GM's own Foundry server on the published site), and that a
tombstoned (`unpublished: true`) post's images are skipped entirely rather than re-fetched and
re-uploaded on every single publish forever for content nobody can ever see on the live site.

## Not yet built

Hooking into `updateJournalEntry`/`updateJournalEntryPage` so publishing is fully automatic
(rather than a manual button click) is the remaining piece.
