import "server-only";
import { Client, Connection } from "@temporalio/client";

export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
export const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
export const TEMPORAL_UI = process.env.TEMPORAL_UI_URL ?? "http://localhost:8080";
export const INTERPRETER_QUEUE = "wf-interpreter";

const g = globalThis as unknown as { __temporal?: Promise<Client> };

export function temporal(): Promise<Client> {
  g.__temporal ??= Connection.connect({ address: TEMPORAL_ADDRESS })
    .then((connection) => new Client({ connection, namespace: TEMPORAL_NAMESPACE }))
    .catch((e) => {
      g.__temporal = undefined; // allow a retry on the next request
      throw e;
    });
  return g.__temporal;
}

export function temporalRunUrl(workflowId: string): string {
  return `${TEMPORAL_UI}/namespaces/${TEMPORAL_NAMESPACE}/workflows/${encodeURIComponent(workflowId)}`;
}
