// Run with: node --test scripts/secrets.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripUnrevealedSecrets } from "./secrets.js";

test("removes an unrevealed secret block, keeping the text around it", () => {
  const html = '<p>Before</p><section class="secret" id="secret-AbC123"><p>Strahd is watching.</p></section><p>After</p>';
  assert.equal(stripUnrevealedSecrets(html), "<p>Before</p><p>After</p>");
});

test("keeps a revealed secret, as Foundry shows it to everyone", () => {
  const html = '<section class="secret revealed" id="secret-x"><p>Now known</p></section>';
  assert.equal(stripUnrevealedSecrets(html), html);
});

test("removes every unrevealed secret, in any order of classes, with single quotes too", () => {
  const html = "<p>a</p><section class='secret'>s1</section><p>b</p><section class=\"foo secret\">s2</section><p>c</p>";
  assert.equal(stripUnrevealedSecrets(html), "<p>a</p><p>b</p><p>c</p>");
});

test("removes a secret whole even when it contains its own sections", () => {
  const html = '<p>x</p><section class="secret"><section><p>inner</p></section><p>more</p></section><p>y</p>';
  assert.equal(stripUnrevealedSecrets(html), "<p>x</p><p>y</p>");
});

test("leaves ordinary sections, and the word 'secret' in text, alone", () => {
  const html = '<section class="intro"><p>The secret door is obvious.</p></section>';
  assert.equal(stripUnrevealedSecrets(html), html);
});

test("an unclosed secret is removed to the end rather than published", () => {
  assert.equal(stripUnrevealedSecrets('<p>ok</p><section class="secret"><p>oops'), "<p>ok</p>");
});

test("handles empty and missing input", () => {
  assert.equal(stripUnrevealedSecrets(""), "");
  assert.equal(stripUnrevealedSecrets(null), "");
  assert.equal(stripUnrevealedSecrets(undefined), "");
});
