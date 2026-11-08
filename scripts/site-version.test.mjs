// Run with: node --test scripts/site-version.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planSitePin, isSiteVersionPublished, SITE_PACKAGE, SITE_ASTRO_VERSION } from "./site-version.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf-8"));

test("lockstep: the site package's version matches module.json's", () => {
  assert.equal(readJson("../packages/site/package.json").version, readJson("../module.json").version);
});

test("lockstep: SITE_ASTRO_VERSION matches the site package's Astro peer dependency", () => {
  assert.equal(readJson("../packages/site/package.json").peerDependencies.astro, SITE_ASTRO_VERSION);
});

const thin = (siteVersion, astro = SITE_ASTRO_VERSION, extra = {}) =>
  JSON.stringify({ name: "my-site", scripts: { build: "astro build" }, dependencies: { [SITE_PACKAGE]: siteVersion, astro, ...extra } }, null, 2) + "\n";

test("planSitePin: bumps an outdated site package and Astro, keeping everything else", () => {
  const result = planSitePin(thin("0.20.0", "7.0.0", { "left-pad": "1.0.0" }), { siteVersion: "0.21.0" });
  assert.equal(result.status, "updated");
  const pkg = JSON.parse(result.content);
  assert.equal(pkg.dependencies[SITE_PACKAGE], "0.21.0");
  assert.equal(pkg.dependencies.astro, SITE_ASTRO_VERSION);
  assert.equal(pkg.dependencies["left-pad"], "1.0.0");
  assert.deepEqual(pkg.scripts, { build: "astro build" });
  assert.ok(result.content.endsWith("}\n"));
});

test("planSitePin: already current is left alone", () => {
  assert.deepEqual(planSitePin(thin("0.21.0"), { siteVersion: "0.21.0" }), { status: "current" });
});

test("planSitePin: a repo without the site package, or without a package.json, is unmanaged", () => {
  const oldLayout = JSON.stringify({ dependencies: { astro: "^7.2.4" } });
  assert.deepEqual(planSitePin(oldLayout, { siteVersion: "0.21.0" }), { status: "unmanaged" });
  assert.deepEqual(planSitePin(null, { siteVersion: "0.21.0" }), { status: "unmanaged" });
});

test("planSitePin: unparseable package.json is reported, not overwritten", () => {
  assert.deepEqual(planSitePin("{ nope", { siteVersion: "0.21.0" }), { status: "invalid" });
});

test("isSiteVersionPublished: true only for a 200 from the registry; never throws", async () => {
  const calls = [];
  const ok = await isSiteVersionPublished("0.21.0", async (url) => (calls.push(url), { status: 200 }));
  assert.equal(ok, true);
  assert.equal(calls[0], "https://registry.npmjs.org/@world2web/site/0.21.0");
  assert.equal(await isSiteVersionPublished("9.9.9", async () => ({ status: 404 })), false);
  assert.equal(
    await isSiteVersionPublished("0.21.0", async () => {
      throw new TypeError("Failed to fetch");
    }),
    false,
  );
});
