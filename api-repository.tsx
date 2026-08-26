"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ApiRecord } from "@/lib/types";

type RepositoryProps = { initialRecords: ApiRecord[] };
type ApiDraft = {
  api_name: string;
  company_name: string;
  description: string;
  api_endpoint: string;
  documentation_url: string;
  category: string;
  authentication_method: string;
};

const emptyDraft: ApiDraft = {
  api_name: "",
  company_name: "",
  description: "",
  api_endpoint: "",
  documentation_url: "",
  category: "Communication",
  authentication_method: "OAuth2",
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
  return `"${stringValue.replaceAll('"', '""')}"`;
}

export default function ApiRepository({ initialRecords }: RepositoryProps) {
  const [records, setRecords] = useState(initialRecords);
  const [selectedId, setSelectedId] = useState(initialRecords[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All categories");
  const [company, setCompany] = useState("All companies");
  const [status, setStatus] = useState("All records");
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<ApiDraft>(emptyDraft);
  const [notice, setNotice] = useState("");
  const [storageMode, setStorageMode] = useState<"dataset" | "supabase">("dataset");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/apis")
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((payload: { apis?: ApiRecord[]; mode?: "dataset" | "supabase" }) => {
        if (!active || !payload.apis?.length) return;
        setRecords(payload.apis);
        setStorageMode(payload.mode ?? "dataset");
        setSelectedId((current) =>
          payload.apis?.some((record) => record.id === current)
            ? current
            : payload.apis?.[0]?.id ?? "",
        );
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT";
      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

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
        [record.api_name, record.company_name, record.description, record.api_endpoint,
          record.authentication_method, ...record.input_formats, ...record.output_formats]
          .join(" ").toLowerCase().includes(normalized);
      const matchesCategory = category === "All categories" || record.category === category;
      const matchesCompany = company === "All companies" || record.company_name === company;
      const matchesStatus = status === "All records" || record.review_status === status;
      return matchesQuery && matchesCategory && matchesCompany && matchesStatus;
    });
  }, [category, company, query, records, status]);

  const selected = filtered.find((record) => record.id === selectedId) ?? filtered[0];
  const publishedCount = records.filter((record) => record.review_status === "Published").length;
  const candidateCount = records.filter((record) => record.review_status === "Verified candidate").length;

  function resetFilters() {
    setQuery("");
    setCategory("All categories");
    setCompany("All companies");
    setStatus("All records");
  }

  function exportCsv() {
    const fields: (keyof ApiRecord)[] = ["api_name", "company_name", "description",
      "api_endpoint", "documentation_url", "category", "authentication_method", "network",
      "input_formats", "output_formats", "business_rules", "client_types", "review_status", "source_url"];
    const csv = [fields.map(csvEscape).join(","),
      ...filtered.map((record) => fields.map((field) => csvEscape(record[field])).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "business-api-repository-export.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function copyEndpoint() {
    if (!selected?.api_endpoint) return;
    await navigator.clipboard.writeText(selected.api_endpoint);
    setNotice("Endpoint copied");
    window.setTimeout(() => setNotice(""), 1800);
  }

  async function submitApi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const now = new Date().toISOString();
    const provisional: ApiRecord = {
      id: crypto.randomUUID(), api_name: draft.api_name.trim(), company_name: draft.company_name.trim(),
      description: draft.description.trim(), api_endpoint: draft.api_endpoint.trim(), instructions: "",
      website_url: "", documentation_url: draft.documentation_url.trim(), category: draft.category,
      authentication_method: draft.authentication_method.trim(), network: "", is_active: true,
      created_at: now, updated_at: now, input_formats: ["JSON"], output_formats: ["JSON"],
      business_rules: [], client_types: ["REST"], review_status: "Draft",
      source_url: draft.documentation_url.trim(), verified_at: "",
    };
    try {
      const response = await fetch("/api/apis", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(provisional),
      });
      if (!response.ok) throw new Error("not connected");
      const payload = (await response.json()) as { api: ApiRecord };
      setRecords((current) => [payload.api, ...current]);
      setSelectedId(payload.api.id);
      setNotice("API saved to Supabase");
    } catch {
      setRecords((current) => [provisional, ...current]);
      setSelectedId(provisional.id);
      setNotice("Draft added to this MVP session; connect Supabase to save it permanently");
    }
    setDraft(emptyDraft);
    setShowForm(false);
    window.setTimeout(() => setNotice(""), 4200);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#catalog" aria-label="Business API Repository home">
          <span className="brand-mark" aria-hidden="true">AR</span>
          <span><strong>API Repository</strong><small>Business API discovery</small></span>
        </a>
        <div className="topbar-actions">
          <span className={`connection-state ${storageMode === "supabase" ? "connected" : ""}`}>
            <i aria-hidden="true" />{storageMode === "supabase" ? "Supabase connected" : "Supabase-ready MVP"}
          </span>
          <button className="button secondary" type="button" onClick={exportCsv}>Export CSV</button>
          <button className="button primary" type="button" onClick={() => setShowForm(true)}>+ Add API</button>
        </div>
      </header>

      <section className="workspace" id="catalog">
        <div className="intro-row">
          <div>
            <p className="eyebrow">Catalog overview</p>
            <h1>Find the right business API, fast.</h1>
            <p className="intro-copy">Search existing integrations, compare formats and authentication, and review new candidates before they enter the repository.</p>
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
            <span className="sr-only">Search APIs</span><span aria-hidden="true">⌕</span>
            <input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search API, company, endpoint, format…" />
            <kbd>/</kbd>
          </label>
          <label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option>All categories</option>{categories.map((item) => <option key={item}>{item}</option>)}
          </select></label>
          <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option>All records</option><option>Published</option><option>Verified candidate</option><option>Draft</option>
          </select></label>
          <label><span>Company</span><select value={company} onChange={(event) => setCompany(event.target.value)}>
            <option>All companies</option>{companies.map((item) => <option key={item}>{item}</option>)}
          </select></label>
        </div>

        <div className="catalog-layout">
          <section className="catalog-list" aria-label="API results">
            <div className="section-heading">
              <div><h2>API catalog</h2><span>{filtered.length} results</span></div>
              {(query || category !== "All categories" || company !== "All companies" || status !== "All records") &&
                <button type="button" className="text-button" onClick={resetFilters}>Clear filters</button>}
            </div>
            <div className="result-list">
              {filtered.map((record) => (
                <button type="button" key={record.id} className={`api-card ${selected?.id === record.id ? "selected" : ""}`} onClick={() => setSelectedId(record.id)}>
                  <span className="api-card-topline">
                    <span className={`pill ${categoryTone[record.category] ?? "tone-gray"}`}>{record.category}</span>
                    <span className={`status-label ${record.review_status === "Verified candidate" ? "candidate" : ""}`}>{record.review_status}</span>
                  </span>
                  <strong>{record.api_name}</strong><span className="company-name">{record.company_name}</span>
                  <p>{record.description}</p>
                  <span className="api-card-meta"><span>{record.authentication_method || "Auth not listed"}</span><span>{record.input_formats.slice(0, 2).join(" · ") || "Format not listed"}</span></span>
                </button>
              ))}
              {filtered.length === 0 && <div className="empty-state"><strong>No APIs match these filters.</strong><p>Try a broader search or clear the current filters.</p><button className="button secondary" type="button" onClick={resetFilters}>Clear filters</button></div>}
            </div>
          </section>

          <aside className="detail-panel" aria-label="Selected API details">
            {selected ? <>
              <div className="detail-header"><div className="company-avatar" aria-hidden="true">{selected.company_name.slice(0, 2).toUpperCase()}</div><div><span className="detail-company">{selected.company_name}</span><h2>{selected.api_name}</h2></div></div>
              <div className="detail-badges"><span className={`pill ${categoryTone[selected.category] ?? "tone-gray"}`}>{selected.category}</span><span className="pill tone-gray">{selected.review_status}</span>{selected.network && <span className="pill tone-purple">{selected.network}</span>}</div>
              <p className="detail-description">{selected.description}</p>
              <section className="endpoint-box"><span>API endpoint</span><code>{selected.api_endpoint}</code><button type="button" onClick={copyEndpoint}>Copy</button></section>
              <dl className="detail-grid">
                <div><dt>Authentication</dt><dd>{selected.authentication_method || "Not listed"}</dd></div>
                <div><dt>Documentation host</dt><dd>{shortHost(selected.documentation_url)}</dd></div>
                <div><dt>Input formats</dt><dd>{selected.input_formats.join(", ") || "Not listed"}</dd></div>
                <div><dt>Output formats</dt><dd>{selected.output_formats.join(", ") || "Not listed"}</dd></div>
              </dl>
              <section className="detail-section"><h3>Implementation notes</h3><p>{selected.instructions || "No implementation notes have been supplied."}</p></section>
              {selected.business_rules.length > 0 && <section className="detail-section"><h3>Business rules</h3><div className="tag-row">{selected.business_rules.map((rule) => <span key={rule}>{rule}</span>)}</div></section>}
              <div className="detail-actions"><a className="button primary" href={selected.documentation_url} target="_blank" rel="noreferrer">Open documentation ↗</a>{selected.website_url && <a className="button secondary" href={selected.website_url} target="_blank" rel="noreferrer">Company website</a>}</div>
            </> : <div className="empty-state"><strong>Select an API to view details.</strong></div>}
          </aside>
        </div>
      </section>

      {showForm && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowForm(false)}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="add-api-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading"><div><p className="eyebrow">New record</p><h2 id="add-api-title">Add an API candidate</h2></div><button type="button" aria-label="Close add API form" onClick={() => setShowForm(false)}>×</button></div>
          <p className="modal-copy">Add the core fields now. The record enters the review queue before publication.</p>
          <form onSubmit={submitApi} className="api-form">
            <label><span>API name *</span><input required value={draft.api_name} onChange={(event) => setDraft({ ...draft, api_name: event.target.value })} /></label>
            <label><span>Company *</span><input required value={draft.company_name} onChange={(event) => setDraft({ ...draft, company_name: event.target.value })} /></label>
            <label className="full"><span>Description *</span><textarea required rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
            <label className="full"><span>API endpoint *</span><input required type="url" placeholder="https://api.example.com/v1/invoices" value={draft.api_endpoint} onChange={(event) => setDraft({ ...draft, api_endpoint: event.target.value })} /></label>
            <label className="full"><span>Official documentation *</span><input required type="url" placeholder="https://developer.example.com/docs" value={draft.documentation_url} onChange={(event) => setDraft({ ...draft, documentation_url: event.target.value })} /></label>
            <label><span>Category</span><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>{["Communication", "Transformation", "Validation"].map((item) => <option key={item}>{item}</option>)}</select></label>
            <label><span>Authentication</span><input value={draft.authentication_method} onChange={(event) => setDraft({ ...draft, authentication_method: event.target.value })} /></label>
            <div className="form-footer full"><span>{storageMode === "supabase" ? "This record will be saved to Supabase." : "Demo mode: connect Supabase to make new records permanent."}</span><div><button className="button secondary" type="button" onClick={() => setShowForm(false)}>Cancel</button><button className="button primary" type="submit">Add to review queue</button></div></div>
          </form>
        </section>
      </div>}
      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
