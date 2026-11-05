import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { WeeklyHours } from "@/lib/channels/rules";
import type { AiCallResult, AiCampaignGoal, AiCampaignStep, AiContactStatus, AiStepRunKind, AiStepRunStatus } from "./aiCampaigns/contract";
import { crmRecords } from "@/lib/crm/schema";
import { people } from "@/lib/leads/schema";
import type {
  AgentOutcome,
  CallCampaignStatus,
  CallDisposition,
  CallStatus,
  CallTranscript,
  CampaignContactStage,
  ContactCallStatus,
  TranscriptStatus,
} from "./contract";
import { organizations } from "@/lib/auth/schema";
import type { CallTimelineEntry, CloudCallPhase, ProxyProtocol, StationLauncher, StationStatus } from "./stationContract";

/** Who talks on a call: the rep, the AI agent in the rep's browser, or the AI agent on a cloud station. */
export type CallMode = "rep" | "agent" | "agent_cloud";
/** Who placed the call: AgentSDR, or the lead calling a station back (the AI agent answered). */
export type CallDirection = "outbound" | "inbound";
/**
 * A cloud call the rep talks on: only a marker, `{}`. Rows written before the
 * audio relay may still hold the old WebRTC offer and answer; nothing reads them.
 */
export type CallRemoteRep = Record<string, unknown>;

/**
 * An outbound IP (static ISP / residential proxy) a calling number's browser
 * uses; each is assigned to at most one number. The password is encrypted
 * (integrations' credential crypto). scripts/create-calling-proxies.ts.
 */
export const callingProxies = pgTable(
  "calling_proxies",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    protocol: text("protocol").notNull().$type<ProxyProtocol>(),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    username: text("username"),
    passwordEncrypted: text("password_encrypted"),
    /** ISO 3166 alpha-2, e.g. "IN". */
    country: text("country"),
    /** IANA zone the browser shows while on this IP. */
    timezone: text("timezone"),
    provider: text("provider"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("calling_proxies_organization_idx").on(table.organizationId),
    check("calling_proxies_protocol_chk", sql`${table.protocol} IN ('http', 'socks5')`),
    check("calling_proxies_port_chk", sql`${table.port} BETWEEN 1 AND 65535`),
  ],
);

/**
 * A cloud calling station: one WhatsApp number whose WhatsApp Web runs in a
 * remote browser that the call worker opens (services/call-worker). Created by
 * scripts/create-calling-stations.ts; see src/lib/calls/stationContract.ts.
 */
