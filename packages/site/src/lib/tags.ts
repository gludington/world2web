// Matches the slugify() in foundry-module/scripts/render.js and
// scripts/ingest.js, but tags aren't pre-slugged in frontmatter (unlike
// journalSlug/authorSlug) since they're a freeform, editable list -- slugify
// on the site side instead, at both the link-out (post page) and
// link-target (tag archive's getStaticPaths) ends, so they always agree.
export function slugifyTag(tag: string): string {
  const slug = tag
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "tag";
}
