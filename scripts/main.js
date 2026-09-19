import {
  collectJournalData,
  downloadJournalData,
  isPublishable,
  isPageTypePublishable,
  resolveDefaultAuthor,
  resolveJournalAuthor,
  resolveDefaultRoot,
} from "./collector.js";
import { renderPayloadToFiles, buildSiteConfigFile } from "./render.js";
import { pushFiles, pushBinaryAssets, retractDeletedPost } from "./github.js";
import { collectAssets, rewriteAssetReferences } from "./assets.js";
import { scopedDeletionUuids } from "./ownership.js";

const MODULE_ID = "world2web";
const I18N_NS = "WORLD2WEB";

// The GitHub template repo anyone's own campaign site gets generated
// from (see the site-template repo's own README setup instructions) --
// reused here to build one-click deploy links for each host that README
// documents, so setup doesn't require knowing these URLs exist or digging
// through a README to find them. See openDeploySiteDialog. Each of these
// is that host's own documented "clone this repo into your account and
// deploy it" flow (Netlify: "Deploy to Netlify" button, docs.netlify.com;
// Cloudflare: "Deploy to Cloudflare" button, developers.cloudflare.com;
// Vercel: "Deploy Button", vercel.com/docs/deploy-button) -- confirmed
// against each host's own docs, not guessed. Order matches the README's
// own (Netlify first as "the more straightforward of the two," then
// Cloudflare, then Vercel as the newest/least-documented addition).
const SITE_TEMPLATE_REPO_URL = "https://github.com/gludington/world2web-site-template";
const NETLIFY_DEPLOY_URL = `https://app.netlify.com/start/deploy?repository=${encodeURIComponent(SITE_TEMPLATE_REPO_URL)}`;
const CLOUDFLARE_DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(SITE_TEMPLATE_REPO_URL)}`;
const VERCEL_DEPLOY_URL = `https://vercel.com/new/clone?repository-url=${encodeURIComponent(SITE_TEMPLATE_REPO_URL)}`;

/**
 * Localizes `key` under the `WORLD2WEB.` namespace. Every user-displayed string in this module
 * goes through here (or, for `game.settings.register()`'s name/hint and DialogV2 button labels, is
 * passed as a bare "WORLD2WEB.X" key directly -- Foundry localizes those itself when rendering).
 * Console (`console.log`/`warn`/`error`) and thrown `Error()` messages are deliberately NOT
 * localized -- diagnostic/developer-facing, not UI a player or GM reads, same convention most
 * Foundry modules use.
 *
 * @param {string} key A key under `WORLD2WEB.`, e.g. `"Notify.Published"`.
 * @param {object} [data] `{ph}`-style placeholder values. When present, uses
 *   `game.i18n.format()`; when absent, plain `game.i18n.localize()`.
 * @returns {string} Never `null`/`undefined`.
 */
function t(key, data) {
  const fullKey = `${I18N_NS}.${key}`;
  return data ? game.i18n.format(fullKey, data) : game.i18n.localize(fullKey);
}

// "Uncommitted" (a local publish/republish/unpublish action that hasn't
// been confirmed by a successful Publish to Web run yet) vs. "committed"
// (confirmed pushed). Amber reuses this module's existing "needs
// attention" color; green is GitHub's own, since that's literally what's
// being confirmed here.
const COLOR_UNCOMMITTED = "#e0a030";
const COLOR_COMMITTED = "#2da44e";
// Neither "needs attention" nor "confirmed" -- a run is actually in
// progress right now, which for Publish to Web (a handful of sequential
// GitHub API calls, one per changed file) can take long enough that
// "disabled but otherwise looks the same" reads as hung, not busy.
const COLOR_IN_PROGRESS = "#6b7280";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);

  game.settings.register(MODULE_ID, "enableDevMode", {
    name: "WORLD2WEB.Settings.EnableDevMode.Name",
    hint: "WORLD2WEB.Settings.EnableDevMode.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  // Off by default: everything stays exactly as it's always been (GM-only)
  // until a GM deliberately opts in. When on, a player who owns a journal
  // entry (Foundry's own Owner permission level) gets that entry's Journal
  // Settings/Post Settings/publish controls too, and their own "Publish to
  // Web" click only publishes journals *they* own -- see the "Player
  // self-publish" section further down this file. Worth knowing before
  // enabling: a player's own browser needs to read the GitHub token
  // setting to publish at all, and Foundry's game.settings.get() has no
  // access control on reads for world-scoped settings regardless of this
  // one being GM-only in the Configure Settings menu -- see that section's
  // own comment for the full reasoning.
  game.settings.register(MODULE_ID, "allowPlayerSelfPublish", {
    name: "WORLD2WEB.Settings.AllowPlayerSelfPublish.Name",
    hint: "WORLD2WEB.Settings.AllowPlayerSelfPublish.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  // Internal bookkeeping, not user-facing (config: false): when a sync
  // (Publish to Web, or Dev Sync in dev mode) last completed successfully,
  // so per-page/button coloring can tell "changed locally, not yet synced"
  // (uncommitted) from "confirmed synced" (committed) -- see
  // isPagePending(). Both sync paths share this single timestamp: from the
  // GM's perspective, either one is "I've taken the current state out of
  // Foundry," which is what the coloring is actually tracking.
  game.settings.register(MODULE_ID, "lastSyncAt", {
    scope: "world",
    config: false,
    type: Number,
    default: 0,
  });

  // Deleting a page (or a whole journal entry) removes it from Foundry's
  // own collections entirely -- collector.js can only ever describe
  // documents that currently exist, so it has no way to notice something
  // that's simply gone, unlike an explicit unpublish (which just flips a
  // flag on a document that's still there). These two settings are what
  // make that detectable -- see the "Deleted pages/entries" section below
  // for how they're populated and consumed.
  //
  // publishedPaths: { [pageUuid]: itsGitHubFilePath }, kept in sync with
  // every post actually in the payload after each successful Publish to
  // Web -- the only reliable record of "where does this UUID's file
  // live," since path disambiguation depends on sibling posts at collect
  // time and can't be cheaply recomputed later from a deleted page alone.
  game.settings.register(MODULE_ID, "publishedPaths", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });

  // pendingDeletions: { [pageUuid]: true }, populated live the instant a
  // previously-published page or entry is deleted (see the
  // deleteJournalEntry/deleteJournalEntryPage hooks below) -- drives both
  // the immediate amber button color (nothing else could notice a
  // deletion in time for that) and which files get retracted on the next
  // publish. A UUID is removed once its retraction has actually
  // succeeded, not just attempted -- see retractPendingDeletions().
  game.settings.register(MODULE_ID, "pendingDeletions", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });

  // contentHashes: { [gitHubPath]: sha256hex(content) } -- github.js's
  // pushFiles() own performance fix, not related to deletions. A publish
  // used to fetch every currently-published post's existing content from
  // GitHub just to check whether it had actually changed, every single
  // time, for every post -- the dominant cost in a real publish taking
  // 9+ minutes. Recording each file's hash after it's confirmed correct
  // lets pushFiles skip that GET entirely next time when nothing about a
  // post actually changed, which -- for a stable journal with hundreds of
  // untouched posts -- is most of them, most publishes.
  game.settings.register(MODULE_ID, "contentHashes", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });

  // A settings-list button, not a plain field -- opens openDeploySiteDialog()
  // (a DialogV2, matching this module's other dialogs) rather than its own
  // window. Placed right before the GitHub fields below since it's meant as
  // this setup flow's actual first step: generate a repo + host from the
  // site template, *then* come back and fill in the owner/repo/token it
  // produced. New in v0.20.2, untested against a live Foundry instance --
  // ApplicationV2's exact render() contract is taken on faith here the same
  // way openJournalConfigDialog's DialogV2 usage originally was (see that
  // function's own doc comment).
  //
  // Declared here, inside this hook, rather than at module top level:
  // registerMenu needs an actual class (not a plain callback), but its
  // `extends foundry.applications.api.ApplicationV2` clause evaluates
  // immediately wherever the class statement sits. Every other
  // foundry.applications.api reference in this file is safely inside a
  // function body, called lazily long after Foundry's core is up --
  // putting this one at module top level instead would touch that API at
  // import time, which could throw before Foundry's core classes exist and
  // take the *whole module* down with it, not just this dialog. Inside
  // "init" is exactly as safe as every other usage here.
  class DeploySiteMenu extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS = { id: "world2web-deploy-site-menu" };

    async render(...args) {
      await openDeploySiteDialog();
      return this;
    }
  }

  game.settings.registerMenu(MODULE_ID, "deploySite", {
    name: "WORLD2WEB.Settings.DeploySite.Name",
    label: "WORLD2WEB.Settings.DeploySite.Label",
    hint: "WORLD2WEB.Settings.DeploySite.Hint",
    icon: "fa-solid fa-cloud-arrow-up",
    type: DeploySiteMenu,
    restricted: true,
  });

  // GitHub push settings. Not encrypted at rest by Foundry -- fine for a
  // fine-grained PAT scoped to just this one repo's Contents (read/write)
  // permission, which is the scope the setup docs walk through, but worth
  // knowing if you're tempted to reuse a broader token here.
  game.settings.register(MODULE_ID, "githubOwner", {
    name: "WORLD2WEB.Settings.GithubOwner.Name",
    hint: "WORLD2WEB.Settings.GithubOwner.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, "githubRepo", {
    name: "WORLD2WEB.Settings.GithubRepo.Name",
    hint: "WORLD2WEB.Settings.GithubRepo.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, "githubBranch", {
    name: "WORLD2WEB.Settings.GithubBranch.Name",
    hint: "WORLD2WEB.Settings.GithubBranch.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "main",
  });
  game.settings.register(MODULE_ID, "githubToken", {
    name: "WORLD2WEB.Settings.GithubToken.Name",
    hint: "WORLD2WEB.Settings.GithubToken.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "siteTheme", {
    name: "WORLD2WEB.Settings.SiteTheme.Name",
    hint: "WORLD2WEB.Settings.SiteTheme.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "default",
  });

  game.settings.register(MODULE_ID, "allowThemeOverride", {
    name: "WORLD2WEB.Settings.AllowThemeOverride.Name",
    hint: "WORLD2WEB.Settings.AllowThemeOverride.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "siteName", {
    name: "WORLD2WEB.Settings.SiteName.Name",
    hint: "WORLD2WEB.Settings.SiteName.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "World2Web",
  });

  game.settings.register(MODULE_ID, "journalsSegment", {
    name: "WORLD2WEB.Settings.JournalsSegment.Name",
    hint: "WORLD2WEB.Settings.JournalsSegment.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "journals",
  });
});

