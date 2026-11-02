"use client";

import { useEffect, useState } from "react";
import { RiSearchLine, RiUserAddLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Input from "@/components/alignui/input";
import * as Modal from "@/components/alignui/modal";
import { FormError } from "@/components/calls/fields";

type PersonRow = {
  person: { id: string; email: string | null; linkedinUrl: string | null; phone?: string | null; fullName: string | null; title: string | null };
  company: { name: string | null; domain: string } | null;
};

export default function AddPeopleToCampaignModal({
  campaignId,
  channel,
  endpoint,
  onClose,
  onAdded,
}: {
  campaignId: string;
  channel: "email" | "linkedin" | "whatsapp";
  /** Where to POST the chosen people, for a campaign kind with its own route (AI calling campaigns; it answers like the WhatsApp one). */
  endpoint?: string;
  onClose: () => void;
  /** The WhatsApp route reports skippedMissingPhone instead of the identity/suppressed counts. */
  onAdded: (result: { requested: number; added: number; skippedMissingIdentity: number; skippedDuplicate: number; skippedSuppressed: number }) => void;
}) {
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "100" });
        if (query.trim()) params.set("q", query.trim());
        const response = await fetch(`/api/leads/people?${params}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load people");
        setRows(body.people ?? []);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load people");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query]);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const url = endpoint ?? (channel === "whatsapp" ? `/api/whatsapp/campaigns/${campaignId}/leads` : `/api/${channel === "email" ? "outreach" : "linkedin"}/campaigns/${campaignId}/people`);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Sequence templates belong to the campaign editor. Including blank
        // template fields here would clear an existing LinkedIn sequence.
        body: JSON.stringify({ personIds: [...selected] }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not add people");
      onAdded(
        channel === "whatsapp"
          ? {
              requested: selected.size,
              added: Number(body.added ?? 0),
              skippedMissingIdentity: Number(body.skippedMissingPhone ?? 0),
              skippedDuplicate: Number(body.skippedDuplicate ?? 0),
              skippedSuppressed: 0,
            }
          : body,
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add people");
    } finally {
      setSaving(false);
    }
  }

  const identity = (person: PersonRow["person"]) => (channel === "email" ? person.email : channel === "whatsapp" ? person.phone : person.linkedinUrl);
  const eligible = rows.filter(({ person }) => identity(person));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Modal.Root open onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <Modal.Content size="max-w-2xl" className="max-h-[80vh]">
        <Modal.Header icon={RiUserAddLine}>
          <Modal.Title>Add from People</Modal.Title>
          <Modal.Description>
            Only people with a {channel === "email" ? "valid email" : channel === "whatsapp" ? "phone number" : "LinkedIn profile"} can be selected.
          </Modal.Description>
        </Modal.Header>
        <div className="border-b border-stroke-soft-200 px-5 pb-4">
          <Input.Root size="small">
            <Input.Wrapper>
              <Input.Icon as={RiSearchLine} />
              <Input.Input
                type="search"
                aria-label="Search people"
                placeholder="Search name, email, company, domain, or LinkedIn…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Input.Wrapper>
          </Input.Root>
        </div>
        <Modal.Body className="min-h-48 p-2">
          {loading ? (
            <p className="p-3 text-paragraph-sm text-text-sub-600">Loading…</p>
          ) : eligible.length === 0 ? (
            <p className="p-3 text-paragraph-sm text-text-sub-600">No eligible people found.</p>
          ) : (
            eligible.map(({ person, company }) => (
              <label key={person.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-bg-weak-50">
                <Checkbox.Root checked={selected.has(person.id)} onCheckedChange={() => toggle(person.id)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-label-sm text-text-strong-950">{person.fullName || person.email || person.phone || person.linkedinUrl}</span>
                  <span className="block truncate text-paragraph-xs text-text-sub-600">{identity(person)}{company?.name ? ` · ${company.name}` : ""}</span>
                </span>
              </label>
            ))
          )}
        </Modal.Body>
        {error && <FormError className="mx-5 mb-3">{error}</FormError>}
        <Modal.Footer>
          <Modal.Close asChild>
            <Button.Root variant="neutral" mode="stroke" size="small" disabled={saving}>Cancel</Button.Root>
          </Modal.Close>
          <Button.Root variant="primary" mode="filled" size="small" disabled={!selected.size || saving} onClick={() => void submit()}>
            {saving ? "Adding…" : `Add ${selected.size || ""} ${selected.size === 1 ? "person" : "people"}`}
          </Button.Root>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
