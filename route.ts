import fallbackApis from "@/app/data/apis.json";
import type { ApiRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

function config() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

function supabaseHeaders(key: string, includeJson = false) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...(includeJson ? { "Content-Type": "application/json", Prefer: "return=representation" } : {}),
  };
}

export async function GET() {
  const connection = config();
  if (!connection) {
    return Response.json({ apis: fallbackApis, mode: "dataset" });
  }

  const response = await fetch(
    `${connection.url}/rest/v1/apis?select=*&order=updated_at.desc`,
    { headers: supabaseHeaders(connection.key), cache: "no-store" },
  );
  if (!response.ok) {
    return Response.json(
      { error: "Supabase returned an error while loading APIs." },
      { status: 502 },
    );
  }
  const apis = (await response.json()) as ApiRecord[];
  return Response.json({ apis, mode: "supabase" });
}

export async function POST(request: Request) {
  const connection = config();
  if (!connection) {
    return Response.json(
      { error: "Supabase is not connected yet." },
      { status: 503 },
    );
  }

  const payload = (await request.json()) as Partial<ApiRecord>;
  if (!payload.api_name?.trim() || !payload.company_name?.trim() || !payload.api_endpoint?.trim()) {
    return Response.json(
      { error: "API name, company, and endpoint are required." },
      { status: 400 },
    );
  }

  const record = {
    ...payload,
    api_name: payload.api_name.trim(),
    company_name: payload.company_name.trim(),
    api_endpoint: payload.api_endpoint.trim(),
    review_status: "Draft",
    is_active: true,
  };
  const response = await fetch(`${connection.url}/rest/v1/apis`, {
    method: "POST",
    headers: supabaseHeaders(connection.key, true),
    body: JSON.stringify(record),
  });
  if (!response.ok) {
    const detail = await response.text();
    return Response.json(
      { error: "Supabase could not save the API.", detail },
      { status: 502 },
    );
  }
  const [api] = (await response.json()) as ApiRecord[];
  return Response.json({ api }, { status: 201 });
}

