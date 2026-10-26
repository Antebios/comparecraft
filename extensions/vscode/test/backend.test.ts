import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { BackendClient, BackendError, BackendManager, ErrorCode, type BackendOptions } from "../src/backend";
import { discoverBackend, InstallationError } from "../src/discovery";

// A scriptable stand-in for comparecraft-backend; FAKE_MODE selects the misbehaviour under test.
const FAKE = String.raw`
const mode = process.env.FAKE_MODE || "ok";
let buffer = Buffer.alloc(0);
let shutdown = false;
const send = message => {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write("Content-Length: " + body.length + "\r\n\r\n");
  process.stdout.write(body);
};
const methods = mode === "nocap" ? ["path.info"] : ["path.info", "text.load", "text.diff", "text.merge", "test.sleep"];
function handle(m) {
  if (m.method === "initialize") {
    if (mode === "silent") return;
    if (mode === "garbage") { process.stdout.write("Content-Length: nope\r\n\r\n{}"); return; }
    if (mode === "noproto") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32010, message: "no common version", data: { supported: [9] } } });
    return send({ jsonrpc: "2.0", id: m.id, result: {
      protocolVersion: mode === "v2" ? 2 : 1,
      server: { name: "comparecraft-backend", version: "9.9.9" },
      capabilities: { methods },
      limits: { maxMessageBytes: 4096, maxConcurrentRequests: 4, maxQueuedRequests: 64, maxLinesPerSide: 100 }
    } });
  }
  if (m.method === "$/cancelRequest") { process.stderr.write("cancel " + m.params.id + "\n"); return; }
  if (m.method === "exit") process.exit(shutdown ? 0 : 1);
  if (m.method === "shutdown") { shutdown = true; if (mode !== "hang") send({ jsonrpc: "2.0", id: m.id, result: null }); return; }
  if (m.method === "crash") { process.stderr.write("comparecraft-backend: error: boom\n"); process.exit(3); }
  if (m.method === "test.sleep") { setTimeout(() => send({ jsonrpc: "2.0", id: m.id, result: "slept" }), m.params.ms); return; }
  if (m.method === "text.diff") {
    // Split the frame across writes to exercise the client's reassembly.
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { identical: false, echo: m.params } }));
    process.stdout.write("Content-Len");
    setTimeout(() => process.stdout.write("gth: " + body.length + "\r\n\r\n" + body.subarray(0, 5).toString()), 5);
    setTimeout(() => process.stdout.write(body.subarray(5)), 10);
    return;
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown method: " + m.method } });
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    handle(message);
  }
});
process.stdin.on("end", () => process.exit(shutdown ? 0 : 1));
`;

let directory = "";
let script = "";

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "comparecraft-backend-test-"));
  script = path.join(directory, "fake-backend.cjs");
  await writeFile(script, FAKE);
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fake(mode: string, extra: Partial<BackendOptions> = {}): BackendOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    client: { name: "test", version: "0" },
    argsPrefix: [script],
    env: { ...process.env, FAKE_MODE: mode },
    log: line => lines.push(line),
    lines,
    ...extra
  };
}

test("handshake exposes server info and requests round-trip across split frames", async () => {
  const client = await BackendClient.start(process.execPath, fake("ok", { requiredMethods: ["text.diff"] }));
  try {
    assert.equal(client.info.server.version, "9.9.9");
    assert.equal(client.info.protocolVersion, 1);
    const result = await client.request<{ identical: boolean; echo: unknown }>("text.diff", { left: ["é"], right: ["b"] });
    assert.deepEqual(result, { identical: false, echo: { left: ["é"], right: ["b"] } });
    await assert.rejects(client.request("text.load", { path: "x" }), (error: BackendError) => error.code === ErrorCode.methodNotFound);
    await assert.rejects(client.request("missing.method"), /does not support missing\.method/);
  } finally {
    await client.dispose();
  }
  assert.equal(client.alive, false);
  await assert.rejects(client.request("text.diff", {}), /shut down/);
});

