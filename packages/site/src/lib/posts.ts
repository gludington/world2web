import { existsSync } from "node:fs";
import path from "node:path";
import { getCollection, type CollectionEntry } from "astro:content";

// Injected by the integration (index.mjs) -- see lib/config.ts.
declare const __WORLD2WEB_CONTENT_DIR__: string;
const WORLDS_DIR = path.join(__WORLD2WEB_CONTENT_DIR__, "worlds");

/** Every published post -- excludes soft-deleted ("unpublished") entries.
 * Foundry has no way to delete an already-pushed file from GitHub
 * (github.js's putFile only ever creates or updates), so unpublishing a
 * previously-published post instead stamps `unpublished: true` on that
 * post's own frontmatter (a tombstone, still in git history) rather than
 * removing the file. Every page on this site must query posts through
 * here, never `getCollection("posts")` directly, or a tombstoned post
 * will still render. */
export async function getPublishedPosts(): Promise<CollectionEntry<"posts">[]> {
  // A brand-new site, before its first Publish to Web, has no content at
  // all. Asking Astro for the collection then logs "The collection 'posts'
  // does not exist or is empty. Please check your content config file for
  // errors" once per page -- harmless, but it's the first thing a new user
  // sees in their host's build log, and it reads as broken.
  if (!existsSync(WORLDS_DIR)) return [];
  return getCollection("posts", (entry) => !entry.data.unpublished);
}
