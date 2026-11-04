/**
 * The agentBrief an AI campaign call carries: the campaign's instructions,
 * then what this one call is for (worded in Langfuse as calls/agent-brief).
 * Kept short on purpose — the token mint (src/lib/calls/liveAgent.ts) adds
 * what happens after the call and the lead's history, so none of that is
 * repeated here. Pure: the caller passes the template it fetched.
 */
import { MAX_AGENT_BRIEF_CHARS } from "../contract";
import { PROMPTS } from "@/lib/prompts/registry";
import { fillPrompt } from "@/lib/prompts/template";
import type { AiStepPurpose } from "./engineRules";

export function composeAgentBrief(
  input: {
    campaignInstructions: string;
    /** "inbound": they called the number back and the agent answered (src/lib/calls/incoming.ts). */
    purpose: AiStepPurpose | "inbound";
    /** The call step's own instructions (none for a call-back). */
    stepInstructions: string | null;
    /** A call-back: the time they asked for, in their words if the agent kept them. */
    callbackWhen?: string | null;
    /** The lead's own instructions (the lead's side sheet), on top of the campaign's. */
    leadInstructions?: string | null;
  },
  template: string = PROMPTS["calls/agent-brief"].template,
): string {
  const campaign = input.campaignInstructions.trim();
  const fill = (campaignInstructions: string) =>
    fillPrompt(template, {
      campaign_instructions: campaignInstructions,
      callback: input.purpose === "callback",
      callback_when: input.callbackWhen?.trim() || "the time they gave",
      chase: input.purpose === "chase",
      inbound: input.purpose === "inbound",
      reach: input.purpose === "reach",
      step: input.stepInstructions?.trim() || null,
      lead_instructions: input.leadInstructions?.trim() || null,
    });
  const brief = fill(campaign);
  if (brief.length <= MAX_AGENT_BRIEF_CHARS) return brief;
  // Over the limit only when both texts are near their own maximum: keep this call's part whole.
  const thisCall = fill("");
  const room = Math.max(0, MAX_AGENT_BRIEF_CHARS - thisCall.length - 3);
  return `${campaign.slice(0, room).trimEnd()}…\n\n${thisCall}`.slice(0, MAX_AGENT_BRIEF_CHARS);
}
