/**
 * Extracts an Actor's biography text, system by system.
 *
 * Foundry's core Actor schema has exactly two fields safe to assume across
 * every game system: `name` and `img` (both defined on Foundry's own base
 * Document schema, not something any system overrides). Biography is NOT
 * one of them -- it lives entirely under the system-defined `system`
 * object, shaped however that system's template.json says, or not present
 * at all. There is no universal path to fall back to.
 *
 * Add a new system by adding another entry to BIOGRAPHY_EXTRACTORS below.
 * A system with no entry here -- or whose extractor finds nothing, or
 * throws -- yields "" (not an error, not a placeholder): an actor-backed
 * author with no biography is an expected, ordinary outcome, not a
 * failure. Raw HTML passthrough, same as post/journal content elsewhere in
 * this pipeline -- these are ProseMirror-authored fields too.
 */

const BIOGRAPHY_EXTRACTORS = {
  // dnd5e's NPC sheet splits biography into `value` (full text, meant for
  // the GM's eyes -- can hold spoilers/secrets) and `public` (the
  // player-facing version). A journal author bio is public by definition, so
  // an NPC always reads from `public`, never `value`, even when `public`
  // is blank -- there's no safe fallback to `value` here. PCs only ever
  // have `value` (no GM/player split), so that's the one to use for them.
  dnd5e: (actor) => {
    const biography = actor.system?.details?.biography;
    return actor.type === "npc" ? biography?.public : biography?.value;
  },
};

/** "" (not null) on any miss -- matches the rest of this pipeline's
 * frontmatter convention of empty string over null/undefined for text
 * fields the site renders directly, and means callers never need a
 * separate null-check before deciding whether to show a bio section. */
export function extractBiography(actor) {
  if (!actor) return "";
  const extractor = BIOGRAPHY_EXTRACTORS[game.system?.id];
  if (!extractor) return "";
  try {
    return String(extractor(actor) ?? "").trim();
  } catch {
    return "";
  }
}
