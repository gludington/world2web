import type { CollectionEntry } from "astro:content";
import { postRoute } from "./routes";

// Foundry stores an author-typed `@UUID[<uuid>]{<label>}` reference as
// literal text -- it's a text *enricher*, resolved into a real (but
// href-less) `<a class="content-link" data-uuid="...">` anchor only at
// *display* time, via TextEditor.enrichHTML(), which Foundry's journal
// sheet calls automatically and this static site never does. So what
// actually reaches post.body is the raw `@UUID[...]{...}` syntax, not an
// anchor -- confirmed live (an earlier version of this file assumed the
// opposite and left the literal syntax showing up unresolved on the site).
// {label} is optional -- Foundry falls back to the resolved document's own
// current name when omitted, which resolveContentLinks() mirrors using the
// target post's title. A pre-existing `<a class="content-link"
// data-uuid="...">` anchor (e.g. from a drag-and-drop insert, or any future
// Foundry behavior that does serialize one directly) is also handled, in
// case both forms ever show up in the same content.
const UUID_ENRICHER_RE = /@UUID\[([^\]]+)\](?:\{([^}]*)\})?/g;
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
const CONTENT_LINK_CLASS_RE = /\bclass="[^"]*\bcontent-link\b[^"]*"/;
const DATA_UUID_RE = /\bdata-uuid="([^"]+)"/;

export interface ContentLinkTarget {
  url: string;
  title: string;
}

/** world-scoped, since Foundry UUIDs are only unique within one world/game
 * instance -- a multi-world site (see routes.ts) could otherwise, in
 * principle, collide two different worlds' random 16-char document ids.
 * Foundry's own `@UUID[...]` resolution never crosses worlds either, so
 * this also just matches Foundry's real semantics, not just paranoia. */
function linkKey(world: string, foundryUuid: string): string {
  return `${world}:${foundryUuid}`;
}

/** Builds the uuid -> {url, title} map once, from every currently-published
 * post -- pass this into resolveContentLinks() for every post in the same
 * build rather than reconstructing it per post (O(n) build, not O(n^2)
 * across the whole site). title is kept alongside url for the label-less
 * `@UUID[...]` case (no `{label}` at all). */
export function buildContentLinkMap(posts: CollectionEntry<"posts">[]): Map<string, ContentLinkTarget> {
  return new Map(
    posts.map((post) => [
      linkKey(post.data.world, post.data.foundryUuid),
      { url: postRoute(post.data), title: post.data.title },
    ]),
  );
}

/** Rewrites every Foundry cross-reference in `html` -- both the raw
 * `@UUID[<uuid>]{<label>}` enricher text Foundry actually stores, and any
 * already-converted `<a class="content-link" data-uuid="...">` anchor --
 * into a real link when the target is another currently-published post, or
 * plain text otherwise (not published, foreign/bad uuid, or a non-journal
 * document type like an Actor or Item, which this site never has a page
 * for). Deliberately not a distinct "broken link" style: a dead link that
 * looks real invites a click that goes nowhere, which reads as broken to a
 * visitor; plain text just reads as a name. This also self-heals with no
 * action needed on the referencing post -- once the target page is itself
 * published, the next site rebuild alone turns it into a real link, since
 * resolution happens here at build time against whatever is currently in
 * `uuidToTarget`, not once at Foundry-publish time. */
export function resolveContentLinks(html: string, world: string, uuidToTarget: Map<string, ContentLinkTarget>): string {
  const withEnrichersResolved = html.replace(UUID_ENRICHER_RE, (full, uuid: string, label: string | undefined) => {
    const target = uuidToTarget.get(linkKey(world, uuid));
    const text = label || target?.title || uuid;
    return target ? `<a href="${target.url}">${text}</a>` : text;
  });

  return withEnrichersResolved.replace(ANCHOR_RE, (full, attrs: string, label: string) => {
    if (!CONTENT_LINK_CLASS_RE.test(attrs)) return full; // an ordinary link, not a Foundry content-link -- leave it alone
    const uuidMatch = attrs.match(DATA_UUID_RE);
    if (!uuidMatch) return full;
    const target = uuidToTarget.get(linkKey(world, uuidMatch[1]));
    return target ? `<a href="${target.url}">${label}</a>` : label;
  });
}
