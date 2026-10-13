"use strict";
/**
 * Slide Studio remote MCP endpoint.
 *
 * Stateless JSON-RPC over Streamable HTTP for ChatGPT and compatible clients.
 * It never reads IndexedDB, browser images, user devices or any clinic data.
 * The returned import URL carries only explicitly supplied slide text.
 */
const { Buffer } = require("node:buffer");
const { gzipSync } = require("node:zlib");

const ORIGIN = "https://slyz.vercel.app/";
const VERSION = "1.1.0";
const MAX_SLIDES = 150;
const MAX_BLOCKS = 45;
const MAX_TEXT = 8000;
const MAX_PAYLOAD = 500000;
const LAYOUTS = ["minimal", "editorial", "spotlight", "split", "frame", "gradient", "gallery", "quote"];
const PALETTES = ["Ocean", "Ink", "Violet", "Sunset", "Cobalt", "Rose", "Sand", "Midnight"];
const THEMES = ["light", "mint", "dark", "black"];
const DIRECTIONS = ["auto", "ltr", "rtl"];
const BLOCKS = ["h1", "h2", "p", "kicker", "ul", "ol", "quote", "stat", "caption"];
const HEX = /^#[0-9A-Fa-f]{6}$/;

const slideSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Slide name used in the navigator." },
    layout: { type: "string", enum: LAYOUTS },
    palette: { type: "string", enum: PALETTES },
    theme: { type: "string", enum: THEMES },
    direction: { type: "string", enum: DIRECTIONS },
    align: { type: "string", enum: ["start", "center"] },
    colors: {
      type: "object",
      properties: {
        accent: { type: "string", description: "Hex color such as #4f6b7b." },
        background: { type: "string" },
        text: { type: "string" }
      }
    },
    blocks: {
      type: "array",
      maxItems: MAX_BLOCKS,
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: BLOCKS },
          text: { type: "string", maxLength: MAX_TEXT }
        },
        required: ["type", "text"]
      }
    }
  },
  required: ["title", "blocks"]
};

const TOOLS = [
  {
    name: "create_deck",
    description: "Create an editable slide presentation in English, Arabic or both. Choose layouts, themes, colors and RTL. Return a mobile/web import link, gzip-compressed for larger decks when possible, without cloud storage.",
    inputSchema: {
      type: "object",
      properties: { slides: { type: "array", minItems: 1, maxItems: MAX_SLIDES, items: slideSchema } },
      required: ["slides"]
    }
  },
  {
    name: "append_slide",
    description: "Append a slide to the explicitly provided deck and return updated JSON plus a browser-local editor import link. No stored session.",
    inputSchema: {
      type: "object",
      properties: { deck: { type: "object" }, slide: slideSchema },
      required: ["deck", "slide"]
    }
  },
  {
    name: "update_slide",
    description: "Replace a numbered slide in an explicitly provided deck. Index is one-based; returns a new import link.",
    inputSchema: {
      type: "object",
      properties: { deck: { type: "object" }, slide_number: { type: "integer", minimum: 1 }, slide: slideSchema },
      required: ["deck", "slide_number", "slide"]
    }
  },
  {
    name: "list_designs",
    description: "List supported slide layouts, palettes, themes, block types and text directions.",
    inputSchema: { type: "object", properties: {} }
  }
];

function validateSlides(slides) {
  if (!Array.isArray(slides) || slides.length < 1 || slides.length > MAX_SLIDES) {
    throw Error("Provide between 1 and 150 slides.");
  }
  return slides.map((slide, index) => {
    if (!slide || typeof slide !== "object" || !Array.isArray(slide.blocks) || slide.blocks.length > MAX_BLOCKS) {
      throw Error("Invalid slide " + (index + 1));
    }
    const blocks = slide.blocks.map((block) => {
      if (!block || !BLOCKS.includes(block.type) || typeof block.text !== "string" || block.text.length > MAX_TEXT) {
        throw Error("Invalid text block in slide " + (index + 1));
      }
      return { type: block.type, text: block.text };
    });
    const colors = {};
    for (const key of ["accent", "background", "text"]) {
      if (slide.colors?.[key] !== undefined) {
        if (typeof slide.colors[key] !== "string" || !HEX.test(slide.colors[key])) {
          throw Error("Invalid " + key + " hex color in slide " + (index + 1));
        }
        colors[key] = slide.colors[key];
      }
    }
    return {
      title: String(slide.title || "Untitled slide").slice(0, 110),
      layout: LAYOUTS.includes(slide.layout) ? slide.layout : "minimal",
      palette: PALETTES.includes(slide.palette) ? slide.palette : "Ocean",
      theme: THEMES.includes(slide.theme) ? slide.theme : "light",
      direction: DIRECTIONS.includes(slide.direction) ? slide.direction : "auto",
      align: slide.align === "center" ? "center" : "start",
      ...(Object.keys(colors).length ? { colors } : {}),
      blocks
    };
  });
}