/**
 * @returns {{owner: string, repo: string, token: string, branch: string}|null} The trimmed GitHub
 *   owner/repo/token/branch settings, or `null` if owner, repo, or token is unset/blank. `branch`
 *   falls back to `"main"` if unset.
 */
function getGithubConfig() {
  const owner = game.settings.get(MODULE_ID, "githubOwner")?.trim();
  const repo = game.settings.get(MODULE_ID, "githubRepo")?.trim();
  const token = game.settings.get(MODULE_ID, "githubToken")?.trim();
  const branch = game.settings.get(MODULE_ID, "githubBranch")?.trim() || "main";
  if (!owner || !repo || !token) return null;
  return { owner, repo, token, branch };
}

// --- Deleted pages/entries -------------------------------------------------
//
// Unpublishing via the checkbox/toggle works because the document is still
// there for collectJournalData() to visit and see a flag flip -- see
// collector.js's own tombstone handling. Deleting a page (or a whole
// journal entry, which takes all its pages with it) removes the document
// from Foundry's collections entirely, so the collector has nothing left
// to visit; it would otherwise just silently stop seeing it, with the
// already-published file sitting on GitHub forever, still live on the site.
//
// The deleteJournalEntryPage/deleteJournalEntry hooks below (bottom of
// this file) catch that at the moment it happens and record the page's
// UUID in the pendingDeletions setting -- the only way anything could
// notice in time, since by the next render there's no document left to
// scan. retractPendingDeletions() (called from publishToGitHub()) is what
// actually retracts them, by patching each one's already-correct
// frontmatter straight on GitHub (github.js's retractDeletedPost) rather
// than trying to reconstruct a post from a document that's gone.

/**
 * Retracts every page currently tracked in `pendingDeletions` -- or, when `scopedToCaller` is set
 * (a player's own "Publish to Web," see "Player self-publish" below), only the ones whose captured
 * ownership snapshot shows the *current* user as an owner, so a player's publish can't retract
 * someone else's deleted content. A UUID with no recorded path (never actually got published, or
 * predates this feature existing at all) has nothing to retract and is just dropped -- there's no
 * file to touch either way. Passes `expectedUuid` through to `retractDeletedPost` so a same-run
 * race (a brand-new page published with the same resulting slug already overwrote this exact path
 * earlier in this very publish, via `pushFiles()` above) backs off instead of unpublishing that
 * live content by mistake -- see that function's own doc comment. One failure doesn't stop the
 * rest -- it's simply left in `pendingDeletions` for the next publish to retry, same "one bad item
 * doesn't fail the batch" pattern assets.js already uses for a failed image fetch.
 *
 * @param {import("./github.js").RepoTarget} config
 * @param {object} [options]
 * @param {boolean} [options.scopedToCaller]
 * @returns {Promise<number>} The count actually retracted, for the publish notification. `0` if
 *   nothing was pending (or, when scoped, nothing pending belonged to the caller).
 */