export const callingStations = pgTable(
  "calling_stations",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** E.164. */
    phone: text("phone").notNull(),
    launcher: text("launcher").notNull().default("cloak").$type<StationLauncher>(),
    gologinProfileId: text("gologin_profile_id"),
    status: text("status").notNull().default("onboarding").$type<StationStatus>(),
    /** Set while the operator wants WhatsApp Web linked; the worker shows its login screen. */
    linkRequestedAt: timestamp("link_requested_at", { withTimezone: true }),
    linkCode: text("link_code"),
    /** PNG data URL of the login screen (QR or code), cleared once linked. */
    linkScreenshot: text("link_screenshot"),
    linkUpdatedAt: timestamp("link_updated_at", { withTimezone: true }),
    /** The requested link starts from a logged-out browser (the session was the wrong account). */
    linkFresh: boolean("link_fresh").notNull().default(false),
    workerId: text("worker_id"),
    /**
     * The call worker keeping this number's WhatsApp Web open, until when
     * (renewed every 20 s). Only the holder runs its calls and links, so the
     * profile is never open twice. scripts/add-calling-station-lease.ts.
     */
    leaseHolder: text("lease_holder"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastCallAt: timestamp("last_call_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** The IP its browser goes out from; unique, so numbers never share one. */
    proxyId: uuid("proxy_id"),
    /**
     * CloakBrowser's fingerprint seed (10000–99999): the number's device
     * identity, kept here so it survives the worker's disk. Set at creation.
     */
    fingerprintSeed: integer("fingerprint_seed")
      .notNull()
      .default(sql`(floor(random() * 90000) + 10000)::int`),
    /** The saved browser profile in R2 (tar.gz), its size, version and save time. 0 = never saved. */
    profileKey: text("profile_key"),
    profileBytes: integer("profile_bytes"),
    profileVersion: integer("profile_version").notNull().default(0),
    profileSavedAt: timestamp("profile_saved_at", { withTimezone: true }),
    /** The account its WhatsApp Web is logged in as (E.164), as the worker last read it. */
    linkedPhone: text("linked_phone"),
    /** AI campaign calls a day from this number; null = the organization's rule. scripts/add-ai-calling-campaigns.ts. */
    callsPerDay: integer("calls_per_day"),
    /** When AI campaigns may call from this number; null = the organization's rule (WeeklyHours). */
    callingHours: jsonb("calling_hours").$type<WeeklyHours>(),
    /** AI campaigns place no call from it before this (the random gap after the last). */
    nextCallAt: timestamp("next_call_at", { withTimezone: true }),
    /** Its first AI campaign call: starts the warm-up ramp. */
    automationStartedAt: timestamp("automation_started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("calling_stations_organization_idx").on(table.organizationId),
    foreignKey({
      columns: [table.proxyId],
      foreignColumns: [callingProxies.id],
      name: "calling_stations_proxy_fk",
    }).onDelete("set null"),
    uniqueIndex("calling_stations_proxy_uq").on(table.proxyId).where(sql`${table.proxyId} IS NOT NULL`),
    check("calling_stations_seed_chk", sql`${table.fingerprintSeed} BETWEEN 10000 AND 99999`),
    unique("calling_stations_org_phone_uq").on(table.organizationId, table.phone),
    check("calling_stations_launcher_chk", sql`${table.launcher} IN ('cloak', 'local', 'gologin_sdk', 'gologin_cloud')`),
    check(
      "calling_stations_status_chk",
      sql`${table.status} IN ('onboarding', 'active', 'paused', 'logged_out', 'banned')`,
    ),
  ],
);

/**
 * A cold-calling campaign: the list of people a rep works through. Created
 * with the rest of the calling tables by scripts/create-call-campaigns.ts.
 */
export const callCampaigns = pgTable(
  "call_campaigns",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active").$type<CallCampaignStatus>(),
    /**
     * Who places the calls: a rep working through the list, or the AI agent
     * on its own (src/lib/calls/aiCampaigns/). scripts/add-ai-calling-campaigns.ts
     * adds this and every ai_* column below.
     */
    runBy: text("run_by").notNull().default("rep").$type<"rep" | "ai">(),
    aiGoal: text("ai_goal").notNull().default("book_meeting").$type<AiCampaignGoal>(),
    aiInstructions: text("ai_instructions").notNull().default(""),
    aiAgentName: text("ai_agent_name"),
    aiAgentVoice: text("ai_agent_voice"),
    aiSteps: jsonb("ai_steps").$type<AiCampaignStep[]>().notNull().default([]),
    aiChaseSteps: jsonb("ai_chase_steps").$type<AiCampaignStep[]>().notNull().default([]),
    aiBookingUrl: text("ai_booking_url"),
    aiBookingMessage: text("ai_booking_message"),
    aiMaxCallbacks: integer("ai_max_callbacks").notNull().default(2),
    /**
     * The CRM Knowledge documents its calls know (crm_knowledge_documents ids).
     * Null: the organization's documents marked "always include", as for a
     * call placed by hand. scripts/add-ai-campaign-knowledge.ts.
     */
    aiKnowledgeIds: uuid("ai_knowledge_ids").array(),
    /** First switched on; a draft AI campaign (null) places no calls. */
    aiLaunchedAt: timestamp("ai_launched_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("call_campaigns_organization_idx").on(table.organizationId),
    check("call_campaigns_name_chk", sql`length(btrim(${table.name})) > 0`),
    check("call_campaigns_status_chk", sql`${table.status} IN ('active', 'paused')`),
    check("call_campaigns_run_by_chk", sql`${table.runBy} IN ('rep', 'ai')`),
    check("call_campaigns_ai_goal_chk", sql`${table.aiGoal} IN ('book_meeting', 'human_callback', 'either')`),
    check("call_campaigns_ai_max_callbacks_chk", sql`${table.aiMaxCallbacks} BETWEEN 0 AND 3`),
  ],
);

/** The calling numbers an AI campaign places its calls (and sends its messages) from. */
export const callCampaignStations = pgTable(
  "call_campaign_stations",
  {
    campaignId: uuid("campaign_id").notNull(),
    stationId: uuid("station_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "call_campaign_stations_pkey", columns: [table.campaignId, table.stationId] }),
    foreignKey({ columns: [table.campaignId], foreignColumns: [callCampaigns.id], name: "call_campaign_stations_campaign_fk" }).onDelete("cascade"),
    foreignKey({ columns: [table.stationId], foreignColumns: [callingStations.id], name: "call_campaign_stations_station_fk" }).onDelete("cascade"),
    index("call_campaign_stations_station_idx").on(table.stationId),
  ],
);

/**
 * A person in a campaign. `stage` is which tab they sit in; `status` is the
 * outcome of the latest call (or "new"). The person itself lives in `people`,
 * so one lead keeps one identity across email, LinkedIn and calls.
 */
export const callCampaignContacts = pgTable(
  "call_campaign_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").notNull(),
    personId: uuid("person_id").notNull(),
    stage: text("stage").notNull().default("to_call").$type<CampaignContactStage>(),
    /**
     * The outcome a rep marked, before call_status replaced it (Sep 2026).
     * Nothing writes it any more; kept so a deployment still running the old
     * code keeps working against the shared database. Drop it once none is.
     */
    status: text("status").notNull().default("new").$type<CallDisposition | "new">(),
    /** Where calling this lead stands; see src/lib/calls/contactCallStatus.ts. */
    callStatus: text("call_status").notNull().default("new").$type<ContactCallStatus>(),
    statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }),
    /** Unanswered (or busy) calls in a row — the retry schedule's position. */
    unansweredAttempts: integer("unanswered_attempts").notNull().default(0),
    /** When to get back to them — a callback time, or a follow-up date. */
    followUpAt: timestamp("follow_up_at", { withTimezone: true }),
    notes: text("notes"),
    callCount: integer("call_count").notNull().default(0),
    lastCalledAt: timestamp("last_called_at", { withTimezone: true }),
    /** AI campaigns only (null for a rep's list): where the lead stands; see aiCampaigns/contract.ts. */
    aiStatus: text("ai_status").$type<AiContactStatus>(),
    /** The next step of the sequence its status runs (steps or chase steps), 0-based. */
    aiStep: integer("ai_step").notNull().default(0),
    /** When the engine may act on it next. */
    aiNextAt: timestamp("ai_next_at", { withTimezone: true }),
    /** The number it is called from, fixed by its first call so a lead always hears the same number. */
    aiStationId: uuid("ai_station_id"),
    aiCallbacks: integer("ai_callbacks").notNull().default(0),
    /** Failed attempts at the current step (worker errors); the lead fails after a few. */
    aiFailures: integer("ai_failures").notNull().default(0),
    /** Why it stopped or failed, or the last error, for the person reading the list. */
    aiNote: text("ai_note"),
    aiBookedAt: timestamp("ai_booked_at", { withTimezone: true }),
    /** The booked meeting's start, from Cal.com; null when none is booked. scripts/add-ai-meeting-at.ts. */
    aiMeetingAt: timestamp("ai_meeting_at", { withTimezone: true }),
    /**
     * The short code its booking link carries (`metadata[c]`), given when a link
     * is first sent; unique across organizations. scripts/add-ai-booking-code.ts.
     */
    aiBookingCode: text("ai_booking_code"),
    /** Extra instructions for calls to this one lead, on top of the campaign's. scripts/add-ai-lead-instructions.ts. */
    aiInstructions: text("ai_instructions"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.campaignId],
      foreignColumns: [callCampaigns.id],
      name: "call_campaign_contacts_campaign_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.aiStationId],
      foreignColumns: [callingStations.id],
      name: "call_campaign_contacts_ai_station_fk",
    }).onDelete("set null"),
    index("call_campaign_contacts_ai_due_idx").on(table.aiStatus, table.aiNextAt).where(sql`${table.aiStatus} IS NOT NULL`),
    uniqueIndex("call_campaign_contacts_ai_booking_code_uq").on(table.aiBookingCode).where(sql`${table.aiBookingCode} IS NOT NULL`),
    foreignKey({
      columns: [table.personId],
      foreignColumns: [people.id],
      name: "call_campaign_contacts_person_fk",
    }).onDelete("restrict"),
    unique("call_campaign_contacts_campaign_person_uq").on(table.campaignId, table.personId),
    index("call_campaign_contacts_campaign_stage_idx").on(table.campaignId, table.stage),
    check("call_campaign_contacts_stage_chk", sql`${table.stage} IN ('to_call', 'follow_up', 'done')`),
    check("call_campaign_contacts_call_count_chk", sql`${table.callCount} >= 0`),
    check(
      "call_campaign_contacts_call_status_chk",
      sql`${table.callStatus} IN ('new', 'calling', 'no_answer', 'busy', 'connected', 'not_on_whatsapp', 'wrong_number', 'failed')`,
    ),
    check("call_campaign_contacts_unanswered_attempts_chk", sql`${table.unansweredAttempts} >= 0`),
    check(
      "call_campaign_contacts_ai_status_chk",
      sql`${table.aiStatus} IS NULL OR ${table.aiStatus} IN ('queued', 'reaching', 'callback', 'chasing', 'booked', 'handoff', 'not_interested', 'unreached', 'replied', 'stopped', 'failed')`,
    ),
  ],
);

