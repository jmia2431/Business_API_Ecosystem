import { NextResponse } from "next/server";
import seedData from "@/app/data/apis.json";
import {
  API_CATEGORIES,
  AUTHENTICATION_TYPES,
  normalizeApiRecord,
  type ApiCategory,
  type ApiRecord,
  type AuthenticationType,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const SELECT_FIELDS = [
  "id",
  "api_name",
  "official_api_name",
  "description",
  "api_endpoint",
  "instructions",
  "company_name",
  "official_company_name",
  "website_url",
  "documentation_url",
  "category",
  "authentication_method",
  "authentication_details",
  "network",
  "is_active",
  "created_at",
  "updated_at",
  "input_formats",
  "output_formats",
  "business_rules",
  "client_types",
  "review_status",
  "source_url",
  "verified_at",
].join(",");

const fallbackRecords = (seedData as Array<Partial<ApiRecord>>).map(normalizeApiRecord);
const fallbackRecordKeys = new Set(fallbackRecords.map(recordKey));
const rateLimitStore = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

type SupabaseConfig = {
  url: string;
  key: string;
  opaqueSecret: boolean;
};

class ValidationError extends Error {}

function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const newSecret = process.env.SUPABASE_SECRET_KEY?.trim();
  const legacyKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const key = newSecret || legacyKey;

  if (!url || !key) return null;
  return { url, key, opaqueSecret: key.startsWith("sb_secret_") };
}

function supabaseHeaders(config: SupabaseConfig, write = false): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: config.key,
    Accept: "application/json",
  };

  // Legacy service-role JWTs need Authorization. New sb_secret_* keys are opaque
  // and must only be sent as the apikey header.
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

