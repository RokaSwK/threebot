// A voice call over the ordinary conversation: speech becomes a normal message
// and the Bot's finished reply is read aloud, then the microphone reopens.

export type VoicePhase = "listening" | "sending" | "thinking" | "speaking" | "muted" | "ended" | "error";
export type VoiceState = { phase: VoicePhase; muted: boolean; heard: string; error: string | null };

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
export type RecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
};

export type VoiceDeps = {
  createRecognition: () => RecognitionLike;
  /** Starts speech and returns its cancel function. */
  speak: (text: string, done: () => void) => () => void;
  send: (text: string) => Promise<void>;
  onChange: (state: VoiceState) => void;
  lang?: string;
  schedule?: (run: () => void, ms: number) => void;
};

export type VoiceObservation = { replyId: string | null; replyText: string; working: boolean; waiting: boolean };

const BLOCKED = new Set(["not-allowed", "service-not-allowed"]);
const MAX_QUICK_ENDS = 4;
const QUICK_END_MS = 1000;

/**
 * Speech recognition doesn't reliably prompt for the microphone on Android, so
 * ask directly from the tap. Returns what went wrong, or null when it can proceed.
 */
export async function requestMicrophone() {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) return null;
  try {
    const stream = await devices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return null;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    // The browser's own reason is what separates a system block from a site block.
    const state = await navigator.permissions?.query({ name: "microphone" as PermissionName }).then((status) => status.state, () => "unknown") ?? "unknown";
    const detail = `(${name || "Error"}: ${message}; site permission: ${state})`;
    if (name === "NotAllowedError" || name === "SecurityError") {
      if (/system/i.test(message)) return `Your phone is blocking the microphone for this browser. ${detail}`;
      if (state === "denied") return `The browser has blocked the microphone for this site. Open the site's settings from the address bar and allow or reset Microphone. ${detail}`;
      return `Microphone access is blocked and the browser gave no prompt. ${detail}`;
    }
    if (name === "NotFoundError") return `No microphone was found on this device. ${detail}`;
    return `Couldn't start the microphone. ${detail}`;
  }
}
const NEEDS_INPUT = "I need your input on screen.";

/** What a listener should hear: prose, without Markdown syntax or anything unreadable. */
export function speakableText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " Code block. ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|`|~~)/g, "")
    .replace(/\|/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

/** Browsers stop long utterances, so speech is queued a sentence at a time. */
export function speechChunks(text: string, limit = 180) {
  const chunks: string[] = [];
  for (const sentence of text.match(/[^.!?]+[.!?]*\s*/g) ?? []) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + sentence.length <= limit) chunks[chunks.length - 1] = last + sentence;
    else chunks.push(sentence);
  }
  return chunks.flatMap((chunk) => chunk.length <= limit ? [chunk.trim()] : chunk.match(new RegExp(`.{1,${limit}}(\\s|$)`, "g"))?.map((part) => part.trim()) ?? []).filter(Boolean);
}

export class VoiceSession {
  private state: VoiceState = { phase: "listening", muted: false, heard: "", error: null };
  private recognition: RecognitionLike | null = null;
  private cancelSpeech: (() => void) | null = null;
  private latestReply: string | null = null;
  private baseline: string | null = null;
  private sawWork = false;
  private announced = false;
  private startedAt = 0;
  private quickEnds = 0;
  /** Only a call that actually exchanged speech belongs in the transcript. */
  spoke = false;

  constructor(private deps: VoiceDeps) {}

