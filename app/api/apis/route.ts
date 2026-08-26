import { NextResponse } from "next/server";
import seedData from "@/app/data/apis.json";
import {
  API_CATEGORIES,
  AUTHENTICATION_TYPES,
  normalizeApiRecord,
  type ApiCategory,
  type ApiRecord,
  type AuditAction,
  type AuditEvent,
  type AuthenticationType,
  type DeletedApiSummary,
  type ReviewStatus,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const SELECT_FIELDS = [
  "id", "api_name", "official_api_name", "description", "api_endpoint", "instructions",
  "company_name", "official_company_name", "website_url", "documentation_url", "category",
  "category_other", "authentication_method", "authentication_other", "authentication_details",
  "network", "is_active", "created_at", "updated_at", "input_formats", "output_formats",
  "business_rules", "client_types", "review_status", "source_url", "verified_at", "verified_by",
  "verification_notes",
].join(",");

const AUDIT_FIELDS = [
  "id", "api_id", "api_name", "company_name", "action", "actor_name", "details", "action_at",
].join(",");

const fallbackRecords = (seedData as Array<Partial<ApiRecord>>).map(normalizeApiRecord);
const fallbackById = new Map(fallbackRecords.map((record) => [record.id, record]));
const rateLimitStore = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 10;
const MAX_BATCH_SIZE = 500;
const MAX_BULK_BODY_BYTES = 1_000_000;
const MAX_MUTATION_BODY_BYTES = 30_000;
const PAGE_SIZE = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SupabaseConfig = { url: string; key: string; opaqueSecret: boolean };
type DatabaseApiRow = Partial<ApiRecord> & { id?: string };
type SubmissionRecord = ReturnType<typeof submissionDatabaseRecord>;
type ValidatedSubmission = { sourceRow: number; record: SubmissionRecord };
type DuplicateReport = {
  source_row: number;
  api_name: string;
  company_name: string;
  reason: string;
};
type InvalidReport = {
  source_row: number;
  api_name: string;
  company_name: string;
  error: string;
};

class ValidationError extends Error {}
class PayloadTooLargeError extends Error {}
class DatabaseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const newSecret = process.env.SUPABASE_SECRET_KEY?.trim();
  const legacyKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const key = newSecret || legacyKey;
  return url && key ? { url, key, opaqueSecret: key.startsWith("sb_secret_") } : null;
}

function supabaseHeaders(config: SupabaseConfig, write = false): Record<string, string> {
  const headers: Record<string, string> = { apikey: config.key, Accept: "application/json" };
  if (!config.opaqueSecret) headers.Authorization = `Bearer ${config.key}`;
  if (write) headers["Content-Type"] = "application/json";
  return headers;
}

