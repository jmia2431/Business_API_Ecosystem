export const API_CATEGORIES = [
  "Communication",
  "Transformation",
  "Validation",
] as const;

export const AUTHENTICATION_TYPES = [
  "OAuth2",
  "Token",
  "API Key",
  "Basic",
  "Certificate/mTLS",
  "WS-Security",
  "HMAC/Signature",
  "None",
  "Composite",
] as const;

export const REVIEW_STATUSES = [
  "Published",
  "Verified candidate",
  "Draft",
] as const;

export type ApiCategory = (typeof API_CATEGORIES)[number];
export type AuthenticationType = (typeof AUTHENTICATION_TYPES)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface ApiRecord {
  id: string;
  api_name: string;
  official_api_name: string;
  description: string;
  api_endpoint: string;
  instructions: string;
  company_name: string;
  official_company_name: string;
  website_url: string;
  documentation_url: string;
  category: ApiCategory;
  authentication_method: AuthenticationType;
  authentication_details: string;
  network: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  input_formats: string[];
  output_formats: string[];
  business_rules: string[];
  client_types: string[];
  review_status: ReviewStatus;
  source_url: string;
  verified_at: string | null;
}

export interface ApiSubmission {
  api_name: string;
  official_api_name: string;
  company_name: string;
  official_company_name: string;
  description: string;
  api_endpoint: string;
  documentation_url: string;
  category: ApiCategory;
  authentication_method: AuthenticationType;
  authentication_details: string;
  website_confirm?: string;
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function normalizeAuthentication(value: unknown): AuthenticationType {
  const original = asString(value).trim();
  const normalized = original.toLowerCase();

  if (!original || normalized === "not required" || normalized === "none") return "None";
  if (normalized === "oauth2") return "OAuth2";
  if (normalized.includes("oauth") && normalized.includes("basic")) return "Composite";
  if (normalized.includes("oauth")) return "OAuth2";
  if (normalized.includes("certificate") || normalized.includes("mtls")) return "Certificate/mTLS";
  if (normalized.includes("ws-security") || normalized.includes("ws security")) return "WS-Security";
  if (normalized.includes("hmac") || normalized.includes("signature")) return "HMAC/Signature";
  if (normalized.includes("session") && normalized.includes("key")) return "Composite";
  if (normalized.includes("saml") || normalized.includes("jwt") && normalized.includes("basic")) return "Composite";
  if (normalized === "basic" || normalized.includes("basic authentication")) return "Basic";
  if (normalized.includes("api key") || normalized.includes("secret key")) return "API Key";
  if (normalized.includes("token")) return "Token";

  return AUTHENTICATION_TYPES.includes(original as AuthenticationType)
    ? (original as AuthenticationType)
    : "Composite";
}

export function normalizeApiRecord(input: Partial<ApiRecord>): ApiRecord {
  const rawAuthentication = asString(input.authentication_method);
  const authentication = normalizeAuthentication(rawAuthentication);
  const suppliedDetails = asString(input.authentication_details).trim();

  const category = API_CATEGORIES.includes(input.category as ApiCategory)
    ? (input.category as ApiCategory)
    : "Communication";
  const reviewStatus = REVIEW_STATUSES.includes(input.review_status as ReviewStatus)
    ? (input.review_status as ReviewStatus)
    : "Draft";

  return {
    id: asString(input.id) || crypto.randomUUID(),
    api_name: asString(input.api_name, "Unnamed API"),
    official_api_name: asString(input.official_api_name),
    description: asString(input.description),
    api_endpoint: asString(input.api_endpoint),
    instructions: asString(input.instructions),
    company_name: asString(input.company_name, "Unknown company"),
    official_company_name: asString(input.official_company_name),
    website_url: asString(input.website_url),
    documentation_url: asString(input.documentation_url),
    category,
    authentication_method: authentication,
    authentication_details:
      suppliedDetails || (rawAuthentication && rawAuthentication !== authentication ? rawAuthentication : ""),
    network: asString(input.network),
    is_active: typeof input.is_active === "boolean" ? input.is_active : true,
    created_at: asString(input.created_at),
    updated_at: asString(input.updated_at),
    input_formats: asStringArray(input.input_formats),
    output_formats: asStringArray(input.output_formats),
    business_rules: asStringArray(input.business_rules),
    client_types: asStringArray(input.client_types),
    review_status: reviewStatus,
    source_url: asString(input.source_url),
    verified_at: asString(input.verified_at) || null,
  };
}
