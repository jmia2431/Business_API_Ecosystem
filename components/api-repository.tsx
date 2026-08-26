"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  API_CATEGORIES,
  AUTHENTICATION_TYPES,
  normalizeAuthentication,
  type ApiCategory,
  type ApiRecord,
  type ApiSubmission,
  type AuthenticationType,
  type AuditAction,
  type DeletedApiSummary,
  type ReviewStatus,
} from "@/lib/types";

type RepositoryProps = { initialRecords: ApiRecord[] };
type StorageMode = "dataset" | "supabase";
type Notice = { message: string; kind: "success" | "error" } | null;
type ModalKind = "import" | "edit" | "delete" | "deleted" | null;
type VerificationDraft = { review_status: ReviewStatus; actor_name: string; verification_notes: string };
type ImportSubmission = ApiSubmission & { source_row: number };
type ImportRowStatus = "ready" | "duplicate" | "invalid";
type ImportPreviewRow = {
  rowNumber: number;
  submission: ImportSubmission;
  status: ImportRowStatus;
  reasons: string[];
};
type ServerRowReport = {
  source_row: number;
  api_name: string;
  company_name: string;
  reason?: string;
  error?: string;
};
type ImportResult = {
  workbookRows: number;
  uploaded: number;
  duplicates: number;
  invalid: number;
  serverReports: ServerRowReport[];
  warning?: string;
};

const IMPORT_HEADERS = [
  "API name",
  "Official API name",
  "Company",
  "Official company name",
  "Description",
  "API endpoint",
  "Official documentation",
  "Category",
  "Authentication",
  "Authentication details",
] as const;
type ImportHeader = (typeof IMPORT_HEADERS)[number];

const emptyDraft: ApiSubmission = {
  api_name: "",
  official_api_name: "",
  company_name: "",
  official_company_name: "",
  description: "",
  api_endpoint: "",
  documentation_url: "",
  category: "Communication",
  category_other: "",
  authentication_method: "OAuth2",
  authentication_other: "",
  authentication_details: "",
  website_confirm: "",
};

const emptyVerification: VerificationDraft = {
  review_status: "Published",
  actor_name: "",
  verification_notes: "",
};

const categoryTone: Record<string, string> = {
  Communication: "tone-teal",
  Transformation: "tone-blue",
  Validation: "tone-amber",
  Other: "tone-purple",
};

const actionLabels: Record<AuditAction, string> = {
  upload: "uploaded",
  edit: "edited",
  verify: "verified",
  status_change: "changed the status of",
  delete: "deleted",
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
  return value === "Published" ? "published" : "verified";
}

function statusMeaning(value: string) {
  return value === "Verified"
    ? "Verified: a site user recorded a manual check against an official source."
    : "Published: visible in the catalog, but not manually verified.";
}

function showOriginal(english: string, original: string) {
  return Boolean(original && original.trim().toLocaleLowerCase() !== english.trim().toLocaleLowerCase());
}

function categoryLabel(record: ApiRecord) {
  return record.category === "Other" && record.category_other
    ? `Other · ${record.category_other}`
    : record.category;
}

function authenticationLabel(record: ApiRecord) {
  return record.authentication_method === "Other" && record.authentication_other
    ? `Other · ${record.authentication_other}`
    : record.authentication_method;
}

function formatDateTime(value: string | null) {
  if (!value) return "Date not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date not recorded"
    : new Intl.DateTimeFormat("en", {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", timeZoneName: "short",
      }).format(date);
}