async function retractPendingDeletions(config, { scopedToCaller = false } = {}) {
  const pending = game.settings.get(MODULE_ID, "pendingDeletions");
  const paths = game.settings.get(MODULE_ID, "publishedPaths");
  const pendingUuids = scopedDeletionUuids(pending, {
    scopedToCaller,
    userId: game.user.id,
    ownerLevel: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
  });
  if (pendingUuids.length === 0) return 0;

  const nextPending = { ...pending };
  const nextPaths = { ...paths };
  let retractedCount = 0;

  for (const uuid of pendingUuids) {
    const path = paths[uuid];
    if (!path) {
      delete nextPending[uuid];
      continue;
    }
    try {
      const ok = await retractDeletedPost({ ...config, path, expectedUuid: uuid });
      if (ok) {
        delete nextPending[uuid];
        delete nextPaths[uuid];
        retractedCount += 1;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to retract deleted page at ${path}:`, err);
    }
  }

  await game.settings.set(MODULE_ID, "pendingDeletions", nextPending);
  await game.settings.set(MODULE_ID, "publishedPaths", nextPaths);
  return retractedCount;
}

/**
 * Records every post actually in this payload -- published or already-tombstoned -- into
 * `publishedPaths`, so a future deletion of any of them can be retracted later. Overlays onto the
 * existing map rather than replacing it outright, so nothing from a prior publish is lost if this
 * one's payload doesn't happen to include it for some reason.
 *
 * @param {object} payload A payload from `collectJournalData()` (see collector.js).
 * @param {string} worldSlug
 * @returns {Promise<void>}
 */
async function recordPublishedPaths(payload, worldSlug) {
  const paths = game.settings.get(MODULE_ID, "publishedPaths");
  const next = { ...paths };
  for (const journal of payload.journals ?? []) {
    for (const post of journal.posts ?? []) {
      next[post.uuid] = `content/worlds/${worldSlug}/journals/${journal._slug}/${post._slug}.md`;
    }
  }
  await game.settings.set(MODULE_ID, "publishedPaths", next);
}

/**
 * A previously-published page or entry was just deleted -- see the "Deleted pages/entries" section
 * above. Records its UUID in `pendingDeletions` (along with a snapshot of its owning entry's
 * ownership map, so a player's later scoped publish -- see "Player self-publish" below -- can tell
 * whether this deletion is theirs to retract, since the entry itself won't exist anymore to check
 * directly by then) and refreshes the sync buttons immediately, since nothing else could notice
 * this happened otherwise (by the next render there's no document left for the usual per-page scan
 * to see).
 *
 * @param {JournalEntryPage} page The Foundry native JournalEntryPage document that was deleted.
 * @param {JournalEntry|null|undefined} entry The page's owning JournalEntry -- passed in rather
 *   than read from `page.parent`, since a whole-entry deletion may have already detached that
 *   reference by the time this runs; see the delete hooks at the bottom of this file for why each
 *   one passes it explicitly.
 * @returns {Promise<void>}
 */
async function trackDeletedPage(page, entry) {
  if (!page?.flags?.[MODULE_ID]?.publishedAt) return; // never published -- nothing to retract
  const pending = game.settings.get(MODULE_ID, "pendingDeletions");
  if (pending[page.uuid]) return; // already tracked
  await game.settings.set(MODULE_ID, "pendingDeletions", {
    ...pending,
    [page.uuid]: { ownership: entry?.ownership ?? {} },
  });
  refreshSyncButtonColors();
}

/**
 * Collects + fetches/content-addresses images + renders + pushes directly to GitHub -- no local
 * script, no download. Safe to call repeatedly: `putFile`/`putBinaryAssetIfMissing` (github.js)
 * skip anything that hasn't actually changed, so re-publishing everyone's journals just to publish
 * your own new post doesn't spam the repo history.
 *
 * @param {object} [options]
 * @param {boolean} [options.scopedToCaller] A player's own "Publish to Web" (see "Player
 *   self-publish" below -- never set for the GM's, which always means everything): restricts
 *   collection to entries the calling user owns (collector.js's own `scopedToCaller`) and
 *   retraction to deletions their ownership snapshot covers ({@link retractPendingDeletions}'s own
 *   `scopedToCaller`) -- so a player's publish only ever touches what's actually theirs.
 *   Everything else here (asset fetching, `pushFiles`, `contentHashes`, `publishedPaths`) needs no
 *   scoping of its own: it just operates on whatever ends up in this already-scoped payload.
 * @returns {Promise<void>}
 */
async function publishToGitHub({ scopedToCaller = false } = {}) {
  const config = getGithubConfig();
  if (!config) {
    ui.notifications.error(`${t("Notify.Prefix")}: ${t("Notify.MissingGithubConfig")}`);
    return;
  }

  const payload = collectJournalData({ scopedToCaller });
  if (payload.journalCount === 0) {
    ui.notifications.warn(`${t("Notify.Prefix")}: ${t("Notify.NothingToPublish")}`);
    return;
  }

  // Fetch every author-portrait/post-image reference and rewrite the
  // payload to point at the resulting content-addressed /assets/<hash>.<ext>
  // paths *before* rendering markdown, so the pushed files reference the
  // local copy from the start rather than Foundry's own (offline-fragile)
  // paths. A failed image fetch is logged and left pointing at Foundry
  // rather than failing the whole publish.
  const { urlMap, files: assetFiles } = await collectAssets(payload);
  rewriteAssetReferences(payload, urlMap);

  const pushedAssets = await pushBinaryAssets({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
    branch: config.branch,
    files: assetFiles,
    commitMessage: `world2web: add asset (${payload.world.title})`,
  });

  const { worldSlug, files } = renderPayloadToFiles(payload);
  const theme = game.settings.get(MODULE_ID, "siteTheme");
  const siteName = game.settings.get(MODULE_ID, "siteName");
  const journalsSegment = game.settings.get(MODULE_ID, "journalsSegment");
  const allowThemeOverride = game.settings.get(MODULE_ID, "allowThemeOverride");
  files.push(buildSiteConfigFile({ theme, siteName, journalsSegment, allowThemeOverride }));

  const { pushed, hashes } = await pushFiles({
    owner: config.owner,
    repo: config.repo,
    token: config.token,
    branch: config.branch,
    files,
    commitMessage: `world2web: publish from Foundry (${payload.world.title})`,
    knownHashes: game.settings.get(MODULE_ID, "contentHashes"),
  });
  await game.settings.set(MODULE_ID, "contentHashes", hashes);

  // Retracts anything deleted (not just unpublished) since the last
  // publish -- see the "Deleted pages/entries" section below. Runs after
  // the normal content push above so a genuinely fresh publish gets
  // everything real synced first, though the two don't actually touch
  // the same files either way.
  const retractedCount = await retractPendingDeletions(
    {
      owner: config.owner,
      repo: config.repo,
      token: config.token,
      branch: config.branch,
    },
    { scopedToCaller },
  );

  // Every post actually in this payload -- published or already-
  // tombstoned by collector.js -- gets its path recorded, so a future
  // deletion of any of them can be retracted the same way. Recorded
  // whether or not pushFiles actually wrote each one (an unchanged file
  // still needs its path tracked); a stale/never-pushed entry is harmless
  // either way -- retractDeletedPost treats a 404 as "already gone."
  await recordPublishedPaths(payload, worldSlug);

  // Confirms every currently-published page's local state (and any recent
  // unpublish) as reflected as of now -- even when total === 0, since that
  // still means everything already matched GitHub. Drives the
  // uncommitted/committed coloring on the per-page and sync buttons (see
  // isPagePending()).
  await markSynced();

  const total = pushed.length + pushedAssets.length + retractedCount;
  ui.notifications.info(
    `${t("Notify.Prefix")}: ${
      total > 0
        ? t("Notify.Published", { posts: pushed.length, assets: pushedAssets.length, retracted: retractedCount })
        : t("Notify.UpToDate")
    }`,
  );
}

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  // Exposed for console use: game.modules.get("world2web").api.collect()
  mod.api = { collect: collectJournalData, download: downloadJournalData, publish: publishToGitHub };
});

/**
 * Builds (but doesn't insert) the Dev Sync button -- shared by the initial render and the
 * `updateSetting` listener below it, so toggling "Enable Dev Mode" doesn't need a page reload to
 * take effect.
 *
 * @returns {HTMLButtonElement}
 */
function createDevSyncButton() {
  const devSyncButton = document.createElement("button");
  devSyncButton.type = "button";
  devSyncButton.className = "world2web-dev-sync-button";
  devSyncButton.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> ${t("Button.DevSync")}`;
  devSyncButton.addEventListener("click", async () => {
    devSyncButton.disabled = true;
    // Swapped back in the finally block below, whether this succeeds or
    // throws -- the busy state is purely visual, not a stored color, so
    // there's nothing to leave stale on failure the way there would be
    // if this were baked into syncButtonColor()'s own logic.
    const restoreHtml = devSyncButton.innerHTML;
    devSyncButton.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Button.Syncing")}`;
    devSyncButton.style.color = COLOR_IN_PROGRESS;
    try {
      const payload = downloadJournalData();
      // Counts as a sync for coloring purposes too -- from the GM's
      // perspective, having just pulled the current state out of Foundry
      // (even just to a local JSON file) is the same "I've taken care of
      // this" signal Publish to Web gives, not a separate concept.
      await markSynced();
      ui.notifications.info(`${t("Notify.Prefix")}: ${t("Notify.Collected", { count: payload.journalCount })}`);
    } finally {
      devSyncButton.innerHTML = restoreHtml;
      devSyncButton.disabled = false;
      // markSynced() already set the correct final color on success;
      // this is the safety net for the (currently impossible, but cheap
      // to guard) case of a thrown error leaving it stuck on the busy
      // color instead of whatever it should actually be.
      refreshSyncButtonColors();
    }
  });
  return devSyncButton;
}

// Manual triggers: buttons in the Journal Directory header. No hooks into
// updateJournalEntry yet, so nothing runs on save/publish automatically.
Hooks.on("renderJournalDirectory", (app, htmlEl) => {
  // Dev Sync is a developer/GM tool regardless of allowPlayerSelfPublish --
  // downloading the raw collected JSON isn't something a self-publishing
  // player needs, and showing it would surface a capability this feature
  // was never meant to grant them. Bail out entirely for anyone who can't
  // see either button at all.
  if (!game.user.isGM && !game.settings.get(MODULE_ID, "allowPlayerSelfPublish")) return;

  const root = htmlEl instanceof HTMLElement ? htmlEl : htmlEl[0];
  const header = root.querySelector(".directory-header .action-buttons");
  // Publish to Web is unconditional (for whoever can see it at all), so
  // its presence is what guards against re-adding buttons on repeated
  // renders -- Dev Sync's own presence isn't a reliable guard since it's
  // conditionally shown based on a setting even for the GM.
  if (!header || header.querySelector(".world2web-publish-to-web-button")) return;

  if (game.user.isGM && game.settings.get(MODULE_ID, "enableDevMode")) {
    header.appendChild(createDevSyncButton());
  }

  const publishButton = document.createElement("button");
  publishButton.type = "button";
  publishButton.className = "world2web-publish-to-web-button";
  publishButton.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> ${t("Button.PublishToWeb")}`;
  publishButton.addEventListener("click", async () => {
    publishButton.disabled = true;
    const restoreHtml = publishButton.innerHTML;
    publishButton.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Button.Publishing")}`;
    publishButton.style.color = COLOR_IN_PROGRESS;
    try {
      // GM = everything, always. A player (only reachable here at all when
      // allowPlayerSelfPublish is on) is scoped to just what they own --
      // see the "Player self-publish" section further down for what that
      // actually touches.
      await publishToGitHub({ scopedToCaller: !game.user.isGM });
    } catch (err) {
      console.error(`${MODULE_ID} | publish to web failed`, err);
      ui.notifications.error(`${t("Notify.Prefix")}: ${t("Notify.PublishFailed", { error: err.message })}`);
    } finally {
      publishButton.innerHTML = restoreHtml;
      publishButton.disabled = false;
      // Correct final color regardless of success or failure -- a failed
      // publish shouldn't leave the button stuck showing "in progress".
      refreshSyncButtonColors();
    }
  });

  header.appendChild(publishButton);
  refreshSyncButtonColors();
});

// --- Publish control on journal entry pages ---------------------------------
//
// Foundry v13+ moved journal sheets to ApplicationV2, which does NOT fire
// the old getJournalSheetHeaderButtons hook (that's ApplicationV1-only) --
// confirmed empirically 2026-08-21 against a live v14 world running dnd5e
// (sheet class JournalEntrySheet5e, extending the core ApplicationV2
// JournalEntrySheet). AppV2 header buttons are just plain
// `<button class="header-control icon ...">` elements sitting in
// `.window-header`, inserted the same way as any other DOM injection --
// there's no buttons-array hook to plug into.
//
// Two sheet classes matter here, confirmed from a live instance:
//   - JournalEntrySheet5e (system-specific subclass of the core
//     JournalEntrySheet): the main entry window with page navigation.
//     Exposes `app.pageId` directly for "which page is currently shown".
//   - JournalEntryPageProseMirrorSheet: a single page popped out into its
//     own window. The page itself IS `app.document` here.
// Foundry calls a render hook for every class in the instance's prototype
// chain, not just the leaf subclass, so hooking the core base names
// (renderJournalEntrySheet, renderJournalEntryPageProseMirrorSheet) should
// fire regardless of which game system's subclass is actually
// instantiated -- the exact observed subclass name is also hooked directly
// as a belt-and-suspenders fallback in case that assumption is wrong for
// some system.

/**
 * @param {object} app A Foundry native `ApplicationV2` instance (a journal entry sheet, or a
 *   popped-out single-page editor).
 * @returns {JournalEntryPage|null} The page currently shown -- the document itself for a
 *   popped-out page editor, or whichever page is selected in a multi-page entry sheet. `null` if
 *   `app` has no document, or (for an entry sheet) no page is currently selected.
 */
function getCurrentPage(app) {
  const doc = app?.document ?? app?.object;
  if (!doc) return null;
  if (doc.documentName === "JournalEntryPage") return doc; // popped-out single-page editor
  const pageId = app.pageId ?? app._pageId;
  return pageId ? (doc.pages?.get?.(pageId) ?? null) : null;
}

/**
 * @param {object} app A Foundry native `ApplicationV2` instance.
 * @returns {JournalEntry|null} The JournalEntry that owns the sheet being rendered -- the entry
 *   itself for a `JournalEntrySheet`, or its parent for a popped-out page editor. `null` if `app`
 *   has no document.
 */
function getOwningEntry(app) {
  const doc = app?.document ?? app?.object;
  if (!doc) return null;
  return doc.documentName === "JournalEntryPage" ? doc.parent : doc;
}

/**
 * @param {string} [str] `null`/`undefined` are treated as `""`.
 * @returns {string} `str` with `& < > " '` escaped for safe use in an HTML attribute value. Never
 *   `null`/`undefined`; `""` if `str` was empty or absent.
 */
function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// --- Player self-publish ----------------------------------------------
//
// Off by default (allowPlayerSelfPublish, registered above) -- everything
// stays exactly GM-only, unchanged, until a GM deliberately opts in. Once
// on, a player who owns a journal entry (Foundry's own Owner permission
// level) gets that entry's Publishing Settings/Post Settings/publish controls
// too (canControlJournal(), used everywhere those get injected), and their
// own "Publish to Web" click is scoped to just what they own: only their
// own owned journals get collected (collector.js's collectJournalData()'s own
// scopedToCaller), and only their own owned deletions get retracted
// (retractPendingDeletions()'s own scopedToCaller, checked against the
// ownership snapshot trackDeletedPage() captures at delete time -- the
// document itself won't exist anymore to check directly by then).
// Dev Sync stays GM-only unconditionally regardless of this setting --
// downloading the raw collected payload isn't something this feature was
// ever meant to grant a self-publishing player.

/**
 * Whether the current user can see/use this entry's journal controls (Publishing Settings, Post
 * Settings, publish icons) -- the GM always can; a player can too, but only for an entry they
 * actually own (Foundry's own `isOwner` getter, always correct for whichever client is asking),
 * and only once a GM has opted into that at all via the `allowPlayerSelfPublish` setting.
 *
 * A compendium-sourced entry (`entry.pack` set) is never controllable regardless of who's asking
 * -- only a world's own `game.journal` collection is ever collected/published
 * (`collectJournalData()` in collector.js never looks at compendium content at all), so publish
 * controls on a compendium document would be pure UI noise implying an action that does nothing.
 *
 * @param {JournalEntry|null|undefined} entry The Foundry native JournalEntry document to check.
 * @returns {boolean} Never `null`/`undefined`.
 */
function canControlJournal(entry) {
  if (entry?.pack) return false;
  if (game.user.isGM) return true;
  if (!game.settings.get(MODULE_ID, "allowPlayerSelfPublish")) return false;
  return !!entry?.isOwner;
}

// Settings-list button (registered as the "deploySite" menu) -- a real
// three-step wizard now, not one dialog with links: deploying a site,
// creating a GitHub token, and configuring this module's own settings are
// genuinely three separate destinations (a chosen host's own site, GitHub's
// own settings pages, and this module), and collapsing them into "click
// some links, then go figure out where to paste things yourself" was more
// confusing than helpful -- each step here hands off to the next
// explicitly, and the last one actually writes the settings itself rather
// than sending someone to Configure Settings to retype them by hand.
// openDeploySiteDialog() is just the orchestrator; see each step function's
// own comment for what it does and why it's split out.
const DEPLOY_URLS_BY_ACTION = {
  "deploy-netlify": NETLIFY_DEPLOY_URL,
  "deploy-cloudflare": CLOUDFLARE_DEPLOY_URL,
  "deploy-vercel": VERCEL_DEPLOY_URL,
};

/**
 * Confirmed live: the typed repo name (see {@link openDeployStep1ChooseHost}) only ever reaches
 * *this module's own* later steps by default -- none of these three hosts' own "Project name"
 * fields pick it up automatically, since that has to come from a URL parameter specific to each
 * host, and only Vercel's own deploy-button docs (vercel.com/docs/deploy-button) document one
 * (`project-name`) -- Netlify's and Cloudflare's own deploy-button docs (checked directly)
 * document no equivalent, only `url`/`repository`. So this only ever changes Vercel's link;
 * Netlify and Cloudflare still show the *template's own* name (world2web-site-template) as their
 * suggested default -- `Dialog.DeploySiteRepoNameHint` says so explicitly, so nobody's left
 * guessing why Vercel looks different.
 *
 * @param {string} action One of the keys in {@link DEPLOY_URLS_BY_ACTION}.
 * @param {string} [repoName] The repo name typed in step 1 -- only used for Vercel's own
 *   `project-name` parameter.
 * @returns {string|null} The deploy URL, or `null` if `action` isn't a recognized host.
 */
function buildDeployUrl(action, repoName) {
  const base = DEPLOY_URLS_BY_ACTION[action];
  if (!base) return null;
  if (action === "deploy-vercel" && repoName) {
    return `${base}&project-name=${encodeURIComponent(repoName)}`;
  }
  return base;
}

/**
 * GitHub's own documented "template URL" feature for fine-grained PAT creation
 * (github.blog/changelog/2025-08-26-template-urls-for-fine-grained-pats...) -- confirmed against
 * GitHub's docs, not guessed. `contents=write` pre-checks exactly the "Contents: Read and write"
 * permission this module actually needs, matching the repo permission called out throughout the
 * README/lang file already. There's no documented parameter for pre-selecting which specific repo
 * under that owner -- GitHub still requires picking "Only select repositories" and the exact repo
 * by hand, so this only saves the owner + permission steps, not the whole thing.
 *
 * @param {string} [owner] Pre-selects the resource owner in the URL (`target_name`) when known;
 *   omitted on a first-ever setup.
 * @returns {string}
 */
function buildGithubTokenUrl(owner) {
  const params = new URLSearchParams({
    name: "World2Web",
    description: "World2Web -- publishes to one campaign-site repo",
    contents: "write",
  });
  if (owner) params.set("target_name", owner);
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

/**
 * Step 1/3 of the Setup Wizard: name the new repo, then pick a host and open its one-click deploy
 * flow. See {@link DEPLOY_URLS_BY_ACTION}'s own doc comment for what "already configured" means
 * and why it's worth warning about regardless of which host gets picked.
 *
 * The repo-name field exists because of a real structural gap: whatever name gets typed into the
 * *host's own* form (its "Project name" field, per the Cloudflare screenshot this was built
 * against) never reaches Foundry at all -- that page runs entirely on the host's own site, with no
 * callback of any kind back here. Before this field existed, steps 2 and 3 had nothing to go on
 * but this module's *previous* settings (or nothing, on a first-ever setup), which could default
 * to genuinely the wrong repo -- confirmed live: it pointed at gludington's own
 * world2web-site-template, which isn't even a repo anyone else has, let alone the one they just
 * meant to create. There's no way to fix this by deriving the name automatically, so instead: ask
 * for it here first, and use whatever's typed as the name to actually create on the host's own
 * form a moment later -- then thread it through steps 2 and 3 so nothing downstream ever has to
 * guess or get retyped.
 *
 * @param {boolean} alreadyConfigured Whether GitHub owner/repo/token are already set -- shows a
 *   warning that continuing creates a separate, new site rather than touching the existing one.
 * @param {string} [owner] The currently-configured GitHub owner, if any -- shown in the warning.
 * @param {string} [repo] The currently-configured GitHub repo, if any -- pre-fills the repo-name
 *   field and is shown in the warning.
 * @returns {Promise<{url: string, repoName: string}|null>} The opened deploy URL and the typed
 *   repo name, to advance to step 2, or `null` to abort the whole wizard (Cancel, the dialog
 *   closed, or an unrecognized host).
 */
async function openDeployStep1ChooseHost(alreadyConfigured, owner, repo) {
  const warning = alreadyConfigured
    ? `<p class="notification warning">${t("Dialog.DeploySiteAlreadyConfiguredWarning", { owner: escapeHtml(owner), repo: escapeHtml(repo) })}</p>`
    : "";

  const content = `
    <p><strong>${t("Dialog.DeployStep1Of3")}</strong></p>
    <p>${t("Dialog.DeploySiteIntro")}</p>
    <p>${t("Dialog.DeploySiteFirstBuildNote")}</p>
    ${warning}
    <div class="form-group">
      <label>${t("Dialog.DeploySiteRepoNameLabel")}</label>
      <input type="text" name="repoName" value="${escapeHtml(repo || "my-campaign-site")}">
      <p class="hint">${t("Dialog.DeploySiteRepoNameHint")}</p>
    </div>
    <p><strong>${t("Dialog.DeploySiteDeployToLabel")}</strong></p>
  `;

  // No deploy button is `default` here (even when nothing's configured
  // yet): with three different hosts to pick from, there's no single
  // obvious choice to fire on a stray Enter keypress the way a single
  // "Deploy" button had -- Cancel is the only safe default now, in both
  // cases. Each deploy button's own callback returns both which host it
  // is and the typed repo name (matching openJournalConfigDialog's
  // established pattern of reading button.form.elements directly), so
  // whichever one gets clicked still carries the name forward.
  const buttonFor = (action, labelKey) => ({
    action,
    label: `WORLD2WEB.Dialog.${labelKey}`,
    icon: "fa-solid fa-cloud-arrow-up",
    callback: (event, button) => ({ action, repoName: button.form.elements.repoName.value.trim() }),
  });

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: t("Dialog.DeploySiteTitle") },
    position: { width: 520 },
    content,
    buttons: [
      buttonFor("deploy-cloudflare", "DeployCloudflare"),
      buttonFor("deploy-netlify", "DeployNetlify"),
      buttonFor("deploy-vercel", "DeployVercel"),
      { action: "cancel", label: "WORLD2WEB.Dialog.Cancel", icon: "fa-solid fa-xmark", default: true },
    ],
    rejectClose: false,
  });

  // Cancel has no callback, so it resolves with its own bare action string
  // ("cancel") rather than an { action, repoName } object -- that's what
  // distinguishes it here, not the repo name's own content (which can
  // legitimately be "" if someone clears the field).
  if (!result || typeof result === "string") return null;
  const url = buildDeployUrl(result.action, result.repoName);
  if (!url) return null;
  window.open(url, "_blank", "noopener");
  return { url, repoName: result.repoName };
}

