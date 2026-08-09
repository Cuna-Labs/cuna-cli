#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prdDirectory = path.join(root, "prds");
const indexPath = path.join(prdDirectory, "PRD-000-index.md");
const json = process.argv.includes("--json");

const errors = [];
const warnings = [];

const index = await readFile(indexPath, "utf8");
if (!/^\|\s*Status\s*\|\s*Accepted baseline\b/m.test(index)) {
  errors.push("PRD-000 has not passed the Accepted baseline gate.");
}
const catalogRows = [...index.matchAll(
  /^\|\s*(\d{3})\s*\|\s*(?:\[[^\]]+\]\(([^)]+)\)|`([^`]+)`)\s*\|[^|]*\|\s*([^|]+?)\s*\|[^|]*\|$/gm,
)];

if (catalogRows.length === 0) {
  errors.push("PRD-000 contains no parseable catalog rows.");
}

const nodes = new Map();
for (const match of catalogRows) {
  const [, id, linkedFile, literalFile, dependencyCell] = match;
  const filename = linkedFile ?? literalFile;
  if (nodes.has(id)) {
    errors.push(`Duplicate catalog identity ${id}.`);
    continue;
  }

  const dependencies = dependencyCell
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^\d{3}$/.test(value));
  nodes.set(id, { filename, dependencies });
}

for (const [id, node] of nodes) {
  for (const dependency of node.dependencies) {
    if (!nodes.has(dependency)) {
      errors.push(`PRD-${id} depends on missing PRD-${dependency}.`);
    }
    if (dependency === id) {
      errors.push(`PRD-${id} depends on itself.`);
    }
  }
}

const indegree = new Map([...nodes.keys()].map((id) => [id, 0]));
const successors = new Map([...nodes.keys()].map((id) => [id, []]));
for (const [id, node] of nodes) {
  for (const dependency of node.dependencies) {
    if (!nodes.has(dependency)) continue;
    indegree.set(id, indegree.get(id) + 1);
    successors.get(dependency).push(id);
  }
}

const ready = [...indegree]
  .filter(([, degree]) => degree === 0)
  .map(([id]) => id)
  .sort();
const topologicalOrder = [];
while (ready.length > 0) {
  const current = ready.shift();
  topologicalOrder.push(current);
  for (const successor of successors.get(current)) {
    const next = indegree.get(successor) - 1;
    indegree.set(successor, next);
    if (next === 0) {
      ready.push(successor);
      ready.sort();
    }
  }
}

if (topologicalOrder.length !== nodes.size) {
  const cyclic = [...indegree]
    .filter(([, degree]) => degree > 0)
    .map(([id]) => id);
  errors.push(`The PRD dependency graph is cyclic: ${cyclic.join(", ")}.`);
}

const files = (await readdir(prdDirectory))
  .filter((filename) => /^PRD-(?!000)\d{3}-.+\.md$/.test(filename))
  .sort();
const catalogFiles = new Set([...nodes.values()].map(({ filename }) => filename));

for (const filename of files) {
  if (!catalogFiles.has(filename)) {
    errors.push(`${filename} is not registered in PRD-000.`);
  }
}

const requirementOwners = new Map();
let requirementCount = 0;
let testReferenceCount = 0;

for (const [id, node] of nodes) {
  let body;
  try {
    body = await readFile(path.join(prdDirectory, node.filename), "utf8");
  } catch {
    errors.push(`PRD-${id} catalog file does not exist: ${node.filename}.`);
    continue;
  }

  const headingIdentity = body.match(/^#\s+PRD-(\d{3})(?:\b|\s|:|\s+—)/m)?.[1];
  if (headingIdentity !== id) {
    errors.push(`${node.filename} declares PRD-${headingIdentity ?? "unknown"}, expected PRD-${id}.`);
  }

  const accepted =
    /^\|\s*Status\s*\|\s*Accepted(?:\s|\|)/m.test(body) ||
    /^\*\*Status:\*\*\s*Accepted(?:\s|·|\|)/m.test(body);
  if (!accepted) {
    errors.push(`${node.filename} has not passed the Accepted specification gate.`);
  }

  if (/\b(?:TBD|TODO)\b/i.test(body)) {
    errors.push(`${node.filename} contains an unresolved TBD/TODO marker.`);
  }

  const requirements = new Set(body.match(/\bR-\d{3}-\d{2}\b/g) ?? []);
  const tests = new Set(body.match(/\bTC-\d{3}-\d{2}\b/g) ?? []);
  requirementCount += requirements.size;
  testReferenceCount += tests.size;

  for (const requirement of requirements) {
    const previous = requirementOwners.get(requirement);
    if (previous && previous !== node.filename) {
      errors.push(`${requirement} is declared by both ${previous} and ${node.filename}.`);
    } else {
      requirementOwners.set(requirement, node.filename);
    }
  }

  if (requirements.size > 0 && tests.size === 0) {
    errors.push(`${node.filename} defines requirements but no stable test identities.`);
  }

  if (
    requirements.size > 0 &&
    !/^##\s+.*(?:Acceptance|Traceability|Verification|Tests|Gates|Assurance|Controls|Blockers)/mi.test(body)
  ) {
    warnings.push(`${node.filename} has requirement IDs but no canonical Acceptance/Traceability heading.`);
  }
}

const result = {
  status: errors.length === 0 ? "PASS" : "FAIL",
  catalog_nodes: nodes.size,
  catalog_edges: [...nodes.values()].reduce(
    (total, node) => total + node.dependencies.length,
    0,
  ),
  topological_order: topologicalOrder,
  requirements: requirementCount,
  test_references: testReferenceCount,
  errors,
  warnings,
};

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      `PRD gate: ${result.status}`,
      `Catalog: ${result.catalog_nodes} nodes / ${result.catalog_edges} edges`,
      `Trace identities: ${result.requirements} requirements / ${result.test_references} tests`,
      `Topological order: ${result.topological_order.join(" -> ")}`,
      ...errors.map((message) => `ERROR: ${message}`),
      ...warnings.map((message) => `WARNING: ${message}`),
    ].join("\n") + "\n",
  );
}

process.exitCode = errors.length === 0 ? 0 : 1;
