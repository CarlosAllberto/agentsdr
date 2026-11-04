/**
 * The shapes shared by the app, its API, and the call-recorder extension
 * (extensions/whatsapp-recorder imports these as types only). Pure types and
 * constants — safe to import from client components and the extension.
 *
 * The flow:
 *   1. The rep clicks Call. The page POSTs /api/calls (cookie-authenticated)
 *      and gets back the call id and a one-time recorder token.
 *   2. The page hands both to the extension over window.postMessage
 *      (RecorderBridge messages below). The extension opens the chat, places
 *      the call, and records it.
 *   3. The extension reports to /api/call-recorder/calls/:id/* with
 *      `Authorization: Bearer <token>` — it never holds the site's cookie.
 *      The recording goes straight to R2 through a presigned PUT URL.
 */

import type { CloudCallPhase } from "./stationContract";

export const CALL_STATUSES = ["pending", "in_progress", "recorded", "no_recording", "failed"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/** Statuses after which the recorder token stops working. */
export const TERMINAL_CALL_STATUSES: readonly CallStatus[] = ["recorded", "no_recording", "failed"];

// --- A campaign lead's call status ------------------------------------------

/**
 * Where calling a lead stands. Set automatically from each call's result
 * (src/lib/calls/contactCallStatus.ts), and by the rep where the extension
 * cannot tell — a declined call looks the same as an unanswered one, and a
 * wrong number looks connected. Separate from the lead's status, which is
 * their CRM stage: the one email and LinkedIn share.
 */
export const CONTACT_CALL_STATUSES = [
  "new",
  "calling",
  "no_answer",
  "busy",
  "connected",
  "not_on_whatsapp",
  "wrong_number",
  "failed",
] as const;
export type ContactCallStatus = (typeof CONTACT_CALL_STATUSES)[number];

export type ContactCallStatusDefinition = {
  label: string;
  tone: "gray" | "blue" | "orange" | "green" | "red";
  /** The rep may set it by hand. */
  manual: boolean;
  /**
   * The message offered after a call ending in this status, editable before
   * it opens in WhatsApp. {{firstName}} resolves to the lead's first name (or
   * "there"). Null when no message fits.
   */
  template: string | null;
};

export const CONTACT_CALL_STATUS_DEFINITIONS: Record<ContactCallStatus, ContactCallStatusDefinition> = {
  new: { label: "Not called", tone: "gray", manual: false, template: null },
  calling: { label: "Calling…", tone: "blue", manual: false, template: null },
  no_answer: {
    label: "Didn't pick up",
    tone: "orange",
    manual: true,
    template: "Hi {{firstName}}, I just tried calling you. Is there a good time for a quick 2-minute call?",
  },
  busy: {
    label: "Busy / declined",
    tone: "orange",
    manual: true,
    template: "Hi {{firstName}}, sorry to catch you at a busy moment. When would suit you for a quick call?",
  },
  connected: {
    label: "Connected",
    tone: "green",
    manual: true,
    template: "Hi {{firstName}}, great speaking with you just now. As discussed, ",
  },
  not_on_whatsapp: { label: "Not on WhatsApp", tone: "red", manual: true, template: null },
  wrong_number: { label: "Wrong number", tone: "red", manual: true, template: null },
  failed: { label: "Call failed", tone: "red", manual: false, template: null },
};

/**
 * The retry schedule for a lead who doesn't pick up (or is busy): after the
 * n-th such call in a row, they are due again RETRY_AFTER_DAYS[n-1] days
 * later. One more unanswered call after the last step and the lead is done.
 */
export const RETRY_AFTER_DAYS = [1, 2, 4] as const;

// --- The lead's CRM stage ---------------------------------------------------

/** The four fixed CRM categories (crm/schema.ts CrmCategoryKey). */
export const LEAD_STAGE_CATEGORIES = ["interested", "customer", "not_interested", "other"] as const;
export type LeadStageCategory = (typeof LEAD_STAGE_CATEGORIES)[number];

/** A lead's CRM stage as Calling shows it. */
export type CampaignContactCrm = {
  recordId: string;
  categoryKey: LeadStageCategory | null;
  subcategoryId: string | null;
  subcategoryName: string | null;
  /** Who set it: a rep ("human"), or the call transcript's analysis ("integration"). */
  categorySource: "ai" | "human" | "integration" | null;
};

// --- Per-call outcomes (legacy) ----------------------------------------------

/**
 * What a rep marked on a call before call status and CRM stages replaced it
 * (Sep 2026). Nothing sets it any more; it stays so older calls keep showing
 * their outcome.
 */
export const CALL_DISPOSITIONS = [
  "no_answer",
  "busy",
  "not_on_whatsapp",
  "wrong_number",
  "interested",
  "meeting_booked",
  "callback",
  "send_details",
  "not_interested",
  "do_not_call",
] as const;
export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

/** Which tab a campaign contact sits in. */
export const CAMPAIGN_CONTACT_STAGES = ["to_call", "follow_up", "done"] as const;
export type CampaignContactStage = (typeof CAMPAIGN_CONTACT_STAGES)[number];

export const CAMPAIGN_CONTACT_STAGE_LABELS: Record<CampaignContactStage, string> = {
  to_call: "To call",
  follow_up: "Follow-up",
  done: "Done",
};

export type CallDispositionDefinition = {
  label: string;
  /** Whether the rep actually spoke to someone. */
  connected: boolean;
  /** The tab the contact moves to when this outcome is marked. */
  stage: CampaignContactStage;
  /** The outcome needs a follow-up date ("call back Tuesday 4 pm"). */
  asksForFollowUpAt?: boolean;
  /**
   * The message offered right after marking the outcome, editable before it
   * opens in WhatsApp. {{firstName}} resolves to the lead's first name (or
   * "there"). Null when a message would be wrong — a do-not-call request.
   */
  template: string | null;
};

export const CALL_DISPOSITION_DEFINITIONS: Record<CallDisposition, CallDispositionDefinition> = {
  no_answer: {
    label: "No answer",
    connected: false,
    stage: "to_call",
    template: "Hi {{firstName}}, I just tried calling you. Is there a good time for a quick 2-minute call?",
  },
  busy: {
    label: "Busy / declined",
    connected: false,
    stage: "to_call",
    template: "Hi {{firstName}}, sorry to catch you at a busy moment. When would suit you for a quick call?",
  },
  not_on_whatsapp: { label: "Not on WhatsApp", connected: false, stage: "done", template: null },
  wrong_number: { label: "Wrong number", connected: false, stage: "done", template: null },
  interested: {
    label: "Interested",
    connected: true,
    stage: "follow_up",
    asksForFollowUpAt: true,
    template: "Hi {{firstName}}, great speaking with you just now. As discussed, ",
  },
  meeting_booked: {
    label: "Meeting booked",
    connected: true,
    stage: "follow_up",
    asksForFollowUpAt: true,
    template: "Hi {{firstName}}, thanks for your time today. Confirming our meeting on ",
  },
  callback: {
    label: "Call back later",
    connected: true,
    stage: "follow_up",
    asksForFollowUpAt: true,
    template: "Hi {{firstName}}, thanks for picking up. I'll call you back as agreed on ",
  },
  send_details: {
    label: "Send details",
    connected: true,
    stage: "follow_up",
    asksForFollowUpAt: true,
    template: "Hi {{firstName}}, thanks for the chat. Here are the details I mentioned: ",
  },
  not_interested: {
    label: "Not interested",
    connected: true,
    stage: "done",
    template: "Hi {{firstName}}, thanks for your time today. If anything changes, feel free to reach out here.",
  },
  do_not_call: { label: "Do not call", connected: true, stage: "done", template: null },
};

// --- Transcripts ------------------------------------------------------------

export const TRANSCRIPT_STATUSES = ["none", "pending", "done", "failed"] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

export type CallTranscript = {
  /** e.g. "hi", "en", "hi-en" for Hinglish, as the model reports it. */
  language: string | null;
  /** Two or three sentences, in English. */
  summary: string;
  utterances: { startSeconds: number; speaker: "rep" | "lead"; text: string }[];
  /** "provider/model" that produced it. */
  model: string;
};

// --- App API (cookie-authenticated) ----------------------------------------

/** POST /api/calls */
export type StartCallRequest = {
  personId: string;
  crmRecordId?: string | null;
  campaignContactId?: string | null;
  /**
   * Required when the person has no phone yet. When given, it is normalized
   * to E.164 and saved to people.phone — replacing a number the rep has just
   * corrected — and the call dials it.
   */
  phone?: string | null;
  /**
   * "agent_cloud": the AI agent places the call from a cloud calling station
   * instead of the rep's browser — queued for the call worker, which opens the
   * station's WhatsApp Web (see stationContract.ts). Needs `agentBrief`.
   */
  mode?: "agent_cloud" | null;
  agentBrief?: string | null;
  /** The agent's name and voice for a cloud call; null = the defaults. */
  agentName?: string | null;
  agentVoice?: string | null;
  /** The station to call from; null or absent = any free active station. */
  stationId?: string | null;
  /**
   * With "agent_cloud": the rep talks instead of the AI agent, from this tab,
   * through the station (see "a rep talking through a calling station"). `agentBrief` is then not needed.
   */
  remoteRep?: boolean | null;
};

export type StartCallResponse = {
  call: CallSummary;
  /** Bearer token for the /api/call-recorder routes of this one call. */
  recorderToken: string;
  /** Who is being called, for the extension's call card. */
  lead: RecorderLead;
};

/** Enough about the lead for the call card on web.whatsapp.com. */
export type RecorderLead = {
  name: string | null;
  /** "Founder · Acme", when known. */
  detail: string | null;
  /** For the WhatsApp contact the extension saves: "Rahul (Acme)". */
  firstName: string | null;
  company: string | null;
};

/** GET /api/calls?personId=… */
export type ListCallsResponse = { calls: CallSummary[] };

export type CallSummary = {
  id: string;
  personId: string;
  crmRecordId: string | null;
  campaignContactId: string | null;
  /** E.164, e.g. "+919876543210". */
  phone: string;
  status: CallStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  hasRecording: boolean;
  /** Where the pick-up is in the recording, ms; null or 0 means the start. */
  recordingOffsetMs: number | null;
  error: string | null;
  disposition: CallDisposition | null;
  transcriptStatus: TranscriptStatus;
  createdAt: string;
  /** Who talks: the rep, the AI agent in the rep's browser, or the AI agent on a cloud station. Absent = rep. */
  mode?: "rep" | "agent" | "agent_cloud";
  /** A cloud call's latest phase (the rep's browser hears nothing from the extension for those). */
  livePhase?: CloudCallPhase | null;
  /** The cloud calling station's name, for a cloud call. */
  stationName?: string | null;
  /** What the AI agent reported with record_outcome, once it has. */
  agentOutcome?: AgentOutcome | null;
  /** A cloud call the rep talks on from AgentSDR (no agent). */
  remoteRep?: boolean;
};

/** GET /api/calls/:id — a call with its transcript. */
export type CallDetail = CallSummary & {
  transcript: CallTranscript | null;
  transcriptError: string | null;
};

// POST /api/calls/:id/cancel → CallDetail. The rep's Cancel on a call not yet
// connected: a pending call becomes no_recording; any other is left as is.
// Calls that never report back are closed out by reads on their own (see
// expireStaleCalls in sessions.ts).

// POST /api/calls/:id/transcribe → CallDetail. (Re)runs transcription;
// recording finish also starts it on its own.

// --- Calling section API (cookie-authenticated) ----------------------------

/**
 * A paused campaign is set aside: it moves to the Paused tab. Calling from it
 * still works — nothing in a calling campaign runs on its own to stop.
 */
export const CALL_CAMPAIGN_STATUSES = ["active", "paused"] as const;
export type CallCampaignStatus = (typeof CALL_CAMPAIGN_STATUSES)[number];

/** How far a campaign has got, for the campaigns list. Counts of leads, not calls. */
export type CampaignStats = {
  leads: number;
  /** Called at least once. */
  called: number;
  /** Picked up at least once. */
  connected: number;
  /** Their CRM stage is Interested or Customer. */
  interested: number;
};

export type CampaignSummary = {
  id: string;
  name: string;
  description: string | null;
  status: CallCampaignStatus;
  counts: Record<CampaignContactStage, number>;
  stats: CampaignStats;
  createdAt: string;
};

/** GET /api/calling/campaigns → { campaigns } ; POST → CampaignSummary */
export type ListCampaignsResponse = { campaigns: CampaignSummary[] };
export type CreateCampaignRequest = { name: string; description?: string | null };

export type CampaignContact = {
  id: string;
  campaignId: string;
  stage: CampaignContactStage;
  callStatus: ContactCallStatus;
  statusUpdatedAt: string | null;
  /** Unanswered (or busy) calls in a row — the retry schedule's position. */
  unansweredAttempts: number;
  /** The lead's CRM stage; null until they have a CRM record. */
  crm: CampaignContactCrm | null;
  followUpAt: string | null;
  notes: string | null;
  callCount: number;
  lastCalledAt: string | null;
  person: {
    id: string;
    fullName: string | null;
    firstName: string | null;
    title: string | null;
    companyName: string | null;
    /** The linked company's domain ("acme.com"), when there is one. */
    companyWebsite: string | null;
    /** Their LinkedIn profile, as a full URL. */
    linkedinUrl: string | null;
    /** A photo for the avatar: a link the rep gave, or one uploaded (served by /api/calling/photos/…). */
    profilePictureUrl: string | null;
    email: string | null;
    /** E.164, or null when the lead has none yet. */
    phone: string | null;
  };
  /** The most recent call, for the row's recording / transcript indicators. */
  lastCall: CallSummary | null;
};

/** GET /api/calling/campaigns/:id → the campaign and its contacts. */
export type CampaignDetailResponse = {
  campaign: CampaignSummary;
  contacts: CampaignContact[];
};

/** PATCH /api/calling/campaigns/:id → CampaignSummary. Only the keys given change. */
export type UpdateCampaignRequest = { name?: string; description?: string | null; status?: CallCampaignStatus };

// DELETE /api/calling/campaigns/:id → { ok: true }. Archives the campaign
// (archived_at): it leaves the Calling section, but its contacts' calls,
// recordings and transcripts stay on the people they belong to.

// DELETE /api/calling/contacts/:id → { ok: true }. Takes the person off the
// campaign; the person, their calls and recordings stay.

/**
 * PATCH /api/calling/contacts/:id/person → CampaignContact. Edits the person
 * behind a campaign contact — the People record, shared across AgentSDR, not
 * a campaign-local copy. Only the keys given change; phone is normalized
 * like everywhere else, companyName links (or creates) the company by name.
 */
export type UpdateCampaignContactPersonRequest = {
  fullName?: string;
  phone?: string;
  companyName?: string | null;
  /** The company's website or domain; links (or creates) the company record by it. */
  companyWebsite?: string | null;
  title?: string | null;
  email?: string | null;
  /** An https link to a photo; null removes the photo. */
  profilePictureUrl?: string | null;
};

// POST /api/calling/contacts/:id/photo → CampaignContact. Multipart `file`
// (an image, at most MAX_PHOTO_BYTES), stored in R2 and set as the person's
// photo.
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** POST /api/calling/campaigns/:id/contacts — the add-a-contact form. */
export type AddCampaignContactRequest = {
  fullName: string;
  phone: string;
  companyName?: string | null;
  /** The company's website or domain ("acme.com"): what links a real company record. */
  companyWebsite?: string | null;
  title?: string | null;
  email?: string | null;
};

/**
 * POST /api/calling/campaigns/:id/contacts/import — multipart `file`
 * (CSV or XLSX; headers matched like the People import).
 */
export type ImportCampaignContactsResponse = {
  added: number;
  alreadyInCampaign: number;
  /** Rows skipped, with why ("row 7: no valid phone number"). */
  skipped: string[];
};

/** GET /api/calling/contacts/:id → the contact, their calls and messages. */
export type CampaignContactDetailResponse = {
  contact: CampaignContact;
  calls: CallDetail[];
  messages: CallMessageSummary[];
};

/**
 * PATCH /api/calling/contacts/:id — correct the call status and/or edit. A
 * call status set by hand (only the `manual` ones) follows the same rules as
 * one a call sets: busy counts toward the retry schedule, not on WhatsApp and
 * wrong number finish the lead. `stage` and `followUpAt`, when given, win
 * over what the status would set.
 */
export type UpdateCampaignContactRequest = {
  callStatus?: ContactCallStatus;
  stage?: CampaignContactStage;
  followUpAt?: string | null;
  notes?: string | null;
};

/**
 * PATCH /api/calling/contacts/:id/stage → CampaignContact. Sets the lead's
 * CRM stage by hand — the same stage email and LinkedIn use — creating their
 * CRM record if they have none. subcategoryId null sets the category alone.
 * "Do Not Contact" also sets the person's global Do Not Contact policy.
 */
export type SetLeadStageRequest = { categoryKey: LeadStageCategory; subcategoryId: string | null };

export type CallMessageSummary = {
  id: string;
  callSessionId: string | null;
  phone: string;
  body: string;
  openedAt: string;
};

/**
 * POST /api/calling/contacts/:id/messages — log a follow-up the page is
 * about to open in WhatsApp. Moves a contact that is not done to follow_up.
 */
export type LogCallMessageRequest = { body: string; callId?: string | null };
export type LogCallMessageResponse = { message: CallMessageSummary; contact: CampaignContact };

// GET /api/calls/:id/recording → 302 to a short-lived presigned R2 URL.

// --- Recorder API (Bearer token, called by the extension) -------------------

/** POST /api/call-recorder/calls/:id/started */
export type CallStartedRequest = { startedAt: string };

/** POST /api/call-recorder/calls/:id/upload-url */
export type UploadUrlRequest = { contentType: string; bytes: number };
export type UploadUrlResponse = {
  uploadUrl: string;
  recordingKey: string;
  /** Headers the PUT must send exactly, or the signature fails. */
  headers: Record<string, string>;
};

/**
 * GET /api/call-recorder/calls/:id — what the extension's call card shows
 * after the upload: whether the transcript is ready, and its summary.
 */
export type RecorderCallStatus = {
  status: CallStatus;
  transcriptStatus: TranscriptStatus;
  summary: string | null;
  durationMs: number | null;
};

/** POST /api/call-recorder/calls/:id/finish — idempotent once terminal. */
export type FinishCallRequest =
  | {
      outcome: "recorded";
      recordingKey: string;
      bytes: number;
      contentType: string;
      /** When the lead picked up. */
      startedAt: string;
      endedAt: string;
      /** Talk time, pick-up to hang-up. */
      durationMs: number;
      /**
       * Where the pick-up is in the recording. The extension records from
       * the moment the call opens the microphone, so the lead's first words
       * are not lost to the time it takes to notice the pick-up; the
       * recording therefore starts with some ringing, and players start
       * here. Absent from recorders before 0.11, which started at pick-up.
       */
      recordingOffsetMs?: number;
    }
  | {
      outcome: "no_recording";
      startedAt?: string | null;
      endedAt?: string | null;
      /** Why, when known ("WhatsApp was closed before the call connected"). */
      error?: string | null;
    }
  | { outcome: "failed"; error: string };

export type FinishCallResponse = { call: CallSummary };

/** The largest recording the upload route will sign for (≈ 3 h of Opus). */
export const MAX_RECORDING_BYTES = 200 * 1024 * 1024;

// --- Page ⇄ extension bridge (window.postMessage) --------------------------

/**
 * The extension's content script marks the page when it is installed, so
 * the UI can tell "no extension" apart from "extension did not answer".
 */
export const RECORDER_INSTALLED_ATTRIBUTE = "data-agentsdr-recorder";

/**
 * The oldest extension version that speaks this page's bridge protocol. An
 * unpacked extension does not update itself: after a rebuild Chrome keeps
 * running the old copy until it is reloaded, and an old copy silently
 * ignores requests it does not know. Bump this with any bridge change.
 */
export const MIN_RECORDER_VERSION = "0.7.0";

/** The oldest extension version that can hand a call to the AI voice agent. */
export const MIN_AGENT_RECORDER_VERSION = "0.16.0";

export type RecorderBridgeRequest = RecorderCallRequest | RecorderMessageRequest | RecorderEndCallRequest | RecorderUpdateRequest;

export type RecorderCallRequest = {
  source: "agentsdr-app";
  type: "call:start";
  /** Correlates the reply. */
  requestId: string;
  callId: string;
  /** E.164. */
  phone: string;
  recorderToken: string;
  /** The page's own origin; the extension only talks to allowlisted ones. */
  apiBase: string;
  lead: RecorderLead | null;
  /** Epoch ms of the rep's click, so the extension can time each step from it. */
  clickedAt?: number;
  /** Set: the AI voice agent talks to the lead instead of the rep (trial). */
  agent?: RecorderAgent | null;
  /** Set (station mode only): the rep talks from their AgentSDR tab, through this station. */
  remoteRep?: boolean | null;
};

// --- a rep talking through a calling station ---------------------------------

/**
 * A rep's call placed from a cloud calling station's WhatsApp, with the rep
 * at their own AgentSDR tab ("Call now"). AgentSDR relays the audio: each
 * side sends its audio up and reads the other side's from one long streaming
 * response. No WebRTC: a GoLogin station's browser rewrites and strips WebRTC
 * (29 Oct 2026), and both sides already reach AgentSDR.
 *
 *   rep's tab    POST /api/calls/:id/relay        (cookie; body: PCM)
 *                GET  /api/calls/:id/relay        (cookie; NDJSON RepRelayEvent stream)
 *                POST /api/calls/:id/relay/hangup (cookie)
 *   station      POST /api/call-recorder/calls/:id/relay  (Bearer recorder token; body: PCM)
 *                GET  /api/call-recorder/calls/:id/relay  (Bearer recorder token; NDJSON stream)
 *                — CORS-allowed for https://web.whatsapp.com (the extension's
 *                content script fetches as the page's origin).
 *
 * Up, each side holds ONE long POST open whose body is a stream of PCM
 * (REP_RELAY_STREAM_HEADER: 1; Chrome streams a request body over HTTP/2 or
 * newer only), and starts a fresh one every REP_RELAY_STREAM_ROTATE_MS. The
 * relay answers the stream's first audio with an `uplink` event on that
 * side's down stream, so a sender learns its stream really arrives (nothing
 * in between holds it back). A stream that cannot start, or is not heard,
 * twice in a row before any worked, sends the rest of the call as small POSTs
 * instead (~REP_RELAY_CHUNK_MS each, one in flight): one request a chunk
 * costs a round trip each, ~1 s through the app (29 Oct 2026), which is why
 * the stream exists. Either way a sender's backlog is capped at
 * REP_RELAY_MAX_CHUNK_MS, oldest dropped.
 *
 * Audio both ways: mono 16-bit little-endian PCM at REP_RELAY_SAMPLE_RATE.
 * The station plays the rep's audio into WhatsApp's microphone exactly as it
 * plays the AI agent's, and sends the lead's side from dialing on (the rep
 * hears it ring). The relay lives in the app process's memory: one app
 * instance, as deployed today.
 */

export const REP_RELAY_SAMPLE_RATE = 16_000;
/** Senders batch about this much audio per POST (chunked, the fallback). */
export const REP_RELAY_CHUNK_MS = 40;
/** A POST carrying more than this much audio is refused; a sender's backlog never holds more. */
export const REP_RELAY_MAX_CHUNK_MS = 1_000;
/** Marks a POST whose body is a stream of PCM (value "1"), read as it arrives. */
export const REP_RELAY_STREAM_HEADER = "X-Relay-Stream";
/**
 * Senders start a new upload stream this often, ending the old one. Proxies
 * limit how long reading one request may take (Traefik v3: 60 s, body
 * included), and a long call outlasts that.
 */
export const REP_RELAY_STREAM_ROTATE_MS = 45_000;
/** The relay ends an upload stream that has run this long (a sender rotates far sooner). */
export const REP_RELAY_STREAM_MAX_MS = 5 * 60_000;
/** Players hold this much before starting to play, to ride out network jitter. */
export const REP_RELAY_JITTER_MS = 100;
/** Players drop queued audio past this much, to catch up after a stall. */
export const REP_RELAY_MAX_BUFFER_MS = 400;
/** A down stream sends a ping this often, so proxies keep it open. */
export const REP_RELAY_PING_MS = 5_000;
/** The rep's down stream gone this long while the call is on: the station is told to hang up. */
export const REP_RELAY_REP_GONE_MS = 10_000;

export type RepRelaySide = "rep" | "station";

/** One line of a relay down stream (newline-delimited JSON). */
export type RepRelayEvent =
  /** The other side's audio: base64 of mono 16-bit LE PCM at REP_RELAY_SAMPLE_RATE. */
  | { t: "audio"; pcm: string }
  /** Whether the other side is connected (its down stream is open). */
  | { t: "peer"; present: boolean }
  /** To the station only: the rep hung up, or their tab left — end the WhatsApp call. */
  | { t: "hangup" }
  /** This side's upload stream delivered audio: streaming works (sent once per stream, and again on reconnecting). */
  | { t: "uplink" }
  | { t: "ping" };

// --- AI voice agent (trial) --------------------------------------------------

/**
 * What the rep asks of the AI voice agent for one call. The agent speaks in
 * the call through Gemini Live: the lead's audio goes to the model and the
 * model's voice is what WhatsApp sends as the "microphone".
 */
export type RecorderAgent = {
  /** The rep's instructions: what the agent is calling about and what it should get. */
  brief: string;
  /** The name the agent introduces itself by (DEFAULT_AGENT_NAME when unset). */
  name?: string | null;
  /** One of AGENT_VOICES (DEFAULT_AGENT_VOICE when unset). */
  voice?: string | null;
};

/** The longest brief the agent-token route accepts. */
export const MAX_AGENT_BRIEF_CHARS = 4_000;
export const MAX_AGENT_NAME_CHARS = 40;

/**
 * Gemini Live's preset voices offered for the agent. The voice is fixed per
 * call; `gender` sets the grammar the agent uses for itself in Hindi.
 */
export const AGENT_VOICES = [
  { id: "Kore", label: "Kore — firm, female", gender: "female" },
  { id: "Aoede", label: "Aoede — breezy, female", gender: "female" },
  { id: "Leda", label: "Leda — youthful, female", gender: "female" },
  { id: "Sulafat", label: "Sulafat — warm, female", gender: "female" },
  { id: "Despina", label: "Despina — smooth, female", gender: "female" },
  { id: "Puck", label: "Puck — upbeat, male", gender: "male" },
  { id: "Charon", label: "Charon — informative, male", gender: "male" },
  { id: "Achird", label: "Achird — friendly, male", gender: "male" },
] as const;
export type AgentVoiceId = (typeof AGENT_VOICES)[number]["id"];
export const DEFAULT_AGENT_VOICE: AgentVoiceId = "Kore";
/** Without a name the model invented a new one every call (27 Oct 2026). */
export const DEFAULT_AGENT_NAME = "Riya";

/** POST /api/call-recorder/calls/:id/agent-token — from the extension's service worker. */
export type AgentTokenRequest = { brief: string; lead: RecorderLead | null; name?: string | null; voice?: string | null };

/** How an agent call went, as the agent recorded it (its record_outcome tool). */
export const AGENT_OUTCOMES = [
  "meeting_booked",
  "interested",
  "human_callback",
  "call_back",
  "not_interested",
  "wrong_person",
  "do_not_contact",
  "no_response",
  "other",
] as const;
export type AgentOutcomeKind = (typeof AGENT_OUTCOMES)[number];
export const AGENT_OUTCOME_LABELS: Record<AgentOutcomeKind, string> = {
  meeting_booked: "Meeting agreed",
  interested: "Interested",
  human_callback: "Wants the team to call",
  call_back: "Call back",
  not_interested: "Not interested",
  wrong_person: "Wrong person",
  do_not_contact: "Do not contact",
  no_response: "No response",
  other: "Other",
};

/** POST /api/call-recorder/calls/:id/outcome — and stored as call_sessions.agent_outcome. */
export type AgentOutcome = {
  outcome: AgentOutcomeKind;
  /** One sentence on how the call went. */
  summary: string | null;
  /** The meeting or call-back time as agreed, in the person's words ("Thursday around 4"). */
  when: string | null;
  /** The same time as an exact instant (ISO 8601 with offset), when the agent could work it out. */
  whenAt?: string | null;
  recordedAt: string;
};

/**
 * A single-use Gemini Live token with the session (model, voice, instructions,
 * tools) locked into it server-side; the API key never leaves the server.
 */
export type AgentTokenResponse = {
  token: string;
  model: string;
  websocketUrl: string;
  /**
   * Test option (AGENT_SAVE_HEARD_AUDIO=true on the server): keep exactly the
   * audio sent to the model — the lead's side, 16 kHz mono — and upload it as
   * a WAV after the call (POST …/heard-audio), to hear what the AI heard.
   */
  saveHeardAudio?: boolean;
  /**
   * The call notes the agent is sent mid-call ("[Call note: …]"), from the
   * server's prompts (Langfuse); an extension without them uses its own copies.
   */
  notes?: AgentCallNotes;
};

export type AgentCallNotes = {
  greeting: string;
  silenceCheck: string;
  carryOn: string;
  sayGoodbye: string;
  silenceGoodbye: string;
};

/** POST /api/call-recorder/calls/:id/heard-audio — body: audio/wav. */
export const MAX_HEARD_AUDIO_BYTES = 40 * 1024 * 1024;

/** Opens the chat with `text` typed in; the rep reads it and presses Enter. */
export type RecorderMessageRequest = {
  source: "agentsdr-app";
  type: "message:open";
  requestId: string;
  /** E.164. */
  phone: string;
  text: string;
};

/** Hangs up the call from AgentSDR: presses WhatsApp's own End call button. */
export type RecorderEndCallRequest = {
  source: "agentsdr-app";
  type: "call:end";
  requestId: string;
  callId: string;
};

/**
 * Opens the extension's own Update page, which installs this deployment's
 * build into the folder the extension was loaded from. Extension 0.14.0+.
 */
export type RecorderUpdateRequest = {
  source: "agentsdr-app";
  type: "recorder:update";
  requestId: string;
};

export type RecorderBridgeReply = {
  source: "agentsdr-recorder";
  requestId: string;
} & (
  | { type: "call:accepted" | "message:opened" | "call:end-accepted" | "recorder:update-opened" }
  | { type: "call:rejected" | "message:rejected" | "call:end-rejected" | "recorder:update-rejected"; error: string }
);

/**
 * Where a call placed from AgentSDR stands, as the extension sees it on
 * web.whatsapp.com. Shown by the call card there, and pushed to the AgentSDR
 * tab that placed the call (RecorderCallUpdate), so the rep can stay there.
 */
export type RecorderCallPhase =
  | { kind: "opening" }
  | { kind: "calling" }
  | { kind: "ringing" }
  /** Picked up; recording. `answeredAt` is epoch ms. */
  | { kind: "on-call"; answeredAt: number; timerSeen: boolean }
  /** The extension couldn't press Voice call; the rep must. Recording is still automatic. */
  | { kind: "manual-dial" }
  /** Chrome held back the call's audio until the rep clicks in the WhatsApp tab. */
  | { kind: "audio-blocked" }
  | { kind: "not-answered" }
  /** `noCallButton`: the chat opened but WhatsApp offers no call — a business number. */
  | { kind: "not-on-whatsapp"; noCallButton?: boolean }
  | { kind: "processing"; durationMs: number; step: "uploading" | "transcribing" }
  | { kind: "done"; durationMs: number; summary: string | null; transcriptFailed: boolean }
  | { kind: "error"; message: string; savedLocally: boolean };

/** Extension → page, unprompted: a call's phase changed. */
export type RecorderCallUpdate = {
  source: "agentsdr-recorder";
  type: "call:update";
  callId: string;
  phase: RecorderCallPhase;
};
