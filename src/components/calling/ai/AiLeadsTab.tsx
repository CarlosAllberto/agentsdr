"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiErrorWarningLine,
  RiFileExcel2Line,
  RiLoader4Line,
  RiMoreLine,
  RiPlayCircleLine,
  RiSearchLine,
  RiStopCircleLine,
  RiTeamLine,
  RiUserAddLine,
} from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import * as Table from "@/components/alignui/table";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { useDialogs } from "@/components/DialogProvider";
import AddPeopleToCampaignModal from "@/components/leads/AddPeopleToCampaignModal";
import CampaignCsvMappingDialog from "@/components/leads/CampaignCsvMappingDialog";
import { EmptyState } from "@/components/page/EmptyState";
import { Skeleton } from "@/components/page/Skeletons";
import { relativeTime } from "@/components/whatsapp/campaigns/metrics";
import { AGENT_OUTCOME_LABELS } from "@/lib/calls/contract";
import type { AiCampaignLead, AiLeadsImportResponse, ListAiLeadsResponse } from "@/lib/calls/aiCampaigns/api";
import { aiLeadsEndpoint, aiLeadsUploadEndpoint, listAiLeads, updateAiLead } from "@/lib/calls/aiCampaigns/client";
import { AI_CONTACT_STATUSES, AI_CONTACT_STATUS_LABELS, AI_OPEN_STATUSES, type AiContactStatus } from "@/lib/calls/aiCampaigns/contract";
import { cn } from "@/utils/cn";
import { AiLeadDrawer } from "./AiLeadDrawer";
import { actionRequiredText, AiStatusBadge, errorText, formatWhen } from "./aiShared";

const PAGE_SIZE = 25;
const ALL = "all";

export function importSummary(result: AiLeadsImportResponse): string {
  const parts = [`${result.added.toLocaleString("en-US")} added`];
  if (result.alreadyInCampaign) parts.push(`${result.alreadyInCampaign.toLocaleString("en-US")} already in the campaign`);
  if (result.skipped.length) parts.push(`${result.skipped.length} skipped (${result.skipped[0]}${result.skipped.length > 1 ? ", …" : ""})`);
  return parts.join(" · ");
}

