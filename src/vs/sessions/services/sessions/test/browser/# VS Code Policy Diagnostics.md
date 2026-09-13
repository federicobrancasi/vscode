# VS Code Policy Diagnostics

*WARNING: This file may contain sensitive information.*

## System Information

| Property | Value |
|----------|-------|
| Generated | 2026-06-29T08:25:56.496Z |
| Product | Visual Studio Code - Insiders 1.127.0-insider |
| Commit | 0d2dfb2eb897808a27356ab6e5d33000acec4590 |

## Account Information

### Default Account Summary

**Account ID/Username**: 75954805

**Account Label**: federicobrancasi

### Detailed Account Properties

| Property | Value |
|----------|-------|
| authenticationProvider | {"id":"github","name":"GitHub","enterprise":false} |
| accountName | federicobrancasi |
| sessionId | *** |
| enterprise | false |
| entitlementsData | {"login":"federicobrancasi","access_type_sku":"copilot_enterprise_seat_multi_quota","analytics_tracking_id":"572f09aba6d2bf21089526baed9bb3c1","assigned_date":"2026-02-02T15:25:51+01:00","can_signup_for_limited":false,"chat_enabled":true,"cli_enabled":true,"copilotignore_enabled":true,"copilot_plan":"enterprise","editor_preview_features_enabled":true,"is_mcp_enabled":true,"is_staff":true,"organization_login_list":["github","microsoft","Visual-Studio-Code"],"organization_list":[{"login":"github","name":"GitHub"},{"login":"microsoft","name":"Microsoft"},{"login":"Visual-Studio-Code","name":"Visual Studio Code"}],"restricted_telemetry":true,"cli_remote_control_enabled":false,"cloud_session_storage_enabled":true,"endpoints":{"api":"https://api.enterprise.githubcopilot.com","origin-tracker":"https://origin-tracker.enterprise.githubcopilot.com","proxy":"https://proxy.enterprise.githubcopilot.com","telemetry":"https://telemetry.enterprise.githubcopilot.com"},"can_upgrade_plan":false,"codex_agent_enabled":true,"quota_reset_date":"2026-07-01","quota_snapshots":{"chat":{"overage_count":0,"overage_entitlement":0,"overage_permitted":false,"percent_remaining":100,"quota_id":"chat","quota_remaining":0,"unlimited":true,"timestamp_utc":"2026-06-29T01:11:29.850-07:00","has_quota":false,"quota_reset_at":0,"token_based_billing":true,"remaining":0,"entitlement":0},"completions":{"overage_count":0,"overage_entitlement":0,"overage_permitted":false,"percent_remaining":100,"quota_id":"completions","quota_remaining":0,"unlimited":true,"timestamp_utc":"2026-06-29T01:11:29.850-07:00","has_quota":false,"quota_reset_at":0,"token_based_billing":true,"remaining":0,"entitlement":0},"premium_interactions":{"overage_count":0,"overage_entitlement":0,"overage_permitted":true,"percent_remaining":100,"quota_id":"premium_interactions","quota_remaining":0,"unlimited":true,"timestamp_utc":"2026-06-29T01:11:29.850-07:00","has_quota":true,"quota_reset_at":0,"token_based_billing":true,"remaining":0,"entitlement":0}},"quota_reset_date_utc":"2026-07-01T00:00:00.000Z","token_based_billing":true} |
| policyData | {"cloud_session_storage_enabled":true,"chat_agent_enabled":true,"chat_preview_features_enabled":true,"mcp":true} |

## Account Policy Gate

| Property | Value |
|----------|-------|
| State | `inactive` |
| Reason | *n/a* |
| ChatApprovedAccountOrganizations | *not set* |

**Legend**

- `inactive`: gate disabled (no approved orgs configured) — policies behave as account data dictates.
- `satisfied`: gate active and approved — account policy values flow normally.
- `restricted`: gate active and not satisfied — opted-in policies forced to their restricted value.
  - `noAccount`: no default account signed in.
  - `wrongProvider`: signed in with a non-GitHub provider.
  - `orgNotApproved`: signed in but account is not a member of any approved organization.
  - `policyNotResolved`: signed in to an approved org but account-side policy data has not yet been fetched.

## Managed Settings

**Active source**: File (managed-settings.json)

### GitHub Server API

| Property | Value |
|----------|-------|
| Endpoint | `/copilot_internal/managed_settings` |
| Last fetch | `ok` |
| Last successful fetch | 6/29/2026, 10:11:34 AM |
| Active | no |

**Normalized bag**

```json
{}
```

### Native MDM

| Property | Value |
|----------|-------|
| Available | yes |
| Active | no |

```json
{}
```

### File (managed-settings.json)

| Property | Value |
|----------|-------|
| Available | yes |
| Active | yes |

```json
{
  "permissions.disableBypassPermissionsMode": "disable",
  "enabledPlugins": "{\"plugin@marketplace\":true}",
  "extraKnownMarketplaces": "{\"my-marketplace\":\"github/agent-skills\"}"
}
```

### Effective

```json
{
  "permissions.disableBypassPermissionsMode": "disable",
  "enabledPlugins": "{\"plugin@marketplace\":true}",
  "extraKnownMarketplaces": "{\"my-marketplace\":\"github/agent-skills\"}"
}
```

### Parse Errors (0)

## Policy-Controlled Settings

### Applied Policy

