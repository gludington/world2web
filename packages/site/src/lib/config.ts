import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// content/site-config.json is pushed by the Foundry module's
// publishToGitHub() alongside post markdown (see render.js's
// buildSiteConfigFile) -- read directly here rather than through the
// content-collections API, since it's a single site-wide value, not a
// collection of entries. This is the mechanism that lets a site-wide
// setting (chosen once, in Foundry) reach an already-deployed site without
// any git action: it rides the same publish button that's already pushing
// posts, not a separate step.
//
// __WORLD2WEB_CONTENT_DIR__ is injected by astro.config.mjs via Vite's
// `define` -- neither process.cwd() (depends on the invoking shell's
// working directory when the build command runs, not this project's root)
// nor this module's own import.meta.url (Astro relocates this into a build
// chunk under dist/.prerender/chunks/, losing its real source location) is
// reliable here. See astro.config.mjs for why its own import.meta.url is.
declare const __WORLD2WEB_CONTENT_DIR__: string;
const CONFIG_PATH = path.join(__WORLD2WEB_CONTENT_DIR__, "site-config.json");

const DEFAULT_SITE_NAME = "World2Web";
const DEFAULT_JOURNALS_SEGMENT = "journals";

/** The configured URL segment name gets slugified here, once, regardless
 * of what the GM actually typed into the Foundry setting -- unlike
 * siteName/theme (plain text, never embedded in a URL), this one becomes a
 * literal path segment on every journal/post URL, so it has to be URL-safe no
 * matter what. */
function slugifySegment(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

export interface SiteConfig {
  theme: string;
  siteName: string;
  journalsSegment: string;
  allowThemeOverride: boolean;
}

const DEFAULT_SITE_CONFIG: SiteConfig = {
  theme: "default",
  siteName: DEFAULT_SITE_NAME,
  journalsSegment: DEFAULT_JOURNALS_SEGMENT,
  allowThemeOverride: false,
};

export function getSiteConfig(): SiteConfig {
  if (!existsSync(CONFIG_PATH)) {
    return DEFAULT_SITE_CONFIG;
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const theme = typeof raw.theme === "string" && raw.theme.trim() ? raw.theme.trim() : "default";
    const siteName = typeof raw.siteName === "string" && raw.siteName.trim() ? raw.siteName.trim() : DEFAULT_SITE_NAME;
    const journalsSegment =
      typeof raw.journalsSegment === "string" && raw.journalsSegment.trim()
        ? slugifySegment(raw.journalsSegment, DEFAULT_JOURNALS_SEGMENT)
        : DEFAULT_JOURNALS_SEGMENT;
    const allowThemeOverride = raw.allowThemeOverride === true;
    return { theme, siteName, journalsSegment, allowThemeOverride };
  } catch {
    return DEFAULT_SITE_CONFIG;
  }
}

/** A plain theme name (not "default", not blank) selects a built-in theme
 * -- a `:root[data-theme="<name>"]` block already compiled into this
 * site's own styles/tokens.css. This is deliberately NOT a separate file
 * loaded externally (an earlier version of this project had exactly that,
 * via themes/parchment.css, removed after it silently went stale following
 * a token rename): baking named themes into this repo's own build means a
 * rename has to touch every theme block in the same commit, so drift is
 * caught immediately instead of silently, months later.
 *
 * No external-URL escape hatch right now (self-hosting a fully custom
 * theme outside this repo's build) -- deliberately deferred as aspirational
 * until something actually needs it; straightforward to add back later
 * alongside this if it comes up. Returns the name to set as
 * `<html data-theme="...">` in Layout.astro, or null for "default"/unset. */
export function resolveDataTheme(theme: string): string | null {
  return theme && theme !== "default" ? theme : null;
}