/**
 * A WhatsApp message for a calling station's worker to send through the
 * number's own WhatsApp Web (AgentSDR's messaging, no Unipile). The message
 * itself is a whatsapp_messages row reserved before sending (origin
 * 'agentsdr'); this is the worker's queue entry for it. A station sends one
 * thing at a time: a call and a message never share its page.
 * scripts/add-ai-calling-campaigns.ts.
 */
export const stationMessageJobs = pgTable(
  "station_message_jobs",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    stationId: uuid("station_id").notNull(),
    whatsappMessageId: uuid("whatsapp_message_id").notNull(),
    /** E.164. */
    phone: text("phone").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("queued").$type<"queued" | "claimed" | "sent" | "failed">(),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("station_message_jobs_organization_idx").on(table.organizationId),
    index("station_message_jobs_queue_idx").on(table.stationId, table.createdAt).where(sql`${table.status} IN ('queued', 'claimed')`),
    unique("station_message_jobs_message_uq").on(table.whatsappMessageId),
    foreignKey({ columns: [table.stationId], foreignColumns: [callingStations.id], name: "station_message_jobs_station_fk" }).onDelete("cascade"),
    check("station_message_jobs_status_chk", sql`${table.status} IN ('queued', 'claimed', 'sent', 'failed')`),
  ],
);

