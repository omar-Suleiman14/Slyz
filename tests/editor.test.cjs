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

test("images use the same Add Block flow, with no separate Images section", () => {
  assert.equal((html.match(/data-pick-type="image"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="dropZone"|id="mediaPickerGroup"|class="field image-field"/);
  assert.match(html, /image-upload-placeholder/);
  assert.match(html, /appendBlock\(t\)/);
  assert.match(html, /if\(!editor&&b\.type==="image"&&!b\.src\)return/);
  assert.match(html, /function openImageInput\(blockId\)/);
  assert.match(html, /existing\.src=src/);
  assert.match(html, /imageFile\(file,undefined,b\.id\)/);
  assert.match(html, /function beginResize\(/);
});

test("image placeholders render without broken img tags", () => {
  const js=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const start=js.indexOf("function displayTextBlock(");
  const end=js.indexOf("function createSlideEl(",start);
  assert.ok(start>=0&&end>start);
  let selected=null,upload=null;
  const doc={createElement:tag=>({
    tagName:tag,style:{setProperty(){}},dataset:{},setAttribute(){},
    addEventListener(){},className:"",hidden:false,onclick:null
  })};
  const display=new Function("document","selectBlock","openImageInput",
    js.slice(start,end)+"\nreturn displayTextBlock")(
      doc,id=>selected=id,id=>upload=id);
  const block={id:"image-1",type:"image",text:""};
  const placeholder=display(block,true,0);
  assert.equal(placeholder.tagName,"button");
  assert.match(placeholder.className,/image-upload-placeholder/);
  placeholder.onclick({stopPropagation(){}});
  assert.equal(selected,"image-1");
  assert.equal(upload,"image-1");
  assert.equal(display(block,false,0).hidden,true);
  const filled=display({...block,src:"data:image/png;base64,abc"},true,0);
  assert.equal(filled.tagName,"img");
  assert.equal(filled.src,"data:image/png;base64,abc");
});