/**
 * Step 2/3: sends the GM to GitHub to create the token this module needs to push. Opening the link
 * and advancing the wizard are the same button -- `DialogV2.wait()` closes on any button click, so
 * there's no way to open the link, keep this dialog open, and wait for a separate "I'm done" click
 * without dropping to DialogV2's lower-level (non-`wait`) API, which isn't worth the added risk
 * for a single extra click saved.
 *
 * @param {string} [owner] Pre-selects the token's resource owner (see
 *   {@link buildGithubTokenUrl}).
 * @param {string} repoName Named explicitly in this dialog's own text, since GitHub's
 *   fine-grained PAT template-URL feature has no parameter for pre-selecting a specific repository
 *   -- only the resource owner.
 * @returns {Promise<boolean>} `true` to advance to step 3, `false` to abort (Cancel or closed).
 */
async function openDeployStep2CreateToken(owner, repoName) {
  const content = `
    <p><strong>${t("Dialog.DeployStep2Of3")}</strong></p>
    <p>${t("Dialog.DeploySiteTokenIntro", { repo: escapeHtml(repoName) })}</p>
  `;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: t("Dialog.DeploySiteTitle") },
    position: { width: 520 },
    content,
    buttons: [
      { action: "open-token", label: "WORLD2WEB.Dialog.OpenGithubTokenPage", icon: "fa-solid fa-key", default: true },
      { action: "cancel", label: "WORLD2WEB.Dialog.Cancel", icon: "fa-solid fa-xmark" },
    ],
    rejectClose: false,
  });

  if (result !== "open-token") return false;
  window.open(buildGithubTokenUrl(owner), "_blank", "noopener");
  return true;
}

/**
 * Step 3/3: a real form, not a pointer back to Configure Settings -- saves directly via
 * `game.settings.set()` so finishing this wizard is actually finishing setup, not "now go find
 * these same three fields somewhere else and retype them." Form values are read directly off the
 * DOM by name, same reasoning as {@link openJournalConfigDialog}'s own doc comment (sidesteps
 * `FormDataExtended` version drift).
 *
 * @param {{owner?: string, repo?: string, token?: string}} defaults Pre-fills the form -- all
 *   blank on a first-ever setup, so re-running this wizard to update one value doesn't require
 *   retyping the other two.
 * @returns {Promise<void>}
 */
