import type { CunaApiClient } from "../api/client.js";
import type { Machine } from "../api/contracts.js";

export async function listAllMachines(
  client: CunaApiClient,
  signal?: AbortSignal,
): Promise<readonly Machine[]> {
  // The public Machine contract is one unpaginated GET /v1/sessions. Do not
  // invent AgentSession-style query parameters: app-website and the vendored
  // OpenAPI both use the naked route.
  return (await client.listMachines(signal)).items;
}