function normalizedHeader(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function importCellText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function duplicateKey(companyName: string, apiName: string) {
  const clean = (value: string) => value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
  return `${clean(companyName)}\u0000${clean(apiName)}`;
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isHttpEndpoint(value: string) {
  // Some official on-premise APIs publish endpoint templates such as
  // http://{VSDC-host}:{port}/path. They are valid catalog endpoints even
  // though the browser URL parser cannot resolve the placeholders yet.
  return /^https?:\/\/[^\s<>"`]+$/i.test(value);
}

function resultCount(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return Array.isArray(value) ? value.length : 0;
}

function canonicalCategory(rawValue: string): { value: ApiCategory; other: string } {
  const raw = rawValue.trim();
  const known = API_CATEGORIES.find((item) => item.toLocaleLowerCase() === raw.toLocaleLowerCase());
  if (known && known !== "Other") return { value: known, other: "" };
  if (known === "Other") return { value: "Other", other: "" };
  return { value: "Other", other: raw };
}

function canonicalAuthentication(rawValue: string): { value: AuthenticationType; other: string } {
  const raw = rawValue.trim();
  if (!raw) return { value: "Other", other: "" };
  const exact = AUTHENTICATION_TYPES.find((item) => item.toLocaleLowerCase() === raw.toLocaleLowerCase());
  if (exact && exact !== "Other") return { value: exact, other: "" };
  if (exact === "Other") return { value: "Other", other: "" };
  const normalized = normalizeAuthentication(raw);
  return normalized === "Other" ? { value: "Other", other: raw } : { value: normalized, other: "" };
}

function validateImportSubmission(submission: ImportSubmission) {
  const reasons: string[] = [];
  const required: Array<[string, string]> = [
    ["API name", submission.api_name],
    ["Company", submission.company_name],
    ["Description", submission.description],
    ["API endpoint", submission.api_endpoint],
    ["Official documentation", submission.documentation_url],
  ];
  for (const [label, value] of required) if (!value) reasons.push(`${label} is empty.`);
  if (submission.api_endpoint && !isHttpEndpoint(submission.api_endpoint)) reasons.push("API endpoint must be an http(s) URL or endpoint template.");
  if (submission.documentation_url && !isHttpUrl(submission.documentation_url)) reasons.push("Official documentation must be an http(s) URL.");
  if (submission.category === "Other" && !submission.category_other) reasons.push("Use the specific category name instead of only “Other”.");
  if (submission.authentication_method === "Other" && !submission.authentication_other) reasons.push("Use the specific authentication name instead of only “Other”.");
  const limits: Array<[string, string, number]> = [
    ["API name", submission.api_name, 180],
    ["Official API name", submission.official_api_name, 240],
    ["Company", submission.company_name, 180],
    ["Official company name", submission.official_company_name, 240],
    ["Description", submission.description, 2_000],
    ["API endpoint", submission.api_endpoint, 2_000],
    ["Official documentation", submission.documentation_url, 2_000],
    ["Authentication details", submission.authentication_details, 1_000],
    ["Other category", submission.category_other, 100],
    ["Other authentication", submission.authentication_other, 120],
  ];
  for (const [label, value, limit] of limits) {
    if (value.length > limit) reasons.push(`${label} exceeds ${limit.toLocaleString()} characters.`);
  }
  return reasons;
}

function createImportRows(rawRows: Array<Record<ImportHeader, string> & { sourceRow: number }>, records: ApiRecord[]) {
  const catalogKeys = new Set(records.map((record) => duplicateKey(record.company_name, record.api_name)));
  const fileKeys = new Set<string>();
  return rawRows.map<ImportPreviewRow>((row) => {
    const category = canonicalCategory(row.Category);
    const authentication = canonicalAuthentication(row.Authentication);
    const submission: ImportSubmission = {
      api_name: row["API name"],
      official_api_name: row["Official API name"],
      company_name: row.Company,
      official_company_name: row["Official company name"],
      description: row.Description,
      api_endpoint: row["API endpoint"],
      documentation_url: row["Official documentation"],
      category: category.value,
      category_other: category.other,
      authentication_method: authentication.value,
      authentication_other: authentication.other,
      authentication_details: row["Authentication details"],
      website_confirm: "",
      source_row: row.sourceRow,
    };
    const reasons = validateImportSubmission(submission);
    if (reasons.length > 0) return { rowNumber: row.sourceRow, submission, status: "invalid", reasons };
    const key = duplicateKey(submission.company_name, submission.api_name);
    if (catalogKeys.has(key)) {
      return { rowNumber: row.sourceRow, submission, status: "duplicate", reasons: ["Company + API name already exists in the catalog."] };
    }
    if (fileKeys.has(key)) {
      return { rowNumber: row.sourceRow, submission, status: "duplicate", reasons: ["A previous workbook row has the same Company + API name."] };
    }
    fileKeys.add(key);
    return { rowNumber: row.sourceRow, submission, status: "ready", reasons: [] };
  });
}

function editableFingerprint(value: ApiSubmission) {
  return JSON.stringify({
    api_name: value.api_name.trim(),
    official_api_name: value.official_api_name.trim(),
    company_name: value.company_name.trim(),
    official_company_name: value.official_company_name.trim(),
    description: value.description.trim(),
    api_endpoint: value.api_endpoint.trim(),
    documentation_url: value.documentation_url.trim(),
    category: value.category,
    category_other: value.category_other.trim(),
    authentication_method: value.authentication_method,
    authentication_other: value.authentication_other.trim(),
    authentication_details: value.authentication_details.trim(),
  });
}

export default function ApiRepository({ initialRecords }: RepositoryProps) {
  const [records, setRecords] = useState(initialRecords);
  const [selectedId, setSelectedId] = useState(initialRecords[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All categories");
  const [company, setCompany] = useState("All companies");
  const [status, setStatus] = useState("All records");
  const [activeModal, setActiveModal] = useState<ModalKind>(null);
  const [draft, setDraft] = useState<ApiSubmission>(emptyDraft);
  const [editBaseline, setEditBaseline] = useState<ApiSubmission>(emptyDraft);
  const [editingId, setEditingId] = useState("");
  const [editActor, setEditActor] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [verificationApiId, setVerificationApiId] = useState("");
  const [verificationDraft, setVerificationDraft] = useState<VerificationDraft>(emptyVerification);
  const [verificationError, setVerificationError] = useState("");
  const [savingVerification, setSavingVerification] = useState(false);
  const [storageMode, setStorageMode] = useState<StorageMode>("dataset");
  const [deletedRecords, setDeletedRecords] = useState<DeletedApiSummary[]>([]);
  const [deletedDetailId, setDeletedDetailId] = useState("");
  const [loadingCatalog, setLoadingCatalog] = useState(initialRecords.length === 0);
  const [catalogError, setCatalogError] = useState("");
  const [selectedForDelete, setSelectedForDelete] = useState<Set<string>>(new Set());
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [deleteActor, setDeleteActor] = useState("");
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [importRows, setImportRows] = useState<ImportPreviewRow[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [importActor, setImportActor] = useState("");
  const [importError, setImportError] = useState("");
  const [parsingFile, setParsingFile] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const firstModalInputRef = useRef<HTMLInputElement>(null);
  const openImportButtonRef = useRef<HTMLButtonElement>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const completionHeadingRef = useRef<HTMLHeadingElement>(null);
  const parseVersionRef = useRef(0);
  const mutationBusyRef = useRef(false);

  function resetImport() {
    parseVersionRef.current += 1;
    setImportRows([]);
    setImportFileName("");
    setImportActor("");
    setImportError("");
    setParsingFile(false);
    setImporting(false);
    setImportResult(null);
    if (importFileInputRef.current) importFileInputRef.current.value = "";
  }

  function closeModal() {
    if (mutationBusyRef.current) return;
    setActiveModal(null);
    setDraft(emptyDraft);
    setEditBaseline(emptyDraft);
    setEditingId("");
    setEditActor("");
    setFormError("");
    setDeleteIds([]);
    setDeleteActor("");
    setDeleteReason("");
    setDeleteError("");
    setDeletedDetailId("");
    resetImport();
  }

  async function refreshRepository(preferredId?: string) {
    try {
      const response = await fetch("/api/apis", { cache: "no-store" });
      if (!response.ok) throw new Error("Repository request failed");
      const payload = (await response.json()) as { apis?: ApiRecord[]; deleted_apis?: DeletedApiSummary[]; mode?: StorageMode };
      setStorageMode(payload.mode ?? "dataset");
      setCatalogError("");
      setDeletedRecords(payload.deleted_apis ?? []);
      if (!payload.apis) return;
      setRecords(payload.apis);
      setSelectedId((current) => {
        if (preferredId && payload.apis?.some((record) => record.id === preferredId)) return preferredId;
        if (payload.apis?.some((record) => record.id === current)) return current;
        return payload.apis?.[0]?.id ?? "";
      });
    } catch {
      // Keep the last successfully loaded catalog visible.
      setCatalogError("The shared database is temporarily unavailable. The last loaded catalog is still shown.");
    }
  }

  useEffect(() => {
    let active = true;
    fetch("/api/apis", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Repository request failed");
        return response.json() as Promise<{ apis?: ApiRecord[]; deleted_apis?: DeletedApiSummary[]; mode?: StorageMode }>;
      })
      .then((payload) => {
        if (!active) return;
        setStorageMode(payload.mode ?? "dataset");
        setLoadingCatalog(false);
        setCatalogError("");
        setDeletedRecords(payload.deleted_apis ?? []);
        if (!payload.apis) return;
        setRecords(payload.apis);
        setSelectedId((current) => payload.apis?.some((record) => record.id === current) ? current : payload.apis?.[0]?.id ?? "");
      })
      .catch(() => {
        if (!active) return;
        setLoadingCatalog(false);
        setCatalogError("The shared database is temporarily unavailable. Please try again shortly.");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setSelectedForDelete((current) => {
      const validIds = new Set(records.map((record) => record.id));
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [records]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if (event.key === "/" && !isTyping && !activeModal) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [activeModal]);

  useEffect(() => {
    if (!activeModal) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => firstModalInputRef.current?.focus());
    function handleModalKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
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
      (previousFocus ?? openImportButtonRef.current)?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal]);

  const categories = useMemo(() => [...new Set(records.map((record) => record.category).filter(Boolean))].sort(), [records]);
  const companies = useMemo(() => [...new Set(records.map((record) => record.company_name).filter(Boolean))].sort(), [records]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return records.filter((record) => {
      const matchesQuery = !normalized || [
        record.api_name, record.official_api_name, record.company_name, record.official_company_name,
        record.description, record.api_endpoint, record.category_other, record.authentication_method,
        record.authentication_other, record.authentication_details, ...record.input_formats, ...record.output_formats,
      ].join(" ").toLowerCase().includes(normalized);
      return matchesQuery
        && (category === "All categories" || record.category === category)
        && (company === "All companies" || record.company_name === company)
        && (status === "All records" || record.review_status === status);
    });
  }, [category, company, query, records, status]);

  const selected = filtered.find((record) => record.id === selectedId) ?? filtered[0];
  const publishedCount = records.filter((record) => record.review_status === "Published").length;
  const verifiedCount = records.filter((record) => record.review_status === "Verified").length;
  const allShownSelected = filtered.length > 0 && filtered.every((record) => selectedForDelete.has(record.id));
  const readyImportRows = importRows.filter((row) => row.status === "ready");
  const duplicateImportCount = importRows.filter((row) => row.status === "duplicate").length;
  const invalidImportCount = importRows.filter((row) => row.status === "invalid").length;
  const deleteRecords = deleteIds.flatMap((id) => {
    const record = records.find((item) => item.id === id);
    return record ? [record] : [];
  });
  const auditTrail = [...(selected?.audit_trail ?? [])].sort((a, b) => new Date(b.action_at).getTime() - new Date(a.action_at).getTime());
  const editHasChanges = editableFingerprint(draft) !== editableFingerprint(editBaseline);
  const deletedDetail = deletedRecords.find((record) => record.id === deletedDetailId) ?? deletedRecords[0];

  useEffect(() => {
    if (verificationOpen && verificationApiId !== selected?.id) {
      setVerificationOpen(false);
      setVerificationApiId("");
      setVerificationError("");
    }
  }, [selected?.id, verificationApiId, verificationOpen]);

  function resetFilters() {
    setQuery(""); setCategory("All categories"); setCompany("All companies"); setStatus("All records");
  }

  function openImport() { resetImport(); setActiveModal("import"); }

  function openEdit() {
    if (!selected) return;
    setEditingId(selected.id);
    setEditActor("");
    const nextDraft: ApiSubmission = {
      api_name: selected.api_name,
      official_api_name: selected.official_api_name,
      company_name: selected.company_name,
      official_company_name: selected.official_company_name,
      description: selected.description,
      api_endpoint: selected.api_endpoint,
      documentation_url: selected.documentation_url,
      category: selected.category,
      category_other: selected.category_other,
      authentication_method: selected.authentication_method,
      authentication_other: selected.authentication_other,
      authentication_details: selected.authentication_details,
      website_confirm: "",
    };
    setDraft(nextDraft);
    setEditBaseline(nextDraft);
    setFormError("");
    setActiveModal("edit");
  }

  function openDelete(ids: string[]) {
    const uniqueIds = [...new Set(ids)].filter((id) => records.some((record) => record.id === id));
    if (!uniqueIds.length) return;
    setDeleteIds(uniqueIds); setDeleteActor(""); setDeleteReason(""); setDeleteError(""); setActiveModal("delete");
  }

  function openDeletedRecords() {
    setDeletedDetailId(deletedRecords[0]?.id ?? "");
    setActiveModal("deleted");
  }

  function toggleSelectedForDelete(id: string) {
    setSelectedForDelete((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllShown() {
    setSelectedForDelete((current) => {
      const next = new Set(current);
      if (allShownSelected) filtered.forEach((record) => next.delete(record.id));
      else filtered.forEach((record) => next.add(record.id));
      return next;
    });
  }

  function exportCsv() {
    const fields: (keyof ApiRecord)[] = [
      "api_name", "official_api_name", "company_name", "official_company_name", "description",
      "api_endpoint", "documentation_url", "category", "category_other", "authentication_method",
      "authentication_other", "authentication_details", "network", "input_formats", "output_formats",
      "business_rules", "client_types", "review_status", "verified_by", "verification_notes", "verified_at", "source_url",
    ];
    const csv = [fields.map(csvEscape).join(","), ...filtered.map((record) => fields.map((field) => csvEscape(record[field])).join(","))].join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "business-api-repository-export.csv"; anchor.click(); URL.revokeObjectURL(url);
  }

  async function downloadImportTemplate() {
    setImportError("");
    try {
      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("APIs");
      sheet.addRow([...IMPORT_HEADERS]);
      sheet.addRow([
        "Example Invoice Submission API", "", "Example Tax Authority (ETA)", "",
        "Submit electronic invoices to the tax authority.", "https://api.example.gov/invoices",
        "https://developer.example.gov/docs", "Communication", "OAuth2",
        "Client credentials flow; invoice.submit scope.",
      ]);
      sheet.getRow(1).font = { bold: true };
      sheet.columns.forEach((column) => { column.width = 28; });
      const output = await workbook.xlsx.writeBuffer();
      const blob = new Blob([output as unknown as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = "api-import-template.xlsx"; anchor.click(); URL.revokeObjectURL(url);
    } catch {
      setImportError("The Excel template could not be generated in this browser.");
    }
  }

  async function parseImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const parseVersion = ++parseVersionRef.current;
    setImportRows([]); setImportResult(null); setImportError(""); setImportFileName(file?.name ?? "");
    if (!file) return;
    if (!file.name.toLocaleLowerCase().endsWith(".xlsx")) { setImportError("Choose an .xlsx Excel workbook."); return; }
    if (file.size > 5 * 1024 * 1024) { setImportError("The workbook is larger than 5 MB."); return; }
    setParsingFile(true);
    try {
      const { readSheet } = await import("read-excel-file/browser");
      if (parseVersion !== parseVersionRef.current) return;
      const sheetRows = await readSheet(file, { trim: false });
      if (parseVersion !== parseVersionRef.current) return;
      if (!sheetRows.length) throw new Error("The workbook has no worksheet data.");
      if (sheetRows.length > 5_000) {
        throw new Error("The first worksheet spans more than 5,000 rows. Remove unused formatted rows and try again.");
      }
      const headerColumns = new Map<string, number>();
      sheetRows[0].forEach((cell, columnIndex) => {
        const header = normalizedHeader(importCellText(cell));
        if (header && !headerColumns.has(header)) headerColumns.set(header, columnIndex);
      });
      const missing = IMPORT_HEADERS.filter((header) => !headerColumns.has(normalizedHeader(header)));
      if (missing.length > 0) throw new Error(`Missing required header${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
      const rawRows: Array<Record<ImportHeader, string> & { sourceRow: number }> = [];
      for (let rowIndex = 1; rowIndex < sheetRows.length; rowIndex += 1) {
        const row = sheetRows[rowIndex];
        const rowNumber = rowIndex + 1;
        const values = Object.fromEntries(IMPORT_HEADERS.map((header) => {
          const column = headerColumns.get(normalizedHeader(header)) as number;
          return [header, importCellText(row[column])];
        })) as Record<ImportHeader, string>;
        if (!IMPORT_HEADERS.some((header) => values[header])) continue;
        rawRows.push({ ...values, sourceRow: rowNumber });
        if (rawRows.length > 500) {
          throw new Error("This workbook contains more than 500 non-empty API rows.");
        }
      }
      if (!rawRows.length) throw new Error("The first worksheet has headers but no API rows.");
      setImportRows(createImportRows(rawRows, records));
    } catch (error) {
      if (parseVersion !== parseVersionRef.current) return;
      setImportError(error instanceof Error ? error.message : "The workbook could not be read.");
    } finally {
      if (parseVersion === parseVersionRef.current) setParsingFile(false);
    }
  }

  async function submitImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (importing || readyImportRows.length === 0) return;
    setImporting(true); setImportError("");
    try {
      const response = await fetch("/api/apis", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_name: importActor, website_confirm: "", apis: readyImportRows.map((row) => row.submission) }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        apis?: ApiRecord[]; imported?: ApiRecord[] | number; duplicates?: unknown[] | number;
        invalid?: unknown[] | number; warning?: string; error?: string; requestId?: string;
      };
      if (!response.ok) {
        const suffix = payload.requestId ? ` Reference: ${payload.requestId}` : "";
        throw new Error(`${payload.error ?? "The APIs could not be imported."}${suffix}`);
      }
      const returnedApis = payload.apis ?? (Array.isArray(payload.imported) ? payload.imported : []);
      setImportResult({
        submitted: readyImportRows.length,
        uploaded: returnedApis.length || resultCount(payload.imported),
        duplicates: duplicateImportCount + resultCount(payload.duplicates),
        invalid: invalidImportCount + resultCount(payload.invalid),
        warning: payload.warning,
      });
      if (returnedApis.length > 0) {
        setRecords((current) => {
          const returnedIds = new Set(returnedApis.map((record) => record.id));
          return [...returnedApis, ...current.filter((record) => !returnedIds.has(record.id))];
        });
        setSelectedId(returnedApis[0].id);
      }
      setStorageMode("supabase");
      await refreshRepository(returnedApis[0]?.id);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "The APIs could not be imported.");
    } finally { setImporting(false); }
  }

  async function copyEndpoint() {
    if (!selected?.api_endpoint) return;
    try { await navigator.clipboard.writeText(selected.api_endpoint); setNotice({ message: "Endpoint copied", kind: "success" }); }
    catch { setNotice({ message: "Could not copy the endpoint", kind: "error" }); }
    window.setTimeout(() => setNotice(null), 1_800);
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !editingId) return;
    setSubmitting(true); setFormError("");
    try {
      const response = await fetch("/api/apis", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId, actor_name: editActor, ...draft }),
      });
      const payload = (await response.json().catch(() => ({}))) as { api?: ApiRecord; warning?: string; error?: string; requestId?: string };
      if (!response.ok || !payload.api) {
        const suffix = payload.requestId ? ` Reference: ${payload.requestId}` : "";
        throw new Error(`${payload.error ?? "The API could not be updated."}${suffix}`);
      }
      setRecords((current) => current.map((record) => record.id === editingId ? payload.api as ApiRecord : record));
      setSelectedId(payload.api.id); setActiveModal(null); setDraft(emptyDraft); setEditingId(""); setEditActor("");
      setNotice(payload.warning
        ? { message: `API changes saved. ${payload.warning}`, kind: "error" }
        : { message: "API changes saved. The edit was added to its history.", kind: "success" });
      window.setTimeout(() => setNotice(null), 4_200);
      await refreshRepository(payload.api.id);
    } catch (error) { setFormError(error instanceof Error ? error.message : "The API could not be updated."); }
    finally { setSubmitting(false); }
  }

  function openVerificationEditor() {
    if (!selected) return;
    setVerificationApiId(selected.id);
    setVerificationDraft({
      review_status: selected.review_status,
      actor_name: "",
      verification_notes: selected.review_status === "Verified" ? selected.verification_notes : "",
    });
    setVerificationError(""); setVerificationOpen(true);
  }

  async function submitVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const verificationTarget = records.find((record) => record.id === verificationApiId);
    if (!verificationTarget || verificationTarget.id !== selected?.id || savingVerification) return;
    setSavingVerification(true); setVerificationError("");
    try {
      const response = await fetch("/api/apis", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: verificationTarget.id,
          review_status: verificationDraft.review_status,
          actor_name: verificationDraft.actor_name,
          verified_by: verificationDraft.review_status === "Verified" ? verificationDraft.actor_name : "",
          verification_notes: verificationDraft.review_status === "Verified" ? verificationDraft.verification_notes : "",
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { api?: ApiRecord; warning?: string; error?: string; requestId?: string };
      if (!response.ok || !payload.api) {
        const suffix = payload.requestId ? ` Reference: ${payload.requestId}` : "";
        throw new Error(`${payload.error ?? "Verification could not be saved."}${suffix}`);
      }
      setRecords((current) => current.map((record) => record.id === verificationTarget.id ? payload.api as ApiRecord : record));
      if (status !== "All records" && status !== payload.api.review_status) setStatus("All records");
      setSelectedId(payload.api.id); setVerificationOpen(false); setVerificationApiId("");
      setNotice(payload.warning
        ? { message: `Status saved. ${payload.warning}`, kind: "error" }
        : { message: payload.api.review_status === "Verified" ? "Verification saved and added to the audit trail." : "Verification removed; the API remains published.", kind: "success" });
      window.setTimeout(() => setNotice(null), 4_200);
      await refreshRepository(payload.api.id);
    } catch (error) { setVerificationError(error instanceof Error ? error.message : "Verification could not be saved."); }
    finally { setSavingVerification(false); }
  }

  async function submitDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (deleting || deleteIds.length === 0) return;
    setDeleting(true); setDeleteError("");
    try {
      const response = await fetch("/api/apis", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: deleteIds, actor_name: deleteActor, reason: deleteReason }),
      });
      const payload = (await response.json().catch(() => ({}))) as { deleted_ids?: string[]; deletedIds?: string[]; warning?: string; error?: string; requestId?: string };
      if (!response.ok) {
        const suffix = payload.requestId ? ` Reference: ${payload.requestId}` : "";
        throw new Error(`${payload.error ?? "The selected APIs could not be deleted."}${suffix}`);
      }
      const removedIds = payload.deleted_ids ?? payload.deletedIds ?? deleteIds;
      const removedSet = new Set([...deleteIds, ...removedIds]);
      const remaining = records.filter((record) => !removedSet.has(record.id));
      setRecords(remaining);
      setSelectedForDelete((current) => new Set([...current].filter((id) => !removedSet.has(id))));
      setSelectedId((current) => removedSet.has(current) ? remaining[0]?.id ?? "" : current);
      const count = removedIds.length;
      setActiveModal(null); setDeleteIds([]); setDeleteActor(""); setDeleteReason("");
      setNotice(payload.warning
        ? { message: `${count} API${count === 1 ? "" : "s"} deleted. ${payload.warning}`, kind: "error" }
        : { message: `${count} API${count === 1 ? "" : "s"} deleted. The action remains in the audit log.`, kind: "success" });
      window.setTimeout(() => setNotice(null), 4_200);
      await refreshRepository();
    } catch (error) { setDeleteError(error instanceof Error ? error.message : "The selected APIs could not be deleted."); }
    finally { setDeleting(false); }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#catalog" aria-label="Business API Repository home">
          <span className="brand-mark" aria-hidden="true">AR</span>
          <span><strong>API Repository</strong><small>Business API discovery</small></span>
        </a>
        <div className="topbar-actions">
          <span className={`connection-state ${storageMode === "supabase" ? "connected" : ""}`}><i aria-hidden="true" />{loadingCatalog ? "Loading catalog" : storageMode === "supabase" ? "Supabase connected" : "Static dataset"}</span>
          <button className="button secondary" type="button" onClick={exportCsv}>Export CSV</button>
          <button ref={openImportButtonRef} className="button primary" type="button" onClick={openImport}>Import Excel</button>
        </div>
      </header>

      <section className="workspace" id="catalog">
        {catalogError && <p className="repository-alert" role="alert">{catalogError}</p>}
        <div className="intro-row">
          <div>
            <p className="eyebrow">Catalog overview</p>
            <h1>Find the right business API, fast.</h1>
            <p className="intro-copy">Search global e-invoicing integrations, compare formats and authentication, and contribute directly to the shared catalog.</p>
            <p className="status-guide"><strong>Published</strong> means publicly visible but not manually verified.<strong>Verified</strong> means a site user recorded an official-source check.</p>
          </div>
          <div className="stat-grid" aria-label="Repository statistics">
            <article><strong>{records.length}</strong><span>Total APIs</span></article>
            <article><strong>{companies.length}</strong><span>Companies</span></article>
            <article><strong>{publishedCount}</strong><span>Published</span></article>
            <article><strong>{verifiedCount}</strong><span>Verified</span></article>
          </div>
        </div>

        <div className="filter-panel">
          <label className="search-field"><span className="sr-only">Search APIs</span><span aria-hidden="true">⌕</span><input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search API, company, endpoint, format…" /><kbd aria-hidden="true">/</kbd></label>
          <label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option>All categories</option>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option>All records</option><option>Published</option><option>Verified</option></select></label>
          <label><span>Company</span><select value={company} onChange={(event) => setCompany(event.target.value)}><option>All companies</option>{companies.map((item) => <option key={item}>{item}</option>)}</select></label>
        </div>

        <div className="catalog-layout">
          <section className="catalog-list" aria-label="API results">
            <div className="section-heading">
              <div><h2>API catalog</h2><span>{filtered.length} results</span></div>
              <div className="section-heading-actions">
                {filtered.length > 0 && <button type="button" className="text-button" onClick={toggleAllShown}>{allShownSelected ? "Unselect shown" : "Select all shown"}</button>}
                {selectedForDelete.size > 0 && <button type="button" className="text-button danger-text" onClick={() => openDelete([...selectedForDelete])}>Delete selected ({selectedForDelete.size})</button>}
                {(query || category !== "All categories" || company !== "All companies" || status !== "All records") && <button type="button" className="text-button" onClick={resetFilters}>Clear filters</button>}
              </div>
            </div>
            <div className="result-list">
              {filtered.map((record) => (
                <div className="api-card-row" key={record.id}>
                  <label className="record-selector"><input type="checkbox" checked={selectedForDelete.has(record.id)} onChange={() => toggleSelectedForDelete(record.id)} /><span className="sr-only">Select {record.api_name} for deletion</span></label>
                  <button type="button" className={`api-card ${selected?.id === record.id ? "selected" : ""}`} onClick={() => { setSelectedId(record.id); setVerificationOpen(false); setVerificationApiId(""); setVerificationError(""); }} aria-pressed={selected?.id === record.id} aria-controls="api-detail">
                    <span className="api-card-topline"><span className={`pill ${categoryTone[record.category] ?? "tone-gray"}`}>{categoryLabel(record)}</span><span className={`status-label ${statusClass(record.review_status)}`} title={statusMeaning(record.review_status)}>{record.review_status}</span></span>
                    <strong>{record.api_name}</strong>
                    {showOriginal(record.api_name, record.official_api_name) && <span className="official-name" lang="und">{record.official_api_name}</span>}
                    <span className="company-name">{record.company_name}</span>
                    <span className="api-card-description">{record.description}</span>
                    <span className="api-card-meta"><span>{authenticationLabel(record) || "Auth not listed"}</span><span>{record.input_formats.slice(0, 2).join(" · ") || "Format not listed"}</span></span>
                  </button>
                </div>
              ))}
              {filtered.length === 0 && <div className="empty-state"><strong>{loadingCatalog ? "Loading the shared catalog…" : "No APIs match these filters."}</strong>{!loadingCatalog && <><p>Try a broader search or clear the current filters.</p><button className="button secondary" type="button" onClick={resetFilters}>Clear filters</button></>}</div>}
            </div>
          </section>

          <aside className="detail-panel" id="api-detail" aria-label="Selected API details">
            {selected ? <>
              <div className="detail-header"><div className="company-avatar" aria-hidden="true">{selected.company_name.slice(0, 2).toUpperCase()}</div><div><span className="detail-company">{selected.company_name}</span>{showOriginal(selected.company_name, selected.official_company_name) && <span className="official-company" lang="und">{selected.official_company_name}</span>}<h2>{selected.api_name}</h2>{showOriginal(selected.api_name, selected.official_api_name) && <p className="detail-official-name" lang="und">{selected.official_api_name}</p>}</div></div>
              <div className="detail-badges"><span className={`pill ${categoryTone[selected.category] ?? "tone-gray"}`}>{categoryLabel(selected)}</span><span className={`pill tone-gray status-${statusClass(selected.review_status)}`} title={statusMeaning(selected.review_status)}>{selected.review_status}</span>{selected.network && <span className="pill tone-purple">{selected.network}</span>}</div>
              <p className="detail-description">{selected.description}</p>
              <section className="endpoint-box"><span>API endpoint</span><code>{selected.api_endpoint}</code><button type="button" onClick={copyEndpoint} aria-label={`Copy endpoint for ${selected.api_name}`}>Copy</button></section>
              <dl className="detail-grid"><div><dt>Authentication</dt><dd>{authenticationLabel(selected) || "Not listed"}</dd></div><div><dt>Documentation host</dt><dd>{shortHost(selected.documentation_url)}</dd></div><div><dt>Input formats</dt><dd>{selected.input_formats.join(", ") || "Not listed"}</dd></div><div><dt>Output formats</dt><dd>{selected.output_formats.join(", ") || "Not listed"}</dd></div></dl>

              <section className={`verification-panel ${selected.review_status === "Verified" ? "verified" : ""}`}>
                <div className="verification-heading"><div><span>Verification status</span><strong>{selected.review_status}</strong></div><button className="button secondary" type="button" onClick={openVerificationEditor}>Update status</button></div>
                {selected.review_status === "Verified" ? <div className="verification-record"><p>Marked verified by <strong>{selected.verified_by || "Internal user"}</strong><span>{formatDateTime(selected.verified_at)}</span></p><p>{selected.verification_notes || "Official source checked; no note supplied."}</p></div> : <p className="verification-copy">This API is public but has not been manually checked. A documentation link alone does not count as verification.</p>}
                {verificationOpen && <form className="verification-form" onSubmit={submitVerification}>
                  <label><span>Status</span><select value={verificationDraft.review_status} onChange={(event) => setVerificationDraft({ ...verificationDraft, review_status: event.target.value as ReviewStatus, verification_notes: event.target.value === "Verified" ? verificationDraft.verification_notes : "" })}><option>Published</option><option>Verified</option></select></label>
                  <label><span>Action by (self-declared) *</span><input required maxLength={120} placeholder="Your name or team" value={verificationDraft.actor_name} onChange={(event) => setVerificationDraft({ ...verificationDraft, actor_name: event.target.value })} /></label>
                  {verificationDraft.review_status === "Verified" && <label className="full"><span>Verification note *</span><textarea required rows={3} maxLength={1_000} placeholder="What official source was checked, and what matched?" value={verificationDraft.verification_notes} onChange={(event) => setVerificationDraft({ ...verificationDraft, verification_notes: event.target.value })} /></label>}
                  <p className="verification-disclaimer full">Names are self-entered because this internal site has no login system.</p>
                  {verificationError && <p className="form-error full" role="alert">{verificationError}</p>}
                  <div className="verification-actions full"><button className="button secondary" type="button" disabled={savingVerification} onClick={() => { setVerificationOpen(false); setVerificationApiId(""); setVerificationError(""); }}>Cancel</button><button className="button primary" type="submit" disabled={savingVerification}>{savingVerification ? "Saving…" : "Save status"}</button></div>
                </form>}
              </section>

              {selected.authentication_details && <section className="detail-section"><h3>Authentication details</h3><p>{selected.authentication_details}</p></section>}
              <section className="detail-section"><h3>Implementation notes</h3><p>{selected.instructions || "No implementation notes have been supplied."}</p></section>
              {selected.business_rules.length > 0 && <section className="detail-section"><h3>Business rules</h3><div className="tag-row">{selected.business_rules.map((rule) => <span key={rule}>{rule}</span>)}</div></section>}
              <section className="detail-section audit-section">
                <div className="audit-heading"><h3>Action history</h3><span>{auditTrail.length} event{auditTrail.length === 1 ? "" : "s"}</span></div>
                {auditTrail.length > 0 ? <ol className="audit-timeline">{auditTrail.map((event) => <li key={event.id}><span className={`audit-marker action-${event.action}`} aria-hidden="true" /><div><p><strong>{event.actor_name || "Internal user"}</strong>{` ${actionLabels[event.action]} this API`}</p><time dateTime={event.action_at}>{formatDateTime(event.action_at)}</time>{event.details && <span className="audit-details">{event.details}</span>}</div></li>)}</ol> : <p className="audit-empty">No action history has been recorded for this dataset entry yet.</p>}
              </section>
              <div className="detail-actions">
                {selected.documentation_url && <a className="button primary" href={selected.documentation_url} target="_blank" rel="noreferrer" aria-label={`Open documentation for ${selected.api_name} in a new tab`}>Open documentation ↗</a>}
                {selected.website_url && <a className="button secondary" href={selected.website_url} target="_blank" rel="noreferrer" aria-label={`Open ${selected.company_name} website in a new tab`}>Company website ↗</a>}
                <button className="button secondary" type="button" onClick={openEdit}>Edit API</button>
                <button className="button danger" type="button" onClick={() => openDelete([selected.id])}>Delete API</button>
              </div>
            </> : <div className="empty-state"><strong>Select an API to view details.</strong></div>}
          </aside>
        </div>
      </section>

      {activeModal === "import" && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
        <section ref={modalRef} className="modal wide import-modal" role="dialog" aria-modal="true" aria-labelledby="import-api-title" aria-describedby="import-api-description">
          <div className="modal-heading"><div><p className="eyebrow">Bulk contribution</p><h2 id="import-api-title">Import APIs from Excel</h2></div><button type="button" aria-label="Close Excel importer" onClick={closeModal}>×</button></div>
          <p className="modal-copy" id="import-api-description">Upload one .xlsx workbook (maximum 5 MB and 500 API rows). The first worksheet is used. Nothing is saved until you review the row-by-row preview and confirm the final set.</p>
          <section className="header-requirements" aria-labelledby="required-headers-title">
            <div><h3 id="required-headers-title">Required headers</h3><p>Include all 10 labels. Order can vary; capitalization and surrounding spaces are ignored. Values may be blank only for the two Official name columns and Authentication details.</p></div>
            <button className="button secondary" type="button" onClick={downloadImportTemplate}>Download template</button>
            <div className="import-header-list">{IMPORT_HEADERS.map((header) => <code key={header}>{header}</code>)}</div>
          </section>
          {!importResult ? <form className="import-form" onSubmit={submitImport}>
            <label className="file-picker"><span>Select Excel workbook *</span><input ref={(node) => { importFileInputRef.current = node; firstModalInputRef.current = node; }} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={parseImportFile} disabled={parsingFile || importing} /><small>{parsingFile ? "Reading and checking workbook…" : importFileName || "Only .xlsx files are accepted."}</small></label>
            {importRows.length > 0 && <>
              <div className="import-summary" aria-label="Import preview summary"><article className="ready"><strong>{readyImportRows.length}</strong><span>Ready to upload</span></article><article className="duplicate"><strong>{duplicateImportCount}</strong><span>Duplicates filtered</span></article><article className="invalid"><strong>{invalidImportCount}</strong><span>Invalid filtered</span></article><article><strong>{importRows.length}</strong><span>Total rows reviewed</span></article></div>
              <p className="preview-explainer">All rows are shown below. Only rows marked <strong>Ready</strong> will be sent; duplicate and invalid rows do not block the batch.</p>
              <div className="import-table-shell" tabIndex={0} aria-label="Excel import preview"><table className="import-table"><thead><tr><th scope="col">Row</th><th scope="col">API</th><th scope="col">Company</th><th scope="col">Category / authentication</th><th scope="col">Decision</th></tr></thead><tbody>{importRows.map((row) => <tr key={row.rowNumber} className={`preview-${row.status}`}><td>{row.rowNumber}</td><td><strong>{row.submission.api_name || "Missing API name"}</strong><span>{row.submission.api_endpoint || "No endpoint"}</span></td><td>{row.submission.company_name || "Missing company"}</td><td><span>{row.submission.category === "Other" ? row.submission.category_other || "Other" : row.submission.category}</span><span>{row.submission.authentication_method === "Other" ? row.submission.authentication_other || "Other" : row.submission.authentication_method}</span></td><td><span className={`row-status ${row.status}`}>{row.status}</span>{row.reasons.map((reason) => <small key={reason}>{reason}</small>)}</td></tr>)}</tbody></table></div>
              <label className="actor-field"><span>Uploaded by (self-declared) *</span><input required maxLength={120} placeholder="Your name or team" value={importActor} onChange={(event) => setImportActor(event.target.value)} /><small>This name and the upload date will appear in every imported API’s history.</small></label>
            </>}
            {importError && <p className="form-error" role="alert">{importError}</p>}
            <div className="form-footer import-footer"><span>{readyImportRows.length > 0 ? `Final upload set: ${readyImportRows.length} API${readyImportRows.length === 1 ? "" : "s"}.` : "Choose a valid workbook to build the final upload set."}</span><div><button className="button secondary" type="button" onClick={closeModal} disabled={importing}>Cancel</button><button className="button primary" type="submit" disabled={importing || parsingFile || readyImportRows.length === 0}>{importing ? "Uploading…" : `Confirm and upload ${readyImportRows.length || ""} API${readyImportRows.length === 1 ? "" : "s"}`}</button></div></div>
          </form> : <section className="import-complete" aria-live="polite"><span className="completion-mark" aria-hidden="true">✓</span><h3>Import finished</h3><p>The server checked the final set again before saving it.</p><div className="import-summary"><article className="ready"><strong>{importResult.uploaded}</strong><span>Uploaded</span></article><article className="duplicate"><strong>{importResult.duplicates}</strong><span>Duplicates filtered</span></article><article className="invalid"><strong>{importResult.invalid}</strong><span>Invalid filtered</span></article><article><strong>{importResult.submitted}</strong><span>Rows submitted</span></article></div>{importResult.warning && <p className="form-error" role="alert">{importResult.warning}</p>}<div className="completion-actions"><button className="button secondary" type="button" onClick={resetImport}>Import another file</button><button className="button primary" type="button" onClick={closeModal}>Close</button></div></section>}
        </section>
      </div>}

      {activeModal === "edit" && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
        <section ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-api-title" aria-describedby="edit-api-description">
          <div className="modal-heading"><div><p className="eyebrow">Catalog maintenance</p><h2 id="edit-api-title">Edit API</h2></div><button type="button" aria-label="Close edit API form" onClick={closeModal}>×</button></div>
          <p className="modal-copy" id="edit-api-description">Save corrected catalog details. The editor and date will be recorded in this API’s history.</p>
          <form onSubmit={submitEdit} className="api-form">
            <label className="full"><span>Edited by (self-declared) *</span><input ref={firstModalInputRef} required maxLength={120} placeholder="Your name or team" value={editActor} onChange={(event) => setEditActor(event.target.value)} /></label>
            <p className="edit-warning full">Editing verified API content returns it to Published until it is checked again.</p>
            <label><span>API name (readable English) *</span><input required maxLength={180} value={draft.api_name} onChange={(event) => setDraft({ ...draft, api_name: event.target.value })} /></label>
            <label><span>Official API/service name</span><input maxLength={240} lang="und" value={draft.official_api_name} onChange={(event) => setDraft({ ...draft, official_api_name: event.target.value })} /></label>
            <label><span>Company (English + abbreviation) *</span><input required maxLength={180} value={draft.company_name} onChange={(event) => setDraft({ ...draft, company_name: event.target.value })} /></label>
            <label><span>Official company name</span><input maxLength={240} lang="und" value={draft.official_company_name} onChange={(event) => setDraft({ ...draft, official_company_name: event.target.value })} /></label>
            <label className="full"><span>Description *</span><textarea required rows={4} maxLength={2_000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
            <label className="full"><span>API endpoint *</span><input required type="text" inputMode="url" maxLength={2_000} value={draft.api_endpoint} onChange={(event) => setDraft({ ...draft, api_endpoint: event.target.value })} /></label>
            <label className="full"><span>Official documentation *</span><input required type="url" maxLength={2_000} value={draft.documentation_url} onChange={(event) => setDraft({ ...draft, documentation_url: event.target.value })} /></label>
            <label><span>Category</span><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as ApiSubmission["category"], category_other: event.target.value === "Other" ? draft.category_other : "" })}>{API_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label><span>Authentication</span><select value={draft.authentication_method} onChange={(event) => setDraft({ ...draft, authentication_method: event.target.value as ApiSubmission["authentication_method"], authentication_other: event.target.value === "Other" ? draft.authentication_other : "" })}>{AUTHENTICATION_TYPES.map((item) => <option key={item}>{item}</option>)}</select></label>
            {draft.category === "Other" && <label><span>Other category *</span><input required maxLength={100} value={draft.category_other} onChange={(event) => setDraft({ ...draft, category_other: event.target.value })} /></label>}
            {draft.authentication_method === "Other" && <label><span>Other authentication *</span><input required maxLength={120} value={draft.authentication_other} onChange={(event) => setDraft({ ...draft, authentication_other: event.target.value })} /></label>}
            <label className="full"><span>Authentication details</span><textarea rows={3} maxLength={1_000} value={draft.authentication_details} onChange={(event) => setDraft({ ...draft, authentication_details: event.target.value })} /></label>
            {formError && <p className="form-error full" role="alert">{formError}</p>}
            <div className="form-footer full"><span>Names are self-entered because this internal site has no login system.</span><div><button className="button secondary" type="button" onClick={closeModal} disabled={submitting}>Cancel</button><button className="button primary" type="submit" disabled={submitting}>{submitting ? "Saving…" : "Save changes"}</button></div></div>
          </form>
        </section>
      </div>}

      {activeModal === "delete" && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
        <section ref={modalRef} className="modal delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-api-title" aria-describedby="delete-api-description">
          <div className="modal-heading"><div><p className="eyebrow danger-eyebrow">Catalog removal</p><h2 id="delete-api-title">Delete {deleteIds.length} API{deleteIds.length === 1 ? "" : "s"}?</h2></div><button type="button" aria-label="Close delete confirmation" onClick={closeModal}>×</button></div>
          <p className="modal-copy" id="delete-api-description">The selected records will disappear from the catalog. Their deletion events remain in the audit log.</p>
          <div className="delete-record-list">{deleteRecords.slice(0, 8).map((record) => <div key={record.id}><strong>{record.api_name}</strong><span>{record.company_name}</span></div>)}{deleteRecords.length > 8 && <p>+ {deleteRecords.length - 8} more selected APIs</p>}</div>
          <form className="delete-form" onSubmit={submitDelete}>
            <label><span>Deleted by (self-declared) *</span><input ref={firstModalInputRef} required maxLength={120} placeholder="Your name or team" value={deleteActor} onChange={(event) => setDeleteActor(event.target.value)} /></label>
            <label><span>Reason (optional)</span><textarea rows={3} maxLength={1_000} placeholder="For example: duplicate, incorrect endpoint, or verification failed" value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} /></label>
            {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
            <div className="form-footer"><span>This action is recorded with your entered name and the current date.</span><div><button className="button secondary" type="button" onClick={closeModal} disabled={deleting}>Cancel</button><button className="button danger" type="submit" disabled={deleting}>{deleting ? "Deleting…" : "Confirm delete"}</button></div></div>
          </form>
        </section>
      </div>}

      {notice && <div className={`toast ${notice.kind === "error" ? "error" : ""}`} role="status">{notice.message}</div>}
    </main>
  );
}
