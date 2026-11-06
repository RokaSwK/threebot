import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function load(path) {
  const bundle = await buildOnce({ configFile: false, logLevel: "silent", build: { ssr: new URL(path, import.meta.url).pathname, write: false }, ssr: { noExternal: true } });
  const directory = await mkdtemp(join(tmpdir(), "bot-t3-speech-"));
  try {
    const file = join(directory, "module.mjs");
    await writeFile(file, entryChunk(bundle).code);
    return await import(pathToFileURL(file).href);
  } finally { await rm(directory, { recursive: true }); }
}
const { appendDictation, clampPcm, dictationEngine, encodeTranscription, speechLanguage, speechProblem, transcribe, transcriptionError } = await load("../src/lib/t3Speech.ts");

test("T3 Code dictates only when it can, and when chosen or the browser can't", () => {
  assert.equal(dictationEngine({ browser: true, t3: false, preferT3: true }), "browser", "an older T3 keeps today's behaviour");
  assert.equal(dictationEngine({ browser: true, t3: true, preferT3: false }), "browser");
  assert.equal(dictationEngine({ browser: true, t3: true, preferT3: true }), "t3");
  assert.equal(dictationEngine({ browser: false, t3: true, preferT3: false }), "t3", "the fallback when the browser has no Web Speech");
  assert.equal(dictationEngine({ browser: false, t3: false, preferT3: true }), null);
});

test("the voice language becomes the base language T3's models list", () => {
  assert.equal(speechLanguage("es-ES"), "es");
  assert.equal(speechLanguage("pt_BR"), "pt");
  assert.equal(speechLanguage("yue-HK"), "yue");
  assert.equal(speechLanguage(""), "auto");
});

test("dictated text joins the draft with the language's word spacing", () => {
  assert.equal(appendDictation("", "Hello", "en-US"), "Hello");
  assert.equal(appendDictation("Note:  ", "hello", "en-US"), "Note: hello");
  assert.equal(appendDictation("修正", "テスト", "ja-JP"), "修正テスト");
  assert.equal(appendDictation("코드를", "검토해", "ko-KR"), "코드를 검토해");
});

test("a server that can't take the recording says what to fix", () => {
  assert.match(speechProblem({ supported: false, reason: "unsupported platform" }, "en"), /unsupported platform/);
  assert.match(speechProblem({ supported: true, state: "missing-model", model: "x" }, "en"), /Settings → Voice/);
  assert.match(speechProblem({ supported: true, state: "ready", model: "Parakeet", languages: ["en"] }, "es"), /Parakeet.*doesn't transcribe/);
  assert.equal(speechProblem({ supported: true, state: "ready", model: "Parakeet", languages: ["en"] }, "en"), null);
  assert.equal(speechProblem({ supported: true, state: "transcribing", model: "Whisper" }, "es"), null, "older status without languages");
  assert.equal(speechProblem({ supported: true, state: "ready", model: "Parakeet", languages: ["en"] }, "auto"), null);
});

test("the request body matches T3's framing: length, options, then PCM", () => {
  const pcm = new Float32Array([0.5, -0.25, 1]);
  const body = encodeTranscription(pcm, "es");
  const length = new DataView(body.buffer).getUint32(0, true);
  const options = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length)));
  assert.deepEqual(options, { speechLanguage: "es", speechTranslateToEnglish: false, speechCustomWords: [], speechRemoveFillerWords: true, speechSilenceFiltering: true });
  assert.deepEqual(Array.from(new Float32Array(body.slice(4 + length).buffer)), [0.5, -0.25, 1]);
});

test("audio that overshoots after decoding stays within T3's [-1, 1]", () => {
  assert.deepEqual(Array.from(clampPcm(new Float32Array([1.5, -2, NaN, 0.5, -Infinity]))), [1, -1, 0, 0.5, -1]);
});

test("T3's error reasons become something to act on", () => {
  assert.match(transcriptionError(400, { reason: "speech_busy" }), /busy/);
  assert.match(transcriptionError(400, { reason: "invalid_command" }), /speech model/);
  assert.match(transcriptionError(403, null), /orchestration:operate/);
  assert.match(transcriptionError(502, null), /HTTP 502/);
});

test("transcribe posts through the gateway's T3 proxy", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ text: "  hello there " }); };
  try {
    assert.equal(await transcribe(new Float32Array(4), "en"), "hello there");
    assert.equal(calls[0].url, "/t3/api/voice/transcribe");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["content-type"], "application/octet-stream");
    globalThis.fetch = async () => Response.json({ _tag: "EnvironmentRequestInvalidError", code: "invalid_request", reason: "speech_busy", traceId: "t" }, { status: 400 });
    await assert.rejects(transcribe(new Float32Array(4), "en"), /busy/);
  } finally { globalThis.fetch = original; }
});
