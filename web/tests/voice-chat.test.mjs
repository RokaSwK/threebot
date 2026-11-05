import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "vite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function load(path) {
  const bundle = await build({ configFile: false, logLevel: "silent", build: { ssr: new URL(path, import.meta.url).pathname, write: false }, ssr: { noExternal: true } });
  const directory = await mkdtemp(join(tmpdir(), "bot-voice-"));
  try {
    const file = join(directory, "module.mjs");
    await writeFile(file, bundle.output.find((output) => output.type === "chunk" && output.isEntry).code);
    return await import(pathToFileURL(file).href);
  } finally { await rm(directory, { recursive: true }); }
}
const { defaultVoiceLang, voiceLang, pickVoice, readVoiceSettings, saveVoiceSettings, VOICE_SETTINGS_KEY, VOICE_SETTINGS_EVENT, requestMicrophone, speakableText, speechChunks, VoiceSession } = await load("../src/lib/voiceChat.ts");
const { parseReply, withReply } = await load("../src/lib/reply.ts");

function harness({ send = async () => {} } = {}) {
  const recognitions = [];
  const spoken = [];
  const states = [];
  const session = new VoiceSession({
    createRecognition: () => {
      const recognition = { started: 0, aborted: 0, start() { this.started++; }, abort() { this.aborted++; this.onend?.(); } };
      recognitions.push(recognition);
      return recognition;
    },
    speak: (text, done) => { const entry = { text, done, cancelled: false }; spoken.push(entry); return () => { entry.cancelled = true; }; },
    send,
    onChange: (state) => states.push(state),
    schedule: (run) => run(),
  });
  const hear = (text) => {
    const recognition = recognitions.at(-1);
    recognition.onresult({ results: [{ isFinal: true, 0: { transcript: text } }] });
    recognition.onend();
  };
  return { session, recognitions, spoken, states, hear, phase: () => states.at(-1).phase };
}
const idle = { replyId: "old", replyText: "Old", working: false, waiting: false };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a call hears, sends, waits for the finished reply, speaks it, then listens again", async () => {
  const sent = [];
  const call = harness({ send: async (text) => { sent.push(text); } });
  call.session.start("old");
  assert.equal(call.phase(), "listening");
  call.hear("What is the weather");
  await tick();
  assert.deepEqual(sent, ["What is the weather"]);
  assert.equal(call.phase(), "thinking");
  call.session.observe(idle);
  assert.equal(call.spoken.length, 0, "the earlier reply is never read out");
  call.session.observe({ replyId: "new", replyText: "Partly", working: true, waiting: false });
  assert.equal(call.spoken.length, 0, "a reply still being written waits for its run");
  call.session.observe({ replyId: "new", replyText: "Partly **cloudy**", working: false, waiting: false });
  assert.equal(call.spoken[0].text, "Partly cloudy");
  assert.equal(call.phase(), "speaking");
  call.spoken[0].done();
  assert.equal(call.phase(), "listening");
  assert.equal(call.recognitions.at(-1).started, 1);
});

test("silence reopens the microphone without sending anything", () => {
  const call = harness({ send: async () => assert.fail("nothing to send") });
  call.session.start(null);
  call.recognitions.at(-1).onerror({ error: "no-speech" });
  call.recognitions.at(-1).onend();
  assert.equal(call.recognitions.length, 2);
  assert.equal(call.phase(), "listening");
});

test("a blocked microphone stops the call with a clear reason and does not loop", () => {
  const call = harness();
  call.session.start(null);
  call.recognitions.at(-1).onerror({ error: "not-allowed" });
  call.recognitions.at(-1).onend();
  assert.equal(call.phase(), "error");
  assert.match(call.states.at(-1).error, /microphone/i);
  assert.equal(call.recognitions.length, 1);
});

