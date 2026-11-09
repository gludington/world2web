# New-user run-through

A full pass as a brand-new World2Web user, on the version you'd submit to Foundry's package
listing. Do it on a released version (installed from the manifest, not the dev symlink), in a
**fresh world** with no World2Web settings. Tick items off as you go; note anything confusing,
not just anything broken.

Automated checks already done from the repo side are listed at the end.

## 1. Install

- [ ] **v13:** Setup → Add-on Modules → Install Module → paste
      `https://github.com/gludington/world2web/releases/latest/download/module.json`. The version
      shown is the release under test.
- [ ] **v14:** the same.
- [ ] Create a fresh world, enable World2Web (Game Settings → Manage Modules), reload.
- [ ] The **World2Web Documentation** compendium is there, opens, and every link between its
      pages works.

## 2. Setup Wizard, once per host

Use a new repo name each time (e.g. `w2w-test-netlify`), and a GitHub account you can clean up
afterwards.

For **each** of Cloudflare, Netlify and Vercel:

- [ ] Configure Settings → World2Web → **Setup Wizard**. Step 1 shows no "already configured"
      warning in a fresh world.
- [ ] The host's deploy button opens its own setup page in a new tab. (Cloudflare's link
      couldn't be checked automatically -- confirm it opens.)
- [ ] The repo-name hint matches what the host suggests (Netlify and Cloudflare suggest
      `world2web-site-template`; change it to the name from step 1).
- [ ] The host's first build **succeeds** and shows a **"Your site is ready"** page. Note the
      site's address.
- [ ] Step 2 opens GitHub's token page with Contents: Read and write pre-selected; pick only the
      new repository; generate the token.
- [ ] Step 3: try a **misspelled repo name** → a specific "Couldn't find owner/repo" message, with
      the form still filled in. Then a **bad token** → "GitHub rejected the token". Then the
      right values → saved.
- [ ] **Cancel** on step 3 leaves any saved settings unchanged.

## 3. First publish

- [ ] Create a journal with two text pages. Journal gear icon → **Publish this journal to the
      web**, author override, tags → Save.
- [ ] Publish one page (upload icon → checkmark), then **Publish to Web**. The message says
      "published in one commit…".
- [ ] The repo has exactly **one** new commit; the host builds **once**; the post is live.
- [ ] Settings → **GitHub Connection → Edit Connection** shows owner, repo, branch and token.

## 4. Features

- [ ] **Homepage → Replace Recent Posts** on the journal: the homepage lists its pages in order,
      no Recent Posts. **Show above Recent Posts**: both. Setting it on a second journal clears
      it from the first.
- [ ] **Homepage Links** (Edit Links): add two, one with a bad address (refused with a message).
      They appear as a footer on the homepage after publishing.
- [ ] A page link dragged between two pages of the journal becomes a working link on the site.
- [ ] A **secret** block in a page stays off the site; after **revealing** it, it's published.
- [ ] **Unpublish** a page and publish: its file is **removed** from the repo, in the publish
      commit.
- [ ] **Delete** a published page in Foundry and publish: its file is removed too.
- [ ] **Cancel** in Publishing Settings and Post Settings changes nothing.
- [ ] **Players** (Allow Player Self-Publish on, a player who owns a journal):
  - [ ] With a GM online, the player's Publish to Web works and only covers their journal.
  - [ ] With no GM online, it's queued; when a GM connects it runs, and the player sees the
        result.
  - [ ] Players don't see the Homepage field.
- [ ] After updating the module to a newer version, the next publish moves the site's
      `@world2web/site` version to match ("your site is being updated…").

## 5. Docs

- [ ] Follow the compendium guide literally, as a newcomer. Note anything wrong, missing or
      unclear.
- [ ] The README's links work in a browser (one GitHub link timed out for automated checks).

## Already checked automatically

- The release manifest: version, download link, compatibility 13–14, license, docs site and
  issue tracker.
- The template repo is a public GitHub template; a fresh copy installs `@world2web/site` from npm
  and builds the "Your site is ready" page.
- The template, Netlify and Vercel deploy links respond.
- The docs site: all seven pages, their links between pages, and their images load.
