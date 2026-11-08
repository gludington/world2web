import type { CollectionEntry } from "astro:content";

// Shared between the homepage (the "root level" -- depth 0, no root prefix
// at all) and every section page (pages/journals/[world]/[...journal].astro,
// deeper levels) so there's exactly one implementation of "walk every
// journal's root path and figure out what lives at each level," not two
// independently-maintained copies.
// Deliberately no author fields here: a journal's posts can each have their
// own author (Post Settings' author override, see the Foundry module's
// collector.js), so there's no single reliable "the journal's author" to
// aggregate -- and this used to pick one arbitrarily (whichever post
// toJournalInfos() below happened to see first for a given journalUuid), which
// silently stopped being representative once that override existed.
// Author is shown per-post everywhere instead (already accurate); a journal
// itself just isn't attributed to anyone in journal-level listings.
export interface JournalInfo {
  journalUuid: string;
  world: string;
  journalSlug: string;
  journalTitle: string;
  root: string | null;
  postOrder: "newest" | "oldest" | "manual";
}

export interface SectionInfo {
  world: string;
  slug: string;
  label: string;
}

export interface SectionNode {
  label: string;
  journals: JournalInfo[];
  childSlugs: Set<string>;
}

/** Groups a flat post list into one JournalInfo per journalUuid (posts.length
 * copies of otherwise-identical journal metadata collapse into one entry). */
export function toJournalInfos(posts: CollectionEntry<"posts">[]): JournalInfo[] {
  const byUuid = new Map<string, JournalInfo>();
  for (const post of posts) {
    if (byUuid.has(post.data.journalUuid)) continue;
    byUuid.set(post.data.journalUuid, {
      journalUuid: post.data.journalUuid,
      world: post.data.world,
      journalSlug: post.data.journalSlug,
      journalTitle: post.data.journalTitle,
      root: post.data.root,
      postOrder: post.data.postOrder,
    });
  }
  return Array.from(byUuid.values());
}

/** A journal's posts in the same order its own archive page displays them --
 * shared so that order (which drives that archive's pagination) and prev/
 * next post navigation never silently disagree with each other. Mutates
 * nothing; returns a new array. */
export function sortPostsForJournal<T extends CollectionEntry<"posts">>(posts: T[], postOrder: JournalInfo["postOrder"]): T[] {
  return [...posts].sort((a, b) => {
    if (postOrder === "oldest") return a.data.publishedAt - b.data.publishedAt;
    if (postOrder === "manual") return a.data.sortIndex - b.data.sortIndex;
    return b.data.publishedAt - a.data.publishedAt;
  });
}

/** Builds, per world, a map of every root-prefix slug -> {label, journals,
 * childSlugs}, by walking every journal's root path. A journal with no root at
 * all contributes nothing here (it belongs at the root/depth-0 level,
 * which this map doesn't represent -- callers handle that case directly by
 * filtering for `root === null`). Label is first-seen-wins if two journals
 * disagree on a segment's spelling/casing. */
export function buildSectionTree(journals: JournalInfo[]): Map<string, Map<string, SectionNode>> {
  const sectionsByWorld = new Map<string, Map<string, SectionNode>>();

  for (const journal of journals) {
    if (!journal.root) continue;
    const labels = journal.root
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    if (labels.length === 0) continue;
    const slugParts = journal.journalSlug.split("/").slice(0, labels.length);

    if (!sectionsByWorld.has(journal.world)) sectionsByWorld.set(journal.world, new Map());
    const sections = sectionsByWorld.get(journal.world)!;

    for (let depth = 1; depth <= labels.length; depth++) {
      const prefixSlug = slugParts.slice(0, depth).join("/");
      if (!sections.has(prefixSlug)) {
        sections.set(prefixSlug, { label: labels[depth - 1], journals: [], childSlugs: new Set() });
      }
      if (depth === labels.length) {
        sections.get(prefixSlug)!.journals.push(journal);
      } else {
        sections.get(prefixSlug)!.childSlugs.add(slugParts.slice(0, depth + 1).join("/"));
      }
    }
  }

  return sectionsByWorld;
}

/** The top-level (depth-1) sections across every world -- what the
 * "sections one level down" widget shows on the homepage, i.e. the root
 * level's own children. */
export function topLevelSections(sectionsByWorld: Map<string, Map<string, SectionNode>>): SectionInfo[] {
  const result: SectionInfo[] = [];
  for (const [world, sections] of sectionsByWorld) {
    for (const [slug, info] of sections) {
      if (!slug.includes("/")) result.push({ world, slug, label: info.label });
    }
  }
  return result;
}

export interface JournalWithSubPath {
  journal: JournalInfo;
  /** Labels of the sections between the queried level and this journal --
   * empty when the journal sits directly at the queried level. E.g. querying
   * "pcs" for a journal rooted at "PCs/Act 1" yields subPath: ["Act 1"]. */
  subPath: string[];
}

/** Every journal at the given section prefix *or in any section beneath it*,
 * recursively -- unlike a section's own `journals` (exact level only), this
 * is what actually answers "what's in this category, including
 * sub-categories," which is usually the more useful view on a section
 * page: a section with real nesting (e.g. "PCs" containing "PCs/Act 1",
 * "PCs/Act 2") often has few or no journals directly on it, with everything
 * actually living one or more levels deeper. */
export function journalsInSubtree(sections: Map<string, SectionNode>, prefixSlug: string): JournalWithSubPath[] {
  const node = sections.get(prefixSlug);
  if (!node) return [];

  const direct: JournalWithSubPath[] = node.journals.map((journal) => ({ journal, subPath: [] }));
  const nested: JournalWithSubPath[] = Array.from(node.childSlugs).flatMap((childSlug) => {
    const childLabel = sections.get(childSlug)?.label ?? childSlug.split("/").pop()!;
    return journalsInSubtree(sections, childSlug).map(({ journal, subPath }) => ({
      journal,
      subPath: [childLabel, ...subPath],
    }));
  });
  return [...direct, ...nested];
}