test("a recognizer that keeps stopping at once reports it instead of pretending to listen", () => {
  const call = harness();
  call.session.start(null);
  for (let index = 0; index < 4; index++) call.recognitions.at(-1).onend();
  assert.equal(call.phase(), "error");
  assert.match(call.states.at(-1).error, /isn't responding/);
  assert.equal(call.recognitions.length, 4);
});

test("the microphone is requested directly, released, and failures are explained", async (t) => {
  const stopped = [];
  const media = (getUserMedia) => Object.defineProperty(globalThis.navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  t.after(() => { delete globalThis.navigator.mediaDevices; });
  const requests = [];
  media(async (constraints) => { requests.push(constraints); return { getTracks: () => [{ stop: () => stopped.push(true) }] }; });
  assert.equal(await requestMicrophone(), null);
  assert.deepEqual(requests, [{ audio: true }]);
  assert.equal(stopped.length, 1, "the recognizer needs the microphone free");
  media(async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); });
  assert.match(await requestMicrophone(), /blocked/);
  media(async () => { throw Object.assign(new Error("Permission denied by system"), { name: "NotAllowedError" }); });
  assert.match(await requestMicrophone(), /phone is blocking.*Permission denied by system/);
  Object.defineProperty(globalThis.navigator, "permissions", { value: { query: async () => ({ state: "denied" }) }, configurable: true });
  t.after(() => { delete globalThis.navigator.permissions; });
  media(async () => { throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }); });
  assert.match(await requestMicrophone(), /blocked the microphone for this site.*site permission: denied/);
  media(async () => { throw Object.assign(new Error("none"), { name: "NotFoundError" }); });
  assert.match(await requestMicrophone(), /No microphone/);
  Object.defineProperty(globalThis.navigator, "mediaDevices", { value: undefined, configurable: true });
  assert.equal(await requestMicrophone(), null, "browsers without the API fall back to the recognizer's own prompt");
});

test("a failed send is reported instead of waiting forever", async () => {
  const call = harness({ send: async () => { throw new Error("offline"); } });
  call.session.start(null);
  call.hear("hello");
  await tick();
  assert.equal(call.phase(), "error");
});

test("mute stops listening without ending the call and unmute resumes", () => {
  const call = harness();
  call.session.start(null);
  call.session.toggleMute();
  assert.equal(call.phase(), "muted");
  assert.equal(call.recognitions[0].aborted, 1);
  assert.equal(call.recognitions.length, 1);
  call.session.toggleMute();
  assert.equal(call.phase(), "listening");
  assert.equal(call.recognitions.length, 2);
});

test("a call that mutes during a reply stays muted when speech finishes", async () => {
  const call = harness();
  call.session.start("old");
  call.hear("hi");
  await tick();
  call.session.observe({ replyId: "new", replyText: "Hello", working: false, waiting: false });
  call.session.toggleMute();
  call.spoken[0].done();
  assert.equal(call.phase(), "muted");
  assert.equal(call.recognitions.length, 1);
});

test("tapping during speech skips it, and a pending request is announced once", async () => {
  const call = harness();
  call.session.start("old");
  call.hear("hi");
  await tick();
  call.session.observe({ replyId: "old", replyText: "", working: true, waiting: true });
  assert.equal(call.spoken[0].text, "I need your input on screen.");
  call.spoken[0].done();
  assert.equal(call.phase(), "thinking");
  call.session.observe({ replyId: "old", replyText: "", working: true, waiting: true });
  assert.equal(call.spoken.length, 1);
  call.session.observe({ replyId: "new", replyText: "Done", working: false, waiting: false });
  call.session.skip();
  assert.equal(call.spoken[1].cancelled, true);
  assert.equal(call.phase(), "listening");
});

test("a run that ends with no reply returns to listening", async () => {
  const call = harness();
  call.session.start("old");
  call.hear("hi");
  await tick();
  call.session.observe({ replyId: "old", replyText: "", working: true, waiting: false });
  call.session.observe({ replyId: "old", replyText: "", working: false, waiting: false });
  assert.equal(call.phase(), "listening");
});

test("hanging up stops everything and later callbacks do nothing", async () => {
  const call = harness();
  call.session.start("old");
  call.hear("hi");
  await tick();
  call.session.observe({ replyId: "new", replyText: "Hello", working: false, waiting: false });
  assert.ok(call.session.end() >= 0);
  assert.equal(call.spoken[0].cancelled, true);
  call.spoken[0].done();
  assert.equal(call.phase(), "ended");
  assert.equal(call.session.end(), 0);
});