  private update(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  private get ended() { return this.state.phase === "ended"; }

  setLang(lang: string) {
    this.deps.lang = lang;
    if (this.recognition && this.state.phase === "listening") {
      const rec = this.recognition;
      this.recognition = null;
      rec.abort();
      this.listen();
    }
  }

  start(reply: string | null) {
    this.latestReply = reply;
    this.startedAt = Date.now();
    this.listen();
  }

  private listen() {
    if (this.ended || this.state.phase === "error") return;
    if (this.state.muted) return this.update({ phase: "muted", heard: "" });
    this.update({ phase: "listening", heard: "" });
    let finalText = "";
    let failed = false;
    const opened = Date.now();
    const recognition = this.deps.createRecognition();
    this.recognition = recognition;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = this.deps.lang || defaultVoiceLang();
    recognition.onresult = (event) => {
      const results = Array.from(event.results);
      finalText = results.filter((result) => result.isFinal).map((result) => result[0].transcript).join(" ").trim();
      if (finalText) this.spoke = true;
      this.update({ heard: results.map((result) => result[0].transcript).join(" ").trim() });
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      failed = true;
      this.update({ phase: "error", error: BLOCKED.has(event.error) ? "Allow microphone access to use voice chat." : event.error === "audio-capture" ? "The microphone isn't available. Hang up and try again." : `Voice error: ${event.error}. Hang up and try again.` });
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognition = null;
      if (failed || this.ended || this.state.phase !== "listening") return;
      if (finalText) { this.quickEnds = 0; void this.submit(finalText); return; }
      // Without this, a recognizer that stops at once would look like it's listening.
      this.quickEnds = Date.now() - opened < QUICK_END_MS ? this.quickEnds + 1 : 0;
      if (this.quickEnds >= MAX_QUICK_ENDS) this.update({ phase: "error", error: "Voice recognition isn't responding on this device. Hang up and try again." });
      else (this.deps.schedule ?? ((run, ms) => { setTimeout(run, ms); }))(() => { if (this.state.phase === "listening" && !this.recognition) this.listen(); }, 250);
    };
    try { recognition.start(); }
    catch { this.update({ phase: "error", error: "Voice recognition stopped. Hang up and try again." }); }
  }

  private async submit(text: string) {
    this.baseline = this.latestReply;
    this.sawWork = false;
    this.announced = false;
    this.update({ phase: "sending", heard: text });
    try {
      await this.deps.send(text);
      if (this.state.phase === "sending") this.update({ phase: "thinking", heard: "" });
    } catch {
      if (!this.ended) this.update({ phase: "error", error: "Couldn't send that. Hang up and try again." });
    }
  }

  /** Follows the transcript; a reply is spoken only once its run has finished. */
  observe({ replyId, replyText, working, waiting }: VoiceObservation) {
    this.latestReply = replyId;
    if (this.state.phase !== "thinking") return;
    if (working) this.sawWork = true;
    if (waiting) {
      if (!this.announced) { this.announced = true; this.say(NEEDS_INPUT, false); }
      return;
    }
    if (working) return;
    const text = replyId && replyId !== this.baseline ? speakableText(replyText) : "";
    if (text) this.say(text, true);
    else if (this.sawWork) this.listen();
  }

  private say(text: string, thenListen: boolean) {
    this.update({ phase: "speaking" });
    this.cancelSpeech = this.deps.speak(text, () => {
      this.cancelSpeech = null;
      if (this.ended) return;
      if (thenListen) this.listen();
      else this.update({ phase: "thinking" });
    });
  }

  /** Stops the Bot's speech and goes straight back to listening. */
  skip() {
    if (this.state.phase !== "speaking") return;
    const cancel = this.cancelSpeech;
    this.cancelSpeech = null;
    cancel?.();
    this.listen();
  }

  toggleMute() {
    const muted = !this.state.muted;
    this.update({ muted });
    if (muted && this.state.phase === "listening") {
      const recognition = this.recognition;
      this.recognition = null;
      recognition?.abort();
      this.update({ phase: "muted", heard: "" });
    } else if (!muted && this.state.phase === "muted") this.listen();
  }

  /** Ends the call and returns its length in seconds. */
  end() {
    if (this.ended) return 0;
    const recognition = this.recognition;
    const cancel = this.cancelSpeech;
    this.recognition = null;
    this.cancelSpeech = null;
    this.update({ phase: "ended", heard: "" });
    recognition?.abort();
    cancel?.();
    return Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
  }
}

export function browserRecognition(): (() => RecognitionLike) | null {
  const scope = window as unknown as Record<string, (new () => RecognitionLike) | undefined>;
  const Recognition = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  return Recognition ? () => new Recognition() : null;
}

export const VOICE_SETTINGS_KEY = "bot.voice";
export const VOICE_SETTINGS_EVENT = "bot-voice-settings-changed";
export type VoiceSettings = { voice: string | null; rate: number; lang: string };

export function defaultVoiceLang(): string {
  if (typeof navigator !== "undefined" && navigator.language) {
    if (navigator.language.toLowerCase().startsWith("es")) {
      return navigator.language;
    }
  }
  return "es-419";
}

export function readVoiceSettings(): VoiceSettings {
  const fallbackLang = defaultVoiceLang();
  try {
    const value: unknown = JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) ?? "null");
    if (value && typeof value === "object") {
      const { voice, rate, lang } = value as Partial<VoiceSettings>;
      return {
        voice: typeof voice === "string" ? voice : null,
        rate: typeof rate === "number" && rate >= 0.5 && rate <= 2 ? rate : 1,
        lang: typeof lang === "string" && lang ? lang : fallbackLang,
      };
    }
  } catch { /* Storage may be unavailable or hold an older value. */ }
  return { voice: null, rate: 1, lang: fallbackLang };
}

export function saveVoiceSettings(patch: Partial<VoiceSettings>): VoiceSettings {
  const current = readVoiceSettings();
  const next: VoiceSettings = { ...current, ...patch };
  try {
    localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(next));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_EVENT, { detail: next }));
    }
  } catch { /* Storage may be unavailable */ }
  return next;
}

export function browserSpeak(settings: () => VoiceSettings, text: string, done: () => void) {
  const synth = window.speechSynthesis;
  const chunks = speechChunks(text);
  let cancelled = false;
  const next = () => {
    if (cancelled) return;
    const chunk = chunks.shift();
    if (chunk === undefined) return done();
    const utterance = new SpeechSynthesisUtterance(chunk);
    const { voice, rate, lang } = settings();
    utterance.rate = rate;
    const effectiveLang = lang || defaultVoiceLang();
    utterance.lang = effectiveLang;
    const voices = synth.getVoices();
    const chosenVoice = voices.find((item) => item.voiceURI === voice);
    const langPrefix = effectiveLang.split("-")[0].toLowerCase();
    const matchingLangVoice = voices.find((item) => item.lang.toLowerCase().startsWith(langPrefix));
    utterance.voice = chosenVoice ?? matchingLangVoice ?? null;
    utterance.onend = next;
    utterance.onerror = next;
    synth.speak(utterance);
  };
  next();
  return () => { cancelled = true; synth.cancel(); };
}
