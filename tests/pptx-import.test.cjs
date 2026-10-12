"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Lightweight XML fixture parser: simulates only DOMParser APIs the browser importer uses.
class XmlNode {
  constructor(name, attributes = {}) {
    this.nodeType = 1;
    this.tagName = name;
    this.localName = name.split(":").pop();
    this.attrs = attributes;
    this.childNodes = [];
    this.parts = [];
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  getAttributeNS(namespace, local) { return this.attrs["r:" + local] ?? this.attrs[local] ?? null; }
  get textContent() { return this.parts.map(p => typeof p === "string" ? p : p.textContent).join(""); }
  getElementsByTagNameNS(ns, name) {
    const out = [];
    const descend = element => {
      for (const x of element.childNodes) {
        if (x.localName === name || name === "*") out.push(x);
        descend(x);
      }
    };
    descend(this);
    return out;
  }
  getElementsByTagName(name) { return this.getElementsByTagNameNS("*", name); }
}
class FakeDOMParser {
  parseFromString(xml) {
    const stack = [], doc = {
      documentElement: null,
      getElementsByTagName: name => doc.documentElement?.getElementsByTagName(name) || [],
      getElementsByTagNameNS: (ns, name) => doc.documentElement?.getElementsByTagNameNS(ns, name) || []
    };
    for (const match of xml.matchAll(/<[^>]+>|[^<]+/g)) {
      const token = match[0];
      if (token.startsWith("<?") || token.startsWith("<!--")) continue;
      if (token.startsWith("</")) { stack.pop(); continue; }
      if (token.startsWith("<")) {
        const tag = /^<([\w:-]+)/.exec(token)?.[1];
        if (!tag) continue;
        const attrs = {};
        for (const m of token.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
        const node = new XmlNode(tag, attrs);
        if (stack.length) { stack[stack.length - 1].childNodes.push(node); stack[stack.length - 1].parts.push(node); }
        else doc.documentElement = node;
        if (!token.endsWith("/>")) stack.push(node);
      } else if (stack.length) {
        stack[stack.length - 1].parts.push(token.replace(/&amp;/g, "&").replace(/&lt;/g, "<"));
      }
    }
    return doc;
  }
}
function zipFixture(override = {}) {
  const photo = Buffer.from([255, 216, 255, 217]);
  const files = {
    "ppt/presentation.xml": `<?xml version="1.0"?>
      <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
       <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
       <p:sldSz cx="12192000" cy="6858000"/>
      </p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships>
       <Relationship Id="rId1" Target="slides/slide1.xml" Type="slide"/>
      </Relationships>`,
    "ppt/slides/slide1.xml": `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FAFAFA"/></a:solidFill></p:bgPr></p:bg>
      <p:spTree><p:sp>
       <p:spPr><a:xfrm><a:off x="1219200" y="685800"/>
       <a:ext cx="6096000" cy="1400000"/></a:xfrm></p:spPr>
       <p:txBody><a:p><a:r><a:rPr sz="3600"/><a:t>Editable title</a:t></a:r></a:p></p:txBody>
      </p:sp><p:pic><p:spPr><a:xfrm><a:off x="1828800" y="2600000"/>
       <a:ext cx="4267200" cy="2700000"/></a:xfrm></p:spPr>
       <p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic>
      </p:spTree></p:cSld>
      </p:sld>`,
    "ppt/slides/_rels/slide1.xml.rels": `<Relationships>
      <Relationship Id="rId3" Target="../media/image1.jpeg" Type="image"/>
      <Relationship Id="external" Target="https://example.com/tracker.png" TargetMode="External"/>
      </Relationships>`,
    "ppt/media/image1.jpeg": photo
  };
  Object.assign(files, override);
  const entries = {};
  for (const [name, value] of Object.entries(files)) {
    if (value == null) continue;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    entries[name] = {
      dir: false, _data: {uncompressedSize: bytes.length},
      async: async type => type === "base64" ? bytes.toString("base64") : bytes.toString("utf8")
    };
  }
  return {files: entries, file(name) { return entries[name] || null; }};
}
function build() {
  const window = {DOMParser: FakeDOMParser};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "slyz-pptx-import.js"), "utf8"), {window});
  class JSZip {
    static async loadAsync(file) { return file.zip; }
  }
  window.JSZip = JSZip;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "slyz-io.js"), "utf8"), {window});
  return window.SlyzIO;
}
test("PPTX converts text and images to editable slide blocks with positions", async () => {
  const deck = await build().importFile({name: "my-presentation.pptx", size: 4096, zip: zipFixture()});
  assert.equal(deck.slides.length, 1);
  assert.equal(deck.slides[0].title, "Editable title");
  assert.equal(deck.slides[0].blocks[0].type, "h1");
  assert.equal(deck.slides[0].blocks[0].text, "Editable title");
  assert.equal(deck.slides[0].blocks[0].position.x, 10);
  assert.equal(deck.slides[0].blocks[1].type, "image");
  assert.match(deck.slides[0].blocks[1].src, /^data:image\/jpeg;base64,/);
  assert.equal(deck.slides[0].colors.background, "#FAFAFA");
});
test("PowerPoint rejects zip bombs, missing slide relationships and entities", async () => {
  const io = build(), base = {name: "unsafe.pptx", size: 512};
  const giant = zipFixture();
  giant.files["ppt/presentation.xml"]._data.uncompressedSize = 250 * 1024 * 1024;
  await assert.rejects(io.importFile({...base, zip: giant}), /too large/i);
  const broken = zipFixture({"ppt/_rels/presentation.xml.rels": "<Relationships/>"});
  await assert.rejects(io.importFile({...base, zip: broken}), /no slides/i);
  const entity = zipFixture({"ppt/presentation.xml": "<!DOCTYPE foo [<!ENTITY x 'bad'>]><p:presentation/>"});
  await assert.rejects(io.importFile({...base, zip: entity}), /entities/i);
});
test("PowerPoint preserves Arabic letters and right-to-left direction", async () => {
  const base = zipFixture();
  const template = await base.file("ppt/slides/slide1.xml").async("string");
  const zip = zipFixture({"ppt/slides/slide1.xml": template.replace("Editable title", "مرحبا بالطلاب")});
  const deck = await build().importFile({name:"arabic.pptx", size:2000, zip});
  assert.equal(deck.slides[0].direction, "rtl");
  assert.equal(deck.slides[0].blocks[0].text, "مرحبا بالطلاب");
});
test("Ctrl/Cmd Shift B toggles the right sidebar and Ctrl/Cmd B toggles the left", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const code = html.match(/<script>\s*\(function\(\)\{([\s\S]*?)<\/script>/)?.[1] || "";
  const start = code.indexOf("function addShortcutHandlers(){");
  const end = code.indexOf("function closeShortcuts()", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  const element = {classList:{contains:()=>false},setAttribute(){},onclick:null};
  const toggled = [];
  const create = new Function("$", "document", "toggleSidebar", "closeShortcuts",
    code.slice(start,end) + "\nreturn addShortcutHandlers;");
  create(()=>element,{addEventListener:(name,fn)=>{if(name==="keydown")handler=fn}},
    side=>toggled.push(side),()=>{})();
  function hit(key, flags = {}) {
    let stopped=false;
    handler({key,metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,
      target:{tagName:"DIV",isContentEditable:false}, preventDefault(){stopped=true},...flags});
    return stopped;
  }
  assert.equal(hit("B",{ctrlKey:true,shiftKey:true}), true);
  assert.equal(hit("b",{metaKey:true,shiftKey:true}), true);
  assert.equal(hit("b",{ctrlKey:true}), true);
  assert.deepEqual(toggled,["design","design","slides"]);
});
