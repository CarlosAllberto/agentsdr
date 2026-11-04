/**
 * The AI voice agent's side of a call (trial): one Gemini Live session,
 * opened by wa-agent when an agent call starts ringing.
 *
 * Why here, in the isolated world: web.whatsapp.com's CSP (connect-src) only
 * lets the page reach WhatsApp's own hosts, so wa-hook, in the page's world,
 * cannot open this socket. Content scripts are not bound by the page's CSP.
 * Audio crosses between the two over window.postMessage as raw PCM:
 *   lead → model: wa-hook posts the lead's side at 16 kHz ("agent-audio");
 *   model → lead: the model's 24 kHz voice goes back to wa-hook
 *                 ("agent-play"), which plays it into the call's microphone.
 *
 * The session's setup — model, voice, instructions, tools — is locked into
 * the token AgentSDR mints (src/lib/calls/liveAgent.ts); the setup sent here
 * only names the model.
 */

import type { AgentOutcomeKind } from "../../../src/lib/calls/contract";
import type { AgentTokenResult } from "./messages";

type Handlers = {
  /** The model's voice: mono 16-bit PCM at `rate` Hz. */
  play(pcm: ArrayBuffer, rate: number): void;
  /** The lead talked over the model: drop its voice still queued. */
  interrupt(): void;
  /** The model called end_call, or the line stayed silent after its goodbye. */
  hangup(reason: string): void;
  /** The model called record_outcome. */
  outcome(report: { outcome: AgentOutcomeKind; summary: string | null; when: string | null; whenAt: string | null }): void;
  /** The session is set up (optional; the voice rehearsal in AgentSDR uses it to "pick up"). */
  ready?(): void;
  /** A finished line of the conversation, as Gemini transcribed it (optional). */
  transcript?(who: "lead" | "agent", text: string, why: "turn" | "interrupted"): void;
  /** A step worth seeing in the call's timing table. */
  trace(step: string): void;
  /** The token request, through the service worker (it holds the call's bearer token). */
  token(): Promise<AgentTokenResult>;
};

const OUTPUT_RATE_PATTERN = /rate=(\d+)/;
/** "[Call note: …]" is what the instructions tell the model comes from the system, not the person. */
const GREETING_PROMPT = "[Call note: the call has just connected and the person is on the line. Open the call now.]";
const SILENCE_CHECK_NOTE =
  "[Call note: the person has not said anything for a few seconds. Check briefly and naturally whether they are still there, in the language of the call.]";
/**
 * After a tool call this model says nothing until the person speaks again
 * (27 Oct 2026, every simulated call): a goodbye never came. A turn with a
 * tool call and no voice at all gets one of these. It used to say "confirm
 * what you agreed", and went out after a turn that ended in a question: the
 * agent then answered its own "would Thursday at 3 work?" with "Great,
 * Thursday at 3 then" (4 Nov 2026).
 */
const CARRY_ON_NOTE = "[Call note: noted. Carry on the call from where it was.]";
const SAY_GOODBYE_NOTE = "[Call note: say your goodbye out loud now.]";
const SILENCE_GOODBYE_NOTE =
  "[Call note: still no answer. Call record_outcome, say a short, friendly goodbye (you will try them another time), then call end_call.]";
/**
 * People pick up and say "Hello?" first; a greeting started at the pick-up
 * gets talked over (seen 11 Oct 2026: three restarts; on 27 Oct the greeting
 * prepared during "Connecting…" still played over their hello). So the agent
 * waits this long for them: with no greeting ready it answers what they say;
 * with one ready, it plays it once they pause.
 */
const GREETING_WAIT_MS = 1_200;
/** Their hello is over after this much quiet. */
const HELLO_PAUSE_MS = 400;
/** A noisy line never goes quiet: the prepared greeting plays by this point regardless. */
const HELLO_MAX_WAIT_MS = 2_000;
/**
 * Gemini Live only speaks after the person does: on a silent line the call
 * just sat there. Measured from the end of the agent's own voice or the lead's
 * last sound: a check-in after this long, then a goodbye, then a hang-up if
 * the model has not ended the call itself.
 */
const SILENCE_CHECK_MS = 4_000;
const SILENCE_GOODBYE_MS = 8_000;
const SILENCE_HANGUP_MS = 12_000;
/**
 * They asked the agent to hold on (it called wait_for_them): no check-ins for
 * this long, unless they speak first. The 4 s check-in and goodbye hung up on
 * a lead who had said "can you wait a second?" (4 Nov 2026).
 */
