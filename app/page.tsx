import ApiRepository from "@/components/api-repository";
import seedData from "@/app/data/apis.json";
import { normalizeApiRecord, type ApiRecord } from "@/lib/types";

export default function HomePage() {
  // Once persistence is configured, the database must decide which seed rows are
  // active. Rendering the entire seed catalogue first would briefly resurrect a
  // seed row that an operator has soft-deleted.
  const hasPersistentStore = Boolean(
    process.env.SUPABASE_URL
      && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY),
  );
  const initialRecords = hasPersistentStore
    ? []
    : (seedData as Array<Partial<ApiRecord>>).map(normalizeApiRecord);
  return <ApiRepository initialRecords={initialRecords} />;
}
