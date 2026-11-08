import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// The glob loader's default id generation special-cases a `slug` frontmatter
// field and uses *only* that as the id, dropping the rest of the path. Our
// frontmatter has exactly such a field (per-author-unique, not global), so
// force ids to the full relative path instead -- otherwise routes silently
// lose their world/author segments. (Bit us once already on an earlier
// content model; see project memory.)
const generateId = ({ entry }: { entry: string }) => entry.replace(/\.md$/, "");

const postSchema = z.object({
  foundryUuid: z.string(),
  world: z.string(),
  journalUuid: z.string(),
  journalTitle: z.string(),
  // journalSlug: unique per journal entry (disambiguated on collision) -- the
  // single-journal archive/permalink identity. authorSlug: shared across every
  // journal with the same displayed author name, deliberately NOT
  // disambiguated -- the cross-journal author archive identity. See
  // assignSlugs() in the Foundry module's render.js or this repo's
  // scripts/ingest.js (both implement it identically) for why these are
  // kept distinct.
  journalSlug: z.string(),
  // Raw (unslugified) root text, e.g. "PCs/Act 1" -- the slugified version
  // is already folded into journalSlug's prefix; this is kept separately for
  // human-readable breadcrumb/section labels. null when there's no root.
  root: z.string().nullable(),
  title: z.string(),
  slug: z.string(),
  author: z.object({
    userId: z.string().nullable(),
    name: z.string(),
    image: z.string().nullable(),
    isGM: z.boolean(),
    // Raw HTML passthrough, same as post bodies -- pulled live from an
    // Actor's own (system-specific) biography field when one is involved
    // in resolving this author, empty otherwise. .default("") so posts
    // published before this field existed still validate.
    bio: z.string().default(""),
  }),
  authorSlug: z.string(),
  tags: z.array(z.string()),
  // This post's own explicit featured image, if it set one -- a URL,
  // already resolved to absolute by the Foundry module's collector.js
  // (resolveAssetUrl), same as author.image. "" (never null) when unset;
  // never auto-derived from the post's own body content. .default("") so
  // posts published before this field existed still validate.
  frontImage: z.string().default(""),
  // This journal's own post-archive listing order -- every other listing
  // site-wide (recent posts, author/tag archives) always shows
  // newest-published-first regardless of this value. "manual" (the
  // default) means the exact order pages appear in Foundry's own page
  // list -- see sortIndex below. .default("manual") so posts published
  // before this field existed still validate -- note that for those,
  // sortIndex also defaults to 0 for every post (see below), so they'll
  // all tie and fall back to whatever order Array.sort leaves them in,
  // not a real chronological order, until republished with a real sort.
  postOrder: z.enum(["newest", "oldest", "manual"]).default("manual"),
  // Foundry's own page.sort -- only meaningful when postOrder is "manual".
  // .default(0) so posts published before this field existed still
  // validate (they'll all tie at 0 under "manual", falling back to
  // whatever order Array.sort leaves them in -- harmless, since "manual"
  // has to be deliberately chosen per journal anyway).
  sortIndex: z.number().default(0),
  // Journal-level, copied onto each post like postOrder: whether this
  // journal is featured on its world's index page (the site homepage on a
  // single-world site) -- "above" or "replace" Recent Posts -- or not.
  // Per world by construction: each world's posts live under their own
  // content/worlds/<world>/, so worlds publishing to one site can't
  // overwrite each other's choice. .default("none") so posts published
  // before this field existed still validate.
  homepage: z.enum(["none", "above", "replace"]).default("none"),
  publishedAt: z.number(),
  updatedAt: z.number(),
  // Soft-delete tombstone: true once a previously-published post is
  // unpublished in Foundry. The file itself is never deleted (there's no
  // GitHub-delete step in the publish pipeline), so every query against
  // this collection must go through getPublishedPosts() in lib/posts.ts,
  // never getCollection("posts") directly, or a tombstoned post will
  // still render.
  unpublished: z.boolean(),
});

export const collections = {
  // content/worlds/<world-slug>/journals/<journal-slug>/<post-slug>.md, where
  // <journal-slug> can itself be more than one path segment (a root path
  // prefix followed by the journal's own slug, e.g. "arc-1/session-notes") --
  // "**" rather than a single "*" between journals/ and the filename, to match
  // any depth there, not just exactly one directory.
  posts: defineCollection({
    // Relative to the project root (this repo), not to this file's own
    // src/ directory -- content/ now lives inside this same repo
    // (world2web-site-template), not as a sibling one level up like it did
    // when the site was still developed inside the world2web dev repo.
    loader: glob({ pattern: "*/journals/**/*.md", base: "content/worlds", generateId }),
    schema: postSchema,
  }),
};