test("handshake failures are explicit and never leave a process behind", async () => {
  await assert.rejects(BackendClient.start(process.execPath, fake("v2")), /protocol 2, but this extension needs protocol 1/);
  await assert.rejects(BackendClient.start(process.execPath, fake("noproto")), (error: BackendError) =>
    error.code === ErrorCode.unsupportedProtocol && /does not support protocol 1/.test(error.message));
  await assert.rejects(BackendClient.start(process.execPath, fake("nocap", { requiredMethods: ["text.diff", "text.merge"] })),
    /lacks required features \(text\.diff, text\.merge\)/);
  await assert.rejects(BackendClient.start(process.execPath, fake("silent", { handshakeTimeoutMs: 300 })), /did not answer the handshake within 0\.3 s/);
  await assert.rejects(BackendClient.start(process.execPath, fake("garbage")), /broke the protocol \(missing or invalid Content-Length\)/);
  await assert.rejects(BackendClient.start(path.join(directory, "no-such-backend.exe"), fake("ok")), /Could not start the CompareCraft backend/);
});

test("a crash rejects every pending request with the exit code and recent stderr", async () => {
  const options = fake("ok");
  const client = await BackendClient.start(process.execPath, options);
  const exits: BackendError[] = [];
  client.onExit(error => exits.push(error));
  // test.sleep is a fake-only capability, so reach it through a crash-free request first.
  const slow = client.request("test.sleep", { ms: 5_000 });
  const crash = (client as unknown as { send(method: string, params: unknown): Promise<unknown> }).send("crash", {});
  for (const pending of [slow, crash]) {
    await assert.rejects(pending, (error: BackendError) => /exited unexpectedly \(code 3\)/.test(error.message) && /boom/.test(error.message));
  }
  assert.equal(exits.length, 1);
  assert.equal(client.alive, false);
  await client.dispose();
});

test("cancellation rejects immediately, notifies the helper, and ignores the late answer", async () => {
  const options = fake("ok");
  const client = await BackendClient.start(process.execPath, options);
  try {
    const controller = new AbortController();
    const slow = client.request("test.sleep", { ms: 200 }, controller.signal);
    controller.abort();
    await assert.rejects(slow, (error: BackendError) => error.code === ErrorCode.cancelled);
    assert.equal(await client.request("test.sleep", { ms: 300 }), "slept");
    // id 1 was the initialize request.
    assert.ok(options.lines.includes("cancel 2"), options.lines.join("\n"));
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(client.request("test.sleep", { ms: 0 }, aborted.signal), /cancelled/);
    await assert.rejects(client.request("text.diff", { left: ["x".repeat(5000)], right: [] }), (error: BackendError) => error.code === ErrorCode.tooLarge);
  } finally {
    await client.dispose();
  }
});

test("dispose kills a helper that ignores shutdown", async () => {
  const client = await BackendClient.start(process.execPath, fake("hang"));
  const started = Date.now();
  await client.dispose();
  assert.equal(client.alive, false);
  assert.ok(Date.now() - started < 8_000);
});

test("the manager starts lazily, shares one helper, restarts after a crash, and resets", async () => {
  let resolves = 0;
  const manager = new BackendManager(async () => { resolves++; return process.execPath; }, fake("ok"));
  try {
    assert.equal(resolves, 0);
    const [a, b] = await Promise.all([manager.get(), manager.get()]);
    assert.equal(a, b);
    await assert.rejects((a as unknown as { send(method: string, params: unknown): Promise<unknown> }).send("crash", {}));
    const c = await manager.get();
    assert.notEqual(c, a);
    assert.equal(resolves, 2);
    await manager.reset();
    assert.equal(c.alive, false);
    const d = await manager.get();
    assert.ok(d.alive);
  } finally {
    await manager.dispose();
  }
  const failing = new BackendManager(async () => { throw new InstallationError("not installed"); }, fake("ok"));
  await assert.rejects(failing.get(), InstallationError);
  await assert.rejects(failing.get(), InstallationError);
});

