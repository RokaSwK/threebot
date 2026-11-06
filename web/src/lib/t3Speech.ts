// Dictation transcribed by T3 Code (0.1.8 nightly and later) instead of the browser.
// The browser records, the gateway's /t3 proxy carries the audio to the T3 server,
// a local model there transcribes it and the server discards the audio.
// Contract: POST /api/voice/transcribe with a 4-byte little-endian JSON length, the
// options JSON, then 16 kHz mono Float32 PCM, at most five minutes. Older servers lack
// the `voiceTranscription` capability, so Threebot keeps using the browser there.
import { t3http } from "./t3";

export const SPEECH_SAMPLE_RATE = 16_000;
export const MAX_SPEECH_SECONDS = 5 * 60;

export type DictationEngine = "browser" | "t3";

/** T3 when chosen, or when the browser can't recognise speech; otherwise the browser. */
export function dictationEngine({ browser, t3, preferT3 }: { browser: boolean; t3: boolean; preferT3: boolean }): DictationEngine | null {
  if (t3 && (preferT3 || !browser)) return "t3";
  return browser ? "browser" : null;
}

/** T3's models list base languages: "es-ES" is "es". */
export function speechLanguage(lang: string) {
  const base = lang.split(/[-_]/)[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(base) ? base : "auto";
}

const SPACELESS = new Set(["ja", "zh", "yue", "th", "lo", "km", "my"]);
/** Adds spoken text after the draft, with a space only where the language uses one. */
export function appendDictation(draft: string, spoken: string, lang: string) {
  const base = draft.trimEnd();
  if (!base) return spoken;
  return SPACELESS.has(speechLanguage(lang)) ? base + spoken : base + " " + spoken;
}

export type T3SpeechStatus =
  | { supported: false; reason: string }
  | { supported: true; state: "missing-model" | "ready" | "transcribing"; model: string; languages?: string[] };

const SETUP = "Choose a speech model in T3 Code → Settings → Voice.";

/** Why the server can't transcribe this language now, or null when it can. */
export function speechProblem(status: T3SpeechStatus, language: string): string | null {
  if (!status.supported) return `T3 Code can't transcribe on this server: ${status.reason}`;
  if (status.state === "missing-model") return `T3 Code has no speech model yet. ${SETUP}`;
  if (language !== "auto" && status.languages?.length && !status.languages.includes(language)) {
    return `T3 Code's speech model (${status.model}) doesn't transcribe this language. ${SETUP}`;
  }
  return null;
}

export function speechStatus(signal?: AbortSignal) {
  return t3http<T3SpeechStatus>("/api/voice/status", { signal });
}

/** The request body T3 decodes: options length, options JSON, then raw PCM. */
export function encodeTranscription(pcm: Float32Array, language: string): Uint8Array<ArrayBuffer> {
  const options = { speechLanguage: language, speechTranslateToEnglish: false, speechCustomWords: [], speechRemoveFillerWords: true, speechSilenceFiltering: true };
  const metadata = new TextEncoder().encode(JSON.stringify(options));
  const body = new Uint8Array(4 + metadata.byteLength + pcm.byteLength);
  new DataView(body.buffer).setUint32(0, metadata.byteLength, true);
  body.set(metadata, 4);
  body.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 4 + metadata.byteLength);
  return body;
}

export function transcriptionError(status: number, body: unknown) {
  const reason = body && typeof body === "object" && "reason" in body ? body.reason : null;
  if (reason === "speech_busy") return "T3 Code is busy with another recording. Try again in a moment.";
  if (reason === "speech_unavailable") return "T3 Code can't transcribe on this server.";
  if (reason === "invalid_audio") return "T3 Code couldn't read that recording.";
  if (reason === "invalid_command") return `T3 Code has no speech model yet. ${SETUP}`;
  if (reason === "scope_not_granted" || status === 403) return "The gateway's T3 token can't transcribe (it needs the orchestration:operate scope).";
  return `T3 Code couldn't transcribe that (HTTP ${status}).`;
}

export async function transcribe(pcm: Float32Array, language: string, signal?: AbortSignal) {
  const res = await fetch("/t3/api/voice/transcribe", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-t3-orchestration-protocol": "2" },
    body: encodeTranscription(pcm, language),
    signal,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(transcriptionError(res.status, body));
  if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string") throw new Error("T3 Code returned no transcript.");
  return body.text.trim();
}

export type Recording = { stop: () => Promise<Float32Array>; cancel: () => void };

/** Records the microphone until stopped. `onLimit` fires shortly before T3's five-minute cap. */
export async function startRecording(onLimit: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let recorder: MediaRecorder;
  try { recorder = new MediaRecorder(stream); }
  catch (error) { for (const track of stream.getTracks()) track.stop(); throw error; }
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  const limit = setTimeout(onLimit, (MAX_SPEECH_SECONDS - 5) * 1000);
  const release = () => {
    clearTimeout(limit);
    if (recorder.state !== "inactive") recorder.stop();
    for (const track of stream.getTracks()) track.stop();
  };
  recorder.start(1000);
  return {
    async stop() {
      release();
      await stopped;
      return toSpeechPcm(new Blob(chunks, { type: recorder.mimeType }));
    },
    cancel: release,
  };
}

/** Decodes whatever the browser recorded (WebM, Ogg or MP4) to 16 kHz mono Float32. */
async function toSpeechPcm(blob: Blob) {
  if (!blob.size) return new Float32Array(0);
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Context();
  let decoded: AudioBuffer;
  try { decoded = await context.decodeAudioData(await blob.arrayBuffer()); }
  finally { void context.close(); }
  const frames = Math.min(Math.ceil(decoded.duration * SPEECH_SAMPLE_RATE), SPEECH_SAMPLE_RATE * MAX_SPEECH_SECONDS);
  if (!frames) return new Float32Array(0);
  // Rendering offline at 16 kHz resamples and mixes down to one channel.
  const offline = new OfflineAudioContext(1, frames, SPEECH_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return clampPcm((await offline.startRendering()).getChannelData(0));
}

/** T3 refuses samples outside [-1, 1], and decoding or resampling can overshoot. */
export function clampPcm(pcm: Float32Array) {
  for (let i = 0; i < pcm.length; i++) {
    const sample = pcm[i];
    pcm[i] = sample > 1 ? 1 : sample < -1 ? -1 : Number.isNaN(sample) ? 0 : sample;
  }
  return pcm;
}
