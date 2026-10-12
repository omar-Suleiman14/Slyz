(function(root) {
  'use strict';
  // Browser-only, local-first project IO. The ZIP never uploads files to a server.
  const FORMAT = 'slyz-project';
  const VERSION = 1;
  const MAX_ARCHIVE = 180 * 1024 * 1024;
  const MAX_TOTAL_IMAGES = 170 * 1024 * 1024;
  const MAX_IMAGE = 8 * 1024 * 1024;
  const ASSET_PATH = /^images\/[a-z0-9-]+\.(?:jpg|png|webp)$/;
  const MIME = {jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp'};
  const pending = new Map();

  function requireScript(name, url) {
    if (root[name]) return Promise.resolve(root[name]);
    if (!pending.has(name)) {
      pending.set(name, new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => root[name] ? resolve(root[name]) : reject(Error(name + ' did not initialize'));
        script.onerror = () => reject(Error('Could not load ' + name + '. Check your internet connection.'));
        document.head.appendChild(script);
      }).catch(err => { pending.delete(name); throw err; }));
    }
    return pending.get(name);
  }
  const getZip = () => requireScript('JSZip', 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
  const getPptx = () => requireScript('PptxGenJS', 'https://cdn.jsdelivr.net/gh/gitbrent/PptxGenJS@3.12.0/dist/pptxgen.bundle.js');

  function extension(src) {
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(src || '');
    if (!match) throw Error('This presentation has an unsupported or damaged image.');
    return {ext: match[1] === 'jpeg' ? 'jpg' : match[1], base64: match[2]};
  }

  async function exportProject(deck) {
    const JSZip = await getZip();
    const zip = new JSZip();
    const byImage = new Map();
    let imageCount = 0;
    let total = 0;
    const slides = deck.slides.map((slide, si) => ({
      ...slide,
      blocks: (slide.blocks || []).map((block, bi) => {
        if (block.type !== 'image' || !block.src) return {...block};
        let path = byImage.get(block.src);
        if (!path) {
          const {ext, base64} = extension(block.src);
          const length = Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
          if (length > MAX_IMAGE) throw Error('An image exceeds the 8 MB backup limit.');
          total += length;
          if (total > MAX_TOTAL_IMAGES) throw Error('Too many images for one backup. Split the deck into smaller projects.');
          path = 'images/slide-' + (si + 1) + '-block-' + (bi + 1) + '.' + ext;
          byImage.set(block.src, path);
          zip.file(path, base64, {base64: true, binary: true});
          imageCount++;
        }
        const {src, ...rest} = block;
        return {...rest, asset: path};
      })
    }));
    zip.file('project.json', JSON.stringify({
      format: FORMAT, formatVersion: VERSION,
      version: deck.version, exportedAt: new Date().toISOString(), slides
    }));
    zip.file('manifest.json', JSON.stringify({
      application: 'Slyz Slide Studio', format: FORMAT, formatVersion: VERSION,
      exportedAt: new Date().toISOString(), slideCount: slides.length, imageCount
    }, null, 2));
    return zip.generateAsync({type: 'blob', compression: 'DEFLATE', compressionOptions: {level: 5}});
  }

  function verifyAsset(path) {
    if (typeof path !== 'string' || !ASSET_PATH.test(path)) throw Error('Invalid image path in project.');
    return path;
  }

  async function importProject(file) {
    const JSZip = await getZip();
    if (file.size > MAX_ARCHIVE) throw Error('ZIP project exceeds the 180 MB size limit.');
    const zip = await JSZip.loadAsync(file, {checkCRC32: true});
    const dataEntry = zip.file('project.json');
    if (!dataEntry || dataEntry._data?.uncompressedSize > 10 * 1024 * 1024) throw Error('Not a supported Slyz ZIP project.');
    const contents = await dataEntry.async('string');
    if (contents.length > 10 * 1024 * 1024) throw Error('Project data is too large.');
    const project = JSON.parse(contents);
    if (project.format !== FORMAT || project.formatVersion !== VERSION || !Array.isArray(project.slides)) {
      throw Error('Unsupported Slyz project version.');
    }
    if (!project.slides.length || project.slides.length > 150) throw Error('Project must contain 1 to 150 slides.');
    let total = 0;
    const images = new Map();
    for (const slide of project.slides) {
      if (!Array.isArray(slide.blocks) || slide.blocks.length > 45) throw Error('Invalid project block count.');
      for (const block of slide.blocks) {
        if (block.type !== 'image' || !block.asset) continue;
        const path = verifyAsset(block.asset);
        if (!images.has(path)) {
          const entry = zip.file(path);
          if (!entry || entry.dir) throw Error('Missing image: ' + path);
          const size = entry._data?.uncompressedSize;
          if (size != null && (size > MAX_IMAGE || size < 1)) throw Error('Invalid image size: ' + path);
          total += size || 0;
          if (total > MAX_TOTAL_IMAGES) throw Error('Project contains too much image data.');
          const raw = await entry.async('base64');
          if (Math.floor(raw.length * 3 / 4) > MAX_IMAGE + 2) throw Error('Image is too large: ' + path);
          const ext = path.slice(path.lastIndexOf('.') + 1);
          images.set(path, 'data:' + MIME[ext] + ';base64,' + raw);
        }
        block.src = images.get(path);
        delete block.asset;
      }
    }
    return {version: project.version || 1, slides: project.slides};
  }

  async function importFile(file) {
    if (!file) throw Error('Choose a Slyz project.');
    if (/\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
      return importProject(file);
    }
    // Legacy JSON is import-only. Keep old backups and MCP-generated decks usable.
    if (/\.json$/i.test(file.name) || file.type === 'application/json') {
      if (file.size > 35 * 1024 * 1024) throw Error('JSON backup is too large.');
      return JSON.parse(await file.text());
    }
    throw Error('Choose a Slyz .zip project or a legacy .json backup.');
  }

  const COLORS = [
    {name: 'Ocean', accent: '07877C', background: 'FFFFFF', text: '18353B', tint: 'C8EAE2'},
    {name: 'Ink', accent: '68D8B2', background: '112E39', text: 'F8FFFD', tint: 'A1D3DD'},
    {name: 'Violet', accent: '6953DE', background: 'F4F0FF', text: '28204D', tint: 'DFD0FF'},
    {name: 'Sunset', accent: 'F26B4E', background: 'FFF1E8', text: '492E30', tint: 'FFC6AA'},
    {name: 'Cobalt', accent: '2856ED', background: 'EDF3FF', text: '183052', tint: 'A0C5FF'},
    {name: 'Rose', accent: 'D44681', background: 'FFF0F5', text: '4C2541', tint: 'FFD0E7'},
    {name: 'Sand', accent: 'B38440', background: 'F7F0DF', text: '4B392C', tint: 'EFDDDB'},
    {name: 'Midnight', accent: '9BF0BD', background: '181E2B', text: 'FFFFFF', tint: '7184BD'}
  ];
  const WIDTH = 13.333, HEIGHT = 7.5;
  const textSizes = {h1: 43, h2: 28, p: 19, kicker: 11, ul: 18, ol: 18, quote: 27, stat: 59, caption: 12};
  const toHex = c => String(c || '').replace('#', '').toUpperCase();
  const validColor = c => /^[0-9A-F]{6}$/.test(c);
  const limit = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const arabic = value => /[\u0600-\u06ff]/.test(value || '');
  function paletteFor(s) {
    const p = COLORS.find(c => c.name === s.palette) || COLORS[0];
    const colors = {...p};
    for (const key of ['accent', 'background', 'text']) {
      const custom = toHex(s.colors?.[key]);
      if (validColor(custom)) colors[key] = custom;
    }
    return colors;
  }
  function isRtl(s) {
    if (s.direction === 'rtl') return true;
    if (s.direction === 'ltr') return false;
    return arabic((s.blocks.find(b => b.type === 'h1' && b.text)?.text ||
      s.blocks.find(b => b.type !== 'image' && b.text)?.text || '').slice(0, 60));
  }
  function addDecor(pptx, page, s, c, rtl) {
    const shape = pptx.ShapeType;
    if (s.layout === 'split') page.addShape(shape.rect, {
      x: rtl ? 0 : WIDTH * 0.63, y: 0, w: WIDTH * 0.37, h: HEIGHT,
      line: {color: c.accent, transparency: 100},
      fill: {color: c.accent, transparency: 84}
    });
    if (s.layout === 'frame') page.addShape(shape.rect, {
      x: 0.37, y: 0.36, w: WIDTH - 0.74, h: HEIGHT - 0.72,
      line: {color: c.accent, width: 1.5, transparency: 38},
      fill: {color: c.background, transparency: 100}
    });
    if (s.layout === 'editorial') page.addShape(shape.line, {
      x: rtl ? WIDTH - 1.12 : 1.12, y: 1.15, w: 0, h: HEIGHT - 2.25,
      line: {color: c.accent, width: 4}
    });
    if (s.layout === 'spotlight') page.addShape(shape.ellipse, {
      x: rtl ? -2 : 8.1, y: 4.05, w: 6.8, h: 6.8,
      line: {color: c.accent, width: 28, transparency: 78},
      fill: {color: c.background, transparency: 100}
    });
    if (s.layout === 'gradient') page.addShape(shape.rect, {
      x: 0, y: 0, w: WIDTH, h: HEIGHT,
      line: {color: c.tint, transparency: 100},
      fill: {color: c.tint, transparency: 24}
    });
  }
  function positionOf(b, x, y, w, h) {
    if (!b.position) return {x, y, w, h};
    const p = b.position;
    const bx = limit((Number(p.x) || 0) / 100 * WIDTH, 0, WIDTH - .12);
    const by = limit((Number(p.y) || 0) / 100 * HEIGHT, 0, HEIGHT - .12);
    const bw = limit((Number(p.w) || 34) / 100 * WIDTH, .2, WIDTH - bx);
    const bh = limit((Number(p.h) || (b.type === 'image' ? 25 : 16)) / 100 * HEIGHT, .2, HEIGHT - by);
    return {x: bx, y: by, w: bw, h: bh};
  }
  function estimateText(b, w, fontSize) {
    const lines = String(b.text || '').split('\n');
    const maxChars = Math.max(9, Math.floor(w * 105 / (fontSize * .58)));
    const count = lines.reduce((n, line) => n + Math.max(1, Math.ceil(line.length / maxChars)), 0);
    return limit(count * fontSize / 72 * 1.45 + .11, .28, 5.8);
  }
  function addBlock(page, b, loc, c, rtl, center) {
    if (b.type === 'image') {
      if (b.src) page.addImage({data: b.src, x: loc.x, y: loc.y, w: loc.w, h: loc.h,
        sizing: {type: 'contain', w: loc.w, h: loc.h}, altText: b.text || 'Slide image'});
      return;
    }
    const text = String(b.text || '');
    if (!text.trim()) return;
    const fontSize = textSizes[b.type] || 19;
    const isArabic = arabic(text);
    const textColor = ['kicker', 'stat'].includes(b.type) ? c.accent : c.text;
    const effectiveText = b.type === 'ul' ? text.split('\n').filter(Boolean).map(x => '•  ' + x).join('\n')
      : b.type === 'ol' ? text.split('\n').filter(Boolean).map((x, i) => (i + 1) + '.  ' + x).join('\n') : text;
    page.addText(effectiveText, {
      ...loc, fontFace: isArabic ? 'Cairo' : 'Aptos',
      fontSize, color: textColor,
      bold: ['h1', 'h2', 'kicker', 'stat'].includes(b.type),
      rtlMode: isArabic || rtl, align: center ? 'center' : rtl ? 'right' : 'left',
      margin: 0, breakLine: false, valign: 'mid', fit: 'shrink',
      lineSpacingMultiple: b.type === 'p' ? 1.22 : 1.06,
      isTextBox: true
    });
  }

  async function exportPowerPoint(deck) {
    const PptxGenJS = await getPptx();
    const pptx = new PptxGenJS();
    pptx.defineLayout({name: 'SLYZ_WIDE', width: WIDTH, height: HEIGHT});
    pptx.layout = 'SLYZ_WIDE';
    pptx.author = 'Slyz Slide Studio';
    pptx.subject = 'Slyz presentation';
    pptx.title = deck.slides[0]?.title || 'Presentation';
    pptx.lang = 'en-US';
    pptx.theme = {headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'en-US'};
    for (const s of deck.slides) {
      const page = pptx.addSlide();
      const c = paletteFor(s), rtl = isRtl(s);
      page.background = {color: s.layout === 'gradient' ? c.tint : c.background};
      addDecor(pptx, page, s, c, rtl);
      const center = s.align === 'center';
      const x = (rtl ? .94 : s.layout === 'editorial' ? 1.42 : .98);
      const w = s.layout === 'split' ? 8.55 : s.layout === 'editorial' ? 10.5 : 11.32;
      let y = 1.15;
      for (const b of (s.blocks || [])) {
        const fontSize = textSizes[b.type] || 19;
        const bh = b.type === 'image' ? 2.35 : estimateText(b, w, fontSize);
        const bw = b.type === 'image' ? Math.min(w, 7.8) : w;
        const bx = b.type === 'image' && center ? (WIDTH - bw) / 2 : rtl ? WIDTH - x - bw : x;
        const place = positionOf(b, bx, y, bw, bh);
        addBlock(page, b, place, c, rtl, center);
        if (!b.position) y += bh + (b.type === 'kicker' ? .12 : .16);
      }
    }
    return pptx.write({outputType: 'blob', compression: true});
  }

  root.SlyzIO = Object.freeze({exportProject, importFile, exportPowerPoint});
})(window);
