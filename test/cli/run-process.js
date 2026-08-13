import { spawn } from "node:child_process";

export function runProcess(command, args, options = {}) {
  const {
    timeoutMs = 30000,
    killGraceMs = 2000,
    ...spawnOptions
  } = options;

  return new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer;
    let killTimer;
    const clearTimers = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      callback(value);
    };
    const terminate = (signal) => {
      try {
        if (useProcessGroup && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return true;
        finish(reject, error);
        return false;
      }
    };
    timer = setTimeout(() => {
      timedOut = true;
      if (!terminate("SIGTERM")) return;
      killTimer = setTimeout(() => {
        if (!terminate("SIGKILL")) return;
        const error = new Error(`${command} timed out after ${timeoutMs}ms`);
        error.processGroupId = useProcessGroup ? child.pid : undefined;
        error.stdout = stdout;
        error.stderr = stderr;
        finish(reject, error);
      }, killGraceMs);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      finish(reject, error);
    });
    child.once("close", (code, signal) => {
      if (timedOut) return;
      finish(resolve, { code, signal, stdout, stderr });
    });
  });
}