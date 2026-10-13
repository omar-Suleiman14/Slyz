"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function importer(archive) {
  const root = {
    JSZip: {
      async loadAsync(file, opts) {
        assert.equal(opts.checkCRC32, true);
        return file.archive;
      }
    }
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "slyz-io.js"), "utf8"),
    {window: root, document: {}, console}
  );
  const entries = Object.fromEntries(Object.entries(archive).map(([name, text]) => [
    name,
    {dir: false, _data: {uncompressedSize: Buffer.byteLength(text)}, async: async (encoding) => {
      assert.equal(encoding, "string");
      return text;
    }}
  ]));
  return {
    io: root.SlyzIO,
    file: {name: "presentation.zip", size: 2000, archive: {file: key => entries[key] || null}}
  };
}
const slides = [{title:"أهلا",layout:"editorial",direction:"rtl",blocks:[{type:"h1",text:"أهلا في وريد"}]}];

test("native ZIP with project.json imports slide text and RTL", async () => {
  const {io,file} = importer({"project.json": JSON.stringify({
    format:"slyz-project",formatVersion:1,version:1,slides
  })});
  const restored = await io.importFile(file);
  assert.equal(restored.slides.length, 1);
  assert.equal(restored.slides[0].direction, "rtl");
  assert.equal(restored.slides[0].blocks[0].text, "أهلا في وريد");
});

test("legacy MCP ZIP with deck.json imports instead of rejecting", async () => {
  const {io,file} = importer({"deck.json": JSON.stringify({version:1,slides})});
  const restored = await io.importFile(file);
  assert.equal(restored.slides[0].title, "أهلا");
});

test("rejects archives without supported slide JSON", async () => {
  const {io,file} = importer({"random.txt":"hello"});
  await assert.rejects(io.importFile(file), /project.json or deck.json/);
});

test("rejects unsupported deck format rather than silently accepting", async () => {
  const {io,file} = importer({"deck.json": JSON.stringify({version:100,slides})});
  await assert.rejects(io.importFile(file), /Unsupported Slyz project version/);
});

test("does not accept absolute or traversal image asset paths", async () => {
  const badSlides=[{title:"Unsafe",blocks:[{type:"image",asset:"../payload.png"}]}];
  const {io,file}=importer({"project.json":JSON.stringify({
    format:"slyz-project",formatVersion:1,version:1,slides:badSlides
  })});
  await assert.rejects(io.importFile(file), /Invalid image path/);
});
