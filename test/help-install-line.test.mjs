// D11: `cuna help --all` ended with `npm install --global
// ./cuna_labs-cli-0.1.0.tgz` in 0.1.3, a local tarball of a version three
// releases old. The README's quick start installs the published package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FULL_HELP } from "../dist/cli/help.js";

test("help --all ends with the install line of the published package, not a local tarball", () => {
  const { name } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const install = FULL_HELP.slice(FULL_HELP.indexOf("Canonical install:")).trim().split("\n");
  assert.deepEqual(install, ["Canonical install:", `  npm install --global ${name}`]);
  assert.doesNotMatch(FULL_HELP, /\.tgz/u);
});
