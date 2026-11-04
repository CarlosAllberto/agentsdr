import "server-only";

import { getPromptTemplate } from "@/lib/observability/langfuse";
import { composeAgentBrief } from "./brief";

/** composeAgentBrief with the calls/agent-brief template from Langfuse (or its copy in code). */
export async function agentBrief(input: Parameters<typeof composeAgentBrief>[0]): Promise<string> {
  return composeAgentBrief(input, (await getPromptTemplate("calls/agent-brief")).text);
}
