/**
 * Keeps a user's site on the site-package version that matches this module.
 *
 * A World2Web site repo holds only content plus a thin package.json that depends on the
 * `@world2web/site` npm package (packages/site in this repo), which provides every page, component
 * and style. The package is released in lockstep with this module -- same version number -- so on
 * Publish to Web, the module sets the site's dependency to its own version. Users update World2Web
 * in Foundry as usual, and their site updates with the next publish; the module and the site can
 * never disagree about the content format.
 *
 * Pure functions, no Foundry globals, so it's unit-testable in plain Node like collector.js.
 */

export const SITE_PACKAGE = "@world2web/site";

/**
 * The exact Astro version the site package is built and tested against -- pinned in the user's
 * package.json alongside the site package, since users' repos have no lockfile. Must match
 * packages/site/package.json's `peerDependencies.astro`; scripts/site-version.test.mjs enforces it.
 */
export const SITE_ASTRO_VERSION = "7.2.4";

/**
 * Works out whether a site repo's package.json needs its versions updated.
 *
 * Only a package.json that depends on `@world2web/site` by a plain version number (`1.2.3`, or a
 * prerelease like `1.2.3-beta.1`) is managed. Anything else is left alone (`"unmanaged"`): a site
 * created before the package existed, one whose owner took the site's code into their own repo,
 * or one deliberately pointed at something else by hand -- a preview build's URL while testing an
 * unreleased change, a `file:`/`link:` path, a git URL. Overwriting those on the next Publish to
 * Web would silently undo a deliberate choice.
 *
 * @param {string|null} packageJsonText The repo's current package.json, or `null` if it has none.
 * @param {{siteVersion: string, astroVersion?: string}} target
 * @returns {{status: "updated", content: string} | {status: "current"|"unmanaged"|"invalid"}}
 *   `"updated"` carries the new file content (2-space JSON, trailing newline). Every other field
 *   in the file is kept as-is.
 */
/** An exact semver version, optionally with a prerelease/build suffix -- no ranges, tags or URLs. */
const PLAIN_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function planSitePin(packageJsonText, { siteVersion, astroVersion = SITE_ASTRO_VERSION }) {
  if (packageJsonText == null) return { status: "unmanaged" };
  let pkg;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch {
    return { status: "invalid" };
  }
  if (!pkg || typeof pkg !== "object") return { status: "unmanaged" };
  const current = pkg.dependencies?.[SITE_PACKAGE];
  if (typeof current !== "string" || !PLAIN_VERSION_RE.test(current)) return { status: "unmanaged" };

  const deps = pkg.dependencies;
  if (deps[SITE_PACKAGE] === siteVersion && deps.astro === astroVersion) return { status: "current" };

  deps[SITE_PACKAGE] = siteVersion;
  deps.astro = astroVersion;
  return { status: "updated", content: `${JSON.stringify(pkg, null, 2)}\n` };
}

/**
 * Whether `version` of the site package is actually on npm. Checked before pinning, so a module
 * version that has no matching site release yet (a development build, or a release whose npm
 * publish failed) never points a live site at a version its host can't install -- which would
 * fail every build until fixed.
 *
 * @param {string} version
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<boolean>} `false` on any error, including network failures. Never throws.
 */
export async function isSiteVersionPublished(version, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${SITE_PACKAGE}/${encodeURIComponent(version)}`);
    return res.status === 200;
  } catch {
    return false;
  }
}