async function openDeployStep3SaveSettings(defaults) {
  const content = `
    <p><strong>${t("Dialog.DeployStep3Of3")}</strong></p>
    <p>${t("Dialog.DeploySiteSaveIntro")}</p>
    <div class="form-group">
      <label>${t("Settings.GithubOwner.Name")}</label>
      <input type="text" name="owner" value="${escapeHtml(defaults.owner ?? "")}">
    </div>
    <div class="form-group">
      <label>${t("Settings.GithubRepo.Name")}</label>
      <input type="text" name="repo" value="${escapeHtml(defaults.repo ?? "")}">
    </div>
    <div class="form-group">
      <label>${t("Settings.GithubToken.Name")}</label>
      <input type="password" name="token" value="${escapeHtml(defaults.token ?? "")}">
      <p class="hint">${t("Settings.GithubToken.Hint")}</p>
    </div>
  `;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: t("Dialog.DeploySiteTitle") },
    position: { width: 520 },
    content,
    buttons: [
      {
        action: "save",
        label: "WORLD2WEB.Dialog.Save",
        icon: "fa-solid fa-check",
        default: true,
        callback: (event, button) => ({
          owner: button.form.elements.owner.value.trim(),
          repo: button.form.elements.repo.value.trim(),
          token: button.form.elements.token.value.trim(),
        }),
      },
      { action: "cancel", label: "WORLD2WEB.Dialog.Cancel", icon: "fa-solid fa-xmark" },
    ],
    rejectClose: false,
  });
  if (!result) return;

  await game.settings.set(MODULE_ID, "githubOwner", result.owner);
  await game.settings.set(MODULE_ID, "githubRepo", result.repo);
  await game.settings.set(MODULE_ID, "githubToken", result.token);

  // game.settings.set() only updates the stored value -- it doesn't touch
  // an already-open Configure Settings window's own rendered <input>
  // elements, which keep showing whatever they had at render time. If a GM
  // opened this wizard *from* that settings screen (the natural path, since
  // it's the "deploySite" menu button sitting right there among the
  // fields), the fields behind it would otherwise still look blank/stale
  // after saving, with nothing indicating the save actually worked. Same
  // pattern as refreshAllOpenIndicators() elsewhere in this file: find any
  // currently-open instance and force a re-render rather than waiting for
  // one that isn't coming on its own. Matched by constructor name, not an
  // imported class reference, since Foundry doesn't export its core
  // SettingsConfig application as something this module can import
  // directly -- untested against a live Foundry instance like the rest of
  // this wizard.
  for (const app of foundry.applications.instances.values()) {
    if (app.constructor.name === "SettingsConfig") app.render(true);
  }

  ui.notifications.info(`${t("Notify.Prefix")}: ${t("Notify.DeploySiteSaved")}`);
}

/**
 * Orchestrates the three-step Setup Wizard (see each step function's own doc comment for what it
 * does and why it's split out): deploying a site, creating a GitHub token, and configuring this
 * module's own settings are genuinely three separate destinations (a chosen host's own site,
 * GitHub's own settings pages, and this module).
 *
 * @returns {Promise<void>}
 */
async function openDeploySiteDialog() {
  const owner = game.settings.get(MODULE_ID, "githubOwner")?.trim();
  const repo = game.settings.get(MODULE_ID, "githubRepo")?.trim();
  const token = game.settings.get(MODULE_ID, "githubToken")?.trim();
  const alreadyConfigured = !!(owner && repo && token);

  const step1 = await openDeployStep1ChooseHost(alreadyConfigured, owner, repo);
  if (!step1) return;
  if (!(await openDeployStep2CreateToken(owner, step1.repoName))) return;
  // step1.repoName (whatever was actually typed, possibly "") wins over the
  // old repo setting here -- it's what step 2 just told them to go create,
  // so step 3 needs to match it, not silently fall back to a stale value.
  await openDeployStep3SaveSettings({ owner, repo: step1.repoName || repo, token });
}

/**
 * Opens the entry-level publishing config dialog, edited via a header button (see
 * {@link injectJournalConfigButton}). DialogV2 (`foundry.applications.api.DialogV2`) is the
 * standard modern (v12+) dialog API, but its exact button-callback signature is taken on faith
 * here rather than confirmed live. Form values are read directly off the DOM form elements by name
 * rather than via Foundry's `FormDataExtended`, to sidestep any version drift in that class.
 *
 * @param {JournalEntry} entry The Foundry native JournalEntry document to configure.
 * @returns {Promise<void>}
 */
async function openJournalConfigDialog(entry) {
  const config = entry.flags?.[MODULE_ID] ?? {};
  const defaultAuthor = resolveDefaultAuthor(entry);
  const defaultRoot = resolveDefaultRoot(entry);

  const content = `
    <fieldset>
      <label class="checkbox">
        <input type="checkbox" name="published" ${config.published ? "checked" : ""}>
        ${t("Dialog.PublishLabel")}
      </label>
      <p class="hint">${t("Dialog.PublishHint")}</p>
      <div class="form-group">
        <label>${t("Dialog.AuthorActorLabel")}</label>
        <input type="text" name="authorActorUuid" value="${escapeHtml(config.authorActorUuid ?? "")}">
        <p class="hint">${t("Dialog.AuthorActorHint")}</p>
      </div>
      <div class="form-group">
        <label>${t("Dialog.AuthorNameLabel")}</label>
        <input type="text" name="authorName" value="${escapeHtml(config.authorName ?? "")}"
               placeholder="${escapeHtml(t("Dialog.DefaultPlaceholder", { value: defaultAuthor.name }))}">
        <p class="hint">${t("Dialog.AuthorNameHint")}</p>
      </div>
      <div class="form-group">
        <label>${t("Dialog.AuthorImageLabel")}</label>
        <input type="text" name="authorImage" value="${escapeHtml(config.authorImage ?? "")}"
               placeholder="${escapeHtml(
                 t("Dialog.DefaultPlaceholder", { value: defaultAuthor.image ?? t("Dialog.None") }),
               )}">
        <p class="hint">${t("Dialog.AuthorImageHint")}</p>
      </div>
      <div class="form-group">
        <label>${t("Dialog.RootLabel")}</label>
        <input type="text" name="root" value="${escapeHtml(config.root ?? "")}"
               placeholder="${escapeHtml(t("Dialog.DefaultPlaceholder", { value: defaultRoot ?? t("Dialog.None") }))}">
        <p class="hint">${t("Dialog.RootHint")}</p>
      </div>
      <div class="form-group">
        <label>${t("Dialog.TagsLabel")}</label>
        <input type="text" name="tags" value="${escapeHtml((config.tags ?? []).join(", "))}">
      </div>
      <div class="form-group">
        <label>${t("Dialog.PostOrderLabel")}</label>
        <select name="postOrder">
          <option value="manual" ${!config.postOrder || config.postOrder === "manual" ? "selected" : ""}>${t("Dialog.PostOrderManual")}</option>
          <option value="newest" ${config.postOrder === "newest" ? "selected" : ""}>${t("Dialog.PostOrderNewest")}</option>
          <option value="oldest" ${config.postOrder === "oldest" ? "selected" : ""}>${t("Dialog.PostOrderOldest")}</option>
        </select>
        <p class="hint">${t("Dialog.PostOrderHint")}</p>
      </div>
    </fieldset>
  `;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: t("Dialog.Title", { name: entry.name }) },
    position: { width: 640 },
    content,
    buttons: [
      {
        action: "save",
        label: "WORLD2WEB.Dialog.Save",
        icon: "fa-solid fa-check",
        default: true,
        callback: (event, button) => ({
          published: button.form.elements.published.checked,
          authorActorUuid: button.form.elements.authorActorUuid.value,
          authorName: button.form.elements.authorName.value,
          authorImage: button.form.elements.authorImage.value,
          root: button.form.elements.root.value,
          tags: button.form.elements.tags.value,
          postOrder: button.form.elements.postOrder.value,
        }),
      },
      { action: "cancel", label: "WORLD2WEB.Dialog.Cancel", icon: "fa-solid fa-xmark" },
    ],
    rejectClose: false,
  });

  if (!result) return; // cancelled or closed

  const tags = String(result.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  const flagsUpdate = {
    published: !!result.published,
    authorActorUuid: String(result.authorActorUuid ?? "").trim(),
    authorName: String(result.authorName ?? "").trim(),
    authorImage: String(result.authorImage ?? "").trim(),
    root: String(result.root ?? "").trim(),
    tags,
    postOrder: ["newest", "oldest"].includes(result.postOrder) ? result.postOrder : "manual",
  };
  // Sticky, stamped once on first-ever publish and never cleared after --
  // omitted (not set to false/undefined) once already set, so Foundry's
  // flag-merge behavior leaves the existing value alone. See collector.js's
  // isPublishable()/collectJournal() for why the collector needs to keep
  // visiting this entry even after `published` is later turned back off.
  if (result.published && !config.publishedAt) {
    flagsUpdate.publishedAt = Date.now();
  }

  await entry.update({ flags: { [MODULE_ID]: flagsUpdate } });

  ui.notifications.info(`${t("Notify.Prefix")}: ${t("Notify.PublishingSettingsSaved", { name: entry.name })}`);
}

/**
 * Gear-icon header button, entry sheets only (not the popped-out page editor) -- opens
 * {@link openJournalConfigDialog}. Shown unconditionally (for whoever can see it at all) so a GM
 * -- or an owning player, once `allowPlayerSelfPublish` is on -- can turn publishing *on* from an
 * unpublished entry, unlike the per-page publish button which only makes sense once the entry
 * itself is publishable.
 *
 * @param {object} app A Foundry native `ApplicationV2` instance (the journal entry sheet).
 * @param {HTMLElement} header The sheet's `.window-header` element to inject the button into.
 * @returns {void}
 */
function injectJournalConfigButton(app, header) {
  const doc = app?.document ?? app?.object;
  if (doc?.documentName !== "JournalEntry") return;
  if (!canControlJournal(doc)) return;

  header.querySelector(".world2web-journal-config-button")?.remove();

  const button = document.createElement("button");
  button.type = "button";
  button.className = "header-control icon fa-solid fa-gear world2web-journal-config-button";
  button.dataset.tooltip = t("Tooltip.PublishingSettings");
  button.setAttribute("aria-label", t("Aria.PublishingSettings"));
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    await openJournalConfigDialog(doc);
  });

  const closeButton = header.querySelector('[data-action="close"]');
  if (closeButton) closeButton.before(button);
  else header.appendChild(button);
}

/**
 * Per-post config, mirroring {@link openJournalConfigDialog} above but scoped to a single page's
 * own flags -- author/tags/front-image overrides only (no "published" checkbox: that's the
 * separate per-page publish control; no root/postOrder: those stay journal-level-only concepts).
 * Any field left blank falls back to the journal's own resolved value, the same "blank = inherit"
 * convention every other override in this module already uses -- see collector.js's
 * `resolvePostAuthor()`/`resolvePostTags()`. Front image has no journal-level equivalent to inherit
 * from at all (`resolvePostFrontImage()`).
 *
 * @param {JournalEntryPage} page The Foundry native JournalEntryPage document to configure.
 * @returns {Promise<void>}
 */
