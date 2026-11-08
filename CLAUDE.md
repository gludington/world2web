# World2Web: Session Journals → Static Site Sync

## Goal

Publish in-character session notes from Foundry VTT to a public static site, readable even when
the world isn't running. Each journal is authored by a player's character; posts are written and
published from inside Foundry with no separate export/upload step.

## Decided architecture

```
Foundry (any journal entry explicitly marked published, one entry per author's journal)
   -> Foundry module ("Publish to Web" button pushes directly; "Dev Sync" is a dev-mode-only
      local-JSON-download alternative; hook wiring for auto-publish is a later step)
   -> local sync script (stands in for a Cloudflare Worker -- see "Local-first" below)
   -> git repo (markdown + frontmatter, our own output format)
   -> Astro static site (chronological journal list + per-author pages)
```

## Local-first: no Cloudflare yet

The user explicitly deferred Cloudflare (Worker, Pages, Tunnel) until ready for that cost/hassle
— not a rejection of the target architecture, just a sequencing choice. Don't push toward wiring
up real Cloudflare deployment unless asked. `scripts/ingest.js` (in the site-template repo, not
this one -- see "Astro site" below) is a local Node script standing in for the eventual Worker: it
reads a collector JSON payload and writes `content/` markdown directly, no network calls, no
auto-commit.

## Data model

- **Journal** = any `JournalEntry` explicitly marked published via a per-entry "Publishing
  Settings" dialog (gear-icon button on the entry sheet) — no folder scoping; any entry anywhere
  can opt in. The dialog stamps `flags['world2web'] = { published, authorName, authorImage,
  root, tags }` on the entry itself. Three more things are configured there, each with a
  computed default that the dialog can override:
  - **Author** — defaults to the first non-GM Foundry user with **Owner** permission on the
    entry, resolved to their assigned character (name + portrait); falls back to `"Game Master"`
    if no player owns it, so GM-only session logs work too. An explicit `authorName`/`authorImage`
    override replaces this entirely.
  - **Root** — a URL path prefix, not just a label: defaults to the entry's containing folder,
    walked hierarchically to the root (e.g. `"Arc 1/Session Notes"`), overridable with any
    string. `render.js` (this repo) and `scripts/ingest.js` (site-template repo) slugify it
    segment-by-segment and prepend it to the
    journal's own slug, so a root of `"arc-1/session-notes"` makes a journal's posts live at
    `/<world>/<journals segment>/arc-1/session-notes/<journal-slug>/<post-slug>/` instead of
    `/<world>/<journals segment>/<journal-slug>/<post-slug>/`. URLs are world-first
    (`/<world>/<journals segment>/...`, `/<world>/authors/...`, `/<world>/tags/...`); `<journals
    segment>` is a configurable module setting (default `"journals"`), the only one of the three
    that isn't a fixed literal.
  - **Tags** — a freeform, user-defined list of strings. Empty by default.
- **Post** = a page within a published journal's journal entry, but **only once explicitly
  published**. Draft
  pages are never collected. Publishing is a manual action (a button added to the page sheet,
  `scripts/main.js`) that stamps the page's own flags:
  `flags['world2web'] = { published: true, publishedAt, updatedAt }` — `publishedAt` is set
  once on first publish and never changes; `updatedAt` bumps on every republish. There is
  deliberately no separate in-story/calendar date field — `publishedAt` alone drives
  chronological order.

See `DEVELOPMENT.md` for the exact collector output shape.

## Foundry module

`collectJournalData()` / `downloadJournalData()` in `scripts/collector.js`. Only touches Foundry
globals (`game`, `CONST`), so it's directly unit-testable in plain Node by stubbing those before
calling in — `scripts/collector.test.mjs`, `node --test`, no real Foundry instance or extra
dependency needed. Run via `npm test`.

The publish button (`getJournalSheetHeaderButtons` hook in `main.js`) is the one piece written
without live Foundry verification — journal page sheet internals changed across v12→v14's
ApplicationV2 migration, and determining "which page is currently shown" inside a multi-page
journal entry sheet has to be read from the live app instance at click time. Expect to iterate on
this against the user's actual Foundry session; see `DEVELOPMENT.md`'s "least-certain part" note.

## Content model / repo layout (target design, not yet built for journals)

```
content/
  worlds/
    <world-slug>/
      journals/
        [<root-path>/]<journal-slug>/   # <root-path> is the slugified root, if any -- absent
                                      # entirely when a journal has no root, one or more nested
                                      # directories when it does.
          <post-slug>.md   # frontmatter: foundryUuid, journalUuid, journalSlug, title, author
                            # {name, image}, authorSlug, tags, publishedAt, updatedAt. Body =
                            # raw HTML (Foundry's ProseMirror output needs no markdown
                            # conversion).
```

Design principles:

- **World-namespaced** to avoid collisions across worlds/campaigns.
- **Diff-and-commit, not append-only** — a sync run should reconcile against what's on disk,
  not just append. Full-replacing the world's directory per run is fine here to start.
- Assets (portrait images) content-addressed if/when that's built — not needed for text-only
  posts, only relevant once author portraits or in-post images need to survive a rebuild without
  re-fetching.

## Astro site — built, and no longer developed in this repo

The site is done: content collection, chronological homepage (a single-world index directly, or
a `/worlds/` picker when there's more than one), per-author and per-tag archives, hierarchical
root/section pages, tag cloud, recent-posts widgets. Its source moved out of this repo's `site/`
(deleted) once a separate GitHub template repo (`world2web-site-template`) became the real,
reusable home for it — anyone spinning up their own campaign site clones that template, not this
one. `wikiworld-site` is one live example created from it. Site-code changes now happen in a
local checkout of the template repo, then get pushed there directly; this repo only carries the
Foundry module. `scripts/ingest.js` (the local "Dev Sync" companion) also lives in the
site-template repo, not here — deliberately, so anyone working on the Astro templates only needs
that one checkout.

Cross-references between posts via Foundry's `@UUID[...]` text-editor enrichers are resolved at
the site's build step (`src/lib/relationships.ts`'s `resolveContentLinks`/`buildContentLinkMap`,
in the site-template repo). A reference to another currently-published post becomes a real link;
anything else (not published, foreign UUID, a non-journal document type) degrades to plain text
rather than a dead link.

## Open questions / not yet resolved

1. **GM-only vs. player-visible posts**: no visibility split decided yet beyond the per-entry
   published flag/ownership. Does a journal need its own public/GM-only distinction, or is
   "published" already the only gate needed?
2. **Hook wiring for auto-publish-on-save**: still manual ("Publish to Web" button) — automating this
   is a later step once the manual path is validated end-to-end.
3. **Publish button correctness**: unverified against live Foundry, see "Foundry module" above.

## Suggested build order (journal pivot) — all done, kept for history

1. [DONE] Foundry module: per-entry publish/unpublish, author/root/tag config, live-verified
   against real Foundry.
2. [DONE, relocated] `scripts/ingest.js` (now in the site-template repo): adapts the journal payload
   shape → `content/worlds/.../journals/<journal-slug>/*.md`.
3. [DONE, relocated] The Astro site — see "Astro site" above for where it actually lives now.
4. Still open: hook wiring for auto-publish, GM/player visibility split, actually deleting (not
   just soft-deleting) an unpublished post's file from GitHub.
