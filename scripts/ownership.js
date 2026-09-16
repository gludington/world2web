/**
 * Pure ownership-scoping helpers for the Player Self-Publish feature (see
 * main.js's own "Player self-publish" section) -- kept separate from
 * collector.js (which filters *live* Foundry documents directly via their
 * own `isOwner` getter) because these instead filter plain, already-
 * captured data (a pendingDeletions map's ownership snapshots) with no
 * live document left to ask. No Foundry globals touched at all, so this
 * is directly Node-testable without stubbing anything.
 */

/**
 * Whether `userId` had Owner-or-higher permission according to a captured ownership snapshot --
 * the same fallback chain Foundry's own permission resolution uses (an explicit per-user level,
 * else the document's own `default` level).
 *
 * @param {object|null|undefined} ownership A captured copy of a Foundry document's own
 *   `.ownership` object (see main.js's `trackDeletedPage()`), or a falsy value if none was
 *   captured.
 * @param {string} userId The Foundry User id to check.
 * @param {number} ownerLevel The permission level that counts as "owner" -- passed in rather than
 *   read from `CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER` directly, so this file has zero Foundry-
 *   global dependency of its own.
 * @returns {boolean} Never `null`/`undefined`.
 */
function ownsSnapshot(ownership, userId, ownerLevel) {
  return (ownership?.[userId] ?? ownership?.default ?? 0) >= ownerLevel;
}

/**
 * Which UUIDs in a `pendingDeletions` map (see main.js) should actually be processed right now.
 *
 * @param {Object<string, {ownership: object}>} pending A `pendingDeletions` map: page UUID ->
 *   `{ ownership }`, where `ownership` is the snapshot {@link ownsSnapshot} expects.
 * @param {object} options
 * @param {boolean} options.scopedToCaller `false` (a GM's "Publish to Web" -- the ONLY value it's
 *   ever called with for a GM, never conditionally) returns every single UUID, completely
 *   unfiltered, regardless of any ownership snapshot -- a GM's publish/retraction always means
 *   *everyone's* pending work. This is deliberately the one and only place that guarantee is
 *   decided, rather than something every call site (both `retractPendingDeletions` and
 *   `syncButtonColor` use this) has to independently get right. `true` (a player's own scoped
 *   publish) returns only the UUIDs whose captured snapshot shows `userId` as an owner.
 * @param {string} options.userId The Foundry User id to scope to when `scopedToCaller` is `true`.
 *   Ignored otherwise.
 * @param {number} options.ownerLevel Passed straight through to {@link ownsSnapshot}.
 * @returns {string[]} Never `null`/`undefined`; `[]` if `pending` is empty or nothing qualifies.
 */
export function scopedDeletionUuids(pending, { scopedToCaller, userId, ownerLevel }) {
  return Object.keys(pending).filter(
    (uuid) => !scopedToCaller || ownsSnapshot(pending[uuid]?.ownership, userId, ownerLevel),
  );
}

// Functions that only ownership.test.mjs needs to see -- not part of this module's real API
// (scopedDeletionUuids above), never imported from anywhere else.
export const _test = { ownsSnapshot };
