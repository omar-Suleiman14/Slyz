"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");

test("editor contains valid embedded JavaScript", () => {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "Embedded editor JavaScript must exist");
  assert.doesNotThrow(() => new Function(match[1]));
});

test("Arabic text uses Cairo, even on English slides", () => {
  assert.match(html, /family=Cairo/);
  assert.match(html, /\.slide \.slideblock\[lang="ar"\]/);
  assert.match(html, /\.slide \.listblock\[lang="ar"\]/);
  assert.match(html, /el\.lang='ar'/);
  assert.match(html, /span\.lang='ar'/);
  assert.match(html, /<html lang="en" dir="ltr">/);
});

test("mobile editor keeps interactive controls", () => {
  for (const id of [
    "slideList", "editorSlide", "slidesPanel", "inspectorPanel", "blockPicker",
    "mcpSheet", "shortcutHelpBtn", "shortcutsSheet", "sidebarResizer",
    "designResizer", "imageInput", "playBtn"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "Missing editor element: " + id);
  }
  assert.match(html, /function beginBlockDrag\(/);
  assert.match(html, /function beginResize\(/);
  assert.match(html, /function restoreUi\(/);
});

test("static code references valid element IDs", () => {
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const staticRefs = [...js.matchAll(/\$\(["']([^"']+)["']\)/g)].map(m => m[1]);
  for (const id of staticRefs) assert.ok(ids.has(id), "Missing ID referenced by $(): " + id);
});

test("keeps portable JSON and browser-local persistence", () => {
  assert.match(html, /indexedDB\.open/);
  assert.match(html, /function exportDeck\(/);
  assert.match(html, /function importDeck\(/);
  assert.match(html, /#deck=/);
});
