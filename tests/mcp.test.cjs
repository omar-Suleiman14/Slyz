"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/mcp.js");

function makeResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    finished: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.finished = true; return this; },
    end() { this.finished = true; return this; }
  };
  return res;
}

async function rpc(method, params, id = 1) {
  const res = makeResponse();
  await handler({ method: "POST", body: { jsonrpc: "2.0", id, method, params } }, res);
  return res;
}

test("reports endpoint metadata and available tools", async () => {
  const res = makeResponse();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.storage, "stateless");
  assert.deepEqual(res.body.platforms, ["mobile", "web"]);
  assert.equal(res.body.endpoint, "https://slyz.vercel.app/api/mcp");
  assert.equal(res.body.tools.length, 4);
});

test("initializes the MCP protocol", async () => {
  const res = await rpc("initialize", {});
  assert.equal(res.body.result.protocolVersion, "2025-06-18");
  assert.equal(res.body.result.serverInfo.name, "slide-studio-mcp");
});

test("returns all tool schemas", async () => {
  const res = await rpc("tools/list", {});
  assert.deepEqual(res.body.result.tools.map(t => t.name), [
    "create_deck", "append_slide", "update_slide", "list_designs"
  ]);
});

test("creates an Arabic RTL deck and local import URL", async () => {
  const slide = { title: "مرحبا", direction: "rtl", palette: "Violet", layout: "editorial", blocks: [{ type: "h1", text: "أهلا وسهلا" }] };
  const res = await rpc("tools/call", { name: "create_deck", arguments: { slides: [slide] } });
  assert.equal(res.body.result.isError, undefined);
  const structured = res.body.result.structuredContent;
  assert.equal(structured.deck.slides[0].direction, "rtl");
  assert.equal(structured.deck.slides[0].palette, "Violet");
  assert.ok(structured.editor_link.startsWith("https://slyz.vercel.app/#deck="));
  const fragment = structured.editor_link.split("#deck=")[1];
  const decoded = JSON.parse(Buffer.from(fragment, "base64url").toString("utf8"));
  assert.equal(decoded.slides[0].blocks[0].text, "أهلا وسهلا");
});

test("appends and updates slides without session state", async () => {
  const deck = { version: 1, slides: [{ title: "First", blocks: [{ type: "h1", text: "Hello" }] }] };
  const second = { title: "Second", blocks: [{ type: "p", text: "World" }] };
  const append = await rpc("tools/call", { name: "append_slide", arguments: { deck, slide: second } });
  assert.equal(append.body.result.structuredContent.deck.slides.length, 2);
  const replacement = { title: "Updated", blocks: [{ type: "h1", text: "Changed" }] };
  const updated = await rpc("tools/call", { name: "update_slide", arguments: { deck, slide_number: 1, slide: replacement } });
  assert.equal(updated.body.result.structuredContent.deck.slides[0].title, "Updated");
  assert.equal(deck.slides[0].title, "First");
});

test("returns a structured error on invalid input", async () => {
  const res = await rpc("tools/call", { name: "create_deck", arguments: { slides: [] } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /between 1 and 150/i);
});

test("responds to preflight and initialized notification", async () => {
  const options = makeResponse();
  await handler({ method: "OPTIONS" }, options);
  assert.equal(options.statusCode, 204);
  const notification = makeResponse();
  await handler({ method: "POST", body: { jsonrpc: "2.0", method: "notifications/initialized" } }, notification);
  assert.equal(notification.statusCode, 202);
});
