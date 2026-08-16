import path from "node:path";
import { fileURLToPath } from "node:url";

import { emitVendoredInfraContractWitness } from "./lib/infra-contract-witness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await emitVendoredInfraContractWitness(root);