async function openPostConfigDialog(page) {
  const config = page.flags?.[MODULE_ID] ?? {};
  const journalAuthor = resolveJournalAuthor(page.parent);

  const content = `
    <fieldset>
      <div class="form-group">
        <label>${t("Dialog.AuthorActorLabel")}</label>
        <input type="text" name="authorActorUuid" value="${escapeHtml(config.authorActorUuid ?? "")}">
        <p class="hint">${t("Dialog.PostAuthorActorHint")}</p>
      </div>
      <div class="form-group">
        <label>${t("Dialog.AuthorNameLabel")}</label>
        <input type="text" name="authorName" value="${escapeHtml(config.authorName ?? "")}"
               placeholder="${escapeHtml(t("Dialog.DefaultPlaceholder", { value: journalAuthor.name }))}">
        <p class="hint">${t("Dialog.PostAuthorNameHint")}</p>
      </div>
      <div class="form-group">
        <label>${t("Dialog.AuthorImageLabel")}</label>
        <input type="text" name="authorImage" value="${escapeHtml(config.authorImage ?? "")}"
               placeholder="${escapeHtml(
                 t("Dialog.DefaultPlaceholder", { value: journalAuthor.image ?? t("Dialog.None") }),
               )}">
        <p class="hint">${t("Dialog.PostAuthorImageHint")}</p>
      </div>
      <div class="form-group">
        <label>${t("Dialog.TagsLabel")}</label>
        <input type="text" name="tags" value="${escapeHtml((config.tags ?? []).join(", "))}">
        <p class="hint">${t("Dialog.PostTagsHint")}</p>
      </div>
      <div class="form-group">
        <label>${t("Dialog.FrontImageLabel")}</label>
        <input type="text" name="frontImage" value="${escapeHtml(config.frontImage ?? "")}">
        <p class="hint">${t("Dialog.FrontImageHint")}</p>
      </div>
    </fieldset>
  `;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: t("Dialog.PostTitle", { name: page.name }) },
    position: { width: 640 },
    content,
    buttons: [
      {
        action: "save",
        label: "WORLD2WEB.Dialog.Save",
        icon: "fa-solid fa-check",
        default: true,
        callback: (event, button) => ({
          authorActorUuid: button.form.elements.authorActorUuid.value,
          authorName: button.form.elements.authorName.value,
          authorImage: button.form.elements.authorImage.value,
          tags: button.form.elements.tags.value,
          frontImage: button.form.elements.frontImage.value,
        }),
      },
      { action: "cancel", label: "WORLD2WEB.Dialog.Cancel", icon: "fa-solid fa-xmark" },
    ],
    rejectClose: false,
  });

  if (!result) return; // cancelled or closed

  const tags = String(result.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  const flagsUpdate = {
    authorActorUuid: String(result.authorActorUuid ?? "").trim(),
    authorName: String(result.authorName ?? "").trim(),
    authorImage: String(result.authorImage ?? "").trim(),
    tags,
    frontImage: String(result.frontImage ?? "").trim(),
  };
  // Bumps the same dirty-detection timestamp togglePublish() uses for a
  // republish, so changing a post's metadata-only fields -- no content
  // edit at all, which wouldn't otherwise touch Foundry's own
  // _stats.modifiedTime -- still shows up as needing a republish; these
  // fields flow into the published frontmatter same as the post's own
  // body text does. Only meaningful once the page has actually been
  // published at least once (publishedAt set) -- nothing downstream reads
  // this page's config before then anyway.
  if (config.publishedAt) {
    flagsUpdate.updatedAt = Date.now();
  }

  await page.update({ flags: { [MODULE_ID]: flagsUpdate } });

  ui.notifications.info(`${t("Notify.Prefix")}: ${t("Notify.PostSettingsSaved", { name: page.name })}`);
}

// --- Drag an Actor onto either dialog's "Author Actor override" field -----
//
// Both openJournalConfigDialog() and openPostConfigDialog() render a plain
// <input name="authorActorUuid">, meant to be filled in either by typing a
// UUID directly or by dragging an Actor onto it. Delegated on `document`
// rather than attached per-dialog-render: DialogV2.wait()'s `content` is a
// plain HTML string with no confirmed hook for running code once it's
// actually in the DOM (these dialogs are already flagged in README.md as
// unverified against a live instance for exactly this kind of uncertainty).
// A single delegated listener, registered once at module load, sidesteps
// needing that hook at all -- it works identically whichever dialog is
// open, and across as many opens/closes as happen, no attach/detach
// bookkeeping required.
/**
 * @param {EventTarget|null} target
 * @returns {boolean} Whether `target` is the "Author Actor override" `<input>` in either
 *   {@link openJournalConfigDialog} or {@link openPostConfigDialog}.
 */
function isActorAuthorInput(target) {
  return target instanceof HTMLInputElement && target.name === "authorActorUuid";
}

document.addEventListener("dragover", (event) => {
  if (!isActorAuthorInput(event.target)) return;
  // Required for "drop" to fire at all -- browsers refuse to drop onto an
  // element that never opted in during dragover. dataTransfer's actual
  // payload isn't readable at this stage (only .types is, in most
  // browsers), so this can't yet tell an Actor drag from anything else;
  // real validation happens in the "drop" handler below. Accepted
  // trade-off: dragging plain arbitrary text onto this field no longer
  // falls back to the browser's native "insert as text" behavior once
  // this preventDefault fires, but that was never a real use case for a
  // field meant to hold one specific UUID.
  event.preventDefault();
});

document.addEventListener("drop", (event) => {
  if (!isActorAuthorInput(event.target)) return;
  event.preventDefault();

  let data;
  try {
    data = JSON.parse(event.dataTransfer.getData("text/plain"));
  } catch {
    return; // not a Foundry document drag -- leave whatever's already typed alone
  }

  // Actor#toDragData() (dragging from the Actors sidebar or a compendium)
  // gives {type: "Actor", uuid: ...} directly. A scene token drags as
  // {type: "Token", uuid: <TokenDocument uuid>} instead -- resolved here to
  // that token's own actor, so dragging a token off the canvas works too,
  // not just dragging from the sidebar specifically.
  let actorUuid = null;
  if (data?.type === "Actor" && data.uuid) {
    actorUuid = data.uuid;
  } else if (data?.type === "Token" && data.uuid) {
    actorUuid = fromUuidSync(data.uuid)?.actor?.uuid ?? null;
  }
  if (!actorUuid) return;

  event.target.value = actorUuid;
  // No code here actually listens for this, but dispatching it costs
  // nothing and matches how a real keystroke would behave, in case
  // something (a future validation script, a browser extension) expects
  // ordinary input events on a value change.
  event.target.dispatchEvent(new Event("input", { bubbles: true }));
});

/**
 * Publish (never -> published), republish (dirty -> bump updatedAt), or unpublish (clean ->
 * published: false) -- which of the three depends on the page's current state, so the caller
 * doesn't need to know which. A page that's clean (published and up to date) is the one case where
 * there's nothing useful left to "republish" -- so clicking it there unpublishes instead, rather
 * than just bumping `updatedAt` for no visible effect.
 *
 * @param {JournalEntryPage} page The Foundry native JournalEntryPage document to toggle.
 * @returns {Promise<void>}
 */
async function togglePublish(page) {
  if (!isPageTypePublishable(page)) {
    ui.notifications.warn(`${t("Notify.Prefix")}: ${unpublishableMessage(page)}`);
    return;
  }

  const current = page.flags?.[MODULE_ID];
  const now = Date.now();

  if (!current?.published) {
    await page.update({ flags: { [MODULE_ID]: { published: true, publishedAt: now, updatedAt: now } } });
    ui.notifications.info(t("Notify.PagePublished", { name: page.name }));
  } else if (getPublishState(page) === "clean") {
    await page.update({ flags: { [MODULE_ID]: { published: false, updatedAt: now } } });
    ui.notifications.info(t("Notify.PageUnpublished", { name: page.name }));
  } else {
    await page.update({ flags: { [MODULE_ID]: { updatedAt: now } } });
    ui.notifications.info(t("Notify.PageRepublished", { name: page.name }));
  }
  refreshSyncButtonColors();
}

// Dirty-check: a page is "dirty" if it's been edited (Foundry's own
// _stats.modifiedTime) since our own last publish/republish (updatedAt).
// Both timestamps get set within the same page.update() call when we
// publish, so they land within a few ms of each other in practice, not
// exactly equal -- DIRTY_GRACE_MS absorbs that instead of flagging a page
// as dirty immediately after we just published it.
const DIRTY_GRACE_MS = 2000;

/**
 * @param {JournalEntryPage} page
 * @returns {"never"|"dirty"|"clean"}
 */
function getPublishState(page) {
  const flags = page.flags?.[MODULE_ID];
  if (!flags?.published) return "never";
  const modifiedTime = page._stats?.modifiedTime ?? 0;
  return modifiedTime > flags.updatedAt + DIRTY_GRACE_MS ? "dirty" : "clean";
}

// This client's own authoritative view of lastSyncAt -- read lazily from
// game.settings on first use, then updated directly by markSynced() and by
// the updateSetting hook below (which fires whenever ANY client, including
// this one, actually writes the setting). Deliberately never re-read via
// game.settings.get() after that first time: Foundry doesn't guarantee its
// settings cache reflects a .set() the moment that promise resolves, so a
// render triggered moments after our own write -- e.g. the
// renderJournalDirectory hook re-creating the sync buttons, which calls
// refreshSyncButtonColors() with no override at all -- could still read
// the OLD value and stomp the correct color right back to stale. Trusting
// our own cache instead of re-asking Foundry sidesteps that regardless of
// what's actually racing what.
let cachedLastSyncAt = null;

/**
 * @returns {number} This client's own cached `lastSyncAt`, lazily initialized from
 *   `game.settings` on first call -- see the comment above. `0` if nothing has ever synced.
 */
function getLastSyncAt() {
  if (cachedLastSyncAt === null) cachedLastSyncAt = game.settings.get(MODULE_ID, "lastSyncAt") ?? 0;
  return cachedLastSyncAt;
}

Hooks.on("updateSetting", (setting) => {
  if (setting.key !== `${MODULE_ID}.lastSyncAt`) return;
  cachedLastSyncAt = setting.value;
  refreshSyncButtonColors(cachedLastSyncAt);
  refreshAllOpenIndicators(cachedLastSyncAt);
});

