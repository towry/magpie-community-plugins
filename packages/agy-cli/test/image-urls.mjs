import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII="
const URL_A = "https://images.example.org/a.png?signature=fake%2Btest&expires=123"
const URL_B = "http://images.example.org/b.jpg?signature=other"
const image = url => ({ type: "image", source: { type: "url", url } })
const viewer = {
  name: "inspect_picture",
  description: "Inspect an image file and answer a visual question as text.",
  input_schema: { type: "object", properties: { file: { type: "string" }, question: { type: "string" } }, required: ["file", "question"] },
}
const request = content => baseBody({ tools: [], messages: [{ role: "user", content }] })

async function withKit(fn, options = {}) {
  const kit = await createBridgeKit(options)
  kit.defaultPrompt = async agent => { await agent.text("received"); return { stopReason: "end_turn" } }
  try { await fn(kit) } finally { await kit.dispose() }
}

test("URL images become unread text in order without downloads; inline images and replay are preserved", async () => {
  let downloads = 0
  globalThis.fetch = async () => { downloads++; throw new Error("unexpected download") }
  await withKit(async kit => {
    const body = request([
      { type: "text", text: "plain-before" },
      image(URL_A),
      { type: "tool_result", tool_use_id: "read_1", content: [
        { type: "text", text: "nested-before" }, image(URL_B), { type: "text", text: "nested-after" },
      ] },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      { type: "text", text: "plain-after" },
    ])
    body.messages.unshift({ role: "user", content: "read both images" }, {
      role: "assistant", content: [{ type: "tool_use", id: "read_1", name: "Read", input: { path: "image.png" } }],
    })
    for (let n = 0; n < 2; n++) {
      const parsed = await readSse(await kit.request(body))
      assert.equal(parsed.error, null)
      const parts = kit.acpLog.filter(x => x.method === "session/prompt").at(-1).params.prompt
      assert.deepEqual(parts.filter(x => x.type === "image").map(x => [x.mimeType, x.data]), [["image/png", PNG]])
      const text = parts.filter(x => x.type === "text").map(x => x.text).join("\n")
      const positions = ["plain-before", URL_A, "nested-before", URL_B, "nested-after", "plain-after"].map(x => text.indexOf(x))
      assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])))
      assert.match(text, /has not been read/)
      assert.match(text, /image-viewing or image-analysis tool/)
      assert.doesNotMatch(text, /view_media|\bobjective\b/)
      assert.match(text, /If no tool can read it, say so/)
      // A later tool-list change must not rewrite image notes in the history.
      body.tools = [viewer]
    }
    assert.equal(downloads, 0)
    assert.equal(body.messages.at(-1).content[1].source.type, "url", "request object remains caller-owned")
  }, { supportsImages: true })
})

for (const sibling of [false, true]) test(`URL images ${sibling ? "beside" : "inside"} tool results continue without ACP image support`, async () => {
  await withKit(async kit => {
    kit.prompts.push(async agent => {
      const result = await agent.tool("Read", { path: "image.png" })
      await agent.text(JSON.stringify(result))
      return { stopReason: "end_turn" }
    })
    const body = baseBody()
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "tool_use")
    const continued = continueWithToolResults(body, first, () => sibling ? "image attached" : [image(URL_A)])
    if (sibling) continued.messages.at(-1).content.push(image(URL_A))
    continued.messages.at(-1).content.push({ type: "text", text: "[Image: original 1200x800, displayed at 600x400.]" })
    const result = await readSse(await kit.request(continued))
    assert.equal(result.error, null)
    assert.equal(result.stopReason, "end_turn")
    const prompt = result.content.filter(x => x.type === "text").map(x => x.text).join("")
    assert.ok(prompt.includes(URL_A))
    assert.match(prompt, /original 1200x800/)
    assert.match(prompt, /has not been read/)
    assert.match(prompt, /as text rather than return another image/)
    assert.doesNotMatch(prompt, /view_media|\bobjective\b/)
    assert.equal(kit.acpSpawns.length, 1, "live tool result stays in the same ACP process")
    assert.equal(kit.acpLog.filter(x => x.method === "session/prompt").length, 1, "image companions are not user steering")
  })
})

test("invalid and credential-bearing URLs are rejected without disclosing their values", async () => {
  await withKit(async kit => {
    for (const url of [null, "not a URL", "file:///etc/passwd", "data:image/png;base64,AAAA", "https://user:fake@images.example.org/a"]) {
      const response = await kit.request(request([image(url)]))
      assert.equal(response.status, 400)
      const error = await response.text()
      if (typeof url === "string") assert.ok(!error.includes(url))
    }
    assert.equal(kit.acpSpawns.length, 0)
  })
})
