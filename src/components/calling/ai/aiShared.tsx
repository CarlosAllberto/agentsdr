"use client";

import { useEffect } from "react";
import Link from "next/link";
import * as Badge from "@/components/alignui/badge";
import * as Checkbox from "@/components/alignui/checkbox";
import { AI_CONTACT_STATUS_LABELS, type AiContactStatus } from "@/lib/calls/aiCampaigns/contract";
import { AI_CAMPAIGN_STATE_LABELS, type AiCampaignState } from "@/lib/calls/aiCampaigns/api";
import type { CallingStation, StationStatus } from "@/lib/calls/stationContract";
import { cn } from "@/utils/cn";

type BadgeColor = React.ComponentProps<typeof Badge.Root>["color"];

export const AI_STATUS_COLOR: Record<AiContactStatus, BadgeColor> = {
  queued: "gray",
  reaching: "blue",
  callback: "sky",
  chasing: "purple",
  booked: "green",
  handoff: "teal",
  not_interested: "gray",
  unreached: "yellow",
  replied: "sky",
  stopped: "orange",
  failed: "red",
};

export function AiStatusBadge({ status }: { status: AiContactStatus }) {
  return (
    <Badge.Root size="small" variant="lighter" color={AI_STATUS_COLOR[status]} className="whitespace-nowrap">
      <Badge.Dot />
      {AI_CONTACT_STATUS_LABELS[status]}
    </Badge.Root>
  );
}

const STATE_COLOR: Record<AiCampaignState, BadgeColor> = { draft: "gray", active: "green", paused: "orange" };

export function AiCampaignStateBadge({ state, size = "medium" }: { state: AiCampaignState; size?: "small" | "medium" }) {
  return (
    <Badge.Root size={size} variant="lighter" color={STATE_COLOR[state]} className="shrink-0">
      <Badge.Dot />
      {AI_CAMPAIGN_STATE_LABELS[state]}
    </Badge.Root>
  );
}

/** Marks a campaign the AI agent runs on its own. */
export function AiAgentBadge() {
  return (
    <Badge.Root size="small" variant="light" color="purple" className="shrink-0">
      AI agent
    </Badge.Root>
  );
}

export function errorText(cause: unknown, fallback = "Something went wrong. Please try again."): string {
  return cause instanceof Error ? cause.message : fallback;
}

/** Asks the browser to confirm leaving the page while `dirty`. */
export function useBeforeUnload(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}

const STATION_LABEL: Record<StationStatus, string> = {
  onboarding: "Not linked yet",
  active: "Active",
  paused: "Paused",
  logged_out: "Logged out",
  banned: "Banned",
};
const STATION_COLOR: Record<StationStatus, BadgeColor> = { onboarding: "gray", active: "green", paused: "orange", logged_out: "red", banned: "red" };

/** The calling numbers a campaign may place its calls from. Only active or still-onboarding numbers can be chosen. */
export function NumberPicker({
  stations,
  selectedIds,
  onChange,
  error,
  disabled,
}: {
  stations: CallingStation[] | null;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  error?: string | null;
  disabled?: boolean;
}) {
  if (stations === null) {
    return <p className="rounded-xl bg-bg-weak-50 p-3 text-paragraph-sm text-text-sub-600">{error ?? "Loading numbers…"}</p>;
  }
  if (stations.length === 0) {
    return (
      <p className="rounded-xl bg-warning-lighter p-3 text-paragraph-sm text-warning-dark">
        No calling numbers yet.{" "}
        <Link href="/settings/whatsapp-stations" className="underline">Add one in Settings → WhatsApp → Calling numbers</Link>
        , link it to WhatsApp Web, then come back. You can still save this campaign as a draft.
      </p>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {stations.map((station) => {
        const checked = selectedIds.includes(station.id);
        const usable = station.status === "active" || station.status === "onboarding";
        return (
          <label
            key={station.id}
            className={cn(
              "flex items-center gap-3 rounded-xl p-3 ring-1 ring-inset transition",
              usable && !disabled ? "cursor-pointer" : "cursor-not-allowed opacity-60",
              checked ? "bg-bg-weak-50 ring-primary-base" : "ring-stroke-soft-200",
              usable && !checked && !disabled && "hover:bg-bg-weak-50",
            )}
          >
            <Checkbox.Root
              checked={checked}
              disabled={disabled || (!usable && !checked)}
              onCheckedChange={() => onChange(checked ? selectedIds.filter((id) => id !== station.id) : [...selectedIds, station.id])}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label-sm text-text-strong-950">{station.name}</span>
              <span className="block truncate text-paragraph-xs tabular-nums text-text-sub-600">{station.phone}</span>
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge.Root size="small" variant="light" color={STATION_COLOR[station.status]}>{STATION_LABEL[station.status]}</Badge.Root>
                {station.openOn && (
                  <Badge.Root size="small" variant="light" color="green" title={`WhatsApp Web is kept open on ${station.openOn}, so calls start right away`}>
                    Ready on {station.openOn}
                  </Badge.Root>
                )}
                {station.status === "onboarding" && (
                  <span className="text-paragraph-xs text-text-soft-400">Link WhatsApp before launching</span>
                )}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "Action required from Nov 6, 1:13 PM", or "In Action required since …" once due. */
export function actionRequiredText(iso: string): string {
  const due = new Date(iso).getTime() <= Date.now();
  return `${due ? "In Action required since" : "Action required from"} ${formatWhen(iso)}`;
}

export function formatCallLength(ms: number | null): string | null {
  if (!ms || ms < 1000) return null;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