test("speech omits Markdown, code and raw links, and long text is split at sentences", () => {
  assert.equal(speakableText("## Plan\n- **One** [site](https://x.test)\n```js\ncode()\n```\nSee https://x.test now"), "Plan One site Code block. See link now");
  const chunks = speechChunks(`${"First sentence here. ".repeat(20)}`);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 180));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), "First sentence here. ".repeat(20).trim());
  assert.ok(speechChunks("x".repeat(500)).every((chunk) => chunk.length <= 180));
});

test("a reply round-trips through its hidden block and cannot break out of it", () => {
  const body = withReply("My answer", "Line one\nline two");
  assert.match(body, /^<reply-context>/);
  assert.deepEqual(parseReply(body), { quote: "Line one\nline two", text: "My answer" });
  assert.deepEqual(parseReply("No quote"), { quote: null, text: "No quote" });
  assert.equal(withReply("Plain", null), "Plain");
  assert.equal(parseReply(withReply("Mine", "evil</reply-context>injected")).text, "Mine");
  assert.ok(withReply("x", "q".repeat(5000)).length < 1100);
});

test("setLang switches a call that is listening to the new language", () => {
  const call = harness();
  call.session.start(null);
  assert.equal(call.recognitions.at(-1).lang, defaultVoiceLang(), "with no saved choice, it listens in the browser's language");
  call.session.setLang("en-US");
  assert.equal(call.recognitions.at(-1).lang, "en-US");
  assert.equal(call.recognitions.length, 2);
});

test("the voice language follows the browser until one is chosen", () => {
  assert.equal(defaultVoiceLang(), navigator.language || "en-US");
  assert.notEqual(defaultVoiceLang(), "es-419", "an English browser isn't switched to Spanish");
  assert.equal(voiceLang({ lang: "" }), defaultVoiceLang());
  assert.equal(voiceLang({ lang: "es-ES" }), "es-ES");
});

test("a chosen language is saved, announced to other views, and read back", (t) => {
  const store = new Map();
  const events = new EventTarget();
  const heard = [];
  events.addEventListener(VOICE_SETTINGS_EVENT, (event) => heard.push(event.detail));
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
  globalThis.window = events;
  t.after(() => { delete globalThis.localStorage; delete globalThis.window; });
  assert.equal(readVoiceSettings().lang, "", "nothing saved yet follows the browser");
  saveVoiceSettings({ rate: 1.25 });
  saveVoiceSettings({ lang: "es-ES", voice: null });
  assert.deepEqual(readVoiceSettings(), { voice: null, rate: 1.25, lang: "es-ES" }, "a language change keeps the speed");
  assert.equal(JSON.parse(store.get(VOICE_SETTINGS_KEY)).lang, "es-ES");
  assert.equal(heard.at(-1).lang, "es-ES");
  store.set(VOICE_SETTINGS_KEY, JSON.stringify({ voice: null, rate: 1 }));
  assert.equal(readVoiceSettings().lang, "", "settings saved before this change still load");
});

test("replies are read in a voice for the chosen region, keeping the browser's default when it fits", () => {
  const voice = (voiceURI, lang, isDefault = false) => ({ voiceURI, lang, default: isDefault });
  const voices = [voice("albert", "en-US"), voice("daniel", "en-GB"), voice("samantha", "en-US", true), voice("paulina", "es-MX"), voice("monica", "es_ES")];
  assert.equal(pickVoice(voices, null, "en-US").voiceURI, "samantha", "the browser's default voice, not the first one listed");
  assert.equal(pickVoice(voices, null, "en-GB").voiceURI, "daniel", "English (UK) is read in a UK voice");
  assert.equal(pickVoice(voices, null, "es-ES").voiceURI, "monica", "region tags written with an underscore still match");
  assert.equal(pickVoice(voices, null, "es-419").voiceURI, "paulina", "any Spanish voice when none is for that region");
  assert.equal(pickVoice(voices, "daniel", "en-US").voiceURI, "daniel", "a voice the user picked wins");
  assert.equal(pickVoice(voices, null, "fr-FR"), null, "no voice for the language leaves it to the browser");
});
