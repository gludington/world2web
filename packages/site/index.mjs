// @world2web/site -- the World2Web site as an Astro integration.
//
// A user's site repo holds only its content (written by the Foundry module)
// plus a few lines of config; every page, component and style lives in this
// package. Updating the site means bumping this package's version, which the
// Foundry module can do on Publish to Web -- no more copying template files
// into every user's repo, where they could never be updated.
//
// Plain .mjs rather than TypeScript: Astro loads integrations through Node
// directly, and Node refuses to strip types from files under node_modules.
// The .astro/.ts files under src/ are fine -- Vite compiles those.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Every page this package provides, as [URL pattern, file under src/pages/]. */
const ROUTES = [
  ["/", "index.astro"],
  ["/search", "search/index.astro"],
  ["/worlds", "worlds/index.astro"],
  ["/[world]/authors/[author]/[...page]", "[world]/authors/[author]/[...page].astro"],
  ["/[world]/tags/[tag]/[...page]", "[world]/tags/[tag]/[...page].astro"],
  ["/[world]/[section]", "[world]/[section]/index.astro"],
  ["/[world]/[section]/[...journal]", "[world]/[section]/[...journal].astro"],
  ["/[world]/[section]/[...journal]/[slug]", "[world]/[section]/[...journal]/[slug]/index.astro"],
];

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(full);
    else if (entry.name.endsWith(".html")) yield full;
  }
}

// Matches Layout.astro: pages that shouldn't be searchable (every listing
// page) render <body data-pagefind-ignore="">.
const IGNORED_BODY_RE = /<body\b[^>]*\bdata-pagefind-ignore\b/;

/**
 * Builds the Pagefind search index over the finished site. Skipped while the
 * site has no searchable pages (a brand-new site before its first publish):
 * Pagefind treats "nothing to index" as an error, which used to fail the very
 * first host build. Any other indexing error still fails the build.
 */
async function buildSearchIndex(siteDir, logger) {
  const hasSearchablePage = [...htmlFiles(siteDir)].some(
    (file) => !IGNORED_BODY_RE.test(readFileSync(file, "utf-8")),
  );
  if (!hasSearchablePage) {
    logger.info("No published posts yet -- skipping the search index.");
    return;
  }

  const pagefind = await import("pagefind");
  const { index, errors } = await pagefind.createIndex();
  if (!index) throw new Error(`Pagefind couldn't start: ${errors.join("; ")}`);
  try {
    const added = await index.addDirectory({ path: siteDir });
    if (added.errors.length) throw new Error(`Pagefind indexing failed: ${added.errors.join("; ")}`);
    const written = await index.writeFiles({ outputPath: join(siteDir, "pagefind") });
    if (written.errors.length) throw new Error(`Pagefind couldn't write its index: ${written.errors.join("; ")}`);
    logger.info("Search index built.");
  } finally {
    await pagefind.close();
  }
}

/**
 * @param {object} [options] Reserved for future site options; none yet.
 * @returns {import("astro").AstroIntegration}
 */
export default function world2web(options = {}) {
  void options;
  return {
    name: "@world2web/site",
    hooks: {
      "astro:config:setup": ({ config, injectRoute, updateConfig }) => {
        for (const [pattern, file] of ROUTES) {
          injectRoute({ pattern, entrypoint: new URL(`./src/pages/${file}`, import.meta.url) });
        }

        // The user's content/ folder, resolved against their project root.
        // Baked in at build time (Vite `define`) because neither
        // process.cwd() nor a bundled module's own import.meta.url reliably
        // points at the project at runtime -- see src/lib/config.ts.
        const contentDir = fileURLToPath(new URL("./content/", config.root));
        updateConfig({
          vite: {
            define: { __WORLD2WEB_CONTENT_DIR__: JSON.stringify(contentDir) },
          },
        });
      },

      "astro:build:done": async ({ dir, logger }) => {
        const siteDir = fileURLToPath(dir);
        if (!existsSync(siteDir)) return;
        await buildSearchIndex(siteDir, logger);
      },
    },
  };
}