/**
 * Each action an AI campaign took for a lead: a call placed or a WhatsApp
 * sent. Inserted before the action, and unique per (lead, step key), so a
 * crash or a second engine can never repeat it; finished when the call or
 * message settles. Step keys: aiCampaigns/contract.ts.
 */
export const callCampaignStepRuns = pgTable(
  "call_campaign_step_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").notNull(),
    stepKey: text("step_key").notNull(),
    kind: text("kind").notNull().$type<AiStepRunKind>(),
    status: text("status").notNull().default("started").$type<AiStepRunStatus>(),
    stationId: uuid("station_id"),
    callSessionId: uuid("call_session_id"),
    whatsappMessageId: uuid("whatsapp_message_id"),
    /** For a call: what it amounted to (AiCallResult). For a message: null. */
    result: text("result").$type<AiCallResult>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({ columns: [table.contactId], foreignColumns: [callCampaignContacts.id], name: "call_campaign_step_runs_contact_fk" }).onDelete("cascade"),
    unique("call_campaign_step_runs_contact_step_uq").on(table.contactId, table.stepKey),
    index("call_campaign_step_runs_call_idx").on(table.callSessionId),
    index("call_campaign_step_runs_message_idx").on(table.whatsappMessageId),
    index("call_campaign_step_runs_open_idx").on(table.status).where(sql`${table.status} = 'started'`),
    check("call_campaign_step_runs_kind_chk", sql`${table.kind} IN ('call', 'message')`),
    check("call_campaign_step_runs_status_chk", sql`${table.status} IN ('started', 'done', 'failed')`),
  ],
);

/**
 * One WhatsApp call placed from the app. The row is created when the rep
 * clicks Call; the recorder extension then reports on it with the per-call
 * token, whose SHA-256 is all the database keeps.
 *
 * The recording itself lives in R2 under `recording_key`; the row is the
 * index into it. scripts/create-call-sessions.ts creates the table.
 */
