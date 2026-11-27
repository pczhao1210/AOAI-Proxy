import { cloneJson, DEFAULT_UPSTREAM_TEMPLATE } from "../../utils.js";
import { newCopilotChannel } from "../../copilot.js";

export const channelProviders = [
  { value: "azure-openai", label: "Azure" },
  { value: "github-copilot", label: "GitHub Copilot" },
  { value: "openai", label: "OpenAI Compatible" },
  { value: "anthropic", label: "Anthropic" }
];

export function channelProviderLabel(value) {
  return channelProviders.find(provider => provider.value === value)?.label || value;
}

export function createChannel(provider, channelId, name) {
  if (provider === "github-copilot") return newCopilotChannel(channelId, name);
  if (!channelProviders.some(item => item.value === provider)) throw new Error(`Unknown channel provider: ${provider}`);
  const channel = { ...cloneJson(DEFAULT_UPSTREAM_TEMPLATE), provider, channelId, name, modelMappings: [] };
  if (provider !== "azure-openai") {
    channel.auth = { mode: "apiKey", apiKey: "" };
    channel.routes = provider === "anthropic"
      ? { messages: "/v1/messages", "messages/count_tokens": "/v1/messages/count_tokens" }
      : { "chat/completions": "/v1/chat/completions", responses: "/v1/responses", "responses/compact": "/v1/responses/compact" };
  }
  return channel;
}