// Toggling "Enable Dev Mode" in Configure Settings used to need a page
// reload to actually show/hide the Dev Sync button -- nothing re-ran
// renderJournalDirectory just because the setting changed. Reacts
// immediately instead: adds or removes the button on every currently-open
// Journal Directory the moment the setting is saved.
Hooks.on("updateSetting", (setting) => {
  if (setting.key !== `${MODULE_ID}.enableDevMode`) return;
  document.querySelectorAll(".directory-header .action-buttons").forEach((header) => {
    const existing = header.querySelector(".world2web-dev-sync-button");
    if (setting.value && !existing) {
      const publishButton = header.querySelector(".world2web-publish-to-web-button");
      const devSyncButton = createDevSyncButton();
      if (publishButton) publishButton.before(devSyncButton);
      else header.appendChild(devSyncButton);
    } else if (!setting.value && existing) {
      existing.remove();
    }
  });
  refreshSyncButtonColors();
});

/**
 * "Uncommitted": this page's current local state -- its content (dirty) or its
 * published/unpublished flag itself -- hasn't been confirmed by a successful sync (Publish to
 * Web, or Dev Sync in dev mode) yet. A page that's never been touched at all (no
 * `flags.updatedAt`) is never pending; there's nothing local to reconcile. Note: for an unpublish,
 * this only reflects whether a sync has run *since* the unpublish -- for Publish to Web
 * specifically, it doesn't (yet) mean the file was actually removed from GitHub, since
 * `pushFiles`/`putFile` only ever create or update files, never delete (see `collectPost()` in
 * collector.js for the soft-delete tombstone that works around that). Dev Sync never pushes
 * anywhere at all -- it only counts here as "the GM has taken the current state out of Foundry," a
 * separate, weaker claim than "it's live."
 *
 * @param {JournalEntryPage} page
 * @param {number} [lastSyncAtOverride] Use this instead of {@link getLastSyncAt}'s cached value --
 *   passed by callers that just learned the new value directly (see `markSynced`/the
 *   `updateSetting` hook) rather than relying on the module-level cache.
 * @returns {boolean}
 */
function isPagePending(page, lastSyncAtOverride) {
  const flags = page.flags?.[MODULE_ID];
  if (!flags?.updatedAt) return false;
  const lastSyncAt = lastSyncAtOverride ?? getLastSyncAt();
  if (flags.updatedAt > lastSyncAt) return true;
  return getPublishState(page) === "dirty";
}

/**
 * @param {"never"|"dirty"|"clean"} status
 * @param {boolean} pending
 * @returns {string}
 */
function publishTooltip(status, pending) {
  if (status === "dirty") return t("Tooltip.PublishDirty");
  if (status === "clean") {
    return pending ? t("Tooltip.PublishCleanPending") : t("Tooltip.PublishCleanLive");
  }
  return pending ? t("Tooltip.PublishNeverPending") : t("Tooltip.PublishNever");
}

/**
 * @param {"never"|"dirty"|"clean"} status
 * @param {boolean} pending
 * @returns {string} A CSS color value, or `"inherit"`.
 */
function publishIconColor(status, pending) {
  if (pending) return COLOR_UNCOMMITTED;
  if (status === "clean") return COLOR_COMMITTED;
  return "inherit";
}

/**
 * Shared copy for a page whose type has no publish path at all (see collector.js's
 * `isPageTypePublishable`) -- used for both the icon's tooltip and the notification a click pops
 * instead of actually publishing.
 *
 * @param {JournalEntryPage} page
 * @returns {string}
 */
function unpublishableMessage(page) {
  return t("Notify.PageTypeNotPublishable", { name: page.name, type: page.type });
}

/**
 * Scans every page in every journal entry for the amber/green coloring shared by the sync buttons
 * (Dev Sync, Publish to Web): amber if anything is pending, green if everything touched is
 * confirmed synced, or leaves default styling alone if nothing's ever been published at all. Also
 * amber whenever a relevant `pendingDeletions` entry exists -- a deleted page/entry no longer
 * exists to be caught by the per-page scan below at all, so that's the only other place this needs
 * checking (see {@link trackDeletedPage}).
 *
 * For the GM this is the same global scan it's always been -- amber if *anything*, anyone's, is
 * pending. For a non-GM (only reached here at all when `allowPlayerSelfPublish` is on, see "Player
 * self-publish" above) it's scoped to what they actually own, matching what their own "Publish to
 * Web" click would actually touch -- otherwise the button could sit amber over someone else's
 * pending work a player's own publish would never resolve.
 *
 * @param {number} [lastSyncAtOverride] See {@link isPagePending}.
 * @returns {string|null} A CSS color value, or `null` if nothing has ever been published at all
 *   (leave default button styling alone).
 */
function syncButtonColor(lastSyncAtOverride) {
  const scoped = !game.user.isGM;

  const pending = game.settings.get(MODULE_ID, "pendingDeletions");
  const relevantDeletionUuids = scopedDeletionUuids(pending, {
    scopedToCaller: scoped,
    userId: game.user.id,
    ownerLevel: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
  });
  if (relevantDeletionUuids.length > 0) return COLOR_UNCOMMITTED;

  let anyTouched = false;
  for (const entry of game.journal.contents) {
    if (scoped && !entry.isOwner) continue;
    for (const page of entry.pages.contents) {
      const flags = page.flags?.[MODULE_ID];
      if (!flags?.updatedAt) continue;
      anyTouched = true;
      if (isPagePending(page, lastSyncAtOverride)) {
        // Deliberately left in as a standing diagnostic, not a one-off
        // debug line: with many journals/pages, "why is this amber" isn't
        // obvious at a glance, so this names the exact page/entry and the
        // data behind the decision every time.
        console.log(`${MODULE_ID} | sync buttons amber because of "${page.name}" in "${entry.name}"`, {
          "flags.updatedAt": flags.updatedAt,
          "flags.published": flags.published,
          lastSyncAtUsed: lastSyncAtOverride ?? getLastSyncAt(),
          publishState: getPublishState(page),
          "page._stats.modifiedTime": page._stats?.modifiedTime,
        });
        return COLOR_UNCOMMITTED;
      }
    }
  }
  return anyTouched ? COLOR_COMMITTED : null;
}

/**
 * @param {number} [lastSyncAtOverride] See {@link isPagePending}.
 * @returns {void}
 */
function refreshSyncButtonColors(lastSyncAtOverride) {
  const color = syncButtonColor(lastSyncAtOverride) ?? "";
  // querySelectorAll, not querySelector -- if the directory happens to have
  // re-rendered and left a stale/duplicate button node around momentarily,
  // querySelector's "first match in document order" could silently color
  // the wrong one while the one actually on screen stays untouched.
  for (const selector of [".world2web-dev-sync-button", ".world2web-publish-to-web-button"]) {
    document.querySelectorAll(selector).forEach((button) => {
      button.style.color = color;
    });
  }
}

/**
 * Stamps `lastSyncAt` as now and refreshes every sync-related color on screen using that exact
 * value directly (see {@link isPagePending}'s note on why -- not by reading the setting back):
 * both sync buttons, and every currently-open journal sheet's per-page/header publish icons, for
 * both Dev Sync and a successful Publish to Web.
 *
 * @returns {Promise<void>}
 */
async function markSynced() {
  const now = Date.now();
  await game.settings.set(MODULE_ID, "lastSyncAt", now);
  cachedLastSyncAt = now; // authoritative from here on -- see getLastSyncAt()
  refreshSyncButtonColors(now);
  refreshAllOpenIndicators(now);
}

/**
 * Header-control publish button -- used only for the popped-out single-page editor
 * (`JournalEntryPageProseMirrorSheet`), where the whole window IS that one page, so "publish this
 * window" is unambiguous. The multi-page entry sheet uses per-page buttons instead (see
 * {@link injectPagePublishButtons}) -- a header button there read as acting on the whole entry
 * when it only ever affected whichever page was shown.
 *
 * @param {object} app A Foundry native `ApplicationV2` instance.
 * @param {HTMLElement} header The sheet's `.window-header` element to inject buttons into.
 * @param {number} [lastSyncAtOverride] See {@link isPagePending}.
 * @returns {void}
 */
function injectPublishButton(app, header, lastSyncAtOverride) {
  const page = getCurrentPage(app);
  if (!canControlJournal(page?.parent)) return;

  header.querySelector(".world2web-publish-button")?.remove(); // refresh state on every render
  header.querySelector(".world2web-post-config-button")?.remove();

  if (page && isPageTypePublishable(page)) {
    const configButton = document.createElement("button");
    configButton.type = "button";
    configButton.className = "header-control icon fa-solid fa-gear world2web-post-config-button";
    configButton.dataset.tooltip = t("Tooltip.PostSettings");
    configButton.setAttribute("aria-label", t("Aria.PostSettings"));
    configButton.addEventListener("click", async (event) => {
      event.preventDefault();
      const current = getCurrentPage(app);
      if (current) await openPostConfigDialog(current);
    });
    const closeButtonForConfig = header.querySelector('[data-action="close"]');
    if (closeButtonForConfig) closeButtonForConfig.before(configButton);
    else header.appendChild(configButton);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "header-control icon fa-solid world2web-publish-button";
  button.setAttribute("aria-label", t("Aria.Publish"));

  if (page && !isPageTypePublishable(page)) {
    // A dead end, not a toggle -- fa-ban plus a click that just explains
    // why, rather than the check/upload icon that implies this can be
    // acted on. See collector.js's isPageTypePublishable.
    button.classList.add("fa-ban");
    button.dataset.tooltip = unpublishableMessage(page);
    button.style.opacity = "0.5";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      ui.notifications.warn(`${t("Notify.Prefix")}: ${unpublishableMessage(page)}`);
    });
  } else {
    const status = page ? getPublishState(page) : "never";
    const pending = page ? isPagePending(page, lastSyncAtOverride) : false;
    button.classList.add(status === "clean" ? "fa-check" : "fa-upload");
    button.dataset.tooltip = publishTooltip(status, pending);
    button.style.color = publishIconColor(status, pending);
    // Resolve the page fresh at click time, not at injection time --
    // switching pages within an already-open entry sheet may not re-fire
    // this render hook, so a page captured at injection time could go
    // stale.
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const current = getCurrentPage(app);
      if (!current) {
        console.warn(`${MODULE_ID} | Could not determine current page for publish button.`, app);
        ui.notifications.warn(`${t("Notify.Prefix")}: ${t("Notify.NoCurrentPage")}`);
        return;
      }
      // togglePublish() itself re-checks isPageTypePublishable (the user
      // may have switched to a different, non-publishable page since this
      // button was rendered, without a re-render happening in between).
      await togglePublish(current);
    });
  }

  const closeButton = header.querySelector('[data-action="close"]');
  if (closeButton) closeButton.before(button);
  else header.appendChild(button);
}

