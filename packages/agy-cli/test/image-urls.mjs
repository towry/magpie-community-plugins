import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=", "base64")
const URL_A = "https://storage.googleapis.com/image-test/a.png?signature=fake%2Btest&expires=123"
const image = url => ({ type: "image", source: { type: "url", url } })
const request = content => baseBody({ tools: [], messages: [{ role: "user", content }] })

async function withKit(fn) {
  const kit = await createBridgeKit({ supportsImages: true })
  kit.defaultPrompt = async agent => { await agent.text("image received"); return { stopReason: "end_turn" } }
  try { await fn(kit) } finally { await kit.dispose() }
}

test("URL images reach ACP as bytes in order, including tool results and replayed history", async () => {
  const downloads = []
  globalThis.fetch = async (url, options) => {
    downloads.push(url)
    assert.equal(options.redirect, "manual")
    assert.equal(options.credentials, "omit")
    assert.equal(options.headers, undefined)
    return new Response(PNG, { headers: { "content-type": "application/octet-stream" } })
  }
  await withKit(async kit => {
    const content = [
      { type: "text", text: "plain-before" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
      { type: "tool_result", tool_use_id: "read_1", content: [
        { type: "text", text: "nested-before" }, image(URL_A), { type: "text", text: "nested-after" },
      ] },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } },
      { type: "text", text: "plain-after" },
    ]
    const body = request(content)
    // A stale tool result is replayed through the actual request -> ACP boundary.
    body.messages.unshift({ role: "user", content: "read the image" }, {
      role: "assistant", content: [{ type: "tool_use", id: "read_1", name: "Read", input: { path: "image.png" } }],
    })
    for (let n = 0; n < 2; n++) {
      const parsed = await readSse(await kit.request(body))
      assert.equal(parsed.error, null)
      const parts = kit.acpLog.filter(x => x.method === "session/prompt").at(-1).params.prompt
      const images = parts.filter(x => x.type === "image")
      assert.deepEqual(images.map(x => [x.mimeType, x.data]), [
        ["image/png", PNG.toString("base64")], ["image/png", PNG.toString("base64")], ["image/jpeg", "/9j/"],
      ])
      const positions = ["plain-before", "nested-before", "nested-after", "plain-after"].map(text =>
        parts.findIndex(x => x.type === "text" && x.text.includes(text)))
      assert.ok(positions.every(x => x >= 0))
      assert.ok(positions[0] < positions[1] && positions[1] < positions[2] && positions[2] < positions[3])
      assert.ok(!JSON.stringify(parts).includes("signature="))
      // Next request also exercises a top-level URL, reusing the same bytes.
      body.messages.at(-1).content[1] = image(URL_A)
    }
    assert.deepEqual(downloads, [URL_A])
    assert.equal(body.messages.at(-1).content[1].source.type, "url", "request object remains caller-owned")
  })
})

test("URL policy rejects private hosts, credential URLs and unsafe redirects without leaking URLs", async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/private?secret=fake" } })
  }
  await withKit(async kit => {
    for (const url of ["http://storage.googleapis.com/a", "https://127.0.0.1/a", "https://[::1]/a",
      "https://storage.googleapis.com.evil.test/a", "https://user:fake@storage.googleapis.com/a", "https://storage.googleapis.com:8443/a"]) {
      const response = await kit.request(request([image(url)]))
      assert.equal(response.status, 400)
      assert.ok(!(await response.text()).includes(url))
    }
    assert.equal(calls, 0)
    const response = await kit.request(request([image(URL_A)]))
    assert.equal(response.status, 400)
    assert.ok(!(await response.text()).includes("secret="))
    assert.equal(calls, 1)
    assert.equal(kit.acpSpawns.length, 0)
  })
})

test("URL downloads reject oversized, non-image, expired and failed responses; failures are not cached", async () => {
  const fixtures = [
    () => new Response("<html>login</html>", { headers: { "content-type": "image/png" } }),
    () => new Response(PNG, { headers: { "content-length": "4900001" } }),
    () => new Response(new Uint8Array(4_900_001)),
    () => new Response("denied", { status: 403 }),
    () => { throw new Error(`network error ${URL_A}`) },
    () => new Response(PNG),
  ]
  let calls = 0
  globalThis.fetch = async () => fixtures[calls++]()
  await withKit(async kit => {
    for (let i = 0; i < fixtures.length - 1; i++) {
      const response = await kit.request(request([image(URL_A)]))
      assert.equal(response.status, 400)
      const error = await response.text()
      assert.ok(!error.includes("signature=") && !error.includes(URL_A))
    }
    assert.equal((await readSse(await kit.request(request([image(URL_A)])))).error, null)
    assert.equal(calls, fixtures.length)
  })
})

test("one trusted redirect preserves the signed destination; caller cancellation reaches the downloader", async () => {
  const destination = "https://bucket.s3.us-east-1.amazonaws.com/a.png?signature=fake%2Fquery"
  let calls = 0
  const controller = new AbortController()
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(options.signal.aborted, false)
    if (calls === 1) return new Response(null, { status: 302, headers: { location: destination } })
    if (calls === 2) { assert.equal(url, destination); return new Response(PNG) }
    controller.abort()
    assert.equal(options.signal.aborted, true)
    throw new Error(`aborted ${url}`)
  }
  await withKit(async kit => {
    assert.equal((await readSse(await kit.request(request([image(URL_A)])))).error, null)
    const response = await kit.request(request([image(URL_A + "&new=1")]), { signal: controller.signal })
    assert.equal(response.status, 400)
    assert.ok(!(await response.text()).includes("signature="))
    assert.equal(calls, 3)
  })
})