const WAIT_FOR_THEM_MS = 90_000;
/**
 * The model often calls end_call first and speaks its goodbye after the tool
 * response (seen 27 Oct 2026), so the hang-up waits for that turn to finish
 * (wa-hook then lets the queued voice play out). Without any voice by
 * HANGUP_NO_VOICE_MS it hangs up; never later than HANGUP_MAX_WAIT_MS.
 */
const HANGUP_NO_VOICE_MS = 5_000;
const HANGUP_MAX_WAIT_MS = 12_000;
/** The heard-audio test option keeps at most 20 minutes (38 MB) of the lead's side. */
const MAX_HEARD_SAMPLES = 16_000 * 60 * 20;
/** A lead-side chunk this loud (-40 dBFS) counts as them making sound, for the reply-latency log. */
const VOICE_PEAK = 0x8000 / 100;

export class LiveAgent {
  private socket: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private greetPending = false;
  private saidThisTurn = "";
  private warnedNotReady = false;
  private sentSamples = 0;
  private sentPeak = 0;
  private sentSince = Date.now();
  private greetTimer: ReturnType<typeof setTimeout> | null = null;
  private leadSpoke = false;
  private firstReply = true;
  /** When the lead's side last carried sound (above -40 dBFS), and whether the model is mid-reply. */
  private lastVoiceAt = 0;
  private replying = false;
  private heardThisTurn = "";
  /** The greeting was asked for during "Connecting…"; its audio is held until the pick-up. */
  private greetPrepared = false;
  private prepareWhenReady = false;
  private pickedUp = false;
  private holding = false;
  private held: [ArrayBuffer, number][] = [];
  /** When the agent's voice already sent for playing ends (playing runs in real time; generating is faster). */
  private playUntil = 0;
  private pickedUpAt = 0;
  private helloWatch: ReturnType<typeof setInterval> | null = null;
  private silenceWatch: ReturnType<typeof setInterval> | null = null;
  private silenceNotes = 0;
  private lastNoteAt = 0;
  private ending = false;
  /** end_call was called: hang up once the goodbye after it is spoken. */
  /** Tools the model called this turn, and whether the turn had any voice. */
  private toolsThisTurn: string[] = [];
  private voicedThisTurn = false;
  /** wait_for_them: silence is expected until then, or until they speak. */
  private waitingUntil = 0;
  private hangupPending: { reason: string; voiced: boolean; timers: ReturnType<typeof setTimeout>[] } | null = null;
  /** The test option's copy of exactly what is sent to the model (null when off). */
  private heard: Int16Array[] | null = null;
  private heardSamples = 0;

  constructor(private readonly handlers: Handlers) {}