function deckResult(slides) {
  const deck = { version: 1, slides: validateSlides(slides) };
  const deck_json = JSON.stringify(deck);
  // Most real decks exceed a safe mobile URL when encoded as raw JSON.
  // Keep the backwards-compatible #deck= fragment for small decks.
  // For larger decks use gzip + base64url; no deck is uploaded or stored.
  const rawLink = ORIGIN + "#deck=" + Buffer.from(deck_json, "utf8").toString("base64url");
  const compressedLink = ORIGIN + "#deckz=" + gzipSync(Buffer.from(deck_json, "utf8")).toString("base64url");
  const link = rawLink.length < 16000 ? rawLink : compressedLink;
  const output = {
    slide_count: deck.slides.length,
    editor_link: link.length < 16000 ? link : null,
    import_instructions: link.length < 16000
      ? "Open the link on your phone or web browser and approve the import into local browser storage."
      : "Import link exceeds safe URL length even after compression. Save deck_json as a .json file and import it in Slide Studio.",
    deck_json,
    deck,
    privacy_note: "This MCP stores no decks. Import links include slide text. Avoid patient data, passwords and other confidential information. Browser-local edits remain private unless explicitly exported."
  };
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output
  };
}

function callTool(name, args) {
  if (name === "list_designs") {
    const result = {
      layouts: LAYOUTS,
      palettes: PALETTES,
      themes: THEMES,
      directions: DIRECTIONS,
      blocks: BLOCKS,
      editor_url: ORIGIN
    };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  }
  if (name === "create_deck") return deckResult(args.slides);
  if (name === "append_slide" || name === "update_slide") {
    const slides = validateSlides(args.deck?.slides);
    if (name === "append_slide") {
      if (slides.length >= MAX_SLIDES) throw Error("Slide limit reached.");
      slides.push(validateSlides([args.slide])[0]);
    } else {
      if (!Number.isInteger(args.slide_number) || args.slide_number < 1 || args.slide_number > slides.length) {
        throw Error("Invalid slide_number.");
      }
      slides[args.slide_number - 1] = validateSlides([args.slide])[0];
    }
    return deckResult(slides);
  }
  throw Error("Unknown tool.");
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") {
    return res.status(200).json({
      name: "Slide Studio MCP",
      protocol: "2025-06-18",
      version: VERSION,
      endpoint: ORIGIN + "api/mcp",
      tools: TOOLS.map((tool) => tool.name),
      storage: "stateless",
      platforms: ["mobile", "web"]
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let message = req.body;
  if (typeof message === "string") {
    try { message = JSON.parse(message); } catch (_) { /* respond below */ }
  }
  if (!message || typeof message !== "object" || Array.isArray(message) || JSON.stringify(message).length > MAX_PAYLOAD) {
    return res.status(400).json(jsonRpcError(null, -32600, "Invalid JSON-RPC request."));
  }
  if (message.method === "notifications/initialized") return res.status(202).end();

  const id = message.id ?? null;
  try {
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "slide-studio-mcp", version: VERSION }
      };
    } else if (message.method === "ping") {
      result = {};
    } else if (message.method === "tools/list") {
      result = { tools: TOOLS };
    } else if (message.method === "tools/call") {
      result = callTool(message.params?.name, message.params?.arguments || {});
    } else {
      return res.status(200).json(jsonRpcError(id, -32601, "Method not found."));
    }
    return res.status(200).json({ jsonrpc: "2.0", id, result });
  } catch (error) {
    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      result: { isError: true, content: [{ type: "text", text: error?.message || "Tool error." }] }
    });
  }
};
