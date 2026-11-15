/**
 * SEA bootstrap for the portable Windows EXE.
 * It is bundled together with build/server.cjs by build-exe.ps1.
 */
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const sea = require("node:sea");

if (!sea.isSea()) {
  console.error("This entry point is only for the packaged DeepSeek Web executable.");
  process.exit(1);
}

let base;
if (process.platform === "win32") {
  base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
} else if (process.platform === "darwin") {
  base = path.join(os.homedir(), "Library", "Application Support");
} else {
  base = path.join(os.homedir(), ".local", "share");
}

const dataRoot = process.env.DEEPSEEK_WEB_DATA || path.join(base, "DeepSeek Web");
fs.mkdirSync(dataRoot, { recursive: true });

globalThis.__DEEPSEEK_SEA_DATA_ROOT__ = dataRoot;
globalThis.__DEEPSEEK_SEA_ASSETS__ = (name) => Buffer.from(sea.getAsset(name));
process.env.DEEPSEEK_WEB_OPEN_BROWSER = process.env.DEEPSEEK_WEB_OPEN_BROWSER || "1";

console.log("DeepSeek Web · EXE");
console.log("数据目录：", dataRoot);
console.log("停止服务：关闭这个窗口或按 Ctrl+C");
console.log("");

require("../build/server.cjs");
