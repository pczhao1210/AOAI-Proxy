import fs from "node:fs";

const existsSync = fs.existsSync;
fs.existsSync = (filePath) => filePath === "/.dockerenv"
  ? process.env.TEST_RESTART_CONTAINER === "1"
  : existsSync(filePath);
Object.defineProperty(process, "pid", { value: Number(process.env.TEST_RESTART_PID), configurable: true });
if (process.env.TEST_RESTART_PPID) Object.defineProperty(process, "ppid", { value: Number(process.env.TEST_RESTART_PPID), configurable: true });
process.kill = (pid, signal) => {
  process.stdout.write(`TEST_RESTART_SIGNAL ${pid} ${signal}\n`);
  return true;
};
