function readHeaderValue(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        return item.trim();
      }
    }
    return "";
  }
  return typeof value === "string" ? value.trim() : "";
}

function firstForwardedForIp(value) {
  if (!value) return "";
  const first = value
    .split(",")
    .map((item) => item.trim())
    .find(Boolean);
  return first || "";
}

function shouldTrustForwardedHeaders(config) {
  return config?.server?.trustProxy === true || config?.server?.caddy?.enabled === true;
}

export function getRequestNetworkContext(config, req) {
  const forwardedFor = readHeaderValue(req?.headers?.["x-forwarded-for"]);
  const realIp = readHeaderValue(req?.headers?.["x-real-ip"]);
  const userAgent = readHeaderValue(req?.headers?.["user-agent"]);
  const remoteAddress = typeof req?.ip === "string" && req.ip
    ? req.ip
    : (typeof req?.socket?.remoteAddress === "string" && req.socket.remoteAddress
      ? req.socket.remoteAddress
      : (typeof req?.raw?.socket?.remoteAddress === "string" ? req.raw.socket.remoteAddress : ""));

  const clientIp = shouldTrustForwardedHeaders(config)
    ? (firstForwardedForIp(forwardedFor) || realIp || remoteAddress)
    : remoteAddress;

  return {
    clientIp,
    userAgent,
    forwardedFor
  };
}