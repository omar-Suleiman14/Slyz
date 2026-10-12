"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class MemoryZip {
  constructor() { this.entries = new Map(); this.size = 2048; }
  file(name, data, opts) {
    if (arguments.length === 1) return this.entries.get(name) || null;
    const raw = String(data);
    const bytes = opts?.base64 ? Buffer.from(raw, "base64").length : Buffer.byteLength(raw);
    this.entries.set(name, {
      dir: false, _data: {uncompressedSize: bytes},
      async: async type => type === "string" ? raw : type === "base64" ? raw : Buffer.from(raw)
    });
    return this;
  }
  async generateAsync() { return this; }
  static async loadAsync(file) { return file; }
}
class FakePptx {
  constructor() {
    this.ShapeType = {rect: "rect", line: "line", ellipse: "ellipse"};
    this.slides = [];
  }
  defineLayout(layout) { this.layoutDefinition = layout; }
  addSlide() {
    const slide = {shapes: [], texts: [], images: [],
      addShape(type, opts) { this.shapes.push({type, opts}); },
      addText(text, opts) { this.texts.push({text, opts}); },
      addImage(opts) { this.images.push(opts); }
    };
    this.slides.push(slide);
    return slide;
  }
  async write() { return this; }
}
function setup() {
  const window = {JSZip: MemoryZip, PptxGenJS: FakePptx};
  const js = fs.readFileSync(path.join(__dirname, "..", "slyz-io.js"), "utf8");
  vm.runInNewContext(js, {window, console}, {filename: "slyz-io.js"});
  return window.SlyzIO;
}
function sample() {
  const base64 = Buffer.from([255, 216, 255, 217]).toString("base64");
  return {version: 1, slides: [
    {title: "العنوان", direction: "rtl", layout: "editorial", palette: "Ocean", blocks: [
      {type: "h1", text: "مرحبا"},
      {type: "image", text: "Cover", src: "data:image/jpeg;base64," + base64,
        position: {x: 20, y: 25, w: 40, h: 35}}
    ]},
    {title: "Second", direction: "ltr", palette: "Sunset", blocks: [
      {type: "p", text: "A second slide"}
    ]}
  ]};
}
test("portable ZIP contains project metadata and separate, recoverable image bytes", async () => {
  const io = setup();
  const zip = await io.exportProject(sample());
  const project = JSON.parse(await zip.file("project.json").async("string"));
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(project.format, "slyz-project");
  assert.equal(manifest.imageCount, 1);
  assert.equal(project.slides[0].blocks[1].src, undefined);
  assert.match(project.slides[0].blocks[1].asset, /^images\//);
  assert.ok(zip.file(project.slides[0].blocks[1].asset));
  const recovered = await io.importFile(Object.assign(zip, {name: "my-deck.zip"}));
  assert.equal(recovered.slides.length, 2);
  assert.equal(recovered.slides[0].blocks[1].src, sample().slides[0].blocks[1].src);
  assert.equal(recovered.slides[0].blocks[1].position.x, 20);
  assert.equal(recovered.slides[0].direction, "rtl");
});
test("legacy JSON remains importable even though new exports use ZIP", async () => {
  const io = setup();
  const deck = sample();
  const imported = await io.importFile({
    name: "old-project.json", type: "application/json", size: 512,
    text: async () => JSON.stringify(deck)
  });
  assert.equal(imported.slides[1].blocks[0].text, "A second slide");
});
test("invalid asset paths and unsupported project versions are rejected", async () => {
  const io = setup(), zip = new MemoryZip();
  zip.file("project.json", JSON.stringify({
    format: "slyz-project", formatVersion: 1,
    slides: [{blocks: [{type: "image", asset: "../outside.jpg"}]}]
  }));
  zip.name = "broken.zip";
  await assert.rejects(io.importFile(zip), /Invalid image path/);
  const future = new MemoryZip();
  future.file("project.json", JSON.stringify({format: "slyz-project", formatVersion: 2, slides: [{}]}));
  future.name = "future.zip";
  await assert.rejects(io.importFile(future), /Unsupported Slyz project version/);
});
test("PowerPoint creates editable text, native images, RTL fonts, and slide decorations", async () => {
  const io = setup();
  const pptx = await io.exportPowerPoint(sample());
  assert.equal(pptx.slides.length, 2);
  assert.equal(pptx.layoutDefinition.width, 13.333);
  assert.equal(pptx.slides[0].texts[0].text, "مرحبا");
  assert.equal(pptx.slides[0].texts[0].opts.fontFace, "Cairo");
  assert.equal(pptx.slides[0].texts[0].opts.rtlMode, true);
  assert.equal(pptx.slides[0].images.length, 1);
  assert.equal(pptx.slides[0].images[0].sizing.type, "contain");
  assert.ok(pptx.slides[0].shapes.length > 0);
});
