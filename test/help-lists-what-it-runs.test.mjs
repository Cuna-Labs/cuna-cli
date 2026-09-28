// D12: help lays its rows out in one column and lists every routed command.
//
// Measured on the installed 0.1.3 on 2026-09-28: the `cuna claude/codex/opencode
// [PATH]` rows of `cuna --help` started their description six columns right of
// the two rows above them, and `executions list|get|cancel` were `[routed]` in
// the complete reference but missing from "Available now".
import test from "node:test";
import assert from "node:assert/strict";

import { FULL_HELP, SHORT_HELP } from "../dist/cli/help.js";
import { CLI_ROUTE_REGISTRY } from "../dist/cli/parser.js";

test("every Start here row puts its description in one column", () => {
  const start = SHORT_HELP.slice(SHORT_HELP.indexOf("Start here:\n") + "Start here:\n".length).split("\n\n")[0].split("\n");
  assert.ok(start.length >= 5, start.join("\n"));
  const columns = new Set(start.map((line) => /^ {2}cuna(?:.*?\S)? {2,}(?=\S)/u.exec(line)?.[0].length));
  assert.deepEqual([...columns], [26], `description columns: ${start.map((line) => JSON.stringify(line)).join("\n")}`);
});

/** Leaf keys a help line names, expanding `a|b|c` alternatives. */
function helpLineKeys(line) {
  const words = [];
  for (const word of line.trim().split(/\s+/u)) {
    if (!/^[a-z][a-z|-]*$/u.test(word)) break;
    words.push(word);
  }
  const [command, action] = words;
  if (command === undefined) return [];
  return action === undefined
    ? command.split("|")
    : action.split("|").map((each) => `${command} ${each}`);
}

test("every routed command appears in the sections that list what this build runs", () => {
  const sections = [
    ["Available now:", "Foreground terminal attach"],
    ["Foreground terminal attach", "Automatic local-to-cloud journey:"],
    ["Automatic local-to-cloud journey:", "Reserved and fail-closed"],
  ];
  const listed = new Set();
  for (const [from, to] of sections) {
    const body = FULL_HELP.slice(FULL_HELP.indexOf(from), FULL_HELP.indexOf(to)).split("\n").slice(1);
    for (const line of body.filter((each) => /^ {2}[a-z]/u.test(each))) {
      for (const key of helpLineKeys(line)) listed.add(key);
    }
  }
  const missing = CLI_ROUTE_REGISTRY
    .filter((route) => route.dispatch === "routed" && !listed.has(route.key))
    .map((route) => route.key);
  assert.deepEqual(missing, [], `routed but never listed: ${missing.join(", ")}`);
});
