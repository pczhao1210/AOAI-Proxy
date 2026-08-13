# AOAI Minimum Documentation Index

This directory contains the documentation for the `aoai-minimum` branch: the lightweight, core-function deployment branch for AOAI Foundry Proxy.

Use this branch when you need the basic proxy, Azure deployment templates, Caddy TLS, and persistence options without the heavier nextgen admin/runtime features.

## Language Entry Points

- English overview: [../README.md](../README.md)
- 中文概览: [README.zh-CN.md](README.zh-CN.md)

## Deployment Guides

- Azure deployment overview: [../README.md#azure-deployment](../README.md#azure-deployment)
- Azure Managed Application package: [../infra/azure_deployment_with_UI/README.md](../infra/azure_deployment_with_UI/README.md)
- ACI persistence guide (English): [aci_persist_vol.en.md](aci_persist_vol.en.md)
- ACI 持久化指南（中文）: [aci_persist_vol.md](aci_persist_vol.md)

## Update Notes

- 2026-08-13 core routing and bug-fix audit (中文): [minimum-update-2026-08-13.md](minimum-update-2026-08-13.md)

## Infrastructure Templates

- Bicep template: [../infra/main.bicep](../infra/main.bicep)
- ARM template: [../infra/azuredeploy.json](../infra/azuredeploy.json)
- Managed Application main template: [../infra/azure_deployment_with_UI/mainTemplate.json](../infra/azure_deployment_with_UI/mainTemplate.json)
- Managed Application UI definition: [../infra/azure_deployment_with_UI/createUiDefinition.json](../infra/azure_deployment_with_UI/createUiDefinition.json)
- Dev parameters: [../infra/parameters/dev.json](../infra/parameters/dev.json)
- Prod parameters: [../infra/parameters/prod.json](../infra/parameters/prod.json)

## Notes

- The root [../README.md](../README.md) is the primary English entry point for `aoai-minimum`.
- The default branch contains the current nextgen experience; this branch is intentionally smaller and focused on stable core functionality.
- Process and scratch documents are intentionally excluded from version control and are not part of the public docs set.