import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Settings, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { recordVoiceCall, sendMessage, toast } from "../store";
import { browserRecognition, browserSpeak, defaultVoiceLang, readVoiceSettings, saveVoiceSettings, VOICE_SETTINGS_EVENT, VoiceSession, voiceLang, type VoiceObservation, type VoiceSettings, type VoiceState } from "../lib/voiceChat";
import type { Bot } from "../lib/types";
import "./VoiceDock.css";

const STATUS: Record<VoiceState["phase"], string> = {
  listening: "Listening", sending: "Sending", thinking: "Thinking", speaking: "Speaking. Tap to skip", muted: "Muted", ended: "Call ended", error: "Voice chat stopped",
};
const SPEEDS = [0.8, 1, 1.25, 1.5];
/** The saved voice settings, kept current when they change in another view or tab. */
export function useVoiceSettings(): VoiceSettings {
  const [settings, setSettings] = useState<VoiceSettings>(readVoiceSettings);
  useEffect(() => {
    const onSettings = () => setSettings(readVoiceSettings());
    window.addEventListener(VOICE_SETTINGS_EVENT, onSettings);
    window.addEventListener("storage", onSettings);
    return () => {
      window.removeEventListener(VOICE_SETTINGS_EVENT, onSettings);
      window.removeEventListener("storage", onSettings);
    };
  }, []);
  return settings;
}
/** "" follows the browser's language. */
export const voiceLanguageOptions = () => [["", `Browser default (${defaultVoiceLang()})`] as const, ...VOICE_LANGUAGES.map((l) => [l.code, l.label] as const)];
export const VOICE_LANGUAGES = [
  { code: "es-419", label: "Español (Latinoamérica)" },
  { code: "es-ES", label: "Español (España)" },
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
];

export function VoiceDock({ bot, threadId, observation, onEnd }: { bot: Bot; threadId: string; observation: VoiceObservation; onEnd: () => void }) {
  const [state, setState] = useState<VoiceState>({ phase: "listening", muted: false, heard: "", error: null });
  const [panel, setPanel] = useState(false);
  const settings = useVoiceSettings();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const session = useRef<VoiceSession | null>(null);
  const latest = useRef(observation);
  latest.current = observation;

  useEffect(() => {
    const createRecognition = browserRecognition();
    if (!createRecognition) return;
    const call = new VoiceSession({
      createRecognition,
      speak: (text, done) => browserSpeak(() => settingsRef.current, text, done),
      send: (text) => sendMessage(bot.slug, text, [], threadId),
      onChange: setState,
      lang: voiceLang(settingsRef.current),
    });
    session.current = call;
    call.start(latest.current.replyId);
    return () => {
      session.current = null;
      const seconds = call.end();
      if (call.spoke && seconds >= 1) recordVoiceCall(threadId, seconds).catch(() => {});
    };
  }, [bot.slug, threadId]);
  useEffect(() => { session.current?.observe(observation); }, [observation]);
  // Follows a language chosen here, in Settings, or in another tab.
  const lang = voiceLang(settings);
  useEffect(() => { session.current?.setLang(lang); }, [lang]);
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener("voiceschanged", load);
    return () => synth.removeEventListener("voiceschanged", load);
  }, []);

  const change = (patch: Partial<VoiceSettings>) => {
    const next = saveVoiceSettings(patch);
    settingsRef.current = next;
  };
  const language = lang.split("-")[0].toLowerCase();
  const choices = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language) || voice.voiceURI === settings.voice);
  const active = state.phase === "listening" || state.phase === "speaking";

  return <div className="voice-dock" data-phase={state.phase} role="group" aria-label={`Voice chat with ${bot.name}`}>
    <div className="voice-dock-bar">
      <Avatar shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={34} state={state.phase === "thinking" ? "thinking" : active ? "working" : "idle"} />
      <button type="button" className="voice-dock-wave" aria-label={STATUS[state.phase]} disabled={state.phase !== "speaking"} onClick={() => session.current?.skip()}>
        {Array.from({ length: 20 }, (_, index) => <span key={index} style={{ animationDelay: `${index * 45}ms` }} aria-hidden="true" />)}
      </button>
      <button type="button" className="voice-dock-button" aria-label="Show settings" aria-expanded={panel} onClick={() => setPanel((open) => !open)}><Settings size={20} aria-hidden="true" /></button>
      <button type="button" className="voice-dock-button" aria-label={state.muted ? "Unmute" : "Mute"} aria-pressed={state.muted} onClick={() => session.current?.toggleMute()}>{state.muted ? <MicOff size={20} aria-hidden="true" /> : <Mic size={20} aria-hidden="true" />}</button>
      <button type="button" className="voice-dock-hangup" aria-label="Hang up" onClick={onEnd}><X size={22} aria-hidden="true" /></button>
    </div>
    <span className="sr-only" role="status">{state.error ?? STATUS[state.phase]}</span>
    {(state.heard || state.error) && <p className="voice-dock-heard" data-error={!!state.error}>{state.error ?? state.heard}</p>}
    {panel && <div className="voice-dock-panel">
      <label>Language<select value={settings.lang} onChange={(event) => change({ lang: event.target.value, voice: null })}>{voiceLanguageOptions().map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
      <label>Voice<select value={settings.voice ?? ""} onChange={(event) => change({ voice: event.target.value || null })}><option value="">Default ({lang})</option>{choices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}</option>)}</select></label>
      <div role="group" aria-label="Speed">{SPEEDS.map((rate) => <button key={rate} type="button" aria-pressed={settings.rate === rate} onClick={() => change({ rate })}>{rate}×</button>)}</div>
    </div>}
    <span className="voice-dock-handle" aria-hidden="true" />
  </div>;
}

export function voiceChatSupported() {
  if (browserRecognition() && "speechSynthesis" in window) return true;
  toast("Voice chat isn't available in this browser");
  return false;
}