test("backend discovery uses the override or the helper next to the desktop app", async () => {
  const present = new Set(["C:\\Apps\\CompareCraft\\comparecraft.exe", "C:\\Apps\\CompareCraft\\comparecraft-backend.exe", "/usr/bin/comparecraft", "/usr/bin/comparecraft-backend"]);
  const isExecutable = async (value: string) => present.has(value);
  assert.equal(await discoverBackend({ platform: "win32", desktopOverride: "C:\\Apps\\CompareCraft\\comparecraft.exe", isExecutable }),
    "C:\\Apps\\CompareCraft\\comparecraft-backend.exe");
  assert.equal(await discoverBackend({ platform: "linux", home: "/home/u", isExecutable }), "/usr/bin/comparecraft-backend");
  await assert.rejects(discoverBackend({ platform: "win32", override: "comparecraft-backend.exe", isExecutable }), /backendPath must be an absolute path/);
  await assert.rejects(discoverBackend({ platform: "win32", override: "C:\\x\\backend", isExecutable }), /backendPath must point to an \.exe/);
  await assert.rejects(discoverBackend({ platform: "win32", override: "C:\\x\\missing.exe", isExecutable }), /Correct comparecraft\.backendPath; automatic discovery was not used/);
  present.delete("/usr/bin/comparecraft-backend");
  await assert.rejects(discoverBackend({ platform: "linux", home: "/home/u", isExecutable }), (error: Error) =>
    error instanceof InstallationError && /does not include the embedded-mode helper/.test(error.message));
});

const realBackend = process.env.COMPARECRAFT_BACKEND ?? path.resolve(__dirname, "..", "..", "..", "..", "src-tauri", "target", "debug",
  process.platform === "win32" ? "comparecraft-backend.exe" : "comparecraft-backend");

test("the real comparecraft-backend matches the protocol contract", { skip: !existsSync(realBackend) && `build it with cargo build --bin comparecraft-backend (${realBackend})` }, async () => {
  const lines: string[] = [];
  const client = await BackendClient.start(realBackend, {
    client: { name: "test", version: "0" }, requiredMethods: ["path.info", "text.load", "text.diff", "text.merge"], log: line => lines.push(line)
  });
  try {
    assert.equal(client.info.server.name, "comparecraft-backend");
    const file = path.join(directory, "real.txt");
    await writeFile(file, "one\r\ntwo\r\n");
    const loaded = await client.request<{ lines: string[]; eol: string }>("text.load", { path: file });
    assert.deepEqual([loaded.lines, loaded.eol], [["one", "two"], "CRLF"]);
    const diffs = await Promise.all([1, 2, 3, 4, 5, 6].map(n => client.request<{ identical: boolean }>("text.diff", { left: ["a", String(n)], right: ["a", "x"] })));
    assert.deepEqual(diffs.map(d => d.identical), [false, false, false, false, false, false]);
    const merged = await client.request<{ conflicts: number }>("text.merge", { base: ["a"], left: ["b"], right: ["c"] });
    assert.equal(merged.conflicts, 1);
    await assert.rejects(client.request("text.load", { path: "relative.txt" }), (error: BackendError) => error.code === ErrorCode.invalidParams);
    await assert.rejects(client.request("text.load", { path: path.join(directory, "missing.txt") }), (error: BackendError) =>
      error.code === ErrorCode.io && (error.data as { kind: string }).kind === "NotFound");
    await assert.rejects(client.request("text.diff", { left: [], right: [], rules: { ignoreCaes: true } }), (error: BackendError) => error.code === ErrorCode.invalidParams);
  } finally {
    await client.dispose();
  }
  assert.equal(client.alive, false);
});
