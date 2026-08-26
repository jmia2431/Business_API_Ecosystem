"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  API_CATEGORIES,
  AUTHENTICATION_TYPES,
  type ApiRecord,
  type ApiSubmission,
} from "@/lib/types";

type RepositoryProps = { initialRecords: ApiRecord[] };
type StorageMode = "dataset" | "supabase";
type Notice = { message: string; kind: "success" | "error" } | null;

const emptyDraft: ApiSubmission = {
  api_name: "",
  official_api_name: "",
  company_name: "",
  official_company_name: "",
  description: "",
  api_endpoint: "",
  documentation_url: "",
  category: "Communication",
  authentication_method: "OAuth2",
  authentication_details: "",
  website_confirm: "",
};

const categoryTone: Record<string, string> = {
  Communication: "tone-teal",
  Transformation: "tone-blue",
  Validation: "tone-amber",
};

function shortHost(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value || "Not supplied";
  }
}

function csvEscape(value: unknown) {
  const stringValue = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  const safeValue = /^[\t\r\n ]*[=+\-@]/.test(stringValue) ? `'${stringValue}` : stringValue;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

function statusClass(value: string) {
  if (value === "Published") return "published";
  if (value === "Verified candidate") return "candidate";
  return "draft";
}

function showOriginal(english: string, original: string) {
  return Boolean(original && original.trim().toLocaleLowerCase() !== english.trim().toLocaleLowerCase());
}

export default function ApiRepository({ initialRecords }: RepositoryProps) {
  const [records, setRecords] = useState(initialRecords);
  const [selectedId, setSelectedId] = useState(initialRecords[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All categories");
  const [company, setCompany] = useState("All companies");
  const [status, setStatus] = useState("All records");
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<ApiSubmission>(emptyDraft);
  const [notice, setNotice] = useState<Notice>(null);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [storageMode, setStorageMode] = useState<StorageMode>("dataset");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const firstModalInputRef = useRef<HTMLInputElement>(null);
  const openFormButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/apis", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Repository request failed");
        return response.json() as Promise<{ apis?: ApiRecord[]; mode?: StorageMode }>;
      })
      .then((payload) => {
        if (!active) return;
        setStorageMode(payload.mode ?? "dataset");
        if (!payload.apis?.length) return;
        setRecords(payload.apis);
        setSelectedId((current) =>
          payload.apis?.some((record) => record.id === current)
            ? current
            : payload.apis?.[0]?.id ?? "",
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (!showForm) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => firstModalInputRef.current?.focus());

    function handleModalKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowForm(false);
        return;
      }
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = [...modalRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleModalKeys);
    return () => {
      document.removeEventListener("keydown", handleModalKeys);
      document.body.style.overflow = previousOverflow;
      (previousFocus ?? openFormButtonRef.current)?.focus();
    };
  }, [showForm]);

  const categories = useMemo(
    () => [...new Set(records.map((record) => record.category).filter(Boolean))].sort(),
    [records],
  );
  const companies = useMemo(
    () => [...new Set(records.map((record) => record.company_name).filter(Boolean))].sort(),
    [records],
  );

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return records.filter((record) => {
      const matchesQuery =
        !normalized ||
        [
          record.api_name,
          record.official_api_name,
          record.company_name,
          record.official_company_name,
          record.description,
          record.api_endpoint,
          record.authentication_method,
          record.authentication_details,
          ...record.input_formats,
          ...record.output_formats,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      const matchesCategory = category === "All categories" || record.category === category;
      const matchesCompany = company === "All companies" || record.company_name === company;
      const matchesStatus = status === "All records" || record.review_status === status;
      return matchesQuery && matchesCategory && matchesCompany && matchesStatus;
    });
  }, [category, company, query, records, status]);

  const selected = filtered.find((record) => record.id === selectedId) ?? filtered[0];
  const publishedCount = records.filter((record) => record.review_status === "Published").length;
  const candidateCount = records.filter(
    (record) => record.review_status === "Verified candidate",
  ).length;

  function resetFilters() {
    setQuery("");
    setCategory("All categories");
    setCompany("All companies");
    setStatus("All records");
  }

  function openForm() {
    setFormError("");
    setShowForm(true);
  }

  function exportCsv() {
    const fields: (keyof ApiRecord)[] = [
      "api_name",
      "official_api_name",
      "company_name",
      "official_company_name",
      "description",
      "api_endpoint",
      "documentation_url",
      "category",
      "authentication_method",
      "authentication_details",
      "network",
      "input_formats",
      "output_formats",
      "business_rules",
      "client_types",
      "review_status",
      "source_url",
    ];
    const csv = [
      fields.map(csvEscape).join(","),
      ...filtered.map((record) => fields.map((field) => csvEscape(record[field])).join(",")),
    ].join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "business-api-repository-export.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function copyEndpoint() {
    if (!selected?.api_endpoint) return;
    try {
      await navigator.clipboard.writeText(selected.api_endpoint);
      setNotice({ message: "Endpoint copied", kind: "success" });
    } catch {
      setNotice({ message: "Could not copy the endpoint", kind: "error" });
    }
    window.setTimeout(() => setNotice(null), 1_800);
  }

  async function submitApi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError("");

    try {
      const response = await fetch("/api/apis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        api?: ApiRecord;
        error?: string;
        requestId?: string;
      };
      if (!response.ok || !payload.api) {
        const suffix = payload.requestId ? ` Reference: ${payload.requestId}` : "";
        throw new Error(`${payload.error ?? "The API could not be saved."}${suffix}`);
      }

      setRecords((current) => [
        payload.api as ApiRecord,
        ...current.filter((record) => record.id !== payload.api?.id),
      ]);
      setSelectedId(payload.api.id);
      setDraft(emptyDraft);
      setShowForm(false);
      setStorageMode("supabase");
      setNotice({
        message: "API saved privately for review. It will appear publicly after approval.",
        kind: "success",
      });
      window.setTimeout(() => setNotice(null), 4_200);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The API could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#catalog" aria-label="Business API Repository home">
          <span className="brand-mark" aria-hidden="true">AR</span>
          <span>
            <strong>API Repository</strong>
            <small>Business API discovery</small>
          </span>
        </a>
        <div className="topbar-actions">
          <span className={`connection-state ${storageMode === "supabase" ? "connected" : ""}`}>
            <i aria-hidden="true" />
            {storageMode === "supabase" ? "Supabase connected" : "Static dataset"}
          </span>
          <button className="button secondary" type="button" onClick={exportCsv}>
            Export CSV
          </button>
          <button
            ref={openFormButtonRef}
            className="button primary"
            type="button"
            onClick={openForm}
          >
            + Add API
          </button>
        </div>
      </header>

      <section className="workspace" id="catalog">
        <div className="intro-row">
          <div>
            <p className="eyebrow">Catalog overview</p>
            <h1>Find the right business API, fast.</h1>
            <p className="intro-copy">
              Search global e-invoicing integrations, compare formats and authentication,
              and contribute candidates to a shared review queue.
            </p>
          </div>
          <div className="stat-grid" aria-label="Repository statistics">
            <article><strong>{records.length}</strong><span>Total APIs</span></article>
            <article><strong>{companies.length}</strong><span>Companies</span></article>
            <article><strong>{publishedCount}</strong><span>Published</span></article>
            <article><strong>{candidateCount}</strong><span>Verified candidates</span></article>
          </div>
        </div>

        <div className="filter-panel">
          <label className="search-field">
            <span className="sr-only">Search APIs</span>
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search API, company, endpoint, format…"
            />
            <kbd aria-hidden="true">/</kbd>
          </label>
          <label>
            <span>Category</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option>All categories</option>
              {categories.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option>All records</option>
              <option>Published</option>
              <option>Verified candidate</option>
              <option>Draft</option>
            </select>
          </label>
          <label>
            <span>Company</span>
            <select value={company} onChange={(event) => setCompany(event.target.value)}>
              <option>All companies</option>
              {companies.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
        </div>

        <div className="catalog-layout">
          <section className="catalog-list" aria-label="API results">
            <div className="section-heading">
              <div><h2>API catalog</h2><span>{filtered.length} results</span></div>
              {(query || category !== "All categories" || company !== "All companies" || status !== "All records") && (
                <button type="button" className="text-button" onClick={resetFilters}>
                  Clear filters
                </button>
              )}
            </div>
            <div className="result-list">
              {filtered.map((record) => (
                <button
                  type="button"
                  key={record.id}
                  className={`api-card ${selected?.id === record.id ? "selected" : ""}`}
                  onClick={() => setSelectedId(record.id)}
                  aria-pressed={selected?.id === record.id}
                  aria-controls="api-detail"
                >
                  <span className="api-card-topline">
                    <span className={`pill ${categoryTone[record.category] ?? "tone-gray"}`}>
                      {record.category}
                    </span>
                    <span className={`status-label ${statusClass(record.review_status)}`}>
                      {record.review_status}
                    </span>
                  </span>
                  <strong>{record.api_name}</strong>
                  {showOriginal(record.api_name, record.official_api_name) && (
                    <span className="official-name" lang="und">{record.official_api_name}</span>
                  )}
                  <span className="company-name">{record.company_name}</span>
                  <span className="api-card-description">{record.description}</span>
                  <span className="api-card-meta">
                    <span>{record.authentication_method || "Auth not listed"}</span>
                    <span>{record.input_formats.slice(0, 2).join(" · ") || "Format not listed"}</span>
                  </span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="empty-state">
                  <strong>No APIs match these filters.</strong>
                  <p>Try a broader search or clear the current filters.</p>
                  <button className="button secondary" type="button" onClick={resetFilters}>
                    Clear filters
                  </button>
                </div>
              )}
            </div>
          </section>

          <aside className="detail-panel" id="api-detail" aria-label="Selected API details">
            {selected ? (
              <>
                <div className="detail-header">
                  <div className="company-avatar" aria-hidden="true">
                    {selected.company_name.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <span className="detail-company">{selected.company_name}</span>
                    {showOriginal(selected.company_name, selected.official_company_name) && (
                      <span className="official-company" lang="und">{selected.official_company_name}</span>
                    )}
                    <h2>{selected.api_name}</h2>
                    {showOriginal(selected.api_name, selected.official_api_name) && (
                      <p className="detail-official-name" lang="und">{selected.official_api_name}</p>
                    )}
                  </div>
                </div>
                <div className="detail-badges">
                  <span className={`pill ${categoryTone[selected.category] ?? "tone-gray"}`}>
                    {selected.category}
                  </span>
                  <span className={`pill tone-gray status-${statusClass(selected.review_status)}`}>
                    {selected.review_status}
                  </span>
                  {selected.network && <span className="pill tone-purple">{selected.network}</span>}
                </div>
                <p className="detail-description">{selected.description}</p>
                <section className="endpoint-box">
                  <span>API endpoint</span>
                  <code>{selected.api_endpoint}</code>
                  <button
                    type="button"
                    onClick={copyEndpoint}
                    aria-label={`Copy endpoint for ${selected.api_name}`}
                  >
                    Copy
                  </button>
                </section>
                <dl className="detail-grid">
                  <div>
                    <dt>Authentication</dt>
                    <dd>{selected.authentication_method || "Not listed"}</dd>
                  </div>
                  <div>
                    <dt>Documentation host</dt>
                    <dd>{shortHost(selected.documentation_url)}</dd>
                  </div>
                  <div>
                    <dt>Input formats</dt>
                    <dd>{selected.input_formats.join(", ") || "Not listed"}</dd>
                  </div>
                  <div>
                    <dt>Output formats</dt>
                    <dd>{selected.output_formats.join(", ") || "Not listed"}</dd>
                  </div>
                </dl>

                {selected.authentication_details && (
                  <section className="detail-section">
                    <h3>Authentication details</h3>
                    <p>{selected.authentication_details}</p>
                  </section>
                )}
                <section className="detail-section">
                  <h3>Implementation notes</h3>
                  <p>{selected.instructions || "No implementation notes have been supplied."}</p>
                </section>
                {selected.business_rules.length > 0 && (
                  <section className="detail-section">
                    <h3>Business rules</h3>
                    <div className="tag-row">
                      {selected.business_rules.map((rule) => <span key={rule}>{rule}</span>)}
                    </div>
                  </section>
                )}
                <div className="detail-actions">
                  {selected.documentation_url && (
                    <a
                      className="button primary"
                      href={selected.documentation_url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open documentation for ${selected.api_name} in a new tab`}
                    >
                      Open documentation ↗
                    </a>
                  )}
                  {selected.website_url && (
                    <a
                      className="button secondary"
                      href={selected.website_url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${selected.company_name} website in a new tab`}
                    >
                      Company website ↗
                    </a>
                  )}
                </div>
              </>
            ) : (
              <div className="empty-state"><strong>Select an API to view details.</strong></div>
            )}
          </aside>
        </div>
      </section>

      {showForm && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowForm(false);
          }}
        >
          <section
            ref={modalRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-api-title"
            aria-describedby="add-api-description"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">New record</p>
                <h2 id="add-api-title">Add an API candidate</h2>
              </div>
              <button
                type="button"
                aria-label="Close add API form"
                onClick={() => setShowForm(false)}
              >
                ×
              </button>
            </div>
            <p className="modal-copy" id="add-api-description">
              Add the core fields now. The record enters the review queue before publication.
            </p>
            <form onSubmit={submitApi} className="api-form">
              <label>
                <span>API name (readable English) *</span>
                <input
                  ref={firstModalInputRef}
                  required
                  maxLength={180}
                  value={draft.api_name}
                  onChange={(event) => setDraft({ ...draft, api_name: event.target.value })}
                />
              </label>
              <label>
                <span>Official API/service name</span>
                <input
                  maxLength={240}
                  lang="und"
                  value={draft.official_api_name}
                  onChange={(event) => setDraft({ ...draft, official_api_name: event.target.value })}
                />
              </label>
              <label>
                <span>Company (English + abbreviation) *</span>
                <input
                  required
                  maxLength={180}
                  value={draft.company_name}
                  onChange={(event) => setDraft({ ...draft, company_name: event.target.value })}
                />
              </label>
              <label>
                <span>Official company name</span>
                <input
                  maxLength={240}
                  lang="und"
                  value={draft.official_company_name}
                  onChange={(event) => setDraft({ ...draft, official_company_name: event.target.value })}
                />
              </label>
              <label className="full">
                <span>Description *</span>
                <textarea
                  required
                  rows={4}
                  maxLength={2_000}
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <label className="full">
                <span>API endpoint *</span>
                <input
                  required
                  type="url"
                  maxLength={2_000}
                  placeholder="https://api.example.com/v1/invoices"
                  value={draft.api_endpoint}
                  onChange={(event) => setDraft({ ...draft, api_endpoint: event.target.value })}
                />
              </label>
              <label className="full">
                <span>Official documentation *</span>
                <input
                  required
                  type="url"
                  maxLength={2_000}
                  placeholder="https://developer.example.com/docs"
                  value={draft.documentation_url}
                  onChange={(event) => setDraft({ ...draft, documentation_url: event.target.value })}
                />
              </label>
              <label>
                <span>Category</span>
                <select
                  value={draft.category}
                  onChange={(event) => setDraft({
                    ...draft,
                    category: event.target.value as ApiSubmission["category"],
                  })}
                >
                  {API_CATEGORIES.map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              <label>
                <span>Authentication</span>
                <select
                  value={draft.authentication_method}
                  onChange={(event) => setDraft({
                    ...draft,
                    authentication_method: event.target.value as ApiSubmission["authentication_method"],
                  })}
                >
                  {AUTHENTICATION_TYPES.map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              <label className="full">
                <span>Authentication details</span>
                <textarea
                  rows={3}
                  maxLength={1_000}
                  placeholder="For example: OAuth2 client credentials, required scopes, token endpoint…"
                  value={draft.authentication_details}
                  onChange={(event) => setDraft({ ...draft, authentication_details: event.target.value })}
                />
              </label>
              <label className="honeypot" aria-hidden="true">
                <span>Leave this field empty</span>
                <input
                  tabIndex={-1}
                  autoComplete="off"
                  value={draft.website_confirm}
                  onChange={(event) => setDraft({ ...draft, website_confirm: event.target.value })}
                />
              </label>
              {formError && <p className="form-error full" role="alert">{formError}</p>}
              <div className="form-footer full">
                <span>
                  {storageMode === "supabase"
                    ? "This record will be saved permanently as Draft and published after owner review."
                    : "Connect the Supabase server variables before accepting submissions."}
                </span>
                <div>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => setShowForm(false)}
                    disabled={submitting}
                  >
                    Cancel
                  </button>
                  <button className="button primary" type="submit" disabled={submitting}>
                    {submitting ? "Saving…" : "Add to review queue"}
                  </button>
                </div>
              </div>
            </form>
          </section>
        </div>
      )}
      {notice && (
        <div className={`toast ${notice.kind === "error" ? "error" : ""}`} role="status">
          {notice.message}
        </div>
      )}
    </main>
  );
}