export const callSessions = pgTable(
  "call_sessions",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id").notNull(),
    /** The CRM record the call was placed from, when there was one. */
    crmRecordId: uuid("crm_record_id"),
    /** The campaign contact the call was placed from, when there was one. */
    campaignContactId: uuid("campaign_contact_id"),
    /** E.164, as dialed ("+919876543210"). */
    phone: text("phone").notNull(),
    status: text("status").notNull().default("pending").$type<CallStatus>(),
    uploadTokenHash: text("upload_token_hash").notNull(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    recordingKey: text("recording_key"),
    recordingBytes: integer("recording_bytes"),
    recordingContentType: text("recording_content_type"),
    /** Where the pick-up is in the recording (ringing before it). scripts/add-call-recording-offset.ts. */
    recordingOffsetMs: integer("recording_offset_ms"),
    error: text("error"),
    /** The outcome the rep marked for this call. */
    disposition: text("disposition").$type<CallDisposition>(),
    transcriptStatus: text("transcript_status").notNull().default("none").$type<TranscriptStatus>(),
    transcript: jsonb("transcript").$type<CallTranscript>(),
    transcriptError: text("transcript_error"),
    transcribedAt: timestamp("transcribed_at", { withTimezone: true }),
    /**
     * Who talks: the rep, the AI agent in the rep's own browser, or the AI
     * agent on a cloud calling station. scripts/create-calling-stations.ts.
     */
    mode: text("mode").notNull().default("rep").$type<CallMode>(),
    /** The calling station a cloud call runs on. */
    stationId: uuid("station_id"),
    /** The rep's brief for the AI agent (cloud calls; a laptop agent call keeps it in the extension). */
    agentBrief: text("agent_brief"),
    /** The agent's name and voice for a cloud call (null: the defaults in contract.ts). scripts/add-call-session-agent-persona.ts. */
    agentName: text("agent_name"),
    agentVoice: text("agent_voice"),
    /** How an agent call went, as the agent recorded it (its record_outcome tool), laptop or cloud. */
    agentOutcome: jsonb("agent_outcome").$type<AgentOutcome>(),
    /** A cloud call's latest phase, as the extension reports it — the rep's page polls it. */
    livePhase: jsonb("live_phase").$type<CloudCallPhase>(),
    /** When a call worker took the cloud call, and which. Null while it waits in the queue. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    /** A cloud call's timed steps, worker's and extension's, posted by the worker. scripts/add-call-session-timeline.ts. */
    timeline: jsonb("timeline").$type<CallTimelineEntry[]>(),
    /** Who placed it: AgentSDR ('outbound') or the lead, calling a station back ('inbound'). scripts/add-call-session-direction.ts. */
    direction: text("direction").notNull().default("outbound").$type<CallDirection>(),
    /**
     * Set (`{}`): a cloud call the rep talks on from their AgentSDR tab instead
     * of the agent, its audio through AgentSDR's relay (contract.ts, "a rep
     * talking through a calling station"). Null otherwise.
     * scripts/add-call-session-remote-rep.ts.
     */
    remoteRep: jsonb("remote_rep").$type<CallRemoteRep>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("call_sessions_organization_idx").on(table.organizationId),
    foreignKey({
      columns: [table.stationId],
      foreignColumns: [callingStations.id],
      name: "call_sessions_station_fk",
    }).onDelete("set null"),
    check("call_sessions_mode_chk", sql`${table.mode} IN ('rep', 'agent', 'agent_cloud')`),
    check("call_sessions_direction_chk", sql`${table.direction} IN ('outbound', 'inbound')`),
    index("call_sessions_cloud_open_idx")
      .on(table.createdAt)
      .where(sql`${table.mode} = 'agent_cloud' AND ${table.status} IN ('pending', 'in_progress')`),
    foreignKey({
      columns: [table.personId],
      foreignColumns: [people.id],
      name: "call_sessions_person_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.crmRecordId],
      foreignColumns: [crmRecords.id],
      name: "call_sessions_crm_record_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.campaignContactId],
      foreignColumns: [callCampaignContacts.id],
      name: "call_sessions_campaign_contact_fk",
    }).onDelete("set null"),
    index("call_sessions_person_created_idx").on(table.personId, table.createdAt),
    check(
      "call_sessions_status_chk",
      sql`${table.status} IN ('pending', 'in_progress', 'recorded', 'no_recording', 'failed')`,
    ),
    check(
      "call_sessions_recording_chk",
      sql`(${table.status} = 'recorded') = (${table.recordingKey} IS NOT NULL)`,
    ),
    check("call_sessions_duration_chk", sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`),
    check(
      "call_sessions_transcript_status_chk",
      sql`${table.transcriptStatus} IN ('none', 'pending', 'done', 'failed')`,
    ),
    index("call_sessions_campaign_contact_idx").on(table.campaignContactId),
  ],
);

/**
 * A follow-up message opened in WhatsApp for a lead, prefilled and sent by
 * the rep. "Opened" is all the app can know — the rep presses Enter.
 */
export const callMessages = pgTable(
  "call_messages",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id").notNull(),
    campaignContactId: uuid("campaign_contact_id"),
    /** The call this message follows up on, when there was one. */
    callSessionId: uuid("call_session_id"),
    phone: text("phone").notNull(),
    body: text("body").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("call_messages_organization_idx").on(table.organizationId),
    foreignKey({
      columns: [table.personId],
      foreignColumns: [people.id],
      name: "call_messages_person_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.campaignContactId],
      foreignColumns: [callCampaignContacts.id],
      name: "call_messages_campaign_contact_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.callSessionId],
      foreignColumns: [callSessions.id],
      name: "call_messages_call_session_fk",
    }).onDelete("set null"),
    index("call_messages_campaign_contact_idx").on(table.campaignContactId, table.openedAt),
    check("call_messages_body_chk", sql`length(btrim(${table.body})) > 0`),
  ],
);
