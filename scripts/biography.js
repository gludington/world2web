/**
 * Per-system Actor behavior, formalized as a small registry -- currently just biography
 * extraction, but shaped so a future per-system need follows the same pattern rather than growing
 * its own separate lookup table.
 *
 * Foundry's core Actor schema has exactly two fields safe to assume across every game system:
 * `name` and `img` (both defined on Foundry's own base Document schema, not something any system
 * overrides). Biography is NOT one of them -- it lives entirely under the system-defined `system`
 * object, shaped however that system's own data model says, or not present at all. There is no
 * universal path to fall back to.
 *
 * Add a new system by adding another entry to SYSTEMS below, with its own `extractBiography(actor)`
 * -- a plain function returning the raw bio text, or a falsy value if this actor has none. A
 * system with no entry here -- or whose extractor finds nothing, or throws -- yields `""` (not an
 * error, not a placeholder): an actor-backed author with no biography is an expected, ordinary
 * outcome, not a failure. Raw HTML/text passthrough, same as post/journal content elsewhere in
 * this pipeline -- these are ProseMirror-authored fields too, where the system uses ProseMirror
 * for them at all.
 */

const SYSTEMS = {
  // dnd5e's NPC sheet splits biography into `value` (full text, meant for the GM's eyes -- can
  // hold spoilers/secrets) and `public` (the player-facing version). A journal author bio is
  // public by definition, so an NPC always reads from `public`, never `value`, even when
  // `public` is blank -- there's no safe fallback to `value` here. PCs only ever have `value`
  // (no GM/player split), so that's the one to use for them.
  dnd5e: {
    extractBiography(actor) {
      const biography = actor.system?.details?.biography;
      return actor.type === "npc" ? biography?.public : biography?.value;
    },
  },

  // pf2e splits its schema by actor type entirely, not just by field name (confirmed against
  // pf2e's own source -- character/data.ts's CharacterBiography interface and npc/data.ts's
  // NPCDetailsSource -- not guessed):
  //  - Character (PC): `details.biography.backstory` -- the general narrative field. The
  //    biography object's other fields (appearance, campaignNotes, allies, enemies,
  //    organizations, likes/dislikes, etc.) are structured worldbuilding notes, not a bio, so
  //    they're left alone.
  //  - NPC: no `details.biography` object at all -- instead `details.publicNotes` (safe) vs
  //    `details.privateNotes` (GM-only, must never be exposed here), the same public/private
  //    split dnd5e's NPCs use, just named differently and one level up.
  //  - Party (the party-wide aggregate actor pf2e generates per world): `details.description`
  //    directly -- a third, distinct shape again. No obvious in-Foundry UI actually populates
  //    this field as of this writing, but it's a real schema field, and returning "" when it's
  //    empty is already the correct behavior regardless.
  pf2e: {
    extractBiography(actor) {
      if (actor.type === "npc") return actor.system?.details?.publicNotes;
      if (actor.type === "party") return actor.system?.details?.description;
      return actor.system?.details?.biography?.backstory;
    },
  },

  // Daggerheart splits its schema by actor type, same idea as pf2e above:
  //  - Character (PC, type "character"): a flat `biography` object -- `background` (the general
  //    narrative field used here) and `connections` (relationships to other PCs, not a personal
  //    bio) sit alongside a `characteristics` sub-object (pronouns/age/faith) that's structured
  //    character info, not prose -- neither of those two is used for the extracted bio.
  //  - Adversary (NPC, type "adversary"): no `biography` object at all -- instead a flat
  //    `description` string (public-safe) and a separate `notes` field that's GM-only and must
  //    never be exposed here.
  daggerheart: {
    extractBiography(actor) {
      if (actor.type === "adversary") return actor.system?.description;
      return actor.system?.biography?.background;
    },
  },
};

/**
 * @param {Actor|null|undefined} actor The Foundry native Actor document to extract a biography
 *   from, or a falsy value (no Actor to pull one from at all).
 * @returns {string} Raw HTML/text, or `""` (never `null`/`undefined`) if `actor` was falsy, the
 *   current game system has no registered entry, or its extractor found/threw nothing -- matches
 *   the rest of this pipeline's convention of `""` over `null`/`undefined` for text fields the
 *   site renders directly, so callers never need a separate null-check before deciding whether to
 *   show a bio section.
 */
export function extractBiography(actor) {
  if (!actor) return "";
  const system = SYSTEMS[game.system?.id];
  if (!system?.extractBiography) return "";
  try {
    return String(system.extractBiography(actor) ?? "").trim();
  } catch {
    return "";
  }
}