| Setting Key | Policy Name | Policy Source | Managed Settings | Default Value | Current Value | Policy Value |
|-------------|-------------|---------------|------------------|---------------|---------------|-------------|
| chat.plugins.enabledPlugins | ChatEnabledPlugins | Managed Settings: File | enabledPlugins | `{}` | `{"plugin@marketplace":true}` | `{"plugin@marketplace":true}` |
| chat.plugins.extraMarketplaces | ChatExtraMarketplaces | Managed Settings: File | extraKnownMarketplaces | `{}` | `{"my-marketplace":"github/agent-skills"}` | `{"my-marketplace":"github/agent-skills"}` |
| chat.tools.global.autoApprove | ChatToolsAutoApprove | Managed Settings: File | permissions.disableBypassPermissionsMode | `false` | `false` | `false` |

###  Non-applied Policy

| Setting Key | Policy Name
|-------------|-------------|
| extensions.allowed | AllowedExtensions|
| chat.agentHost.enabled | ChatAgentHostEnabled|
| chat.agentHost.claudeAgent.enabled | Claude3PIntegration|
| chat.agentHost.codexAgent.enabled | Codex3PIntegration|
| chat.agentHost.otel.enabled | CopilotOtelEnabled|
| chat.agentHost.otel.exporterType | CopilotOtelProtocol|
| chat.agentHost.otel.otlpProtocol | CopilotOtelOtlpProtocol|
| chat.agentHost.otel.otlpEndpoint | CopilotOtelEndpoint|
| chat.agentHost.otel.captureContent | CopilotOtelCaptureContent|
| chat.agentHost.otel.outfile | CopilotOtelOutfile|
| chat.agentHost.otel.serviceName | CopilotOtelServiceName|
| chat.agentHost.otel.resourceAttributes | CopilotOtelResourceAttributes|
| chat.agentHost.otel.headers | CopilotOtelHeaders|
| chat.defaultModel | ChatDefaultModel|
| chat.sessionSync.enabled | CopilotSessionSync|
| chat.tools.eligibleForAutoApproval | ChatToolsEligibleForAutoApproval|
| chat.mcp.access | ChatMCP|
| mcp.enterpriseManagedAuth.idp | McpEnterpriseManagedAuthIdp|
| chat.extensionTools.enabled | ChatAgentExtensionTools|
| chat.plugins.enabled | ChatPluginsEnabled|
| chat.plugins.strictMarketplaces | ChatStrictMarketplaces|
| chat.agent.enabled | ChatAgentMode|
| chat.agent.networkFilter | ChatAgentNetworkFilter|
| chat.agent.allowedNetworkDomains | ChatAgentAllowedNetworkDomains|
| chat.agent.deniedNetworkDomains | ChatAgentDeniedNetworkDomains|
| chat.mcp.gallery.serviceUrl | McpGalleryServiceUrl|
| chat.useHooks | ChatHooks|
| chat.approvedAccountOrganizations | ChatApprovedAccountOrganizations|
| extensions.autoUpdate | ExtensionsAutoUpdate|
| extensions.autoUpdateDelay | ExtensionsAutoUpdateDelay|
| extensions.gallery.serviceUrl | ExtensionGalleryServiceUrl|
| chat.tools.terminal.enableAutoApprove | ChatToolsTerminalEnableAutoApprove|
| chat.agent.sandbox.enabled | ChatAgentSandboxEnabled|
| chat.agent.sandbox.allowNetwork | ChatAgentSandboxAllowNetwork|
| chat.agent.sandbox.allowUnsandboxedCommands | ChatAgentSandboxAllowUnsandboxedCommands|
| chat.agent.sandbox.allowAutoApprove | ChatAgentSandboxAllowAutoApprove|
| update.mode | UpdateMode|
| telemetry.telemetryLevel | TelemetryLevel|
| telemetry.feedback.enabled | EnableFeedback|
| workbench.browser.enableChatTools | BrowserChatTools|
| github.copilot.nextEditSuggestions.enabled | CopilotNextEditSuggestions|
| github.copilot.chat.reviewAgent.enabled | CopilotReviewAgent|
| github.copilot.chat.reviewSelection.enabled | CopilotReviewSelection|
| github.copilot.chat.claudeAgent.enabled | Claude3PIntegration|
| github.copilot.chat.otel.enabled | CopilotOtelEnabled|
| github.copilot.chat.otel.exporterType | CopilotOtelProtocol|
| github.copilot.chat.otel.protocol | CopilotOtelOtlpProtocol|
| github.copilot.chat.otel.otlpEndpoint | CopilotOtelEndpoint|
| github.copilot.chat.otel.captureContent | CopilotOtelCaptureContent|
| github.copilot.chat.otel.serviceName | CopilotOtelServiceName|
| github.copilot.chat.otel.resourceAttributes | CopilotOtelResourceAttributes|
| github.copilot.chat.otel.headers | CopilotOtelHeaders|
| github.copilot.chat.otel.outfile | CopilotOtelOutfile|

## Authentication Information

### Authentication Providers

| Provider ID | Sessions | Accounts |
|-------------|----------|----------|
| github | 1 | federicobrancasi |
| github-enterprise | 0 | None |
| microsoft | 0 | None |
| __GitHub.copilot-chat | 0 | None |

### Detailed Session Information

#### github

| Account | Scopes | Extensions with Access |
|---------|--------|------------------------|
| federicobrancasi | read:user, user:email, repo, workflow | vscode.github (trusted), github.remotehub (trusted), ms-vscode.remote-server (trusted), github.vscode-pull-request-github (trusted), github.codespaces (trusted), github.copilot (trusted), github.copilot-chat (trusted), ms-vsliveshare.vsliveshare (trusted), ms-azuretools.vscode-azure-github-copilot (trusted) |

