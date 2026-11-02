import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Settings, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { recordVoiceCall, sendMessage, toast } from "../store";
import { browserRecognition, browserSpeak, readVoiceSettings, VOICE_SETTINGS_KEY, VoiceSession, type VoiceObservation, type VoiceSettings, type VoiceState } from "../lib/voiceChat";
import type { Bot } from "../lib/types";
import "./VoiceDock.css";

const STATUS: Record<VoiceState["phase"], string> = {
  listening: "Listening", sending: "Sending", thinking: "Thinking", speaking: "Speaking. Tap to skip", muted: "Muted", ended: "Call ended", error: "Voice chat stopped",
};
const SPEEDS = [0.8, 1, 1.25, 1.5];

export function VoiceDock({ bot, threadId, observation, onEnd }: { bot: Bot; threadId: string; observation: VoiceObservation; onEnd: () => void }) {
  const [state, setState] = useState<VoiceState>({ phase: "listening", muted: false, heard: "", error: null });
  const [panel, setPanel] = useState(false);
  const [settings, setSettings] = useState<VoiceSettings>(readVoiceSettings);
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
      lang: navigator.language,
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
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener("voiceschanged", load);
    return () => synth.removeEventListener("voiceschanged", load);
  }, []);

  const change = (patch: Partial<VoiceSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    try { localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(next)); }
    catch { /* The choice still applies to this call. */ }
  };
  const language = navigator.language.split("-")[0];
  const choices = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language.toLowerCase()) || voice.voiceURI === settings.voice);
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
      <label>Voice<select value={settings.voice ?? ""} onChange={(event) => change({ voice: event.target.value || null })}><option value="">Default</option>{choices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}</option>)}</select></label>
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
