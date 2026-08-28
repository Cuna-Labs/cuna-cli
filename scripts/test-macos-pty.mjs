import process from "node:process";

console.log(JSON.stringify({ testId: "T14.2-MAC", result: "UNVERIFIED", host: { platform: process.platform, arch: process.arch, release: process.version }, reason: process.platform === "darwin" ? "The macOS native PTY interaction matrix is not implemented yet. Never upgrade this record to PASS without executing R14.3." : "Requires a real macOS host. Emulation or an unexecuted definition is not evidence." }));
