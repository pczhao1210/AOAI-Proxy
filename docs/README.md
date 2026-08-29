# Documentation Index

This directory contains the project documentation and deployment guides.

## Language Entry Points

- English overview: [../README.md](../README.md)
- 中文概览: [README.zh-CN.md](README.zh-CN.md)

## Development

- Git 协作指南（中文）: [development/git-workflow.zh-CN.md](development/git-workflow.zh-CN.md)
- Claude Code / Codex 接入要求: [development/claude-code-codex-requirements.md](development/claude-code-codex-requirements.md)

## Protocols

- Chat / Responses / Messages 兼容性与 $3 \times 3$ 路由矩阵: [protocols/protocol-support.md](protocols/protocol-support.md)

## Configuration Reference

- Feature Flag 与布尔开关目录（中文）: [configuration/feature-flags.zh-CN.md](configuration/feature-flags.zh-CN.md)

## Deployment Guides

- Log Analytics through DCE (English): [observability/log-analytics-dce.en.md](observability/log-analytics-dce.en.md)
- 通过 DCE 写入 Log Analytics（中文）: [observability/log-analytics-dce.zh-CN.md](observability/log-analytics-dce.zh-CN.md)
- Database-first Azure deployment: [../README.md#azure-deployment](../README.md#azure-deployment)
- Azure deployment overview: [../README.md#azure-deployment](../README.md#azure-deployment)
- Azure Managed Application package: [../infra/azure_deployment_with_UI/README.md](../infra/azure_deployment_with_UI/README.md)
- ACI persistence guide (English): [deployment/aci-persistence.en.md](deployment/aci-persistence.en.md)
- ACI 持久化指南（中文）: [deployment/aci-persistence.zh-CN.md](deployment/aci-persistence.zh-CN.md)

## Infrastructure Templates

- Bicep template: [../infra/main.bicep](../infra/main.bicep)
- ARM template: [../infra/azuredeploy.json](../infra/azuredeploy.json)
- Managed Application main template: [../infra/azure_deployment_with_UI/mainTemplate.json](../infra/azure_deployment_with_UI/mainTemplate.json)
- Managed Application UI definition: [../infra/azure_deployment_with_UI/createUiDefinition.json](../infra/azure_deployment_with_UI/createUiDefinition.json)
- Dev parameters: [../infra/parameters/dev.json](../infra/parameters/dev.json)
- Prod parameters: [../infra/parameters/prod.json](../infra/parameters/prod.json)

## Notes

- The root [../README.md](../README.md) is the primary English entry point.
- Azure deployment defaults are now database-first and support both new and existing storage/database resource paths. The ACI persistence guides explain when to choose PostgreSQL, Azure Files, or the combined database+azureFile mode.
- Process and scratch documents are intentionally excluded from version control and are not part of the public docs set.