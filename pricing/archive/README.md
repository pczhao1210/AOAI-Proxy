# Archived model cards

These definitions are retained for migration and historical pricing reference.
They are intentionally outside the active `pricing/*.json` surface and are not
loaded by the backend Model Catalog or the admin UI bundled template library.
The default GitHub sync path is also non-recursive and ignores this directory;
an administrator who explicitly configures a different sync path remains
responsible for that path's contents.

The Azure lifecycle schedule used for this archive is maintained at
<https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule>.
Fireworks Serverless lifecycle evidence is maintained in the
<https://docs.fireworks.ai/updates/changelog>.

| Card | Lifecycle evidence as of 2026-09-20 |
| --- | --- |
| `codex-mini.json` | Deprecated; retirement 2026-11-15 |
| `claude-opus-4-1.json` | Anthropic API and Microsoft Foundry retired 2026-08-05; replacement `claude-opus-4-8` |
| `claude-haiku-4-5.json` | Anthropic/Foundry retirement window begins 2026-10-15 |
| `claude-sonnet-4-5.json` | Anthropic/Foundry retirement window begins 2026-10-19 |
| `gpt-4o-mini.json` | Deprecated; retirement 2027-04-14 |
| `gpt-4o-transcribe.json` | Retirement 2026-10-15 |
| `gpt-5-chat.json` | Retired; the card version retired 2026-05-13 |
| `gpt-5.1-chat.json` | Retired; retirement 2026-06-29 |
| `gpt-5.2-chat.json` | Retired; the card version retired 2026-06-29 |
| `gpt-chat-latest.json` | Current card version retires 2026-12-02 |
| `gpt-image-1.5.json` | Retirement 2026-12-16 |
| `kimi-k2.7-code.json` | Retirement 2026-10-03 |
| `deepseek-v4-flash-0731.json` | Fireworks Serverless decommissioning 2026-09-25; dedicated deployments are unaffected |
| `deepseek-v4-pro-0813.json` | Fireworks Serverless decommissioning 2026-09-25; dedicated deployments are unaffected |
| `o1.json` | Deprecated; retirement 2026-11-19 |
| `o3.json` | Deprecated; retirement 2026-11-19 |
| `o3-mini.json` | Deprecated; retirement 2026-11-19 |
| `o3-pro.json` | Deprecated; retirement 2026-11-19 |
| `o4-mini.json` | Deprecated; retirement 2026-11-19 |

The archive is intentionally conservative for provider-specific cards. For
example, `gpt-realtime-2.json` remains active because its card is for the
OpenAI API, which still documents that model; an Azure retirement entry alone
does not retire the OpenAI card.

## 2026-10-27 additions

The administrator selected retirement plus official Deprecated/Legacy status
as the archival criterion, not model age or an assumed lack of usage.
The following cards were moved without changing their JSON, so existing
configured bindings retain their historical metadata and prices.

| Card | Exact offering and evidence |
| --- | --- |
| [gpt-4.1.json](gpt-4.1.json) | Azure version 2025-04-14: Deprecated; scheduled retirement 2027-04-14. |
| [gpt-4.1-mini.json](gpt-4.1-mini.json) | Azure version 2025-04-14: Deprecated; scheduled retirement 2027-04-14. |
| [gpt-4.1-nano.json](gpt-4.1-nano.json) | Azure version 2025-04-14: Deprecated; scheduled retirement 2027-04-14. |
| [gpt-4o.json](gpt-4o.json) | Azure version 2024-11-20: Legacy; scheduled retirement 2027-04-14. Other GPT-4o versions have different dates. |
| [o1-preview.json](o1-preview.json) | Azure version 2024-09-12: already recorded as retired on 2025-07-28, with imports and automatic pricing disabled. |
| [glm-5.2.json](glm-5.2.json) | Foundry `FW-GLM-5.2` pay-per-token retired 2026-10-08; replacement `FW-GLM-5.3`. PTU is a separate, still-listed offering. |

Azure evidence: [model retirement schedule](https://learn.microsoft.com/azure/foundry/openai/concepts/model-retirement-schedule).
Fireworks evidence: [Foundry Fireworks model catalog](https://learn.microsoft.com/azure/foundry/how-to/fireworks/fireworks-model-catalog).
These dates and statuses apply to the selected provider and offering, not all
endpoints using a similar model name.

`GLM-5` remains active because its card explicitly retains an
administrator-approved PTU template with automatic token pricing disabled;
its retired pay-per-token offering does not retire PTU. Anthropic still lists
Opus 4.6/4.7/4.8 and Sonnet 4.6 as active in its
[lifecycle table](https://platform.claude.com/docs/en/about-claude/model-deprecations).
Old GPT/Codex cards, Azure-direct DeepSeek cards and other provider-specific
audio/realtime cards were not removed merely because newer models exist.
No live usage statistics were used to classify a card as unused.
