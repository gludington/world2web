import { getSiteConfig } from "./config";

// Two distinct identities, deliberately not conflated:
//  - "journal" = one journal entry. journalSlug is disambiguated (uuid suffix on
//    collision) so it always maps to exactly one journal.
//  - "author" = a displayed author name. authorSlug is NOT disambiguated --
//    multiple journals sharing the same author name are meant to merge onto
//    one author page. See assignSlugs() in the Foundry module's render.js
//    or this repo's scripts/ingest.js -- both implement it identically.
//
// URLs are world-first: /<world>/<journalsSegment>/..., /<world>/authors/...,
// /<world>/tags/.... journalsSegment is the one configurable piece (the
// "Journals URL Segment" Foundry setting, default "journals" -- see
// lib/config.ts's getSiteConfig()); "authors"/"tags" are fixed literals,
// only their position (now under the world) changed.
interface JournalRef {
  world: string;
  journalSlug: string;
}

interface PostRef extends JournalRef {
  slug?: string;
}

interface AuthorRef {
  world: string;
  authorSlug: string;
}

interface TagRef {
  world: string;
  tagSlug: string;
}

export function postRoute(post: PostRef): string {
  const { journalsSegment } = getSiteConfig();
  return `/${post.world}/${journalsSegment}/${post.journalSlug}/${post.slug}/`;
}

export function journalRoute(journal: JournalRef): string {
  const { journalsSegment } = getSiteConfig();
  return `/${journal.world}/${journalsSegment}/${journal.journalSlug}/`;
}

export function authorRoute(author: AuthorRef): string {
  return `/${author.world}/authors/${author.authorSlug}/`;
}

export function tagRoute(tag: TagRef): string {
  return `/${tag.world}/tags/${tag.tagSlug}/`;
}

/** The site's one search page (pages/search/index.astro) -- not
 * world-scoped, since Pagefind's index spans every world at once. See
 * README.md's "Search" section for the Pagefind setup this page
 * relies on. */
export function searchRoute(): string {
  return `/search/`;
}

export interface Crumb {
  label: string;
  href: string;
}

/** Breadcrumb entries for a journal's root path, one per segment, each linking
 * to that segment's own section page (pages/[world]/[section]/[...journal].astro,
 * the "section" case) -- e.g. a root of "PCs/Act 1" on a journal whose
 * journalSlug is "pcs/act-1/some-journal" yields
 * [{label:"PCs", href:"/<world>/<journalsSegment>/pcs/"}, {label:"Act 1", href:"/<world>/<journalsSegment>/pcs/act-1/"}].
 * Deliberately doesn't need to re-slugify anything: journalSlug already has the
 * root's slugified form as its own leading segments (assignSlugs built it
 * that way), in the same order and count as the raw root's own segments --
 * so this just re-pairs raw labels with the slug segments already sitting
 * in journalSlug. Returns [] when there's no root at all. */
export function rootCrumbs(entry: { world: string; root: string | null; journalSlug: string }): Crumb[] {
  if (!entry.root) return [];
  const labels = entry.root
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (labels.length === 0) return [];
  const { journalsSegment } = getSiteConfig();
  const slugParts = entry.journalSlug.split("/").slice(0, labels.length);
  return labels.map((label, i) => ({
    label,
    href: `/${entry.world}/${journalsSegment}/${slugParts.slice(0, i + 1).join("/")}/`,
  }));
}

/** Same "/<world>/<journalsSegment>/<slug>/" shape as journalRoute(), for a
 * section prefix rather than a full journal slug -- used by ChildSections. */
export function sectionRoute(world: string, prefixSlug: string): string {
  const { journalsSegment } = getSiteConfig();
  return `/${world}/${journalsSegment}/${prefixSlug}/`;
}

/** A world's own journal index -- /<world>/<journalsSegment>/ with no further
 * path at all (pages/[world]/[section]/index.astro). Not just sectionRoute()
 * with an empty prefix: that would produce a trailing double slash. */
export function worldIndexRoute(world: string): string {
  const { journalsSegment } = getSiteConfig();
  return `/${world}/${journalsSegment}/`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Best-effort display label for a world slug -- slugs are all we have per
 * world (Foundry's actual world title only survives as this already-
 * slugified form, see assignSlugs() in the Foundry module's render.js or
 * this repo's scripts/ingest.js), so this is a guess, not a preserved
 * original title. */
export function worldLabel(world: string): string {
  return world.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
