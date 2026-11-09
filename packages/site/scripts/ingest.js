#!/usr/bin/env node
/**
 * Local stand-in for the Cloudflare Worker step in the Foundry module's own
 * design docs: takes a world2web collector payload (downloaded from Foundry
 * via the module's "Dev Sync" button, hidden unless "Enable Dev Mode" is
 * checked in the module's settings) and writes it out as content/ markdown,
 * matching this site's content model. No network calls, no git commit --
 * just files on disk, reviewed and committed by hand.
 *
 * Lives in this repo (not the Foundry module/sync repo) specifically so
 * anyone working on the Astro templates only needs one checkout: point
 * "Dev Sync" at your own test world, run this, and `astro dev` picks up
 * the result immediately -- no second repo, no env var pointing across
 * repos.
 *
 * Usage:
 *   node scripts/ingest.js <path-to-collector-payload.json> [--content-dir <dir>]
 *
 * Writes to <this repo>/content by default; --content-dir overrides that
 * if you want it somewhere else.
 *
 * Diffing is coarse for now: each run fully replaces the target world's
 * directory under content/worlds/<world-slug>/ with the new payload, rather
 * than doing UUID-keyed add/update/delete reconciliation. That's the right
 * level of care once this is wired to real git-integration publishing; for
 * now, `git status` after a run shows you exactly what changed.
 *
 * No asset handling (author portrait images keep their original
 * Foundry-relative paths) -- not needed for text-only posts yet.
 */

import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

function slugify(str) {
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
function slugifyPath(rawPath) {
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
 *    journal's author (see the Foundry module's collector.js's
 *    resolvePostAuthor) and needs to land on its own author's archive
 *    page, not its journal's default one. NOT disambiguated on collision --
 *    this is what lets every post sharing the same author name merge onto
 *    one cross-journal author archive page, whether that name comes from the
 *    same journal or not. Collision here is the intended behavior, not a bug.
 * Also assigns a unique slug per post within each journal (disambiguated by
 * page uuid). */
function assignSlugs(journals) {
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
    // post.author/post.tags: already fully resolved by the Foundry
    // module's collector.js with inheritance baked in (a post with no
    // override of its own gets its journal's own author/tags verbatim; one
    // with an override gets that instead) -- so this is always the right
    // value to write, never journal.author/journal.tags directly.
    author: post.author,
    authorSlug: post._authorSlug,
    tags: post.tags ?? [],
    frontImage: post.frontImage ?? "",
    // This journal's own post-archive order ("manual"/"newest"/"oldest") --
    // every other listing site-wide (recent posts, author/tag archives)
    // always shows newest-published-first regardless of this value.
    postOrder: ["newest", "oldest"].includes(journal.postOrder) ? journal.postOrder : "manual",
    // Foundry's own page.sort -- only consumed site-side when postOrder is
    // "manual". See the Foundry module's collector.js's collectPost() for
    // why this is always collected regardless of postOrder.
    sortIndex: post.sortIndex ?? 0,
    // Journal-level, copied onto each post like postOrder -- see the
    // Foundry module's collector.js resolveHomepage().
    homepage: ["above", "replace"].includes(journal.homepage) ? journal.homepage : "none",
    publishedAt: post.publishedAt,
    updatedAt: post.updatedAt,
    // Soft-delete tombstone -- true once a previously-published post is
    // unpublished. The file still gets written (there's no way to delete
    // an already-pushed file from GitHub), but this site's content queries
    // (getPublishedPosts() in src/lib/posts.ts) filter these out.
    unpublished: !!post.unpublished,
  };
}

async function writeJournal(contentDir, worldSlug, journal) {
  const dir = path.join(contentDir, "worlds", worldSlug, "journals", journal._slug);
  await mkdir(dir, { recursive: true });

  for (const post of journal.posts) {
    await writeFile(
      path.join(dir, `${post._slug}.md`),
      // Same as the module's render.js: an unpublished post keeps only its
      // tracking frontmatter -- no text, biography or front image.
      post.unpublished
        ? `${toFrontmatter(stripUnpublishedContent(postFrontmatter(worldSlug, journal, post)))}\n`
        : `${toFrontmatter(postFrontmatter(worldSlug, journal, post))}\n${post.html}\n`,
    );
  }
}

/** Mirrors the World2Web module's render.js stripUnpublishedContent(). */
function stripUnpublishedContent(frontmatter) {
  return {
    ...frontmatter,
    author: frontmatter.author ? { ...frontmatter.author, bio: "" } : frontmatter.author,
    frontImage: "",
    unpublished: true,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const payloadPath = args.find((a) => !a.startsWith("--"));
  const contentDirFlagIdx = args.indexOf("--content-dir");
  const contentDirArg = contentDirFlagIdx >= 0 ? args[contentDirFlagIdx + 1] : null;

  if (!payloadPath) {
    console.error("Usage: world2web-ingest <path-to-collector-payload.json> [--content-dir <dir>]  (run from your site repo's root)");
    process.exit(1);
  }

  // Run from the site repo's root (as `world2web-ingest`, installed with
  // @world2web/site), so content/ is relative to the current directory --
  // not to this script, which now lives inside node_modules.
  const contentDir = contentDirArg ? path.resolve(contentDirArg) : path.join(process.cwd(), "content");

  const raw = await readFile(path.resolve(payloadPath), "utf-8");
  const payload = JSON.parse(raw);

  const worldSlug = slugify(payload.world?.title || payload.world?.id || "world");
  const journals = payload.journals ?? [];

  assignSlugs(journals);

  const journalsDir = path.join(contentDir, "worlds", worldSlug, "journals");
  if (existsSync(journalsDir)) {
    await rm(journalsDir, { recursive: true, force: true });
  }
  await mkdir(journalsDir, { recursive: true });

  let postCount = 0;
  for (const journal of journals) {
    await writeJournal(contentDir, worldSlug, journal);
    postCount += journal.posts.length;
  }

  // content/site-config.json: read by src/lib/config.ts at Astro build time
  // (theme, site name, journals URL segment, allowThemeOverride). The
  // direct-to-GitHub path (the Foundry module's main.js's publishToGitHub
  // -> render.js's buildSiteConfigFile) writes this too; this is the
  // equivalent for the local "Dev Sync" + ingest.js path, which only ever
  // sees this downloaded JSON, never a live game.settings.
  const siteConfig = payload.siteConfig ?? {};
  await writeFile(
    path.join(contentDir, "site-config.json"),
    `${JSON.stringify(
      {
        theme: siteConfig.theme || "default",
        siteName: siteConfig.siteName || "World2Web",
        journalsSegment: siteConfig.journalsSegment || "journals",
        allowThemeOverride: !!siteConfig.allowThemeOverride,
      },
      null,
      2,
    )}\n`,
  );

  // content/worlds/<world>/world-config.json: this world's own settings
  // (Homepage Links), in its own folder so worlds sharing a site don't
  // overwrite each other's -- the same file the module's Publish to Web
  // writes (render.js's buildWorldConfigFile).
  const worldConfig = payload.worldConfig ?? {};
  await writeFile(
    path.join(contentDir, "worlds", worldSlug, "world-config.json"),
    `${JSON.stringify(
      { homepageLinks: Array.isArray(worldConfig.homepageLinks) ? worldConfig.homepageLinks : [] },
      null,
      2,
    )}\n`,
  );

  console.log(`world2web ingest: wrote ${postCount} post(s) across ${journals.length} journal(s) to ${journalsDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
