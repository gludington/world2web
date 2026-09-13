/**
 * Pure transform: a collectJournalData() payload -> a flat list of
 * {path, content} markdown files, matching the content/worlds/... layout
 * scripts/ingest.js (site-template repo) writes locally. No filesystem, no
 * network -- deliberately duplicated from that script's equivalent logic
 * rather than shared across a repo boundary: Foundry modules serve only
 * files inside their own folder, so a shared module living outside
 * foundry-module/ wouldn't resolve at runtime without adding a build step,
 * which this project has otherwise avoided throughout. Keep the two in
 * sync by hand if the file-naming/frontmatter shape ever changes.
 */

export function slugify(str) {
  const slug = String(str ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

/** Slugifies a "/"-delimited path (a journal's root override or its default
 * folder-hierarchy path), segment by segment -- "Arc 1/Session Notes" ->
 * "arc-1/session-notes". Leading/trailing/doubled slashes collapse away
 * (split -> filter(Boolean)). Empty/missing input -> "". */
export function slugifyPath(rawPath) {
  return String(rawPath ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map(slugify)
    .join("/");
}

/** Assigns distinct slugs, deliberately not conflated:
 *  - journal._slug: unique per journal entry (disambiguated by journal uuid on
 *    collision), built from the journal's root (a slugified "/"-path prefix,
 *    empty if none) followed by a slug of the journal's own title. Drives the
 *    single-journal archive URL/permalink and the content/ directory name --
 *    two different journals must never collide here, even if they share a
 *    root.
 *  - post._authorSlug: based on the displayed author name of that POST
 *    specifically -- not a journal-wide value, since a post can override its
 *    journal's author (see collector.js's resolvePostAuthor) and needs to
 *    land on its own author's archive page, not its journal's default one.
 *    NOT disambiguated on collision -- this is what lets every post
 *    sharing the same author name merge onto one cross-journal author
 *    archive page, whether that name comes from the same journal or not.
 *    Collision here is the intended behavior, not a bug.
 * Also assigns a unique slug per post within each journal (disambiguated by
 * page uuid). Mutates journals/posts in place, same as the site-template repo's
 * scripts/ingest.js version. */
export function assignSlugs(journals) {
  const seenJournalSlugs = new Map();
  for (const journal of journals) {
    const rootSlug = slugifyPath(journal.root);
    const titleSlug = slugify(journal.title);
    let leaf = titleSlug;
    let combined = rootSlug ? `${rootSlug}/${leaf}` : leaf;
    if (seenJournalSlugs.has(combined)) {
      leaf = `${titleSlug}-${journal.uuid.split(".").pop().slice(-6).toLowerCase()}`;
      combined = rootSlug ? `${rootSlug}/${leaf}` : leaf;
    }
    seenJournalSlugs.set(combined, journal.uuid);
    journal._slug = combined;

    const seenPostSlugs = new Map();
    for (const post of journal.posts) {
      const postBase = slugify(post.title);
      let postSlug = postBase;
      if (seenPostSlugs.has(postSlug)) {
        postSlug = `${postBase}-${post.uuid.split(".").pop().slice(-6).toLowerCase()}`;
      }
      seenPostSlugs.set(postSlug, post.uuid);
      post._slug = postSlug;
      post._authorSlug = slugify(post.author.name);
    }
  }
}

/** A single JSON flow-style object is valid YAML, so this doubles as
 * frontmatter without pulling in a YAML serializer dependency. */
function toFrontmatter(obj) {
  return `---\n${JSON.stringify(obj, null, 2)}\n---\n`;
}

function postFrontmatter(worldSlug, journal, post) {
  return {
    foundryUuid: post.uuid,
    world: worldSlug,
    journalUuid: journal.uuid,
    journalTitle: journal.title,
    journalSlug: journal._slug,
    // Raw (unslugified) root text, e.g. "PCs/Act 1" -- kept alongside the
    // already-slugified prefix baked into journalSlug so the site can render
    // human-readable breadcrumb/section labels ("Act 1") rather than their
    // URL slugs ("act-1"). null when the journal has no root at all.
    root: journal.root ?? null,
    title: post.title,
    slug: post._slug,
    // post.author/post.tags: already fully resolved by collector.js with
    // inheritance baked in (a post with no override of its own gets its
    // journal's own author/tags verbatim; one with an override gets that
    // instead) -- so this is always the right value to write, never
    // journal.author/journal.tags directly.
    author: post.author,
    authorSlug: post._authorSlug,
    tags: post.tags ?? [],
    frontImage: post.frontImage ?? "",
    // This journal's own post-archive order ("manual"/"newest"/"oldest") --
    // every other listing site-wide (recent posts, author/tag archives)
    // always shows newest-published-first regardless of this value.
    postOrder: ["newest", "oldest"].includes(journal.postOrder) ? journal.postOrder : "manual",
    // Foundry's own page.sort -- only consumed site-side when postOrder is
    // "manual". See collector.js's collectPost() for why this is always
    // collected regardless of postOrder.
    sortIndex: post.sortIndex ?? 0,
    publishedAt: post.publishedAt,
    updatedAt: post.updatedAt,
    // Soft-delete tombstone -- true once a previously-published post is
    // unpublished. The file still gets written (there's no way to delete
    // an already-pushed file from GitHub), but the site's content queries
    // (getPublishedPosts() in the site repo's src/lib/posts.ts) filter these out.
    unpublished: !!post.unpublished,
  };
}

/** Render a collectJournalData() payload into a flat list of {path, content}
 * files, ready to push individually (e.g. via github.js's putFile). path is
 * relative to the repo root, matching the on-disk layout the site-template
 * repo's scripts/ingest.js produces. */
export function renderPayloadToFiles(payload) {
  const worldSlug = slugify(payload.world?.title || payload.world?.id || "world");
  const journals = payload.journals ?? [];
  assignSlugs(journals);

  const files = [];
  for (const journal of journals) {
    for (const post of journal.posts) {
      files.push({
        path: `content/worlds/${worldSlug}/journals/${journal._slug}/${post._slug}.md`,
        content: `${toFrontmatter(postFrontmatter(worldSlug, journal, post))}\n${post.html}\n`,
      });
    }
  }
  return { worldSlug, files };
}

/** content/site-config.json: the one non-post-data file this module pushes.
 * Read directly (plain fs, not the content-collections API) by
 * the site repo's src/lib/config.ts at Astro build time -- see that file for
 * how `theme` selects a built-in `[data-theme]` block in the site's own
 * tokens.css, `siteName` replaces the "World2Web" branding throughout the
 * site, `journalsSegment` becomes the "journals" (or whatever it's set to)
 * segment in every journal/post URL (world-first: /<world>/<journalsSegment>/...),
 * and `allowThemeOverride` controls whether the site shows a
 * visitor-facing theme picker at all. Site-wide settings (module setting ->
 * pushed file -> read at build) that need to reach an already-deployed
 * site without any git action belong here. */
export function buildSiteConfigFile({ theme, siteName, journalsSegment, allowThemeOverride }) {
  return {
    path: "content/site-config.json",
    content: `${JSON.stringify(
      {
        theme: theme || "default",
        siteName: siteName || "World2Web",
        journalsSegment: journalsSegment || "journals",
        allowThemeOverride: !!allowThemeOverride,
      },
      null,
      2,
    )}\n`,
  };
}
