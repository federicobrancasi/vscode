<!--
Copyright (c) Microsoft Corporation. All rights reserved.
Licensed under the MIT License. See License.txt in the project root for license information.
-->

# Native model teams

The Agents Window model picker can configure one normal local Copilot chat as
a **Lead + Worker** team, optionally with a separate **Scout**. These are native
Copilot subagents, not Agent Collab rooms or separate provider runtimes.

## Using a team

1. Open a workspace chat with the local Copilot provider.
2. Open the model picker and turn **Team** on. On first use, choose the missing
   helper model in the normal model picker. Cancelling setup leaves Single unchanged.
3. The model list is replaced by **Lead** and **Worker** cards. Each model button
   opens the normal rich model picker; each reasoning button changes only that
   role's supported reasoning level. **Add Scout** adds an optional third role.
4. Choices save immediately for the next request; there is no Apply/Cancel form.
   Send the request normally. Opening or changing the picker never starts
   inference by itself.

The Lead plans, reads, reviews, and answers. The Worker is the only agent that
edits files and runs commands. The optional Scout performs read-only research.
The runtime enforces at most one active Worker and one active Scout. Role names
describe participants; selecting one model for multiple roles does not make it
multiple distinct models.

The closed input control shows the agents' model icons and names in a compact
row. Its hover and accessible label identify each role and any pending change
or unavailable selection, including each role's reasoning. Turn **Team** off to
return to the normal model picker. The Lead remains the single agent, and the
helper models/settings are remembered for that chat, including after reload.
New chats still start in Single mode. An in-progress request retains its
configuration; new selections apply at the next request boundary. Stop and
normal approvals retain their existing meanings.

Roles can use the same model with different reasoning levels. Choices come from
the model's configuration schema, not a universal list of effort levels. Models
without adjustable reasoning, including Lead Auto routing, show model-managed
reasoning. Helper context-size overrides are not currently supported. Role
configuration does not change another role or profile-global model preferences.
Native teams use these per-role reasoning selections instead of the ordinary
single-chat reasoning-effort capability override.

The participants share the chat's working folder. No worktrees, commits, merges,
or independent sessions are created by selecting a team. Existing workspace
trust, content exclusions, sandbox restrictions, and managed approvals still
apply.

## Availability and limitations

- Initial support is the primary workspace chat in the Agents Window using
  local Copilot. Quick chats, inline editing, ephemeral requests, Agent Collab,
  remote/cloud hosts, and separate agent runtimes are not supported.
- The runtime must advertise native team contract version 1 and authoritative
  per-role reasoning support. Older runtimes do
  not expose the feature. AI-disabled, untrusted, and signed-out surfaces do not
  gain a new execution path.
- Helpers require concrete Copilot catalog models. BYOK models are not part of
  the initial contract. Normal Lead Auto selection remains available.
- An unavailable or policy-disabled helper is an error requiring a replacement,
  never permission to fall back to the Lead's model.
- Restored teams retain their settings and picker schema while the model catalog
  is loading or a selected model is unavailable. Availability is checked again
  before work starts; restoring the controls does not authorize a model call.
- Native and client tool scopes are separate. Arbitrary external/MCP tools are
  not automatically granted to a role, even if they advertise a read-only hint.
- Additional participants can increase usage. Existing subagent transcripts and
  usage reporting are reused; there is no synthetic combined model or price.

## Development dependencies

This implementation is an unpublished cross-repository development change.
[The dependency manifest](../../../../../../package.json) currently refers to
the sibling Copilot SDK and engine builds using local `file:` dependencies.
Build them before installing this checkout:

```sh
cd ../copilot-sdk/nodejs
npm run build
cd ../../copilot-agent-runtime
pnpm run build:runtime
pnpm run build
cd ../vscode
npm install
npm run transpile-client
```

Restart the development Agent Host after rebuilding the engine. The local
dependency references must be replaced with compatible released package versions
before an upstream release; they are not an update to installed Stable or
Insiders.

## Ownership and validation

The Sessions provider owns selection, dormant preferences, and configuration
transport; the shared picker receives generic header/body extensions, alternate
selection presentation, and role-scoped model configuration access.
The Agent Host records desired and applied configuration separately, resumes
only the affected native session when role definitions change, and retains
session/chat identities.

The SDK/runtime owns strict model/effort routing, role tool admission, capacity,
cancellation, and native capability acknowledgement. Prompts explain those
constraints but do not enforce them. The engine's current-SDK permission-mode
entry point delegates to its existing managed-policy-checked permission mutation.

Focused unit tests cover picker behavior, draft rollback, hydration, send
ordering, role projection, create/resume options, and Single-mode preservation.
The Agent Host protocol test exercises capability/configuration/reset without
inference. Companion SDK transport tests and native Rust tests cover role
capacity, cancellation, tool execution, and outgoing loopback model requests.
Themed picker fixtures cover light, dark, and both high-contrast themes.