/** The Leads tab: every lead, filtered by status or searched, with a side sheet per lead. */
export function AiLeadsTab({
  campaignId,
  counts,
  total,
  onChanged,
}: {
  campaignId: string;
  /** Leads per status, when the stats are loaded. */
  counts: Record<AiContactStatus, number> | null;
  total: number;
  onChanged: () => void;
}) {
  const dialogs = useDialogs();
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListAiLeadsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [showPeople, setShowPeople] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    try {
      setData(await listAiLeads(campaignId, { page, pageSize: PAGE_SIZE, status: status === ALL ? undefined : (status as AiContactStatus), q: debounced || undefined }));
      setLoadError(null);
    } catch (cause) {
      setLoadError(errorText(cause, "Could not load leads"));
    } finally {
      setLoading(false);
    }
  }, [campaignId, page, status, debounced]);

  useEffect(() => {
    // Fetch on mount and whenever the query changes; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // The campaign page polls its counts; when the total moves, this page is stale too.
  const totalSeen = useRef(total);
  useEffect(() => {
    if (totalSeen.current !== total) {
      totalSeen.current = total;
      void load();
    }
  }, [total, load]);

  const refreshAll = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  async function act(lead: AiCampaignLead, action: "stop" | "requeue") {
    setBusyId(lead.id);
    try {
      await updateAiLead(campaignId, lead.id, { action });
      refreshAll();
    } catch (cause) {
      await dialogs.alert({ title: action === "stop" ? "Could not stop the lead" : "Could not queue the lead again", description: errorText(cause), variant: "error" });
    } finally {
      setBusyId(null);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtering = status !== ALL || debounced.length > 0;

  const importActions = (
    <>
      <Button.Root variant="neutral" mode="stroke" size="small" onClick={() => fileRef.current?.click()}>
        <Button.Icon as={RiFileExcel2Line} />
        Import spreadsheet
      </Button.Root>
      <Button.Root variant="neutral" mode="stroke" size="small" onClick={() => setShowPeople(true)}>
        <Button.Icon as={RiUserAddLine} />
        Add from People
      </Button.Root>
    </>
  );

  return (
    <Frame>
      <FrameHeader title="Leads" description="Everyone in this campaign and where they are in the sequence." actions={<div className="flex flex-wrap items-center gap-2">{importActions}</div>} />
      <FramePanel className="p-2 sm:p-2">
        <div className="flex flex-col gap-2 p-2 sm:flex-row sm:items-center sm:justify-between">
          <Select.Root size="small" value={status} onValueChange={(value) => { setStatus(value); setPage(1); }}>
            <Select.Trigger className="w-full sm:w-60" aria-label="Filter by status"><Select.Value /></Select.Trigger>
            <Select.Content>
              <Select.Item value={ALL}>All leads{counts ? ` (${total.toLocaleString("en-US")})` : ""}</Select.Item>
              {AI_CONTACT_STATUSES.map((value) => (
                <Select.Item key={value} value={value}>{AI_CONTACT_STATUS_LABELS[value]}{counts ? ` (${counts[value].toLocaleString("en-US")})` : ""}</Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <Input.Root size="small" className="w-full sm:w-64">
            <Input.Wrapper>
              <Input.Icon as={RiSearchLine} />
              <Input.Input type="search" aria-label="Search leads" placeholder="Search name, phone, company…" value={search} onChange={(event) => setSearch(event.target.value)} />
            </Input.Wrapper>
          </Input.Root>
        </div>

        {notice && <p role="status" className="mx-2 mb-2 rounded-xl bg-bg-weak-50 px-3 py-2 text-paragraph-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">{notice}</p>}

        <div className="overflow-x-auto">
          {loading ? (
            <div aria-busy="true" aria-label="Loading" className="space-y-2 p-2">
              {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}
            </div>
          ) : loadError ? (
            <EmptyState icon={RiErrorWarningLine} title="Could not load leads" description={loadError} action={<Button.Root variant="neutral" mode="stroke" size="small" onClick={() => { setLoading(true); void load(); }}>Try again</Button.Root>} />
          ) : !data || data.leads.length === 0 ? (
            filtering ? (
              <EmptyState icon={RiSearchLine} title="No leads match" description="Try another status or search." action={<Button.Root variant="neutral" mode="stroke" size="small" onClick={() => { setSearch(""); setStatus(ALL); }}>Clear filters</Button.Root>} />
            ) : (
              <EmptyState icon={RiTeamLine} title="No leads yet" description="Import a spreadsheet with phone numbers, or add people from your lead database." action={<div className="flex flex-wrap justify-center gap-2">{importActions}</div>} />
            )
          ) : (
            <Table.Root className="min-w-[1000px] [&>table]:table-fixed">
              <Table.Header>
                <Table.Row>
                  <Table.Head scope="col" className="px-4">Lead</Table.Head>
                  <Table.Head scope="col" className="w-36 px-4">Phone</Table.Head>
                  <Table.Head scope="col" className="w-40 px-4">Status</Table.Head>
                  <Table.Head scope="col" className="w-36 px-4">Step</Table.Head>
                  <Table.Head scope="col" className="w-32 px-4">Next action</Table.Head>
                  <Table.Head scope="col" className="w-44 px-4">Last outcome</Table.Head>
                  <Table.Head scope="col" className="w-16 px-4 text-right">Calls</Table.Head>
                  <Table.Head scope="col" className="w-14 px-4"><span className="sr-only">Actions</span></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body spacing={4}>
                {data.leads.map((lead) => {
                  const busy = busyId === lead.id;
                  const open = (AI_OPEN_STATUSES as readonly string[]).includes(lead.status);
                  const requeueable = lead.status === "failed" || lead.status === "unreached" || (lead.status === "stopped" && (lead.note ?? "").startsWith("Stopped by "));
                  return (
                    <Table.Row
                      key={lead.id}
                      tabIndex={0}
                      aria-busy={busy || undefined}
                      onClick={() => setOpenId(lead.id)}
                      onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") setOpenId(lead.id); }}
                      className={cn("cursor-pointer outline-none focus-visible:[&>td]:bg-bg-weak-50", busy && "pointer-events-none opacity-60")}
                    >
                      <Table.Cell className="px-4">
                        <p className="truncate text-label-sm text-text-strong-950" title={lead.name ?? undefined}>{lead.name || "Unnamed"}</p>
                        <p className="mt-0.5 truncate text-paragraph-xs text-text-sub-600">{[lead.title, lead.companyName].filter(Boolean).join(" · ") || "—"}</p>
                      </Table.Cell>
                      <Table.Cell className="px-4 text-paragraph-sm tabular-nums text-text-sub-600">{lead.phone}</Table.Cell>
                      <Table.Cell className="px-4">
                        <AiStatusBadge status={lead.status} />
                        {lead.note && <p className="mt-1 line-clamp-2 text-paragraph-xs text-text-sub-600" title={lead.note}>{lead.note}</p>}
                        {lead.meetingAt && <p className="mt-0.5 text-paragraph-xs text-text-sub-600" suppressHydrationWarning>Meeting {formatWhen(lead.meetingAt)}</p>}
                        {lead.actionRequiredAt && <p className="mt-0.5 text-paragraph-xs text-text-sub-600" suppressHydrationWarning>{actionRequiredText(lead.actionRequiredAt)}</p>}
                      </Table.Cell>
                      <Table.Cell className="px-4 text-paragraph-sm text-text-sub-600">{lead.currentStep ?? "—"}</Table.Cell>
                      <Table.Cell className="px-4 text-paragraph-sm text-text-sub-600" suppressHydrationWarning>{open ? (lead.nextAt ? relativeTime(lead.nextAt) : "Waiting for a number") : "—"}</Table.Cell>
                      <Table.Cell className="px-4">
                        {lead.lastOutcome ? (
                          <>
                            <p className="truncate text-paragraph-sm text-text-strong-950">{AGENT_OUTCOME_LABELS[lead.lastOutcome.outcome]}</p>
                            {lead.lastOutcome.summary && <p className="mt-0.5 truncate text-paragraph-xs text-text-sub-600" title={lead.lastOutcome.summary}>{lead.lastOutcome.summary}</p>}
                          </>
                        ) : <span className="text-paragraph-sm text-text-soft-400">—</span>}
                      </Table.Cell>
                      <Table.Cell className="px-4 text-right text-paragraph-sm tabular-nums text-text-sub-600">{lead.calls}</Table.Cell>
                      <Table.Cell className="px-4" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                        <div className="flex justify-end">
                          <Dropdown.Root>
                            <Dropdown.Trigger asChild>
                              <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={busy} aria-label={`More actions for ${lead.name || lead.phone}`}>
                                <Button.Icon as={busy ? RiLoader4Line : RiMoreLine} className={cn(busy && "animate-spin")} />
                              </Button.Root>
                            </Dropdown.Trigger>
                            <Dropdown.Content align="end">
                              {open && (
                                <Dropdown.Item onSelect={() => void act(lead, "stop")}>
                                  <Dropdown.ItemIcon as={RiStopCircleLine} />
                                  Stop this lead
                                </Dropdown.Item>
                              )}
                              {requeueable && (
                                <Dropdown.Item onSelect={() => void act(lead, "requeue")}>
                                  <Dropdown.ItemIcon as={RiPlayCircleLine} />
                                  Queue again
                                </Dropdown.Item>
                              )}
                              {!open && !requeueable && <Dropdown.Item disabled>No actions</Dropdown.Item>}
                            </Dropdown.Content>
                          </Dropdown.Root>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          )}
        </div>

        {data && data.total > data.pageSize && (
          <div className="flex items-center justify-between gap-3 px-3 pb-2 pt-3">
            <p className="text-paragraph-xs tabular-nums text-text-sub-600">
              {((data.page - 1) * data.pageSize + 1).toLocaleString("en-US")}–{Math.min(data.page * data.pageSize, data.total).toLocaleString("en-US")} of {data.total.toLocaleString("en-US")}
            </p>
            <div className="flex items-center gap-1">
              <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={data.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page"><Button.Icon as={RiArrowLeftSLine} /></Button.Root>
              <span className="px-2 text-paragraph-xs tabular-nums text-text-sub-600">Page {data.page} of {pages}</span>
              <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={data.page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><Button.Icon as={RiArrowRightSLine} /></Button.Root>
            </div>
          </div>
        )}
      </FramePanel>

      <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(event) => setPendingFile(event.target.files?.[0] ?? null)} />
      {pendingFile && (
        <CampaignCsvMappingDialog
          file={pendingFile}
          endpoint={aiLeadsUploadEndpoint(campaignId)}
          channel="whatsapp"
          onClose={() => { setPendingFile(null); if (fileRef.current) fileRef.current.value = ""; }}
          onImported={(result) => {
            setNotice(importSummary(result as AiLeadsImportResponse));
            setPendingFile(null);
            if (fileRef.current) fileRef.current.value = "";
            refreshAll();
          }}
        />
      )}
      {showPeople && (
        <AddPeopleToCampaignModal
          campaignId={campaignId}
          channel="whatsapp"
          endpoint={aiLeadsEndpoint(campaignId)}
          onClose={() => setShowPeople(false)}
          onAdded={(result) => {
            setNotice(`${result.added} added from People${result.skippedDuplicate ? ` · ${result.skippedDuplicate} already in the campaign` : ""}${result.skippedMissingIdentity ? ` · ${result.skippedMissingIdentity} without a phone number` : ""}`);
            refreshAll();
          }}
        />
      )}
      {openId && <AiLeadDrawer campaignId={campaignId} contactId={openId} onClose={() => setOpenId(null)} onChanged={refreshAll} />}
    </Frame>
  );
}
