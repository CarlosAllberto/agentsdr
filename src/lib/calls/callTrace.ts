import "server-only";

import { recordPastTrace } from "@/lib/observability/langfuse";
import type { CallTimelineEntry } from "./stationContract";
import type { callSessions } from "./schema";

type CallRow = typeof callSessions.$inferSelect;

const AGENT_TURN = /^agent \((turn|interrupted)\): ([\s\S]*)$/;
const LEAD_TURN = /^lead: ([\s\S]*)$/;
const REPLY_GAP = /^AI agent: replied (\d+) ms after/;
const OUTCOME = /^AI agent: outcome (\w+)/;
/** What the calling system did to the conversation: call notes, holds, hang-ups. */
const SYSTEM_STEP = /^AI agent: (silent |still silent|asked to hold|hanging up|ending the call|no answer after|lead picked up|picked up|greeting|lead said hello)/;
const PROBLEM = /\b(error|failed|refused|no session|could not|gone)\b/i;

/**
 * An AI agent's phone call as a Langfuse trace, once the worker has sent its
 * timeline (the last thing a cloud call reports): every turn the agent spoke
 * and heard, how long it took to reply, the call notes the system sent it, the
 * outcome it recorded and anything that went wrong — in the same Langfuse
 * session (the call's id) as its setup prompt and its transcription. Not for a
 * call a rep talked on.
 */
export function traceAgentConversation(row: CallRow): void {
  if (row.mode !== "agent_cloud" || row.remoteRep) return;
  const timeline = [...((row.timeline as CallTimelineEntry[] | null) ?? [])].sort((a, b) => a.at - b.at);
  if (!timeline.length) return;
  const startTime = new Date(timeline[0]!.at);
  const endTime = new Date(timeline.at(-1)!.at);
  const replyGaps: number[] = [];
  let pendingGap: number | null = null;
  const observations: Parameters<typeof recordPastTrace>[0]["observations"] = [];
  const transcript: { speaker: "agent" | "lead"; text: string; secondsIn: number }[] = [];
  const secondsIn = (at: number) => Math.round((at - startTime.getTime()) / 100) / 10;

  for (const entry of timeline) {
    const at = new Date(entry.at);
    const agent = AGENT_TURN.exec(entry.text);
    if (agent) {
      const interrupted = agent[1] === "interrupted";
      transcript.push({ speaker: "agent", text: agent[2]!, secondsIn: secondsIn(entry.at) });
      observations.push({
        name: interrupted ? "agent said (interrupted)" : "agent said",
        type: "generation",
        startTime: at,
        model: "gemini-live",
        output: agent[2],
        linkPrompt: false,
        metadata: { ...(pendingGap === null ? {} : { replyMs: pendingGap }), interrupted },
      });
      pendingGap = null;
      continue;
    }
    const lead = LEAD_TURN.exec(entry.text);
    if (lead) {
      transcript.push({ speaker: "lead", text: lead[1]!, secondsIn: secondsIn(entry.at) });
      observations.push({ name: "lead said", type: "event", startTime: at, input: lead[1] });
      continue;
    }
    const gap = REPLY_GAP.exec(entry.text);
    if (gap) {
      pendingGap = Number(gap[1]);
      replyGaps.push(pendingGap);
      continue;
    }
    const outcome = OUTCOME.exec(entry.text);
    if (outcome) {
      observations.push({ name: "outcome recorded", type: "event", startTime: at, output: entry.text.replace(/^AI agent: /, "") });
      continue;
    }
    if (SYSTEM_STEP.test(entry.text)) {
      observations.push({ name: "call system", type: "event", startTime: at, output: entry.text.replace(/^AI agent: /, "") });
      continue;
    }
    if (PROBLEM.test(entry.text)) {
      observations.push({ name: "problem", type: "event", level: "WARNING", startTime: at, output: entry.text, metadata: { source: entry.source } });
    }
  }

  const sorted = [...replyGaps].sort((a, b) => a - b);
  recordPastTrace({
    name: row.direction === "inbound" ? "call-conversation-inbound" : "call-conversation",
    startTime,
    endTime,
    sessionId: row.id,
    input: { agentName: row.agentName, voice: row.agentVoice, brief: row.agentBrief, direction: row.direction },
    output: { outcome: row.agentOutcome, status: row.status, transcript },
    metadata: {
      callId: row.id,
      personId: row.personId,
      campaignContactId: row.campaignContactId,
      stationId: row.stationId,
      status: row.status,
      error: row.error,
      durationSeconds: row.durationMs ? Math.round(row.durationMs / 1000) : null,
      replyMs: sorted.length ? { median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1), count: sorted.length } : null,
      timeline: timeline.map((entry) => `+${secondsIn(entry.at)}s ${entry.source}: ${entry.text}`),
    },
    tags: [row.agentOutcome?.outcome ?? row.status],
    observations,
  });
}
