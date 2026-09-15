import process from "node:process";

if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
  console.error("provider fixture requires a real PTY");
  process.exit(2);
}
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  process.stdout.write("\u001b[0m\u001b[?25h\u001b[?1049lPROVIDER_CTRL_C_OBSERVED\r\n");
  process.stdin.setRawMode(false);
  process.stdin.pause();
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\u001b[?1049h\u001b[2J\u001b[H\u001b[38;5;208mprovider mock ready 界 🦊\u001b[0m");
process.stdin.on("data", (chunk) => {
  if (chunk.includes(0x03)) { restore(); process.exitCode = 0; }
});
process.once("exit", restore);
