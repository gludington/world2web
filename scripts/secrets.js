/**
 * Removes Foundry's unrevealed secret blocks from HTML before it's published.
 *
 * In a journal page (or an Actor's biography), a GM can mark passages as Secret; Foundry stores
 * them as `<section class="secret">...</section>` and only owners see them. When the GM reveals
 * one, it gains the `revealed` class and everyone sees it. This mirrors Foundry's own rule for
 * non-owners (client/applications/ux/text-editor.mjs, enrichHTML with `secrets: false`):
 * remove every `section.secret:not(.revealed)`. The published site is public, so it gets
 * exactly what a player would see.
 *
 * String-based rather than DOM-based so it runs the same in Foundry and in plain Node tests.
 * Section tags are matched with nesting depth, so a secret containing its own <section>s is
 * removed whole. An unclosed secret is removed to the end of the HTML: when in doubt, hide.
 */

const SECTION_TAG_RE = /<(\/?)section\b[^>]*>/gi;
const CLASS_ATTR_RE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/**
 * @param {string} openTag A `<section ...>` opening tag.
 * @returns {boolean} Whether it starts an unrevealed secret block.
 */
function isUnrevealedSecret(openTag) {
  const match = openTag.match(CLASS_ATTR_RE);
  if (!match) return false;
  const classes = (match[1] ?? match[2] ?? "").split(/\s+/);
  return classes.includes("secret") && !classes.includes("revealed");
}

/**
 * @param {string} html
 * @returns {string} The HTML without unrevealed secret blocks. Never `null`/`undefined`; returns
 *   the exact same string when there's nothing to remove.
 */
export function stripUnrevealedSecrets(html) {
  const text = String(html ?? "");
  if (!/secret/i.test(text)) return text;

  let out = "";
  let copyFrom = 0;
  let depth = 0; // open <section>s, outside or inside a secret
  let secretStart = -1; // index where the secret being removed starts
  let secretDepth = -1; // depth of that secret's own opening tag

  SECTION_TAG_RE.lastIndex = 0;
  for (let m; (m = SECTION_TAG_RE.exec(text)); ) {
    const isClose = m[1] === "/";
    if (!isClose) {
      if (secretStart < 0 && isUnrevealedSecret(m[0])) {
        secretStart = m.index;
        secretDepth = depth;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (secretStart >= 0 && depth === secretDepth) {
        out += text.slice(copyFrom, secretStart);
        copyFrom = m.index + m[0].length;
        secretStart = -1;
        secretDepth = -1;
      }
    }
  }
  // An unclosed secret runs to the end: drop the rest rather than publish it.
  if (secretStart >= 0) return out + text.slice(copyFrom, secretStart);
  return out + text.slice(copyFrom);
}