function publicError(message: string, status: number, requestId: string) {
  return NextResponse.json(
    { error: message, requestId },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function sanitizeString(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
  required = false,
) {
  const value = input[field];
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required.`);
    return "";
  }
  if (typeof value !== "string") throw new ValidationError(`${field} must be text.`);
  const cleaned = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (required && !cleaned) throw new ValidationError(`${field} is required.`);
  if (cleaned.length > maxLength) {
    throw new ValidationError(`${field} must be ${maxLength} characters or fewer.`);
  }
  return cleaned;
}

function requireHttpUrl(value: string, label: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError(`${label} must start with http:// or https://.`);
  }
}

function requireHttpEndpoint(value: string) {
  // Government-hosted, on-premise connectors sometimes document a template
  // (for example http://{VSDC-host}:{port}/path) rather than one deployable URL.
  if (!/^https?:\/\/[^\s<>"`]+$/i.test(value)) {
    throw new ValidationError("API endpoint must be an http(s) URL or endpoint template.");
  }
}

function requireUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new ValidationError("API id is invalid.");
}

function getClientKey(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function isRateLimited(clientKey: string) {
  const now = Date.now();
  const recent = (rateLimitStore.get(clientKey) ?? []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitStore.set(clientKey, recent);
    return true;
  }
  recent.push(now);
  rateLimitStore.set(clientKey, recent);
  if (rateLimitStore.size > 5_000) {
    for (const [key, timestamps] of rateLimitStore) {
      if (!timestamps.some((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS)) {
        rateLimitStore.delete(key);
      }
    }
  }
  return false;
}

function normalizeKeyPart(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function recordKey(record: Pick<ApiRecord, "company_name" | "api_name">) {
  return `${normalizeKeyPart(record.company_name)}\u0000${normalizeKeyPart(record.api_name)}`;
}

function sourceRow(input: Record<string, unknown>, index: number) {
  const value = input.source_row;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : index + 2;
}

async function readJsonObject(request: Request, maximumBytes: number) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new PayloadTooLargeError("Request body is too large.");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumBytes) {
    throw new PayloadTooLargeError("Request body is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ValidationError("Invalid JSON request body.");
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new ValidationError("A JSON object is required.");
  }
  return value as Record<string, unknown>;
}

function optionalBoolean(
  input: Record<string, unknown>,
  field: string,
  defaultValue: boolean,
) {
  const value = input[field];

  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0"].includes(normalized)) return false;
  }

  throw new ValidationError(`${field} must be true or false.`);
}

function optionalStringArray(
  input: Record<string, unknown>,
  field: string,
  defaultValue: string[] = [],
) {
  const value = input[field];

  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/[,;|\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  throw new ValidationError(`${field} must be a list or text.`);
}

function submissionDatabaseRecord(input: Record<string, unknown>) {
  const apiName = sanitizeString(input, "api_name", 180, true);
  const companyName = sanitizeString(input, "company_name", 180, true);

  const description = sanitizeString(input, "description", 2_000, true);
  const apiEndpoint = sanitizeString(input, "api_endpoint", 2_000, true);
  const documentationUrl = sanitizeString(
    input,
    "documentation_url",
    2_000,
    true,
  );

  const category = sanitizeString(input, "category", 40, true);
  const authentication = sanitizeString(
    input,
    "authentication_method",
    60,
    true,
  );

  const instructions = sanitizeString(input, "instructions", 4_000);
  const websiteUrl = sanitizeString(input, "website_url", 2_000);
  const network = sanitizeString(input, "network", 200);

  const categoryOtherInput = sanitizeString(
    input,
    "category_other",
    100,
  );

  const authenticationOtherInput = sanitizeString(
    input,
    "authentication_other",
    120,
  );

  const authenticationDetails = sanitizeString(
    input,
    "authentication_details",
    1_000,
  );

  requireHttpEndpoint(apiEndpoint);
  requireHttpUrl(documentationUrl, "Official documentation");

  if (websiteUrl) {
    requireHttpUrl(websiteUrl, "Website URL");
  }

  if (!API_CATEGORIES.includes(category as ApiCategory)) {
    throw new ValidationError("Category is not supported.");
  }

  if (!AUTHENTICATION_TYPES.includes(authentication as AuthenticationType)) {
    throw new ValidationError("Authentication type is not supported.");
  }

  if (category === "Other" && !categoryOtherInput) {
    throw new ValidationError("Please enter the other category.");
  }

  if (authentication === "Other" && !authenticationOtherInput) {
    throw new ValidationError(
      "Please enter the other authentication type.",
    );
  }

  return {
    api_name: apiName,

    // Not required from Excel
    official_api_name: "",
    company_name: companyName,
    official_company_name: "",

    description,
    api_endpoint: apiEndpoint,
    instructions,

    website_url: websiteUrl,
    documentation_url: documentationUrl,

    category: category as ApiCategory,
    category_other:
      category === "Other" ? categoryOtherInput : "",

    authentication_method:
      authentication as AuthenticationType,
    authentication_other:
      authentication === "Other"
        ? authenticationOtherInput
        : "",
    authentication_details: authenticationDetails,

    network,

    is_active: optionalBoolean(input, "is_active", true),

    input_formats: optionalStringArray(
      input,
      "input_formats",
      ["JSON"],
    ),

    output_formats: optionalStringArray(
      input,
      "output_formats",
      ["JSON"],
    ),

    business_rules: optionalStringArray(
      input,
      "business_rules",
      [],
    ),

    client_types: optionalStringArray(
      input,
      "client_types",
      ["REST"],
    ),

    review_status: "Published" as ReviewStatus,
    source_url: documentationUrl,

    verified_at: null,
    verified_by: "",
    verification_notes: "",
  };
}


function databaseRecord(record: ApiRecord) {
  return {
    id: record.id,
    api_name: record.api_name,
    official_api_name: record.official_api_name,
    description: record.description,
    api_endpoint: record.api_endpoint,
    instructions: record.instructions,
    company_name: record.company_name,
    official_company_name: record.official_company_name,
    website_url: record.website_url,
    documentation_url: record.documentation_url,
    category: record.category,
    category_other: record.category_other,
    authentication_method: record.authentication_method,
    authentication_other: record.authentication_other,
    authentication_details: record.authentication_details,
    network: record.network,
    is_active: record.is_active,
    input_formats: record.input_formats,
    output_formats: record.output_formats,
    business_rules: record.business_rules,
    client_types: record.client_types,
    review_status: "Published" as ReviewStatus,
    source_url: record.source_url,
    verified_at: null,
    verified_by: "",
    verification_notes: "",
  };
}

async function fetchAllRows<T>(
  config: SupabaseConfig,
  table: "apis" | "api_audit_events",
  select: string,
  order: string,
  requestId: string,
) {
  const rows: T[] = [];
  let offset = 0;
  while (true) {
    const query = new URLSearchParams({
      select,
      order,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    const response = await fetch(`${config.url}/rest/v1/${table}?${query}`, {
      headers: supabaseHeaders(config),
      cache: "no-store",
    });
    if (!response.ok) {
      console.error("Supabase read failed", { table, status: response.status, requestId });
      throw new DatabaseError("Database read failed.", response.status);
    }
    const page = (await response.json()) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    offset += page.length;
    if (offset > 100_000) throw new DatabaseError("Database result is too large.", 500);
  }
}

function normalizeAuditEvents(rows: Array<Partial<AuditEvent>>) {
  const actions: AuditAction[] = ["upload", "edit", "verify", "status_change", "delete"];
  return rows.flatMap((row): AuditEvent[] => {
    if (
      typeof row.id !== "string" || typeof row.api_id !== "string" ||
      typeof row.api_name !== "string" || typeof row.company_name !== "string" ||
      typeof row.action !== "string" || !actions.includes(row.action as AuditAction) ||
      typeof row.actor_name !== "string" || typeof row.details !== "string" ||
      typeof row.action_at !== "string"
    ) return [];
    return [row as AuditEvent];
  });
}

function mergeWithFallback(databaseRecords: ApiRecord[]) {
  // Inactive DB rows deliberately shadow bundled rows, so soft-deleted seeds
  // cannot reappear on refresh.
  const databaseIds = new Set(databaseRecords.map((record) => record.id));
  const databaseKeys = new Set(databaseRecords.map(recordKey));
  const activeByKey = new Map<string, ApiRecord>();
  for (const record of databaseRecords) {
    if (record.is_active) activeByKey.set(recordKey(record), record);
  }
  for (const record of fallbackRecords) {
    if (!databaseIds.has(record.id) && !databaseKeys.has(recordKey(record))) {
      activeByKey.set(recordKey(record), record);
    }
  }
  return [...activeByKey.values()];
}

async function insertApiRows(config: SupabaseConfig, records: unknown[], requestId: string) {
  if (records.length === 0) return [] as DatabaseApiRow[];
  const query = new URLSearchParams({ select: SELECT_FIELDS });
  const response = await fetch(`${config.url}/rest/v1/apis?${query}`, {
    method: "POST",
    headers: { ...supabaseHeaders(config, true), Prefer: "return=representation" },
    body: JSON.stringify(records),
    cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 409) throw new DatabaseError("Duplicate API record.", 409);
    console.error("Supabase API insert failed", { status: response.status, requestId });
    throw new DatabaseError("API insert failed.", response.status);
  }
  return (await response.json()) as DatabaseApiRow[];
}

async function updateApiRows(
  config: SupabaseConfig,
  ids: string[],
  update: Record<string, unknown>,
  requestId: string,
) {
  if (ids.length === 0) return [] as DatabaseApiRow[];
  const query = new URLSearchParams({ id: `in.(${ids.join(",")})`, select: SELECT_FIELDS });
  const response = await fetch(`${config.url}/rest/v1/apis?${query}`, {
    method: "PATCH",
    headers: { ...supabaseHeaders(config, true), Prefer: "return=representation" },
    body: JSON.stringify(update),
    cache: "no-store",
  });
  if (!response.ok) {
    console.error("Supabase API update failed", { status: response.status, requestId });
    throw new DatabaseError("API update failed.", response.status);
  }
  return (await response.json()) as DatabaseApiRow[];
}

async function appendAuditEvents(
  config: SupabaseConfig,
  events: Array<Omit<AuditEvent, "id" | "action_at">>,
  requestId: string,
) {
  if (events.length === 0) return true;
  // Stable client-generated IDs make one retry safe even if the first response
  // was lost after Supabase committed the transaction.
  const rows = events.map((event) => ({ id: crypto.randomUUID(), ...event }));
  let firstAttemptWasAmbiguous = false;
  let lastStatus: number | "network" = "network";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${config.url}/rest/v1/api_audit_events`, {
        method: "POST",
        headers: { ...supabaseHeaders(config, true), Prefer: "return=minimal" },
        body: JSON.stringify(rows),
        cache: "no-store",
      });
      if (response.ok) return true;
      lastStatus = response.status;
      if (attempt === 1 && response.status === 409 && firstAttemptWasAmbiguous) return true;
      firstAttemptWasAmbiguous = response.status >= 500;
    } catch {
      lastStatus = "network";
      firstAttemptWasAmbiguous = true;
    }
  }
  console.error("Supabase audit insert failed", { status: lastStatus, requestId });
  return false;
}

async function resolveMutationTargets(
  config: SupabaseConfig,
  ids: string[],
  requestId: string,
) {
  let rawRows = await fetchAllRows<DatabaseApiRow>(config, "apis", SELECT_FIELDS, "id.asc", requestId);
  let records = rawRows.map(normalizeApiRecord);
  let byId = new Map(records.map((record) => [record.id, record]));
  let byKey = new Map(records.map((record) => [recordKey(record), record]));
  const promotions = new Map<string, ApiRecord>();

  for (const id of ids) {
    if (byId.has(id)) continue;
    const seed = fallbackById.get(id);
    if (!seed) continue;
    const existingByKey = byKey.get(recordKey(seed));
    if (existingByKey) byId.set(id, existingByKey);
    else promotions.set(seed.id, seed);
  }

  if (promotions.size > 0) {
    try {
      await insertApiRows(config, [...promotions.values()].map(databaseRecord), requestId);
    } catch (error) {
      // Another request may have promoted the same seed. Reload on a unique-key race.
      if (!(error instanceof DatabaseError) || error.status !== 409) throw error;
    }
    rawRows = await fetchAllRows<DatabaseApiRow>(config, "apis", SELECT_FIELDS, "id.asc", requestId);
    records = rawRows.map(normalizeApiRecord);
    byId = new Map(records.map((record) => [record.id, record]));
    byKey = new Map(records.map((record) => [recordKey(record), record]));
  }

  const targets = new Map<string, ApiRecord>();
  const notFound: string[] = [];
  for (const id of ids) {
    const seed = fallbackById.get(id);
    const target = byId.get(id) || (seed ? byKey.get(recordKey(seed)) : undefined);
    if (target) targets.set(target.id, target);
    else notFound.push(id);
  }
  return { targets: [...targets.values()], notFound };
}

function mutationGuard(request: Request, action: string, requestId: string) {
  if (!isSameOrigin(request)) {
    return publicError("Updates must come from this website.", 403, requestId);
  }
  if (isRateLimited(`${action}:${getClientKey(request)}`)) {
    return publicError("Too many updates. Please try again later.", 429, requestId);
  }
  return null;
}

function requireConfig(requestId: string) {
  const config = getSupabaseConfig();
  if (!config) {
    return {
      config: null,
      response: publicError(
        "Changes are not connected yet. Add the Supabase server variables in Vercel.",
        503,
        requestId,
      ),
    };
  }
  return { config, response: null };
}

function auditWarning(recorded: boolean) {
  return recorded ? undefined : "The change was saved, but its audit event could not be recorded.";
}

export async function GET() {
  const requestId = crypto.randomUUID();
  const config = getSupabaseConfig();
  if (!config) {
    return NextResponse.json(
      { apis: fallbackRecords, mode: "dataset" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const [apiRows, auditRows] = await Promise.all([
      fetchAllRows<DatabaseApiRow>(config, "apis", SELECT_FIELDS, "id.asc", requestId),
      fetchAllRows<Partial<AuditEvent>>(
        config, "api_audit_events", AUDIT_FIELDS, "action_at.desc", requestId,
      ),
    ]);
    const auditByApi = new Map<string, AuditEvent[]>();
    for (const event of normalizeAuditEvents(auditRows)) {
      const existing = auditByApi.get(event.api_id) ?? [];
      existing.push(event);
      auditByApi.set(event.api_id, existing);
    }
    const databaseRecords = apiRows.map((row) => {
      const normalized = normalizeApiRecord(row);
      normalized.audit_trail = auditByApi.get(normalized.id) ?? [];
      return normalized;
    });
    const merged = mergeWithFallback(databaseRecords).map((record) => ({
      ...record,
      audit_trail: auditByApi.get(record.id) ?? record.audit_trail,
    }));
    const activeIds = new Set(merged.map((record) => record.id));
    const deletedById = new Map<string, DeletedApiSummary>();
    for (const record of databaseRecords) {
      if (record.is_active) continue;
      deletedById.set(record.id, {
        id: record.id,
        api_name: record.api_name,
        company_name: record.company_name,
        audit_trail: auditByApi.get(record.id) ?? [],
      });
    }
    // Audit snapshots are enough to retain a tombstone even if an inactive row
    // is later removed outside this application.
    for (const [apiId, events] of auditByApi) {
      if (activeIds.has(apiId) || deletedById.has(apiId) || !events.some((event) => event.action === "delete")) continue;
      const newest = [...events].sort((a, b) => Date.parse(b.action_at) - Date.parse(a.action_at))[0];
      deletedById.set(apiId, {
        id: apiId,
        api_name: newest.api_name,
        company_name: newest.company_name,
        audit_trail: events,
      });
    }
    const deletedApis = [...deletedById.values()].sort((a, b) => {
      const latestA = Math.max(0, ...a.audit_trail.map((event) => Date.parse(event.action_at) || 0));
      const latestB = Math.max(0, ...b.audit_trail.map((event) => Date.parse(event.action_at) || 0));
      return latestB - latestA;
    });
    return NextResponse.json(
      { apis: merged, deleted_apis: deletedApis, mode: "supabase" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Supabase catalog request failed", {
      message: error instanceof Error ? error.message : "Unknown fetch error",
      requestId,
    });
    // Falling back here would resurrect soft-deleted bundled records.
    return publicError("The database is temporarily unavailable. Please try again.", 502, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const guard = mutationGuard(request, "upload", requestId);
  if (guard) return guard;
  try {
    const input = await readJsonObject(request, MAX_BULK_BODY_BYTES);
    const honeypot = sanitizeString(input, "website_confirm", 200);
    if (honeypot) return publicError("Submission could not be accepted.", 400, requestId);
    const actorName = sanitizeString(input, "actor_name", 120, true);
    if (!Array.isArray(input.apis)) throw new ValidationError("apis must be an array.");
    if (input.apis.length === 0) throw new ValidationError("At least one API is required.");
    if (input.apis.length > MAX_BATCH_SIZE) {
      throw new ValidationError(`A maximum of ${MAX_BATCH_SIZE} APIs can be uploaded at once.`);
    }

    const invalid: InvalidReport[] = [];
    const valid: ValidatedSubmission[] = [];
    input.apis.forEach((item, index) => {
      const object = item && !Array.isArray(item) && typeof item === "object"
        ? (item as Record<string, unknown>) : null;
      const rowNumber = object ? sourceRow(object, index) : index + 2;
      const apiName = object && typeof object.api_name === "string" ? object.api_name.trim() : "";
      const companyName = object && typeof object.company_name === "string"
        ? object.company_name.trim() : "";
      if (!object) {
        invalid.push({ source_row: rowNumber, api_name: apiName, company_name: companyName, error: "Row must be an object." });
        return;
      }
      try {
        valid.push({ sourceRow: rowNumber, record: submissionDatabaseRecord(object) });
      } catch (error) {
        invalid.push({
          source_row: rowNumber,
          api_name: apiName,
          company_name: companyName,
          error: error instanceof ValidationError ? error.message : "Row is invalid.",
        });
      }
    });

    const { config, response } = requireConfig(requestId);
    if (!config) return response;
    const databaseRows = await fetchAllRows<DatabaseApiRow>(
      config, "apis", "id,api_name,company_name,is_active", "id.asc", requestId,
    );
    const databaseIds = new Set(
      databaseRows.flatMap((row) => (typeof row.id === "string" ? [row.id] : [])),
    );
    const databaseKeys = new Set<string>();
    for (const row of databaseRows) {
      if (typeof row.api_name === "string" && typeof row.company_name === "string") {
        databaseKeys.add(recordKey({ api_name: row.api_name, company_name: row.company_name }));
      }
    }
    const existingKeys = new Set(databaseKeys);
    for (const fallback of fallbackRecords) {
      const key = recordKey(fallback);
      if (!databaseIds.has(fallback.id) && !databaseKeys.has(key)) existingKeys.add(key);
    }

    const seenInUpload = new Set<string>();
    const duplicates: DuplicateReport[] = [];
    let uploadable = valid.filter(({ sourceRow: rowNumber, record }) => {
      const key = recordKey(record);
      if (seenInUpload.has(key)) {
        duplicates.push({
          source_row: rowNumber, api_name: record.api_name, company_name: record.company_name,
          reason: "Duplicate within this Excel upload.",
        });
        return false;
      }
      seenInUpload.add(key);
      if (existingKeys.has(key)) {
        duplicates.push({
          source_row: rowNumber, api_name: record.api_name, company_name: record.company_name,
          reason: "Already exists in the repository.",
        });
        return false;
      }
      return true;
    });

    let savedRows: DatabaseApiRow[] = [];
    if (uploadable.length > 0) {
      try {
        savedRows = await insertApiRows(config, uploadable.map(({ record }) => record), requestId);
      } catch (error) {
        if (!(error instanceof DatabaseError) || error.status !== 409) throw error;
        // Resolve an insert race by filtering only the rows that now exist.
        const latestRows = await fetchAllRows<DatabaseApiRow>(
          config, "apis", "id,api_name,company_name,is_active", "id.asc", requestId,
        );
        const latestKeys = new Set(latestRows.flatMap((row) =>
          typeof row.api_name === "string" && typeof row.company_name === "string"
            ? [recordKey({ api_name: row.api_name, company_name: row.company_name })] : [],
        ));
        uploadable = uploadable.filter(({ sourceRow: rowNumber, record }) => {
          if (!latestKeys.has(recordKey(record))) return true;
          duplicates.push({
            source_row: rowNumber, api_name: record.api_name, company_name: record.company_name,
            reason: "Already exists in the repository.",
          });
          return false;
        });
        if (uploadable.length > 0) {
          // A second race should still filter only the conflicting row, not
          // reject the rest of the batch. This slower path is used only after
          // the normal bulk insert has encountered a unique-key conflict.
          const successfullyInserted: DatabaseApiRow[] = [];
          const stillUploadable: ValidatedSubmission[] = [];
          for (const candidate of uploadable) {
            try {
              successfullyInserted.push(...(await insertApiRows(config, [candidate.record], requestId)));
              stillUploadable.push(candidate);
            } catch (individualError) {
              if (!(individualError instanceof DatabaseError) || individualError.status !== 409) {
                throw individualError;
              }
              duplicates.push({
                source_row: candidate.sourceRow,
                api_name: candidate.record.api_name,
                company_name: candidate.record.company_name,
                reason: "Already exists in the repository.",
              });
            }
          }
          uploadable = stillUploadable;
          savedRows = successfullyInserted;
        }
      }
    }

    const saved = savedRows.map(normalizeApiRecord);
    const sourceRowByKey = new Map(
      uploadable.map(({ sourceRow: rowNumber, record }) => [recordKey(record), rowNumber]),
    );
    const auditRecorded = await appendAuditEvents(
      config,
      saved.map((record) => ({
        api_id: record.id,
        api_name: record.api_name,
        company_name: record.company_name,
        action: "upload" as AuditAction,
        actor_name: actorName,
        details: `Uploaded through Excel bulk import (source row ${sourceRowByKey.get(recordKey(record)) ?? "unknown"}).`,
      })),
      requestId,
    );
    return NextResponse.json(
      {
        apis: saved,
        uploaded_count: saved.length,
        duplicate_count: duplicates.length,
        invalid_count: invalid.length,
        duplicates,
        invalid,
        warning: auditWarning(auditRecorded),
      },
      { status: saved.length > 0 ? 201 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return publicError(error.message, 413, requestId);
    if (error instanceof ValidationError) return publicError(error.message, 400, requestId);
    console.error("Unexpected API bulk upload error", {
      message: error instanceof Error ? error.message : "Unknown error", requestId,
    });
    return publicError("The APIs could not be saved. Please try again.", 502, requestId);
  }
}

export async function PUT(request: Request) {
  const requestId = crypto.randomUUID();
  const guard = mutationGuard(request, "edit", requestId);
  if (guard) return guard;
  try {
    const input = await readJsonObject(request, MAX_MUTATION_BODY_BYTES);
    const id = sanitizeString(input, "id", 36, true);
    requireUuid(id);
    const actorName = sanitizeString(input, "actor_name", 120, true);
    const submissionInput = input.api && !Array.isArray(input.api) && typeof input.api === "object"
      ? (input.api as Record<string, unknown>) : input;
    const edited = submissionDatabaseRecord(submissionInput);
    const { config, response } = requireConfig(requestId);
    if (!config) return response;
    const { targets } = await resolveMutationTargets(config, [id], requestId);
    const target = targets[0];
    if (!target || !target.is_active) return publicError("API record was not found.", 404, requestId);

    const newKey = recordKey(edited);
    const oldKey = recordKey(target);
    if (newKey !== oldKey) {
      const allRows = await fetchAllRows<DatabaseApiRow>(
        config, "apis", "id,api_name,company_name,is_active", "id.asc", requestId,
      );
      const allDatabaseIds = new Set(
        allRows.flatMap((row) => (typeof row.id === "string" ? [row.id] : [])),
      );
      const allDatabaseKeys = new Set(
        allRows.flatMap((row) =>
          typeof row.api_name === "string" && typeof row.company_name === "string"
            ? [recordKey({ api_name: row.api_name, company_name: row.company_name })]
            : [],
        ),
      );
      const duplicateInDatabase = allRows.some((row) =>
        row.id !== target.id && typeof row.api_name === "string" &&
        typeof row.company_name === "string" &&
        recordKey({ api_name: row.api_name, company_name: row.company_name }) === newKey,
      );
      const duplicateSeed = fallbackRecords.some((record) => {
        const key = recordKey(record);
        const shadowed = allDatabaseIds.has(record.id) || allDatabaseKeys.has(key);
        return !shadowed && record.id !== id && record.id !== target.id && key === newKey;
      });
      if (duplicateInDatabase || duplicateSeed) {
        return publicError("This company and API name are already in the repository.", 409, requestId);
      }
    }

    const editableUpdate = {
      api_name: edited.api_name,
      official_api_name: edited.official_api_name,
      company_name: edited.company_name,
      official_company_name: edited.official_company_name,
      description: edited.description,
      api_endpoint: edited.api_endpoint,
      documentation_url: edited.documentation_url,
      category: edited.category,
      category_other: edited.category_other,
      authentication_method: edited.authentication_method,
      authentication_other: edited.authentication_other,
      authentication_details: edited.authentication_details,
      source_url: edited.documentation_url,
    };
    const updatedRows = await updateApiRows(
      config,
      [target.id],
      {
        ...editableUpdate,
        review_status: "Published",
        verified_at: null,
        verified_by: "",
        verification_notes: "",
      },
      requestId,
    );
    const saved = updatedRows[0] ? normalizeApiRecord(updatedRows[0]) : null;
    if (!saved) return publicError("The API was updated but could not be returned.", 502, requestId);
    const auditRecorded = await appendAuditEvents(
      config,
      [{
        api_id: saved.id,
        api_name: saved.api_name,
        company_name: saved.company_name,
        action: "edit",
        actor_name: actorName,
        details: target.review_status === "Verified"
          ? "Edited API details; manual verification was reset to Published."
          : "Edited API details.",
      }],
      requestId,
    );
    return NextResponse.json(
      { api: saved, warning: auditWarning(auditRecorded) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return publicError(error.message, 413, requestId);
    if (error instanceof ValidationError) return publicError(error.message, 400, requestId);
    if (error instanceof DatabaseError && error.status === 409) {
      return publicError("This company and API name are already in the repository.", 409, requestId);
    }
    console.error("Unexpected API edit error", {
      message: error instanceof Error ? error.message : "Unknown error", requestId,
    });
    return publicError("The API could not be updated. Please try again.", 502, requestId);
  }
}

export async function PATCH(request: Request) {
  const requestId = crypto.randomUUID();
  const guard = mutationGuard(request, "verification", requestId);
  if (guard) return guard;
  try {
    const input = await readJsonObject(request, MAX_MUTATION_BODY_BYTES);
    const id = sanitizeString(input, "id", 36, true);
    requireUuid(id);
    const actorName = sanitizeString(input, "actor_name", 120, true);
    const reviewStatus = sanitizeString(input, "review_status", 20, true);
    if (reviewStatus !== "Published" && reviewStatus !== "Verified") {
      throw new ValidationError("Verification status is not supported.");
    }
    const verifiedByInput = sanitizeString(input, "verified_by", 120);
    const verificationNotesInput = sanitizeString(input, "verification_notes", 1_000);
    const verifiedBy = reviewStatus === "Verified" ? verifiedByInput || actorName : "";
    if (reviewStatus === "Verified" && !verificationNotesInput) {
      throw new ValidationError("A verification note is required for Verified status.");
    }

    const { config, response } = requireConfig(requestId);
    if (!config) return response;
    const { targets } = await resolveMutationTargets(config, [id], requestId);
    const target = targets[0];
    if (!target || !target.is_active) return publicError("API record was not found.", 404, requestId);
    const update = reviewStatus === "Verified"
      ? {
          review_status: "Verified" as ReviewStatus,
          verified_by: verifiedBy,
          verification_notes: verificationNotesInput,
          verified_at: new Date().toISOString(),
        }
      : {
          review_status: "Published" as ReviewStatus,
          verified_by: "",
          verification_notes: "",
          verified_at: null,
        };
    const updatedRows = await updateApiRows(config, [target.id], update, requestId);
    const saved = updatedRows[0] ? normalizeApiRecord(updatedRows[0]) : null;
    if (!saved) return publicError("Verification was saved but could not be returned.", 502, requestId);

    const auditAction: AuditAction = reviewStatus === "Verified" ? "verify" : "status_change";
    const details = reviewStatus === "Verified"
      ? `Marked as Verified by ${verifiedBy}. Note: ${verificationNotesInput}`
      : `Changed status from ${target.review_status} to Published.${
          verificationNotesInput ? ` Note: ${verificationNotesInput}` : ""
        }`;
    const auditRecorded = await appendAuditEvents(
      config,
      [{
        api_id: saved.id,
        api_name: saved.api_name,
        company_name: saved.company_name,
        action: auditAction,
        actor_name: actorName,
        details,
      }],
      requestId,
    );
    return NextResponse.json(
      { api: saved, warning: auditWarning(auditRecorded) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return publicError(error.message, 413, requestId);
    if (error instanceof ValidationError) return publicError(error.message, 400, requestId);
    console.error("Unexpected verification update error", {
      message: error instanceof Error ? error.message : "Unknown error", requestId,
    });
    return publicError("Verification could not be saved. Please try again.", 502, requestId);
  }
}

export async function DELETE(request: Request) {
  const requestId = crypto.randomUUID();
  const guard = mutationGuard(request, "delete", requestId);
  if (guard) return guard;
  try {
    const input = await readJsonObject(request, MAX_MUTATION_BODY_BYTES);
    const actorName = sanitizeString(input, "actor_name", 120, true);
    const reason = sanitizeString(input, "reason", 1_000);
    if (!Array.isArray(input.ids)) throw new ValidationError("ids must be an array.");
    if (input.ids.length === 0) throw new ValidationError("At least one API id is required.");
    if (input.ids.length > MAX_BATCH_SIZE) {
      throw new ValidationError(`A maximum of ${MAX_BATCH_SIZE} APIs can be deleted at once.`);
    }
    const ids = [...new Set(input.ids.map((value) => {
      if (typeof value !== "string") throw new ValidationError("Every API id must be text.");
      const id = value.trim();
      requireUuid(id);
      return id;
    }))];

    const { config, response } = requireConfig(requestId);
    if (!config) return response;
    const { targets, notFound } = await resolveMutationTargets(config, ids, requestId);
    const activeTargets = targets.filter((record) => record.is_active);
    const inactiveIds = targets.filter((record) => !record.is_active).map((record) => record.id);
    const deletedRows: DatabaseApiRow[] = [];
    for (let index = 0; index < activeTargets.length; index += 100) {
      const chunk = activeTargets.slice(index, index + 100);
      deletedRows.push(...(await updateApiRows(
        config, chunk.map((record) => record.id), { is_active: false }, requestId,
      )));
    }
    const deleted = deletedRows.map(normalizeApiRecord);
    const auditRecorded = await appendAuditEvents(
      config,
      deleted.map((record) => ({
        api_id: record.id,
        api_name: record.api_name,
        company_name: record.company_name,
        action: "delete" as AuditAction,
        actor_name: actorName,
        details: reason ? `Soft-deleted API. Reason: ${reason}` : "Soft-deleted API.",
      })),
      requestId,
    );
    return NextResponse.json(
      {
        deleted_ids: deleted.map((record) => record.id),
        deleted_count: deleted.length,
        not_found_ids: notFound,
        already_deleted_ids: inactiveIds,
        warning: auditWarning(auditRecorded),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return publicError(error.message, 413, requestId);
    if (error instanceof ValidationError) return publicError(error.message, 400, requestId);
    console.error("Unexpected API delete error", {
      message: error instanceof Error ? error.message : "Unknown error", requestId,
    });
    return publicError("The APIs could not be deleted. Please try again.", 502, requestId);
  }
}
