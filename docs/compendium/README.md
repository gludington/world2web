# Documentation compendium: page sources

The **World2Web Documentation** compendium (`packs/documentation`) and the docs site
(world2web.loodingdongs.com) are both built from one journal in the `docs` Foundry world. These
files are the text of its pages, kept here so changes can be reviewed like code. Foundry is still
where the pages are edited and published; these files are the source you paste in.

| File | Page | Page ID |
|---|---|---|
| `1-introduction-requirements.html` | Introduction & Requirements | `sEFz09Fcfphsk9AV` |
| `2-module-setup.html` | Module Setup | `YJgINFmlwzaLHjbo` |
| `3-journal-setup.html` | Journal Setup | `yRJTauP9wSpUlnLQ` |
| `4-publishing-a-page.html` | Publishing A Page | `Vq11kS2FukvL4GAH` |
| `5-publishing.html` | Publishing! | `RCsd666cT4PHmxUS` |
| `6-site-settings-and-players.html` | Site Settings & Players | *new page* |
| `7-troubleshooting.html` | Troubleshooting | *new page* |

## Updating the docs

1. In the `docs` world, open the documentation journal. For each page, edit it, switch the editor
   to **Source HTML** (the `</>` button), and replace the contents with the matching file.
2. Pages 6 and 7 are new: create them after "Publishing!", in that order.
3. Pages 2 and 5 contain the placeholder `@UUID[.TROUBLESHOOTING_ID]`. Replace it with a link to
   the Troubleshooting page: drag the page in, or write `@UUID[.<its page id>]`. Keep links in the
   **relative** form `@UUID[.<id>]` (a dot, then the page ID). Only that form works both in the
   world and in the compendium copy; the module expands it to a full link when publishing.
   Write it as `@UUID[.YJgINFmlwzaLHjbo]{Module Setup}`, just the target page's ID after the
   dot. **Not** `@UUID[.JournalEntryPage.YJgINFmlwzaLHjbo]`: Foundry reads that as something inside
   the current page, so it shows as a broken link. Links only work in view mode, not while editing.
   Afterwards, record the new pages' IDs in the table above.
4. Retake any screenshots whose UI has changed (they live in `assets/`, referenced as
   `modules/world2web/assets/<file>`).
5. In the journal's Publishing Settings: **Author name override** "World2Web", **Post order**
   Manual, **Homepage** Replace Recent Posts.
6. Publish the pages, **Publish to Web**, and check the docs site.
7. Unlock the compendium, export the journal into it (overwriting the existing entry, keeping
   IDs), lock it again, and check that a link between pages works there.
8. Close Foundry (it holds a lock on the pack files), then commit `packs/documentation` together
   with any changes here and in `assets/`.

## Checks to run in Foundry before the 0.22.0 release

Not yet tried in a live Foundry session:

- Setup Wizard, step 3: a misspelled repo name or bad token gives a specific message and keeps
  the form filled in; correct values save; Cancel leaves saved settings alone.
- Publishing Settings and Post Settings: Cancel changes nothing.
- Homepage dropdown: choosing it for one journal clears it from any other; players don't see it.
- A page link dragged between pages of one journal comes out as a full link on the site.
