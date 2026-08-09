import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const roots = ["src", "test", "scripts", "packaging", ".github"];
const extensions = new Set([".ts", ".mts", ".mjs", ".json", ".md", ".yml", ".yaml"]);
const findings = [];

async function walk(relative) {
  const absolute = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!new Set(["node_modules", "dist", "release-artifacts", "evidence"]).has(entry.name)) await walk(child);
      continue;
    }
    if (!extensions.has(path.extname(entry.name))) continue;
    const content = await readFile(path.join(root, child), "utf8");
    if (content.includes("\r")) findings.push(`${child}: CRLF is not canonical source format`);
    if (!content.endsWith("\n")) findings.push(`${child}: missing final newline`);
    if (/^(<<<<<<<|=======|>>>>>>>)/m.test(content)) findings.push(`${child}: merge-conflict marker`);
    content.split("\n").forEach((line, index) => {
      if (/[ \t]+$/.test(line)) findings.push(`${child}:${index + 1}: trailing whitespace`);
    });
    if (path.extname(entry.name) === ".json") {
      try {
        JSON.parse(content);
      } catch (error) {
        findings.push(`${child}: invalid JSON (${error.message})`);
      }
    }
  }
}

for (const relative of roots) await walk(relative);
if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write('{"status":"lint-pass"}\n');