/**
 * Per-page publish control, next to each page's own title in the entry sheet's page-navigation
 * list -- replaces the old passive status dot with something actually clickable, right where it's
 * unambiguous which page it acts on. Always shown (including when clean), since the icon itself
 * already conveys the state the dot used to (checkmark vs. upload, plus the same tooltip the
 * header button used to show).
 *
 * @param {HTMLElement} root The sheet's rendered root element.
 * @param {JournalEntry} entry The Foundry native JournalEntry document whose pages to inject
 *   buttons for.
 * @param {number} [lastSyncAtOverride] See {@link isPagePending}.
 * @returns {void}
 */
function injectPagePublishButtons(root, entry, lastSyncAtOverride) {
  if (!canControlJournal(entry)) return;

  for (const page of entry.pages.contents) {
    const titleEl = root.querySelector(`[data-page-id="${page.id}"] .page-title`);
    if (!titleEl) continue;
    titleEl.parentElement?.querySelector(".world2web-page-publish-button")?.remove();
    titleEl.parentElement?.querySelector(".world2web-page-config-button")?.remove();

    // An <a>, not a <button> -- a bare <button> here picks up the browser's
    // native button chrome (border/background box) since, unlike the
    // header-control buttons elsewhere, nothing in this context (a plain
    // page-title row) resets it. An anchor has no such default chrome, so
    // the icon renders as a plain icon instead of a small filled box.
    const link = document.createElement("a");
    link.setAttribute("role", "button");
    link.setAttribute("aria-label", t("Aria.Publish"));
    link.tabIndex = 0;
    // Sized to actually stand out next to the page title rather than fade
    // into it -- an earlier version at 0.8em/opacity 0.6 read as basically
    // invisible, and using a <button> element rendered as a small
    // filled-in box instead of a plain icon (native button chrome).
    link.style.cssText = `display:inline-block;margin-left:0.5em;cursor:pointer;
      font-size:1.15em;line-height:1;vertical-align:middle;`;

    if (!isPageTypePublishable(page)) {
      // A dead end, not a toggle -- fa-ban plus a click that just explains
      // why, rather than the check/upload icon that implies this can be
      // acted on. See collector.js's isPageTypePublishable.
      link.className = "world2web-page-publish-button fa-solid fa-ban";
      link.dataset.tooltip = unpublishableMessage(page);
      link.style.opacity = "0.5";
      const onBlocked = (event) => {
        event.preventDefault();
        event.stopPropagation();
        ui.notifications.warn(`${t("Notify.Prefix")}: ${unpublishableMessage(page)}`);
      };
      link.addEventListener("click", onBlocked);
      link.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") onBlocked(event);
      });
      titleEl.after(link);
      continue;
    }

    // Color signals uncommitted (amber) vs. committed (green) -- see
    // publishIconColor()/isPagePending().
    const status = getPublishState(page);
    const pending = isPagePending(page, lastSyncAtOverride);
    link.className = `world2web-page-publish-button fa-solid ${status === "clean" ? "fa-check" : "fa-upload"}`;
    link.dataset.tooltip = publishTooltip(status, pending);
    link.style.color = publishIconColor(status, pending);
    const onActivate = async (event) => {
      event.preventDefault();
      event.stopPropagation(); // don't also trigger the nav row's own "switch to this page" handler
      await togglePublish(page);
    };
    link.addEventListener("click", onActivate);
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") onActivate(event);
    });
    titleEl.after(link);

    // Post Settings gear -- author/tags/front-image overrides for this one
    // post (see openPostConfigDialog). Only reachable here for a
    // publishable page type (the non-publishable branch above `continue`s
    // before this point), matching the publish icon's own gating -- a
    // pdf/video page can never actually become a post, so its metadata
    // never matters.
    const configLink = document.createElement("a");
    configLink.setAttribute("role", "button");
    configLink.setAttribute("aria-label", t("Aria.PostSettings"));
    configLink.tabIndex = 0;
    configLink.className = "world2web-page-config-button fa-solid fa-gear";
    configLink.dataset.tooltip = t("Tooltip.PostSettings");
    configLink.style.cssText = `display:inline-block;margin-left:0.5em;cursor:pointer;
      font-size:1.15em;line-height:1;vertical-align:middle;`;
    const onConfigActivate = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await openPostConfigDialog(page);
    };
    configLink.addEventListener("click", onConfigActivate);
    configLink.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") onConfigActivate(event);
    });
    link.after(configLink);
  }
}

/**
 * @param {object} app A Foundry native `ApplicationV2` instance (a journal entry sheet or a
 *   popped-out page editor).
 * @param {HTMLElement} [htmlEl] The sheet's rendered root element; falls back to `app.element`.
 * @param {number} [lastSyncAtOverride] See {@link isPagePending}.
 * @returns {void}
 */
function refreshIndicators(app, htmlEl, lastSyncAtOverride) {
  const entry = getOwningEntry(app);
  if (!entry) return;
  const root = htmlEl ?? app?.element;
  const header = root?.querySelector?.(".window-header");
  if (!root || !header) return;

  // The config button (turns publishing on/off) is entry-wide and always
  // shown; the publish control(s) only make sense once the entry itself
  // has been marked published.
  injectJournalConfigButton(app, header);
  if (isPublishable(entry)) {
    const doc = app?.document ?? app?.object;
    if (doc?.documentName === "JournalEntry") {
      header.querySelector(".world2web-publish-button")?.remove();
      header.querySelector(".world2web-post-config-button")?.remove();
      injectPagePublishButtons(root, entry, lastSyncAtOverride);
    } else {
      root.querySelectorAll(".world2web-page-publish-button, .world2web-page-config-button").forEach((btn) => btn.remove());
      injectPublishButton(app, header, lastSyncAtOverride);
    }
  } else {
    header.querySelector(".world2web-publish-button")?.remove();
    header.querySelector(".world2web-post-config-button")?.remove();
    root.querySelectorAll(".world2web-page-publish-button, .world2web-page-config-button").forEach((btn) => btn.remove());
  }
  refreshSyncButtonColors(lastSyncAtOverride);
}

/**
 * Sweeps every currently-open journal entry/page sheet and refreshes its indicators -- unlike the
 * `updateJournalEntryPage`/`updateJournalEntry` hooks below (which only touch sheets for the ONE
 * entry that changed), a sync (Publish to Web, Dev Sync) can affect every published page across
 * every entry at once, so every open sheet needs a nudge, not just one.
 *
 * @param {number} [lastSyncAtOverride] See {@link isPagePending}.
 * @returns {void}
 */
function refreshAllOpenIndicators(lastSyncAtOverride) {
  for (const app of foundry.applications.instances.values()) {
    const doc = app.document ?? app.object;
    if (doc?.documentName === "JournalEntry" || doc?.documentName === "JournalEntryPage") {
      refreshIndicators(app, undefined, lastSyncAtOverride);
    }
  }
}

for (const hookName of [
  "renderJournalEntrySheet",
  "renderJournalEntrySheet5e",
  "renderJournalEntryPageProseMirrorSheet",
]) {
  Hooks.on(hookName, (app, htmlEl) => {
    // Cheap top-level bail matching today's exact behavior when
    // allowPlayerSelfPublish is off (its default); when it's on, this lets
    // a non-GM through so refreshIndicators()'s own per-entry
    // canControlJournal() checks can decide entry by entry.
    if (!game.user.isGM && !game.settings.get(MODULE_ID, "allowPlayerSelfPublish")) return;
    console.log(`${MODULE_ID} | ${hookName} fired for`, app?.document?.name ?? app?.object?.name);

    const root = htmlEl instanceof HTMLElement ? htmlEl : htmlEl?.[0];
    refreshIndicators(app, root);
  });
}

// Editing a page's content (saving in ProseMirror) doesn't reliably trigger
// the sheet's own render hook -- Foundry's document-update-to-sheet-rerender
// wiring only fires for the exact sheet showing the updated document, and
// even then not always for a parent entry sheet whose page list needs
// updating too. updateJournalEntryPage fires unconditionally on every page
// update regardless of any sheet's render behavior, so use it to proactively
// refresh indicators on every currently-open relevant sheet instead of
// waiting for a render that might not come.
Hooks.on("updateJournalEntryPage", (page) => {
  const entry = page.parent;
  for (const app of foundry.applications.instances.values()) {
    const doc = app.document ?? app.object;
    if (!doc) continue;
    const isEntrySheet = doc.documentName === "JournalEntry" && doc.id === entry.id;
    const isThisPageEditor = doc.documentName === "JournalEntryPage" && doc.id === page.id;
    if (isEntrySheet || isThisPageEditor) refreshIndicators(app);
  }
});

// Same idea, for the entry's own flags -- saving the journal config dialog
// updates the entry document, which re-renders its own open sheet
// automatically, but a popped-out page editor (a separate app instance)
// needs an explicit nudge to pick up the newly (un)published state.
Hooks.on("updateJournalEntry", (entry) => {
  for (const app of foundry.applications.instances.values()) {
    const doc = app.document ?? app.object;
    if (!doc) continue;
    const isEntrySheet = doc.documentName === "JournalEntry" && doc.id === entry.id;
    const isPageOfThisEntry = doc.documentName === "JournalEntryPage" && doc.parent?.id === entry.id;
    if (isEntrySheet || isPageOfThisEntry) refreshIndicators(app);
  }
});

// A deleted page no longer exists anywhere in Foundry's own collections --
// this hook, firing with the (about to be removed) document still intact,
// is the only chance to notice it happened at all. See the "Deleted
// pages/entries" section (trackDeletedPage()) further up this file.
Hooks.on("deleteJournalEntryPage", (page) => {
  trackDeletedPage(page, page.parent);
});

// Deleting a whole entry takes every one of its pages with it. Whether
// Foundry also separately fires deleteJournalEntryPage for each child in
// this case is unconfirmed against a live instance -- trackDeletedPage()
// is idempotent (a plain "already tracked?" check), so calling it here
// regardless is harmless either way, not a double-count. Passes `entry`
// explicitly (rather than relying on each page's own `.parent`) since
// there's no guarantee that reference is still intact once the parent
// itself is mid-deletion.
Hooks.on("deleteJournalEntry", (entry) => {
  for (const page of entry.pages?.contents ?? []) {
    trackDeletedPage(page, entry);
  }
});
