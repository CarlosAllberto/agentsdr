"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RiAddLine, RiRobot2Line } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Table from "@/components/alignui/table";
import { ErrorState } from "@/components/analytics/kit/ErrorState";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { EmptyState } from "@/components/page/EmptyState";
import { Skeleton } from "@/components/page/Skeletons";
import { useRefreshOnReturn } from "@/components/calling/useRefreshOnReturn";
import type { AiCampaignSummary } from "@/lib/calls/aiCampaigns/api";
import { listAiCampaigns } from "@/lib/calls/aiCampaigns/client";
import { AI_CAMPAIGN_GOAL_LABELS } from "@/lib/calls/aiCampaigns/contract";
import { cn } from "@/utils/cn";
import { AiAgentBadge, AiCampaignStateBadge, errorText } from "./aiShared";

export const NEW_AI_CAMPAIGN_HREF = "/calling/campaigns/ai/new";
const num = "text-paragraph-sm tabular-nums text-text-strong-950";

/** The AI agent campaigns: the Call campaigns page's list. */
export function AiCampaignsSection() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<AiCampaignSummary[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setCampaigns((await listAiCampaigns()).campaigns);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRefreshOnReturn(load);

  const open = (id: string) => router.push(`/calling/campaigns/ai/${id}`);

  return (
    <Frame className="mt-5">
      <FrameHeader
        title="AI agent campaigns"
        description="The agent calls the leads itself from your calling numbers, follows up on WhatsApp, and hands over interested people."
        actions={
          <Button.Root variant="primary" mode="filled" size="small" onClick={() => router.push(NEW_AI_CAMPAIGN_HREF)}>
            <Button.Icon as={RiAddLine} />
            New AI campaign
          </Button.Root>
        }
      />
      <FramePanel className="overflow-x-auto p-2 sm:p-2">
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : campaigns === null ? (
          <div aria-busy="true" aria-label="Loading" className="space-y-2 p-2">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        ) : campaigns.length === 0 ? (
          <EmptyState
            compact
            icon={RiRobot2Line}
            title="No AI campaigns yet"
            description="Set a goal, pick calling numbers and add leads. The agent follows your sequence of calls and WhatsApp messages."
            action={
              <Button.Root variant="primary" mode="filled" size="small" onClick={() => router.push(NEW_AI_CAMPAIGN_HREF)}>
                <Button.Icon as={RiAddLine} />
                New AI campaign
              </Button.Root>
            }
          />
        ) : (
          <Table.Root className="min-w-[860px]">
            <Table.Header>
              <Table.Row>
                <Table.Head scope="col" className="px-4">Campaign</Table.Head>
                <Table.Head scope="col" className="w-48 px-4">Numbers</Table.Head>
                <Table.Head scope="col" className="w-24 px-4 text-right">Leads</Table.Head>
                <Table.Head scope="col" className="w-28 px-4 text-right">Calls today</Table.Head>
                <Table.Head scope="col" className="w-24 px-4 text-right">Booked</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body spacing={4}>
              {campaigns.map((campaign) => (
                <Table.Row
                  key={campaign.id}
                  tabIndex={0}
                  onClick={() => open(campaign.id)}
                  onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") open(campaign.id); }}
                  className="cursor-pointer outline-none focus-visible:[&>td]:bg-bg-weak-50"
                >
                  <Table.Cell className="h-16 px-4">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-label-sm text-text-strong-950" title={campaign.name}>{campaign.name}</span>
                      <AiAgentBadge />
                      <AiCampaignStateBadge state={campaign.state} size="small" />
                    </div>
                    <p className="mt-0.5 truncate text-paragraph-xs text-text-sub-600">{AI_CAMPAIGN_GOAL_LABELS[campaign.goal].label} · {campaign.stepCount} {campaign.stepCount === 1 ? "step" : "steps"}</p>
                  </Table.Cell>
                  <Table.Cell className="px-4 text-paragraph-sm text-text-sub-600">
                    <span className="block truncate" title={campaign.numbers.map((n) => n.name).join(", ")}>
                      {campaign.numbers.length === 0 ? "None yet" : campaign.numbers.map((n) => n.name).join(", ")}
                    </span>
                  </Table.Cell>
                  <Table.Cell className={cn("px-4 text-right", num)}>{campaign.leads.toLocaleString("en-US")}</Table.Cell>
                  <Table.Cell className={cn("px-4 text-right", num)}>{campaign.callsToday.toLocaleString("en-US")}</Table.Cell>
                  <Table.Cell className={cn("px-4 text-right", num)}>{campaign.booked.toLocaleString("en-US")}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
      </FramePanel>
    </Frame>
  );
}
