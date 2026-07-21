const MAX_CORRELATION_ID_LENGTH = 256;

function normalizeHeaderValue(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate == null) return "";
  return String(candidate)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_CORRELATION_ID_LENGTH);
}

export function resolveRequestContext(req) {
  const headers = req?.headers || {};
  const generatedRequestId = normalizeHeaderValue(req?.id);
  const requestId = normalizeHeaderValue(headers["x-request-id"]) || generatedRequestId;
  const correlationId = normalizeHeaderValue(headers["x-correlation-id"]);
  const requestedConversationId = normalizeHeaderValue(headers["x-conversation-id"]);
  const requestedSessionId = normalizeHeaderValue(headers["x-session-id"]);

  return {
    requestId,
    conversationId: requestedConversationId || requestedSessionId || correlationId || requestId,
    sessionId: requestedSessionId || requestedConversationId || correlationId || requestId
  };
}

export function attachRequestContext(req) {
  const context = resolveRequestContext(req);
  req.requestContext = context;
  return context;
}

export function getRequestContext(req) {
  return req?.requestContext || resolveRequestContext(req);
}

export function buildCorrelationHeaders(context) {
  return {
    "x-request-id": context?.requestId || "",
    "x-conversation-id": context?.conversationId || context?.requestId || "",
    "x-session-id": context?.sessionId || context?.requestId || ""
  };
}