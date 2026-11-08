# scripts/ingest.js

Local stand-in for the Cloudflare Worker step described in the Foundry module's own design docs.
Takes a `world2web` collector payload (the JSON downloaded from Foundry via the module's **Dev
Sync** button, hidden unless "Enable Dev Mode" is checked in the module's settings) and writes it
out as `content/` markdown here — one file per published post. No network calls, no git commit,
no Cloudflare — just files on disk for you to review and commit.

## Use

Lives in this repo, not the Foundry module/sync repo, specifically so working on these Astro
templates only needs one checkout:

```sh
npx world2web-ingest ~/Downloads/world2web-codex-2026-08-21T....json
```

Writes to `content/` at this repo's own root by default -- `astro dev`/`astro build` here pick it
up immediately, no env var pointing across repos needed. Override with `--content-dir <dir>` if
you want it written somewhere else instead.

## What it does

- Slugifies each journal's own title into a slug, prepends its (also slugified, segment-by-segment)
  `root` path if it has one, and calls the result `journalSlug` (the directory name, and the journal's
  own archive URL/permalink prefix -- a root of "Arc 1/Session Notes" makes a journal end up at
  `content/worlds/<world>/journals/arc-1/session-notes/<title-slug>/`). Separately slugifies the
  author's display name into an `authorSlug` -- deliberately NOT disambiguated, so several journals
  sharing an author name merge onto one author archive page on the site. Journal collisions (same
  root + title) get a short disambiguating suffix from the entry's own UUID; post-title
  collisions within a journal are disambiguated the same way from the page's UUID.
- Writes `content/worlds/<world-slug>/journals/<journal-slug>/<post-slug>.md` (`<journal-slug>` may itself
  span more than one directory when a root is set): frontmatter (post uuid, parent journal
  uuid/title/slug, raw `root` text, title, slug, author, `authorSlug`, `tags`, `postOrder`,
  `sortIndex`, `publishedAt`/`updatedAt`, `unpublished` soft-delete flag) + the post's HTML as the
  markdown body (raw HTML passthrough — Astro's markdown renderer handles this natively, no
  HTML→Markdown conversion happening or needed).
- Writes `content/site-config.json` (theme, site name, journals URL segment) from the payload's
  `siteConfig` field -- the local-path equivalent of what the Foundry module's `publishToGitHub()`
  pushes directly on the GitHub path.

## What it deliberately does NOT do

- **No asset handling.** Author portrait `image` fields keep their original Foundry-relative
  paths. Not needed yet for text-only posts.
- **No incremental diffing.** Each run deletes and fully rewrites
  `content/worlds/<world-slug>/journals/`, rather than doing UUID-keyed add/update/delete
  reconciliation. Coarse but correct for a single-developer, manual-trigger workflow — `git
  status` after a run shows exactly what changed.
- **No git commit.** Deliberately left to you to review and commit by hand.
- **No Cloudflare anything.** No Worker, no Tunnel, no Pages.
