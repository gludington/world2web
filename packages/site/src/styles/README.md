# Design system

Two files, plus component-local styles:

- **`tokens.css`** — every value a theme can override: colors, fonts, and two shape variables.
  Just custom properties on `:root`, nothing else. Single fixed light palette — no
  `prefers-color-scheme: dark` block.
- **`base.css`** — global resets and the *visual* styling (color, font, borders) for every
  reusable class, all as `var(--color-...)` references. It does **not** own layout/spacing for
  most components anymore — see "Where structural CSS lives" below.
- **Component-local `<style>` blocks** — `ContentPanel.astro`, `Breadcrumbs.astro`,
  `Pagination.astro`, and a few page files (`[...journal].astro`, the tag archive page) each carry
  their own scoped `<style>` for structural layout (flex/grid, gaps, margins). The intent (see
  `Pagination.astro`'s own comment): "Keep the structural flex/grid containers local to the
  layout element! The visual tokens (borders, fonts, colors) stay inherited from base.css."

Both shared files are imported once, in `layouts/Layout.astro`, and apply site-wide.

## How theming works

The Foundry module's "Site Theme" setting is a plain name (or `default`/blank for none), resolved
by `lib/config.ts`'s `resolveDataTheme()` and set by `layouts/Layout.astro` as
`<html data-theme="...">`. This selects a matching `:root[data-theme="..."] { ... }` (or, for the
default look, a bare `html` selector) block already compiled into this repo's own `tokens.css` —
see that file for the current set of built-in themes. Adding another means adding another block
to that same file, not a new file elsewhere.

A second, independent Foundry setting, "Allow Visitor Theme Override," controls whether a visitor
can pick their own theme from a dropdown (`ThemeSelector.astro`, saved to their own browser's
`localStorage`, applied via an inline `<head>` script before first paint to avoid a flash of the
wrong theme). Off by default: `Layout.astro` skips rendering both the script and the picker
entirely when the setting is off, not just hides them — the GM's Site Theme is then the only
theme anyone sees. Keeping the picker's own list of options (`ThemeSelector.astro`) in sync with
whatever blocks actually exist in `tokens.css` is a manual step — nothing currently derives one
from the other.

**Why built-in themes live in this repo instead of as separate files:** an earlier version of
this project loaded themes as standalone files, fetched externally at runtime
(`themes/parchment.css`). When `tokens.css`'s variable names were later renamed, nothing caught
that file silently going stale; it kept "working" (loading successfully) while doing nothing at
all, since every property it set no longer matched anything `base.css` read. It was removed
rather than fixed, and named themes moved into `tokens.css` itself specifically so a future
rename can't produce that failure mode again — a `--color-*` rename has to touch every
`[data-theme]` block in the same commit, in the same file, reviewed together.

There's deliberately no way to load a fully custom theme from an external URL right now (self-
hosting your own CSS outside this repo's build, without a redeploy here) — that's aspirational,
not something anything currently needs, and was cut rather than half-built. Straightforward to
add back later (as a second, clearly-separate mechanism from built-in `[data-theme]` blocks) if a
real need for it comes up.

## Token reference (`tokens.css`)

| Token | Value | Used for |
|---|---|---|
| `--color-font-heading` | `'Cinzel', 'Georgia', serif` | `h1`, `.site-title`, `.crumbs`, `.panel-title`, `.entry-title`, `.article-title`, prose headings, table headers |
| `--color-font-body` | `'EB Garamond', 'Garamond', serif` | `body`, `.meta`, prose paragraphs/tables |
| `--color-bg` | `#fdfaf2` | Page background; also the text color on `.prose th` (dark accent background) |
| `--color-card-bg` | `#f5eedc` | `.empty-state`, `.prose blockquote`, `.tag-item:hover` background |
| `--color-text-main` | `#2b1f14` | Body text, link hover color, `.meta a`, `.entry-title:hover`, `.pagination-status` |
| `--color-text-muted` | `#5c534c` | `.meta`, `.tag-label`, `.tag-sep`, `.pagination .disabled`, `.tag-count` |
| `--color-accent` | `#5c1d16` | Links, headings, `.panel-title`/`.article-title` borders-and-text, `.prose blockquote` left border, `.prose th` background |
| `--color-border` | `#b89047` | Every hairline border/rule (`h1`, `.panel-title`, `.pagination`, `.prose h1`/`h2`, `.empty-state`, avatars) |
| `--card-radius` | `0px` | Consumed via `var(--card-radius, 0px)` on `.empty-state` — sharp corners by default |
| `--avatar-radius` | `0px` | Consumed via `var(--avatar-radius, 0px)` on `.avatar` — square avatars by default |

Two more variables are *consumed* (with fallbacks) but never *set* in `tokens.css` — a theme can
define them to opt into an effect the built-in default doesn't use:

| Token | Fallback when unset | Used for |
|---|---|---|
| `--avatar-border` | `1px solid var(--color-border)` | `.avatar`, `.article-header .avatar` |
| `--card-border` | Varies: `2px solid var(--color-border)` on `.empty-state`; `none` on inline `.prose img`; `1px solid var(--color-border)` on a solitary breakout `.prose img` | Border around cards/images |

There's no spacing scale (no `--space-*` tokens) — each component's own scoped `<style>` picks
plain rem values directly.

See `tokens.css` itself for the current set of built-in named themes (each its own
`[data-theme="..."]` block below the values in the table above) — see "How theming works" below
for how one gets selected.

## Class reference

| Class | Purpose | Where it's styled |
|---|---|---|
| `.site-title` | Homepage masthead — the site name as `<h1>`. Also matches `h1.siteTitle`/`.siteTitle` (both spellings targeted at once) | `base.css` |
| `.crumbs`, `.separator`, `.current` | Breadcrumb row — styled as a large uppercase heading-like row, not a muted small line | `base.css` (colors/type) + `Breadcrumbs.astro` (layout: flex-wrap, gap) |
| `.world-dashboard`, `.sidebar-column` | Two-column homepage/world-index layout (Recent Posts main column, Browse + Tags sidebar on desktop; stacks single-column under 900px) | `base.css`, mirrored in `WorldIndex.astro`'s own `<style>` |
| `.panel`, `.panel-title` | One grouped block of content (rendered generically by `ContentPanel.astro` now — see below) | `base.css` (colors/type) + `ContentPanel.astro`/`TagCloud.astro` (layout) |
| `.entry-list`, `.entry`, `.entry-title` | A list of linked items inside a panel (or a full-page listing, e.g. `worlds/index.astro`) | `base.css` (colors/type) + `ContentPanel.astro` (layout) |
| `.meta` | Secondary line under a title (author, date) | `base.css` |
| `.avatar` | Small square (by default) author portrait, 24px | `base.css`. `.avatar-lg` (64px, the author archive page's larger variant) is defined locally in that page instead, per the component/page-local-styling pattern above |
| `.tag-container`, `.tag-item`, `.tag-name`, `.tag-count` | Tag cloud pills (replaces the old `.tag`/`.tag-cloud`/`.tag-count` names) | `base.css` + `TagCloud.astro`'s own `<style>` (both define overlapping rules — the component's scoped rules win within it) |
| `.pagination`, `.pagination-status`, `.disabled` | Prev/status/next row, now also has a dedicated `Pagination.astro` component (not yet used everywhere — the author archive page still hand-rolls its own `nav.pagination` markup) | `base.css` (colors/type) + `Pagination.astro` (grid layout) where used |
| `.empty-state` | Muted "nothing here yet" message, now a bordered/backgrounded card rather than plain italic text | `base.css` |
| `.article-header`, `.article-title` | Single-post page's title block (distinct from `.panel-title`/generic `h1`) | `base.css`, in `[slug]/index.astro` |
| `.tag-label`, `.post-tag`, `.tag-sep` | The post page's own "Tags: a, b, c" line | `base.css`, in `[slug]/index.astro` |
| `.prose` | Post body wrapper — now includes a drop-cap on the first paragraph, justified text, styled blockquotes/tables, and a "breakout" rule that lets a lone image span full-bleed width | `base.css` |

## Shared components

- **`ContentPanel.astro`** — generic `{title, items[]}` renderer for any "list of linked things
  with optional author/date/section metadata" panel. Replaces the previously-separate
  `JournalFeed.astro`, `JournalsAtLevel.astro`, `JournalsInSection.astro`, `ChildSections.astro`, and
  `RecentPosts.astro` (all now deleted) with one component driven by a plain `Item[]` array each
  caller builds from its own data.
- **`Breadcrumbs.astro`** — `{siteName, crumbs[], currentLabel?}`, replacing the inline
  `<nav class="crumbs">...</nav>` markup previously duplicated in every page file.
- **`Pagination.astro`** — `{prevUrl, nextUrl, pageNum, totalPages}`, replacing inline
  `<nav class="pagination">` markup. Adopted in the journal, tag, and author archive pages.