function getClientKey(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
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

function recordKey(record: Pick<ApiRecord, "company_name" | "api_name">) {
  return `${record.company_name.trim().toLowerCase()}\u0000${record.api_name.trim().toLowerCase()}`;
}

function mergeWithFallback(databaseRecords: ApiRecord[]) {
  const merged = new Map<string, ApiRecord>();
  for (const record of databaseRecords) merged.set(recordKey(record), record);
  for (const record of fallbackRecords) {
    if (!merged.has(recordKey(record))) merged.set(recordKey(record), record);
  }
  return [...merged.values()];
}

export async function GET() {
  const config = getSupabaseConfig();
  if (!config) {
    return NextResponse.json(
      { apis: fallbackRecords, mode: "dataset" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const query = new URLSearchParams({
    select: SELECT_FIELDS,
    is_active: "eq.true",
    order: "created_at.desc",
    limit: "1000",
  });

  try {
    const response = await fetch(`${config.url}/rest/v1/apis?${query}`, {
      headers: supabaseHeaders(config),
      cache: "no-store",
    });
    if (!response.ok) {
      console.error("Supabase API list failed", { status: response.status });
      return NextResponse.json(
        { apis: fallbackRecords, mode: "dataset", warning: "Database is temporarily unavailable." },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const rows = (await response.json()) as Array<Partial<ApiRecord>>;
    const databaseRecords = rows.map(normalizeApiRecord);
    return NextResponse.json(
      { apis: mergeWithFallback(databaseRecords), mode: "supabase" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Supabase API list request failed", {
      message: error instanceof Error ? error.message : "Unknown fetch error",
    });
    return NextResponse.json(
      { apis: fallbackRecords, mode: "dataset", warning: "Database is temporarily unavailable." },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 20_000) return publicError("Request body is too large.", 413, requestId);

  const clientKey = getClientKey(request);
  if (isRateLimited(clientKey)) {
    return publicError("Too many submissions. Please try again later.", 429, requestId);
  }

  let input: Record<string, unknown>;
  try {
    const body = await request.text();
    if (body.length > 20_000) return publicError("Request body is too large.", 413, requestId);
    input = JSON.parse(body) as Record<string, unknown>;
    if (!input || Array.isArray(input) || typeof input !== "object") {
      throw new ValidationError("A JSON object is required.");
    }
  } catch (error) {
    const message = error instanceof ValidationError ? error.message : "Invalid JSON request body.";
    return publicError(message, 400, requestId);
  }

  try {
    const honeypot = sanitizeString(input, "website_confirm", 200);
    if (honeypot) return publicError("Submission could not be accepted.", 400, requestId);

    const apiName = sanitizeString(input, "api_name", 180, true);
    const officialApiName = sanitizeString(input, "official_api_name", 240);
    const companyName = sanitizeString(input, "company_name", 180, true);
    const officialCompanyName = sanitizeString(input, "official_company_name", 240);
    const description = sanitizeString(input, "description", 2_000, true);
    const apiEndpoint = sanitizeString(input, "api_endpoint", 2_000, true);
    const documentationUrl = sanitizeString(input, "documentation_url", 2_000, true);
    const category = sanitizeString(input, "category", 40, true);
    const authentication = sanitizeString(input, "authentication_method", 60, true);
    const authenticationDetails = sanitizeString(input, "authentication_details", 1_000);

    requireHttpUrl(apiEndpoint, "API endpoint");
    requireHttpUrl(documentationUrl, "Official documentation");
    if (!API_CATEGORIES.includes(category as ApiCategory)) {
      throw new ValidationError("Category is not supported.");
    }
    if (!AUTHENTICATION_TYPES.includes(authentication as AuthenticationType)) {
      throw new ValidationError("Authentication type is not supported.");
    }
    if (fallbackRecordKeys.has(recordKey({ company_name: companyName, api_name: apiName }))) {
      return publicError("This company and API name are already in the repository.", 409, requestId);
    }

    const config = getSupabaseConfig();
    if (!config) {
      return publicError(
        "Submissions are not connected yet. Add the Supabase server variables in Vercel.",
        503,
        requestId,
      );
    }

    const duplicateQuery = new URLSearchParams({
      select: "id",
      company_name: `eq.${companyName}`,
      api_name: `eq.${apiName}`,
      limit: "1",
    });
    const duplicateResponse = await fetch(`${config.url}/rest/v1/apis?${duplicateQuery}`, {
      headers: supabaseHeaders(config),
      cache: "no-store",
    });
    if (!duplicateResponse.ok) {
      console.error("Supabase duplicate check failed", {
        status: duplicateResponse.status,
        requestId,
      });
      return publicError("The database could not be checked. Please try again.", 502, requestId);
    }
    const duplicates = (await duplicateResponse.json()) as Array<{ id: string }>;
    if (duplicates.length > 0) {
      return publicError("This company and API name are already in the repository.", 409, requestId);
    }

    const record = {
      api_name: apiName,
      official_api_name: officialApiName,
      company_name: companyName,
      official_company_name: officialCompanyName,
      description,
      api_endpoint: apiEndpoint,
      documentation_url: documentationUrl,
      category,
      authentication_method: authentication,
      authentication_details: authenticationDetails,
      instructions: "",
      website_url: "",
      network: "",
      is_active: true,
      input_formats: ["JSON"],
      output_formats: ["JSON"],
      business_rules: [],
      client_types: ["REST"],
      review_status: "Published",
      source_url: documentationUrl,
      verified_at: null,
    };

    const insertResponse = await fetch(`${config.url}/rest/v1/apis?select=${SELECT_FIELDS}`, {
      method: "POST",
      headers: {
        ...supabaseHeaders(config, true),
        Prefer: "return=representation",
      },
      body: JSON.stringify(record),
      cache: "no-store",
    });

    if (!insertResponse.ok) {
      console.error("Supabase insert failed", { status: insertResponse.status, requestId });
      if (insertResponse.status === 409) {
        return publicError("This API is already in the repository.", 409, requestId);
      }
      return publicError("The API could not be saved. Please try again.", 502, requestId);
    }

    const rows = (await insertResponse.json()) as Array<Partial<ApiRecord>>;
    const saved = rows[0];
    if (!saved) return publicError("The API was saved but could not be returned.", 502, requestId);

    return NextResponse.json(
      { api: normalizeApiRecord(saved) },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ValidationError) return publicError(error.message, 400, requestId);
    console.error("Unexpected API submission error", {
      message: error instanceof Error ? error.message : "Unknown error",
      requestId,
    });
    return publicError("The API could not be saved. Please try again.", 500, requestId);
  }
}
