import process from "node:process";

import { runLocalRichForeground } from "./local-rich-foreground.mjs";

const options = new Set(process.argv.slice(2));
function formatFailure(error) {
  if (error instanceof AggregateError) {
    return [error.stack ?? error.message, ...error.errors.map(formatFailure)].join("\nCaused by: ");
  }
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
try {
  await runLocalRichForeground({
    color: !options.has("--no-color"),
    detachDelayMs: options.has("--slow-detach") ? 300 : 0,
    detachFailure: options.has("--detach-failure"),
  });
} catch (error) {
  console.error(formatFailure(error));
  process.exitCode = 1;
}
