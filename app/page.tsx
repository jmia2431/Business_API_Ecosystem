import ApiRepository from "@/components/api-repository";
import seedData from "@/app/data/apis.json";
import { normalizeApiRecord, type ApiRecord } from "@/lib/types";

export default function HomePage() {
  const initialRecords = (seedData as Array<Partial<ApiRecord>>).map(normalizeApiRecord);
  return <ApiRepository initialRecords={initialRecords} />;
}
