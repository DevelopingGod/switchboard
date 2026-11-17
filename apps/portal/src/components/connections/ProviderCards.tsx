import type { CatalogModel, ConnectionRow } from "@/lib/router-types";
import { ApiProviderCard } from "./ApiProviderCard";
import { CliProviderCard } from "./CliProviderCard";

/** One card for any provider row; shared by Connections and the wizard's Connect step. */
export function ProviderCardFor({ row, models }: { row: ConnectionRow; models: CatalogModel[] }) {
  return row.kind === "cli" ? <CliProviderCard row={row} /> : <ApiProviderCard row={row} models={models} />;
}
