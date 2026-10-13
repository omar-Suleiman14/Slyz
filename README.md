# Slyz — Slide Studio

Live editor: **https://slyz.vercel.app**  
Remote MCP endpoint: **https://slyz.vercel.app/api/mcp**

An English-first, mobile-friendly presentation editor with Notion-style draggable blocks, resizable images, collapsible sidebars, slide design presets, themes, custom colors, keyboard shortcuts, and presentation mode, editable PowerPoint export, and ZIP project import/export with embedded images. It supports RTL and loads **Cairo for Arabic text, including Arabic blocks inside English slides**.

> This is the dedicated Slyz source repository. The current Vercel production project was originally deployed without Git integration. **Do not assume commits deploy automatically until the Vercel Git connection is confirmed.**

## File structure

- `index.html` — complete front-end editor, styling and browser-local persistence. No bundler needed.\n- `slyz-io.js` — browser-side ZIP project import/export and editable PowerPoint generation.
- `slyz-pptx-import.js` — client-side PowerPoint XML importer.
- `api/mcp.js` — Vercel Node.js Function implementing a stateless MCP endpoint over HTTP/JSON-RPC.
- `tests/mcp.test.cjs` — Node built-in tests for MCP tools and protocol behavior.
- `README.md` — setup, architecture and safety notes.

## Run

Requires Node.js 22 or later and the Vercel CLI to run the endpoint locally:

```bash
cd slyz
npx vercel dev
```

Use the local address printed by the Vercel CLI. The static editor can be served through any HTTP static server, but the `/api/mcp` route requires the Vercel runtime or equivalent Node request/response adapter.

Run tests without third-party test dependencies:

```bash
node --check api/mcp.js
node --test tests/mcp.test.cjs
```

## Deployment

1. Connect this repository to a Vercel project (framework preset: **Other**, root: `./`, production branch: `main`).
2. Confirm that `/` serves `index.html` and `/api/mcp` serves the Node MCP function.
3. Keep `slyz.vercel.app` assigned to the currently healthy project until the Git-connected deployment is verified. Do not delete the old production project prematurely.
4. Test Arabic + English slides, mobile drag gestures, ZIP/PPTX export, PPTX/ZIP and legacy JSON import, IndexedDB saving and MCP create/update operations.

The standalone HTML and the API function should remain under one origin to preserve the existing MCP import links. If the origin changes, update the `ORIGIN` constant in `api/mcp.js`.

## Local data and privacy

Presentation data and uploaded images stay in the editor browser's **IndexedDB/localStorage**. The MCP is stateless and cannot read unexported browser-local work. It returns portable JSON and, for smaller decks, a URL fragment containing the deck. **Do not put secrets, medical records, or confidential patient details in MCP calls or generated import links.**

A different subdomain is a different browser storage origin: export a Slyz ZIP project on the old address and import it on the new address. Previously exported JSON files are still accepted as imports.

## Import and export

- **PowerPoint import (.pptx):** Import slide text boxes and JPEG/PNG/WebP pictures as editable positioned Slyz blocks. Slide ordering, approximate text hierarchy, RTL text, and simple solid backgrounds are preserved. Unsupported charts, tables, vector drawings, advanced typography, master layouts, animations, and slide effects are not fully converted; a warning appears if elements are omitted. Import runs locally in your browser.

- **Slyz project (.zip):** The recommended portable backup. Contains `project.json`, a human-readable `manifest.json`, and individual image files in `images/`. Reimport the ZIP directly in Slyz to restore editable slide blocks and images; no upload to a server is involved. ZIPs containing an older MCP-created `deck.json` (version 1) are also accepted; malformed or unsupported versions are rejected.
- **PowerPoint (.pptx):** Generates 16:9 slides client-side with editable text, embedded images, colors and basic layout decorations using PptxGenJS. Some CSS-only effects, exact wrapping, and browser animations will differ from the web editor; the PPTX is editable rather than a screenshot of each slide.
- **Legacy (.json):** Supported for import, including MCP-generated decks. New backups export as ZIP, not JSON. The MCP returns direct `#deck=` links for short decks and gzip `#deckz=` links for larger decks that fit the safe fragment limit. The browser decompresses locally; if compression or the browser is unsupported, save the returned deck JSON and import it using the file picker.
- **Shortcuts:** Ctrl/⌘ + B toggles left slide previews; Ctrl/⌘ + Shift + B toggles the right Design sidebar. Some browsers may reserve these shortcuts.

The ZIP/PPTX exporters lazy-load JSZip and PptxGenJS from pinned CDN versions when requested. Exporting therefore needs an internet connection for the first load; slide content remains on-device. Retest exports on Safari/iOS and PowerPoint before relying on them for a live presentation.

## Typography and languages

- Editor controls: system UI font, English.
- Arabic slide blocks and lists: **Cairo**, loaded using Google Fonts.
- RTL/LTR: per-slide auto/manual direction; auto direction also applies to individual block text.
- Mixed Arabic + English: Arabic-containing blocks are tagged `lang="ar"` and styled with Cairo independently of the slide's overall direction.

## Future refactoring

The current editor is a self-contained single HTML file because it began as a local-only rapid prototype. When further features are needed, extract the canvas/editor/model/drag-and-drop/persistence into maintainable modules before substantially increasing complexity. Add browser-driven mobile tests (not only syntax checks). Avoid breaking the existing IndexedDB storage key during refactors.
