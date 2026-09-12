/**
 * Pure ownership-scoping helpers for the Player Self-Publish feature (see
 * main.js's own "Player self-publish" section) -- kept separate from
 * collector.js (which filters *live* Foundry documents directly via their
 * own `isOwner` getter) because these instead filter plain, already-
 * captured data (a pendingDeletions map's ownership snapshots) with no
 * live document left to ask. No Foundry globals touched at all, so this
 * is directly Node-testable without stubbing anything.
 */

/** Whether userId had Owner-or-higher permission according to a captured
 * ownership snapshot (an entry's own `.ownership` object, captured at
 * some point in time -- see main.js's trackDeletedPage()) -- the same
 * fallback chain Foundry's own permission resolution uses (an explicit
 * per-user level, else the document's own `default` level). ownerLevel
 * is passed in rather than read from CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
 * directly, so this file has zero Foundry-global dependency of its own. */
export function ownsSnapshot(ownership, userId, ownerLevel) {
  return (ownership?.[userId] ?? ownership?.default ?? 0) >= ownerLevel;
}

/** Which UUIDs in a pendingDeletions map (see main.js) should actually be
 * processed right now.
 *
 * scopedToCaller: false (a GM's "Publish to Web" -- and this is the ONLY
 * value it's ever called with for a GM, never conditionally) means every
 * single UUID, completely unfiltered, regardless of any ownership
 * snapshot -- a GM's publish/retraction always means *everyone's*
 * pending work. This is deliberately the one and only place that
 * guarantee is decided, rather than something every call site (both
 * retractPendingDeletions and syncButtonColor use this) has to
 * independently get right.
 *
 * scopedToCaller: true (a player's own scoped publish) means only the
 * UUIDs whose captured ownership snapshot shows userId as an owner. */
export function scopedDeletionUuids(pending, { scopedToCaller, userId, ownerLevel }) {
  return Object.keys(pending).filter(
    (uuid) => !scopedToCaller || ownsSnapshot(pending[uuid]?.ownership, userId, ownerLevel),
  );
}
