import fs from "node:fs";

const packageInfo = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

function readBuildValue(name) {
  const value = String(process.env[name] || "").trim();
  return value || null;
}

const buildInfo = Object.freeze({
  service: packageInfo.name || "aoai-proxy",
  version: readBuildValue("AOAI_PROXY_VERSION") || packageInfo.version || "unknown",
  buildTime: readBuildValue("AOAI_PROXY_BUILD_TIME")
});

export function getBuildInfo() {
  return buildInfo;
}