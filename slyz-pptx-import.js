(function(root) {
  "use strict";

  // PowerPoint OOXML importer: deliberately best-effort. Native text/image
  // shapes remain editable; unsupported effects/charts are not rasterized.
  const NS = {
    p: "http://schemas.openxmlformats.org/presentationml/2006/main",
    a: "http://schemas.openxmlformats.org/drawingml/2006/main",
    r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  };
  const MAX_FILE = 180 * 1024 * 1024;
  const MAX_XML = 8 * 1024 * 1024;
  const MAX_DECOMPRESSED = 240 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
  const MAX_TOTAL_IMAGE_BYTES = 170 * 1024 * 1024;
  const MIME = {jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp"};
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const children = (n, tag) => Array.from(n?.childNodes || []).filter(x => x.nodeType === 1 && (!tag || x.localName === tag));
  const child = (n, name) => children(n, name)[0] || null;
  const descendants = (n, tag) => Array.from(n?.getElementsByTagNameNS("*", tag) || []);
  const attr = (n, name) => n?.getAttribute?.(name) || "";
  const relAttr = (n, key) => n?.getAttributeNS?.(NS.r, key) || attr(n, "r:" + key);
  const number = (n, key, fallback = 0) => {
    const v = Number.parseInt(attr(n, key), 10);
    return Number.isFinite(v) ? v : fallback;
  };
  const pt = (v, defaultPt = 18) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n / 100 : defaultPt;
  };

  function resolvePath(source, target) {
    if (!target || /^(?:[a-z]+:|\/\/)/i.test(target) || target.includes("?") || target.includes("#")) return null;
    const names = (target[0] === "/" ? [] : source.split("/").slice(0, -1));
    for (const name of target.replace(/\\/g, "/").split("/")) {
      if (name === "" || name === ".") continue;
      if (name === "..") { if (!names.length) return null; names.pop(); }
      else names.push(name);
    }
    return names.join("/");
  }

  function relationshipFile(path) {
    const bits = path.split("/");
    return bits.slice(0, -1).concat(["_rels", bits[bits.length - 1] + ".rels"]).join("/");
  }

  function decodeXML(xml) {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error("PowerPoint contains unsupported XML entities.");
    if (typeof root.DOMParser !== "function") throw Error("XML import is not supported by this browser.");
    const doc = new root.DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length || !doc.documentElement) {
      throw Error("PowerPoint contains malformed XML.");
    }
    return doc;
  }

  async function loadXML(zip, path, required = false) {
    const entry = zip.file(path);
    if (!entry) { if (required) throw Error("PowerPoint is missing " + path); return null; }
    if (entry.dir || entry._data?.uncompressedSize > MAX_XML) throw Error("PowerPoint XML part is too large.");
    const xml = await entry.async("string");
    if (xml.length > MAX_XML) throw Error("PowerPoint XML part is too large.");
    return decodeXML(xml);
  }

  async function relationships(zip, path) {
    const doc = await loadXML(zip, relationshipFile(path));
    const map = new Map();
    if (!doc) return map;
    for (const rel of descendants(doc, "Relationship")) {
      if (attr(rel, "TargetMode").toLowerCase() === "external") continue;
      const resolved = resolvePath(path, attr(rel, "Target"));
      if (resolved) map.set(attr(rel, "Id"), {path: resolved, type: attr(rel, "Type")});
    }
    return map;
  }

  function xfrm(n) {
    if (!n) return null;
    const off = child(n, "off"), ext = child(n, "ext");
    if (!off || !ext) return null;
    return {x: number(off, "x"), y: number(off, "y"), w: number(ext, "cx"), h: number(ext, "cy")};
  }

  function shapeRect(node, transform) {
    const element = node.localName === "graphicFrame" ? child(node, "xfrm") : child(child(node, "spPr"), "xfrm");
    const local = xfrm(element);
    if (!local || local.w <= 0 || local.h <= 0) return null;
    return {
      x: transform.x + local.x * transform.sx, y: transform.y + local.y * transform.sy,
      w: local.w * transform.sx, h: local.h * transform.sy
    };
  }

  function nestedGroupTransform(node, parent) {
    const xf = child(child(node, "grpSpPr"), "xfrm");
    if (!xf) return parent;
    const off = child(xf, "off"), ext = child(xf, "ext");
    const cOff = child(xf, "chOff"), cExt = child(xf, "chExt");
    if (!off || !ext || !cOff || !cExt) return parent;
    const cx = number(cExt, "cx"), cy = number(cExt, "cy");
    if (cx <= 0 || cy <= 0) return parent;
    const sx = number(ext, "cx") / cx, sy = number(ext, "cy") / cy;
    return {
      sx: parent.sx * sx, sy: parent.sy * sy,
      x: parent.x + parent.sx * (number(off, "x") - number(cOff, "x") * sx),
      y: parent.y + parent.sy * (number(off, "y") - number(cOff, "y") * sy)
    };
  }

  function percentage(rect, sw, sh) {
    // Floating blocks are the closest Slyz equivalent to PPTX absolute layout.
    const x = clamp(rect.x / sw * 100, 0, 86);
    const y = clamp(rect.y / sh * 100, 0, 91);
    const w = clamp(rect.w / sw * 100, 12, 100 - x);
    const h = clamp(rect.h / sh * 100, 8, 100 - y);
    return {x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100,
      w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100};
  }

  function textOf(shape) {
    const body = child(shape, "txBody");
    if (!body) return null;
    const paragraphs = children(body, "p");
    if (!paragraphs.length) return null;
    const lines = [];
    let bullets = 0, numbers = 0, fontSize = 0, rtl = false;
    for (const para of paragraphs) {
      let line = "";
      // Only text runs inside this paragraph, not all descendant shapes.
      for (const element of children(para)) {
        if (element.localName === "r" || element.localName === "fld") {
          const t = child(element, "t");
          if (t) line += t.textContent || "";
          const rPr = child(element, "rPr");
          if (rPr) fontSize = Math.max(fontSize, pt(attr(rPr, "sz"), 0));
        } else if (element.localName === "br") line += "\n";
        else if (element.localName === "endParaRPr") fontSize = Math.max(fontSize, pt(attr(element, "sz"), 0));
      }
      const pPr = child(para, "pPr");
      if (child(pPr, "buChar")) bullets++;
      else if (child(pPr, "buAutoNum")) numbers++;
      if (attr(pPr, "rtl") === "1") rtl = true;
      lines.push(line);
    }
    const text = lines.join("\n").trim().slice(0, 8000);
    if (!text) return null;
    const size = fontSize || 18;
    let type = "p";
    if (bullets && bullets === paragraphs.length) type = "ul";
    else if (numbers && numbers === paragraphs.length) type = "ol";
    else if (size >= 34) type = "h1";
    else if (size >= 25) type = "h2";
    else if (size <= 12) type = "caption";
    return {type, text, rtl};
  }

  function slideBackground(doc) {
    const bg = descendants(doc, "bgPr")[0];
    const color = bg ? descendants(bg, "srgbClr")[0] : null;
    const hex = attr(color, "val");
    return /^[0-9a-f]{6}$/i.test(hex) ? "#" + hex : null;
  }

  async function pptxImport(file, JSZip) {
    if (!file || (Number.isFinite(file.size) && file.size > MAX_FILE)) throw Error("PowerPoint exceeds 180 MB.");
    const zip = await JSZip.loadAsync(file, {checkCRC32: true});
    const entries = Object.entries(zip.files || {});
    if (entries.length > 5000) throw Error("PowerPoint contains too many files.");
    let uncompressed = 0;
    for (const [, entry] of entries) {
      if (entry.dir) continue;
      uncompressed += entry._data?.uncompressedSize || 0;
      if (uncompressed > MAX_DECOMPRESSED) throw Error("PowerPoint contents are too large.");
    }
    const presentation = await loadXML(zip, "ppt/presentation.xml", true);
    const sldSz = descendants(presentation, "sldSz")[0];
    const sw = number(sldSz, "cx", 12192000), sh = number(sldSz, "cy", 6858000);
    if (sw <= 0 || sh <= 0) throw Error("PowerPoint has invalid slide dimensions.");
    const presRels = await relationships(zip, "ppt/presentation.xml");
    const slideIds = descendants(presentation, "sldId");
    const slidePaths = slideIds.map(id => presRels.get(relAttr(id, "id"))?.path).filter(Boolean);
    if (!slidePaths.length) throw Error("PowerPoint contains no slides.");
    if (slidePaths.length > 150) throw Error("Slyz supports at most 150 slides.");

    const stats = {unsupported: 0, skippedImages: 0, clipped: 0};
    const imageCache = new Map();
    let imageBytes = 0;
    const slides = [];
    for (let index = 0; index < slidePaths.length; index++) {
      const path = slidePaths[index];
      const slideDoc = await loadXML(zip, path, true);
      const mediaRels = await relationships(zip, path);
      const spTree = descendants(slideDoc, "spTree")[0];
      if (!spTree) throw Error("PowerPoint slide " + (index + 1) + " has no content tree.");
      const blocks = [];
      let rtl = false;
      const imageFor = async target => {
        if (imageCache.has(target)) return imageCache.get(target);
        const ext = target.split(".").pop().toLowerCase();
        const entry = zip.file(target);
        if (!MIME[ext] || !entry || entry.dir) { stats.skippedImages++; return null; }
        const size = entry._data?.uncompressedSize;
        if (size > MAX_IMAGE_BYTES || imageBytes + (size || 0) > MAX_TOTAL_IMAGE_BYTES) {
          stats.skippedImages++; return null;
        }
        const b64 = await entry.async("base64");
        if (b64.length > 8_450_000) { stats.skippedImages++; return null; }
        imageBytes += size || Math.floor(b64.length * 3 / 4);
        const src = "data:" + MIME[ext] + ";base64," + b64;
        imageCache.set(target, src);
        return src;
      };
      async function visit(tree, transform) {
        for (const node of children(tree)) {
          if (node.localName === "grpSp") {
            await visit(node, nestedGroupTransform(node, transform));
            continue;
          }
          if (node.localName === "sp") {
            const data = textOf(node);
            if (!data) { stats.unsupported++; continue; }
            const rect = shapeRect(node, transform);
            if (!rect) continue;
            rtl = rtl || data.rtl || /[\u0600-\u06ff]/.test(data.text);
            blocks.push({type: data.type, text: data.text, position: percentage(rect, sw, sh)});
            continue;
          }
          if (node.localName === "pic") {
            const rect = shapeRect(node, transform);
            const blip = descendants(node, "blip")[0];
            const target = mediaRels.get(relAttr(blip, "embed"))?.path;
            if (!rect || !target) {stats.skippedImages++; continue;}
            const src = await imageFor(target);
            if (src) blocks.push({type: "image", text: "", src, position: percentage(rect, sw, sh)});
            continue;
          }
          if (["graphicFrame", "cxnSp", "contentPart"].includes(node.localName)) stats.unsupported++;
        }
      }
      await visit(spTree, {x: 0, y: 0, sx: 1, sy: 1});
      if (blocks.length > 45) { stats.clipped += blocks.length - 45; blocks.length = 45; }
      const titleBlock = blocks.find(b => b.type === "h1") || blocks.find(b => b.type !== "image");
      const title = (titleBlock?.text || "Slide " + (index + 1)).split("\n")[0].slice(0, 110);
      const background = slideBackground(slideDoc);
      slides.push({
        title, theme: "light", palette: "Ocean", align: "start",
        direction: rtl ? "rtl" : "ltr", layout: "minimal",
        ...(background ? {colors: {background}} : {}),
        blocks: blocks.length ? blocks : [{type: "p", text: "", position: {x: 10, y: 15, w: 80, h: 15}}]
      });
    }
    const warnings = [];
    if (stats.skippedImages) warnings.push(stats.skippedImages + " unsupported or oversized image(s) were skipped");
    if (stats.unsupported) warnings.push("Some diagrams, shapes, charts, tables or other unsupported items were omitted");
    if (stats.clipped) warnings.push(stats.clipped + " block(s) exceeded Slyz slide limits");
    return {version: 1, slides, importWarnings: warnings};
  }

  root.SlyzPptxImport = pptxImport;
})(window);
