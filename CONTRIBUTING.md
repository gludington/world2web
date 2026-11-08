# Developing World2Web

This repo holds two things that are released together, always under the same version number:

- **The Foundry module**, at the top level: `module.json`, `scripts/`, `lang/`, `packs/`,
  `assets/`. It's what Foundry installs.
- **The site package, `@world2web/site`**, in `packages/site`. It's an
  [Astro](https://astro.build/) integration that provides every page, component and style of a
  World2Web site, published to npm.

A user's site repo (created from
[world2web-site-template](https://github.com/gludington/world2web-site-template)) holds only its
content plus a few lines of config that load `@world2web/site`. On Publish to Web, the module
updates that repo's `@world2web/site` version to match the module's own version, so updating the
module in Foundry also updates the site.

## Layout

```
module.json, scripts/, lang/,   the Foundry module
packs/, assets/
packages/site/                  @world2web/site (published to npm)
  index.mjs                     the integration: adds the pages, builds the search index
  src/                          pages, components, layouts, styles, content schema
  scripts/ingest.js             the world2web-ingest command (Dev Sync payload -> content/)
packages/starter/               a thin site repo, linked to the local package (never published)
```

## Setup

You need Node 22 and pnpm (the version is pinned in `package.json`'s `packageManager` field;
`corepack enable` picks it up).

```sh
pnpm install
```

## Day-to-day testing

None of this publishes anything or uses up a version number.

### Module changes

Symlink the repo into Foundry's modules folder once:

```sh
ln -s /home/gludington/workspace/world2web ~/foundries/data/14.364/Data/modules/world2web
```

Enable **World2Web** in a world (**Game Settings → Manage Modules**), and reload Foundry after
each change. Publish to Web pushes to whatever site repo the module settings point at, so use a
test site.

Unit tests run in plain Node with Foundry's globals stubbed, no Foundry instance needed:

```sh
pnpm test
```

### Site changes

```sh
pnpm site:dev
```

This runs `packages/starter` against the local `packages/site` source, with hot reload. To get
real content into it: turn on **Enable Dev Mode** in the module's settings, click **Dev Sync** in
Foundry, then:

```sh
pnpm --filter world2web-starter ingest ~/Downloads/world2web-....json
```

That writes into `packages/starter/content/`, which is gitignored. `pnpm site:build` does a full
production build, including the search index.

#### Search while developing

Pagefind builds the search index from the finished HTML of a full build, so plain `pnpm site:dev`
has no index and the search page says so. Use:

```sh
pnpm site:dev:search
```

It builds once, then starts the dev server, which serves that build's index at `/pagefind/` (the
integration's `astro:server:setup` hook). Limitations:

- Search results reflect content as of that build. Rerun it to pick up new or edited posts; every
  other page still hot-reloads as usual.
- Only posts and author pages are indexed. Listing pages carry `data-pagefind-ignore`, since
  they'd only repeat the posts.
- Astro allows one dev server per project. Stop a running `pnpm site:dev` first.

### A site change on a real host, before releasing

Point a test site's `package.json` at a preview build instead of a version number, and push:

```json
"@world2web/site": "https://pkg.pr.new/gludington/world2web/@world2web/site@<commit>"
```

Preview builds come from [pkg.pr.new](https://pkg.pr.new): every push to a branch other than
`main` gets one, without publishing to npm. *Not set up yet: it needs the pkg.pr.new GitHub App
installed on this repo, then a small workflow.*

Publish to Web leaves this alone. The module only manages a dependency that's a plain version
number like `1.0.0`. A URL, a `file:` or `link:` path, a git URL or a range counts as set by hand
(see `scripts/site-version.js`). Put the plain version back when you're done testing.

## Version lockstep

`module.json` and `packages/site/package.json` must have the same `version`, and the module's
`SITE_ASTRO_VERSION` (in `scripts/site-version.js`) must match the site package's Astro peer
dependency. `scripts/site-version.test.mjs` fails if either drifts, which blocks a release.

When upgrading Astro, change it in `packages/site/package.json`, `packages/starter/package.json`
and `SITE_ASTRO_VERSION` together. Users' repos have no lockfile, so the module pins Astro's exact
version in them too.

## Releasing

1. Work on a feature branch and open a PR to `main`. Squash-merge.
2. To release, bump `version` in **both** `module.json` and `packages/site/package.json` in that
   PR. Merging to `main` with no version change releases nothing.
3. On merge, `.github/workflows/release.yml`:
   1. runs the tests and builds the site through `packages/starter`;
   2. publishes `@world2web/site` to npm (skipped if that version is already there);
   3. creates the GitHub release with `module.json` and `module.zip`;
   4. checks that the manifest and download URLs resolve.

   The npm publish deliberately comes before the GitHub release. Publish to Web only pins a site
   version that exists on npm, so it's there before anyone can install the module version that
   asks for it. If the npm publish fails, no module release happens.

A version number can only be used once on npm, even after unpublishing. A broken release is fixed
with a new patch release, never by re-publishing, which is one more reason to test on a real host
with preview builds rather than test releases.

### One-time npm setup

- An npm organization named `world2web` owns the `@world2web` scope (npmjs.com → Add
  Organization; free for public packages).
- A granular npm access token with publish rights for `@world2web`, stored in this repo's GitHub
  secrets as `NPM_TOKEN`.

## Working on the site package

- **`index.mjs` is plain JavaScript on purpose.** Astro loads integrations through Node directly,
  and Node won't strip TypeScript types from files inside `node_modules`. It would work in this
  workspace and fail for every real user. The `.astro` and `.ts` files under `src/` are fine,
  because Vite compiles those.
- **Every page goes through `getPublishedPosts()`** in `src/lib/posts.ts`, never
  `getCollection("posts")` directly. That filters out unpublished posts, and avoids a noisy
  warning on a brand-new site with no content.
- **Test the package the way users get it** before a release that changes its structure (new
  files, exports or dependencies):

  ```sh
  cd packages/site && pnpm pack --pack-destination /tmp/w2w
  ```

  Then, in a fresh copy of world2web-site-template, set the dependency to `file:/tmp/w2w/<tarball>`
  and run `npm install && npm run build`. The workspace link hides problems that only show up when
  the package is installed from npm into `node_modules`.
- **Content format changes need both halves.** A new frontmatter field is written by the module
  (`scripts/render.js`, plus `scripts/ingest.js` in the package for Dev Sync) and read by the
  package (`src/content.config.ts`). Give new fields a `.default(...)` in the schema, so content
  published before the field existed still builds.