  async start(): Promise<void> {
    this.handlers.trace("AI agent: asking for a session");
    const result = await this.handlers.token();
    if (this.closed) return;
    if (!result.ok) {
      this.handlers.trace(`AI agent: no session — ${result.error}`);
      console.warn("[agentsdr agent] no session:", result.error);
      return;
    }
    if (result.saveHeardAudio) {
      this.heard = [];
      this.handlers.trace("AI agent: saving what it hears (test option)");
    }
    const socket = new WebSocket(`${result.websocketUrl}?access_token=${encodeURIComponent(result.token)}`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ setup: { model: result.model } }));
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => console.warn("[agentsdr agent] socket error");
    socket.onclose = (event) => {
      this.ready = false;
      if (!this.closed) {
        this.handlers.trace(`AI agent: disconnected (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
        console.warn("[agentsdr agent] socket closed", event.code, event.reason);
      }
    };
  }

  /**
   * WhatsApp shows "Connecting…": the lead has accepted, and the audio link
   * takes a few seconds more (2.5 s on the call worker, 23 Oct 2026). The
   * greeting is generated now and held, so it plays as soon as they have said
   * hello instead of after the model's ~1 s to start speaking.
   */
  prepareGreeting(): void {
    if (this.greetPrepared || this.leadSpoke) return;
    // Not connected to the model yet: prepare it the moment the session is ready.
    if (!this.ready) {
      this.prepareWhenReady = true;
      return;
    }
    this.greetPrepared = true;
    this.holding = true;
    this.handlers.trace("AI agent: lead accepted — preparing the greeting while WhatsApp connects");
    this.sendGreeting();
  }

  /** The lead picked up (the call timer appeared): the model speaks first, after their hello. */
  greet(): void {
    this.pickedUp = true;
    this.pickedUpAt = Date.now();
    this.prepareWhenReady = false;
    this.startSilenceWatch();
    if (this.greetPrepared) {
      // The lead's audio is not sent to the model while the greeting is held:
      // their "Hello?" would make it greet a second time ("Hi Asha. Hi Asha.").
      this.handlers.trace("AI agent: picked up — greeting ready, waiting for their hello");
      this.helloWatch = setInterval(() => {
        const now = Date.now();
        const spoke = this.lastVoiceAt > this.pickedUpAt;
        if (spoke && now - this.lastVoiceAt >= HELLO_PAUSE_MS) this.releaseGreeting("after their hello");
        else if (!spoke && now - this.pickedUpAt >= GREETING_WAIT_MS) this.releaseGreeting("they said nothing");
        else if (now - this.pickedUpAt >= HELLO_MAX_WAIT_MS) this.releaseGreeting("the line never went quiet");
      }, 50);
      return;
    }
    this.handlers.trace("AI agent: lead picked up — waiting for their hello");
    this.greetTimer = setTimeout(() => {
      this.greetTimer = null;
      if (this.leadSpoke) return;
      this.handlers.trace("AI agent: lead said nothing — greeting");
      if (this.ready) this.sendGreeting();
      else this.greetPending = true;
    }, GREETING_WAIT_MS);
  }

  /** The lead's side of the call: mono 16-bit PCM at 16 kHz. */
  sendAudio(pcm: ArrayBuffer): void {
    if (!this.ready || !this.socket) {
      if (!this.warnedNotReady) this.handlers.trace("AI agent: lead audio arrived before the session was ready — dropped");
      this.warnedNotReady = true;
      return;
    }
    // Held greeting: listen for their hello here, but do not hand it to the model.
    if (!this.holding) this.socket.send(JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: toBase64(pcm) } } }));
    if (this.heard && !this.holding && this.heardSamples < MAX_HEARD_SAMPLES) {
      const copy = new Int16Array(pcm.slice(0));
      this.heard.push(copy);
      this.heardSamples += copy.length;
    }
    // Every 5 s: how much of the lead's audio went to the model, and how loud
    // it was — the evidence for "the agent did not hear me".
    const samples = new Int16Array(pcm);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    this.sentSamples += samples.length;
    this.sentPeak = Math.max(this.sentPeak, peak);
    const now = Date.now();
    if (peak > VOICE_PEAK) this.lastVoiceAt = now;
    if (now - this.sentSince >= 5_000) {
      const peakDb = this.sentPeak > 0 ? Math.round(20 * Math.log10(this.sentPeak / 0x8000)) : -Infinity;
      this.handlers.trace(`AI agent: sent ${(this.sentSamples / 16_000).toFixed(1)} s of the lead's audio in ${((now - this.sentSince) / 1000).toFixed(1)} s, peak ${peakDb} dB`);
      this.sentSamples = 0;
      this.sentPeak = 0;
      this.sentSince = now;
    }
  }

  /** The test option's recording of what the model heard, 16 kHz mono; null when it was off. */
  takeHeardAudio(): Int16Array | null {
    if (!this.heard?.length) return null;
    const all = new Int16Array(this.heardSamples);
    let at = 0;
    for (const chunk of this.heard) {
      all.set(chunk, at);
      at += chunk.length;
    }
    this.heard = null;
    this.heardSamples = 0;
    return all;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.greetTimer) clearTimeout(this.greetTimer);
    if (this.helloWatch) clearInterval(this.helloWatch);
    if (this.silenceWatch) clearInterval(this.silenceWatch);
    for (const timer of this.hangupPending?.timers ?? []) clearTimeout(timer);
    this.ready = false;
    try {
      this.socket?.close(1000);
    } catch {
      // Already closing.
    }
    this.socket = null;
  }

  private sendGreeting(): void {
    this.greetPending = false;
    this.socket?.send(JSON.stringify({ realtimeInput: { text: GREETING_PROMPT } }));
  }

  private releaseGreeting(why: string): void {
    if (this.helloWatch) clearInterval(this.helloWatch);
    this.helloWatch = null;
    if (!this.holding) return;
    this.holding = false;
    const held = this.held.splice(0);
    const waited = Date.now() - this.pickedUpAt;
    this.handlers.trace(`AI agent: greeting ${waited} ms after the pick-up, ${why} (${held.length ? "prepared during Connecting…" : "still being prepared"})`);
    for (const [pcm, rate] of held) this.play(pcm, rate);
  }

  private play(pcm: ArrayBuffer, rate: number): void {
    const now = Date.now();
    this.playUntil = Math.max(now, this.playUntil) + (pcm.byteLength / 2 / rate) * 1000;
    this.handlers.play(pcm, rate);
  }

  /** Nudges the model when the line goes quiet (see SILENCE_CHECK_MS). */
  private startSilenceWatch(): void {
    if (this.silenceWatch) return;
    this.silenceWatch = setInterval(() => {
      if (this.closed || this.holding || this.replying || this.ending || !this.ready) return;
      const now = Date.now();
      if (now < this.waitingUntil) return;
      const quiet = now - Math.max(this.playUntil, this.lastVoiceAt, this.lastNoteAt, this.pickedUpAt);
      if (this.silenceNotes === 0 && quiet >= SILENCE_CHECK_MS) this.note(SILENCE_CHECK_NOTE, `silent ${Math.round(quiet / 1000)} s — checking they are there`);
      else if (this.silenceNotes === 1 && quiet >= SILENCE_GOODBYE_MS) this.note(SILENCE_GOODBYE_NOTE, `still silent ${Math.round(quiet / 1000)} s — saying goodbye`);
      else if (this.silenceNotes >= 2 && quiet >= SILENCE_HANGUP_MS) {
        this.ending = true;
        this.handlers.trace("AI agent: no answer after its goodbye — hanging up");
        this.handlers.hangup("no response");
      }
    }, 250);
  }

  private note(text: string, why: string): void {
    this.silenceNotes += 1;
    this.lastNoteAt = Date.now();
    this.handlers.trace(`AI agent: ${why}`);
    this.socket?.send(JSON.stringify({ realtimeInput: { text } }));
  }

  private receive(data: unknown): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    let message: LiveServerMessage;
    try {
      message = JSON.parse(text) as LiveServerMessage;
    } catch {
      return;
    }

    if (message.setupComplete) {
      this.ready = true;
      this.handlers.trace("AI agent: session ready");
      if (this.greetPending) this.sendGreeting();
      else if (this.prepareWhenReady && !this.pickedUp) this.prepareGreeting();
      this.handlers.ready?.();
      return;
    }

    const content = message.serverContent;
    if (content) {
      if (content.interrupted) {
        this.replying = false;
        this.playUntil = Date.now();
        this.handlers.interrupt();
        this.flushTranscript("interrupted");
      }
      if (content.inputTranscription?.text) {
        // They spoke first: the model answers that turn itself, greeting included.
        if (!this.leadSpoke && this.greetTimer) this.handlers.trace("AI agent: lead said hello first — answering them");
        this.leadSpoke = true;
        // They said something: the silence check-ins start over.
        if (!this.holding) this.silenceNotes = 0;
        this.waitingUntil = 0;
        this.heardThisTurn += content.inputTranscription.text;
        // Logged as it arrives: a turn the model never answers is never flushed.
        this.handlers.trace(`AI agent: heard "${content.inputTranscription.text.trim()}"`);
      }
      if (content.outputTranscription?.text) {
        if (this.heardThisTurn) this.flushHeard();
        this.saidThisTurn += content.outputTranscription.text;
      }
      for (const part of content.modelTurn?.parts ?? []) {
        const audio = part.inlineData;
        if (!audio?.data || !audio.mimeType?.startsWith("audio/pcm")) continue;
        const rate = Number(OUTPUT_RATE_PATTERN.exec(audio.mimeType)?.[1] ?? 24_000);
        if (this.firstReply) {
          this.firstReply = false;
          this.handlers.trace("AI agent: first audio from Gemini");
        } else if (!this.replying && this.lastVoiceAt) {
          // The gap the lead hears: from their last sound to the model's first.
          this.handlers.trace(`AI agent: replied ${Date.now() - this.lastVoiceAt} ms after the lead's last sound`);
        }
        this.replying = true;
        this.voicedThisTurn = true;
        if (this.hangupPending) this.hangupPending.voiced = true;
        if (this.holding) this.held.push([fromBase64(audio.data), rate]);
        else this.play(fromBase64(audio.data), rate);
      }
      if (content.turnComplete) {
        this.replying = false;
        this.flushTranscript("turn");
        const tools = this.toolsThisTurn;
        const voiced = this.voicedThisTurn;
        this.toolsThisTurn = [];
        this.voicedThisTurn = false;
        if (this.hangupPending?.voiced) this.hangUp();
        else if (tools.includes("end_call")) {
          // Its goodbye came before end_call in this same turn: done. Asking again
          // made it say goodbye twice (4 Nov 2026).
          if (voiced) this.hangUp();
          else {
            this.handlers.trace("AI agent: silent after a tool call — asking it to say goodbye");
            this.socket?.send(JSON.stringify({ realtimeInput: { text: SAY_GOODBYE_NOTE } }));
          }
        } else if (!voiced && tools.some((tool) => tool !== "wait_for_them")) {
          // Spoke nothing at all this turn: it went quiet after the tool. A turn that
          // spoke (often ending in a question) waits for the person instead.
          this.handlers.trace("AI agent: silent after a tool call — asking it to carry on");
          this.socket?.send(JSON.stringify({ realtimeInput: { text: CARRY_ON_NOTE } }));
        }
      }
    }

    for (const call of message.toolCall?.functionCalls ?? []) {
      this.toolsThisTurn.push(call.name);
      const text = (key: string) => (typeof call.args?.[key] === "string" && (call.args[key] as string).trim() ? (call.args[key] as string).trim() : null);
      if (call.name === "record_outcome") {
        const outcome = text("outcome") as AgentOutcomeKind | null;
        this.respond(call);
        if (!outcome) continue;
        this.handlers.trace(`AI agent: outcome ${outcome}${text("when") ? ` (${text("when")})` : ""} — ${text("summary") ?? ""}`);
        this.handlers.outcome({ outcome, summary: text("summary"), when: text("when"), whenAt: text("whenAt") });
      } else if (call.name === "wait_for_them") {
        this.respond(call);
        this.waitingUntil = Date.now() + WAIT_FOR_THEM_MS;
        this.handlers.trace(`AI agent: asked to hold on — waiting up to ${WAIT_FOR_THEM_MS / 1000} s for them`);
      } else if (call.name === "end_call") {
        const reason = text("reason") ?? "the agent ended the call";
        this.respond(call);
        this.ending = true;
        if (this.hangupPending) continue;
        this.handlers.trace(`AI agent: ending the call after its goodbye (${reason})`);
        const pending = { reason, voiced: false, timers: [] as ReturnType<typeof setTimeout>[] };
        pending.timers.push(
          setTimeout(() => !pending.voiced && this.hangUp(), HANGUP_NO_VOICE_MS),
          setTimeout(() => this.hangUp(), HANGUP_MAX_WAIT_MS),
        );
        this.hangupPending = pending;
      }
    }

    if (message.goAway) this.handlers.trace(`AI agent: Gemini will close the session in ${message.goAway.timeLeft ?? "?"}`);
  }

  private hangUp(): void {
    const pending = this.hangupPending;
    if (!pending || this.closed) return;
    for (const timer of pending.timers) clearTimeout(timer);
    this.hangupPending = null;
    this.handlers.trace(`AI agent: hanging up (${pending.reason})`);
    this.handlers.hangup(pending.reason);
  }

  private respond(call: { id: string; name: string }): void {
    this.socket?.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: call.id, name: call.name, response: { ok: true } }] } }));
  }

  private flushHeard(): void {
    console.info("[agentsdr agent] lead:", this.heardThisTurn.trim());
    this.handlers.trace(`lead: ${this.heardThisTurn.trim()}`);
    this.handlers.transcript?.("lead", this.heardThisTurn.trim(), "turn");
    this.heardThisTurn = "";
  }

  private flushTranscript(why: string): void {
    if (this.heardThisTurn) this.flushHeard();
    if (this.saidThisTurn) {
      console.info(`[agentsdr agent] agent (${why}):`, this.saidThisTurn.trim());
      this.handlers.trace(`agent (${why}): ${this.saidThisTurn.trim()}`);
      this.handlers.transcript?.("agent", this.saidThisTurn.trim(), why === "interrupted" ? "interrupted" : "turn");
    }
    this.saidThisTurn = "";
  }
}

/** The fields of a BidiGenerateContent server message this reads. */
type LiveServerMessage = {
  setupComplete?: object;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    interrupted?: boolean;
    turnComplete?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  toolCall?: { functionCalls?: { id: string; name: string; args?: Record<string, unknown> }[] };
  goAway?: { timeLeft?: string };
};

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
