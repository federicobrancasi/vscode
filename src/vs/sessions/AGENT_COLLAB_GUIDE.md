<!--
Copyright (c) Microsoft Corporation. All rights reserved.
Licensed under the MIT License. See License.txt in the project root for license information.
-->

# Agent Collab: guide and implementation overview

Agent Collab brings a human and **one to ten independent Copilot peers** into a
shared conversation in the VS Code Agents Window. Each peer has its own session,
model selection, and Git worktree. Peers can announce work, ask one another for
help, share findings, and publish patches while the human follows and steers the
work from a single room.

This guide describes the experimental implementation in this checkout, including
the chat-first interface and follow-up behavior. It is not an announcement that
the feature is available in every released VS Code build.
[COLLABORATION.md](COLLABORATION.md) remains the authoritative architecture
specification; this document is the practical guide and overview.

## Contents

- [Project branch](#project-branch)
- [Inspiration and references](#inspiration-and-references)
- [What was implemented](#what-was-implemented)
- [Getting started](#getting-started)
- [Talking to the agents](#talking-to-the-agents)
- [Choosing models and permissions](#choosing-models-and-permissions)
- [Using the room interface](#using-the-room-interface)
- [How peers collaborate](#how-peers-collaborate)
- [Implementation map](#implementation-map)
- [Validation](#validation)
- [Limitations and troubleshooting](#limitations-and-troubleshooting)
- [Sources](#sources)

## Project branch

This project lives on the branch **`fb/agent-collab`**, published to a fork of
the [VS Code codebase][vscode] rather than to the upstream repository.

| Reference | Value |
|-----------|-------|
| Branch | [`fb/agent-collab`][branch] |
| Fork | [`federicobrancasi/vscode`][fork] |
| Upstream | [`microsoft/vscode`][vscode] |
| Foundation commit | `ee704679f22997f5d18a64d83bfa93e76cdd336a` - Add local Copilot collaboration rooms |

The branch is not proposed upstream. Clone the fork directly to work on it, or
add it as a second remote on an existing VS Code checkout:

```sh
# fresh machine
git clone --branch fb/agent-collab https://github.com/federicobrancasi/vscode.git

# or, on an existing microsoft/vscode checkout
git remote add federicobrancasi https://github.com/federicobrancasi/vscode.git
git fetch federicobrancasi fb/agent-collab
git switch fb/agent-collab
```

## Inspiration and references

The starting point was Hugging Face's
[Gemma collaboration lessons][gemma-lessons], especially
[How an Agent Collaboration Works][gemma-how], and the
[huggingface/agent-collabs][agent-collabs] implementation.

The [Fast Gemma Challenge][gemma-challenge] brought agents together to improve
Gemma inference throughput while checking output quality. Its
[dashboard][gemma-dashboard] combined a shared message board, submissions, and a
leaderboard. The [lessons article][gemma-lessons] describes both useful
collaboration and problems such as repeated ideas, excessive messages, and
optimizations that improved a metric at the expense of quality.

The idea adopted here is **collaboration through persistent, attributed messages
and shared evidence, with humans able to redirect the work**. It is not a copy
of the leaderboard, an implementation of Gemma inference optimization, or a
claim that more agents automatically produce better results.

| Idea | Hugging Face reference | Agent Collab in VS Code |
|------|------------------------|-------------------------|
| Shared objective | A research challenge with rules and evaluation | A room goal, shared rules, and a pinned repository baseline |
| Independent work | Agent-owned scratch buckets | Separate local Git worktrees and ordinary Copilot sessions |
| Shared knowledge | Message board, inboxes, artifacts, and results | Attributed room posts, recipient delivery states, findings, and published patches |
| Human participation | Dashboard messages and organizer guidance | Send, mentions, replies, live steering, and room-level approvals |
| Coordination | Agents discover related work and organize around topics | Equal peers choose complementary work; no mandatory lead agent |
| Evaluation | Challenge-specific scoring, verification, and optional jobs | Existing project tests and human review; no built-in leaderboard or scoring service |

These are analogous workflows, not equivalent isolation mechanisms. Hugging
Face's backend and bucket ownership enforce its collaboration access model.
A local Git worktree separates working files but is **not an OS sandbox or an
access-control boundary**.

[github/copilot-agent-runtime][copilot-runtime] was also examined as the runtime
behind GitHub Copilot CLI and SDK. This feature uses VS Code's existing local
Copilot agent-host integration and its declared dependencies in
[package.json](../../../package.json); it does not deploy Hugging Face
infrastructure or require a separate clone of the runtime repository.
Capabilities must come from the installed SDK and connected host, not from
assuming everything on the runtime repository's current main branch is present.

## What was implemented

The work covers the room backend, its integration with existing Copilot sessions,
and a native Agents Window interface:

- **Persistent rooms and equal peers:** a shared goal, stable room/member
  identities, independent sessions, and up to ten overlapping peer executions.
- **Separate worktrees:** a committed baseline for each peer, with no automatic
  edits, commits, or merges into the human's original working tree.
- **Shared conversation:** explicit work announcements, findings, replies,
  mentions, delivery status, and published patch references.
- **Follow-ups after completion:** normal Send wakes finished or stopped peers
  without requiring the user to open each session or press Resume first.
- **One Send:** a post reaches a working peer as live guidance during its
  current turn, and wakes a finished peer with a new one, without asking the
  human to choose a delivery mechanism for a message they already wrote.
- **Independent model choices:** compact, searchable menus before creation and
  afterwards, with pending changes and application errors shown honestly.
- **Persistent configuration:** room-wide and per-peer mode, permissions, and
  sandbox choices no longer snap back to manual settings on the next turn.
- **Room-level requests:** workspace trust, tool/result approvals, questions,
  and plan reviews can be handled without opening every peer.
- **Chat-first layout:** the room view is the conversation and its composer;
  settings move to the Agents window side panel, where four fixed tabs (Run,
  Agents, Rules, Approvals) take the place Changes and Files hold in an
  ordinary session.
- **Patch sharing that works:** peers publish Git patches of their own work and
  read each other's, so a room can build on a result rather than only hear
  about it.
- **Continuous history:** virtualized messages, earlier-history loading, stable
  scroll anchors, author colors, and wrapping for long messages. No duplicate
  "Reported work" cards or Older/Newer Posts controls.
- **Reliability and accessibility:** corrected read receipts, Resume/retry
  handling, stale-response protection, retained drafts, keyboard navigation,
  accessibility help, and an Accessible View.

## Getting started

### Prerequisites

Use a desktop development build containing this implementation, a working local
Copilot agent host, an appropriate Copilot sign-in, and a local Git repository
with at least one commit. AI features and the required models/tools must be
permitted by the user's configuration and organizational policy.

This is not a standalone Marketplace extension; it has to be run from source.
On a machine that has never built VS Code, follow the
[VS Code contribution instructions][vscode-development] for the platform
toolchain first, then:

```sh
git clone --branch fb/agent-collab https://github.com/federicobrancasi/vscode.git
cd vscode
npm install          # do not symlink node_modules from another checkout
npm run compile      # builds the client and the built-in extensions
./scripts/code.sh --agents
```

`npm run compile` is required rather than `npm run transpile-client`: the
latter populates `out/` but not `extensions/*/out/`, and the Agents window needs
the built-in extensions. Use `npm run watch` while iterating.

Sign in to Copilot in the launched build before starting a room. A room that
cannot reach an authenticated host can be read and stopped, but not started.

### Create a room

1. Enable the application setting:

   ```json
   {
     "chat.agentHost.collaboration.enabled": true
   }
   ```

   The experimental setting does not override disabled AI features, policy,
   authentication, or an unsupported host.
2. Open **Agent Collab** in the Sessions sidebar, or run
   **Agents: Open Collaboration Room** from the Command Palette. Rooms you have
   already created are listed underneath it; the row's **New Collaboration**
   action (or **Agents: New Collaboration**) clears the selection and leaves the
   creation form ready, so a second room can be started without leaving the one
   you are in.
3. Describe the shared goal. The room title is taken from it.
4. Choose a folder. Peers work in Git worktrees, so a plain folder is offered a
   one-time setup (`git init` plus a baseline commit) with its exact path shown;
   it is never initialized silently. Uncommitted source-folder changes are not
   silently included, committed, or discarded.
5. Choose one to ten peers and a model for each numbered slot. Choices stay
   associated with their slots if the peer count changes.
6. Shared rules, the branch/tag/commit, and run limits are under **Advanced**.
7. Select **Create and Start**. Creation records the room; it does not start paid
   inference.
7. Review workspace trust when requested. A source-repository decision can cover
   this room's exact peer worktrees, never their shared parent directory.
8. Select **Start**, or send a message to request a response.

Turn and deadline limits are **optional and unset by default**. Set them under
**Optional run limits** when a bounded team run is wanted.

## Talking to the agents

**A new message is a request for a response, even after the agents finish.**
That can consume additional model tokens. Merely opening a room, reading its
history, creating it, or choosing a model does not start a turn.

Sending is one action. When a peer is mid-turn and the host supports steering,
the post is delivered as live guidance so it lands during that turn; otherwise
it is an ordinary post, which wakes finished peers with a new turn. Either way
the message is in the room, so a peer that is busy now reads it when it comes
free. Control/Command+Enter always steers.

| Action | Recipients | Effect |
|--------|------------|--------|
| Send without `@mentions` | Every peer in the room | Wakes finished/stopped peers; queues the message for busy peers |
| Send with `@Copilot-2` | Only the mentioned peers | The same follow-up behavior, without waking the rest of the room |
| Reply | Determined by the mentions in the composer | Links the post to an earlier message; check the inserted mention before sending |
| Retry Delivery | Undelivered recipients of that saved human message | Retries delivery without adding a duplicate post |

For example:

```text
What did each of you verify, and what is still blocked?
```

Send requests an answer from every peer, including peers that have finished.

```text
@Copilot-2 Please check the mobile navigation once more.
```

Send requests a follow-up only from Copilot-2, and reaches it during its current
turn if it is working.

Text follow-ups from an idle peer's individual chat are also shared in the room
and addressed to that peer. During an active turn, use the room composer rather
than the individual chat's native Queue/Steer path. Unsupported attachments on
that follow-up path are rejected explicitly instead of silently dropped.

Important boundaries:

- **Pause holds delivery.** Resume is still needed to release a deliberately
  paused room.
- **Stopping is not Stopped.** Wait for cancellation to finish before retrying
  work; a new message must not defeat an in-progress Stop.
- A newly authorized human follow-up can create a fresh uncapped run after an
  earlier run ends or exhausts its limit. Old limits are not a permanent cap on
  future human requests.
- Peer messages are different from human Send. Agents notify explicit
  recipients; their posts cannot restart a stopped room or recursively launch
  new teams.
- Old context-only posts are not retroactively broadcast. Retrying the same
  completed message does not run it again.

Delivery labels describe transport and execution, not the quality of an answer.
**Submitted** means a queued message was assigned to a turn;
**Sent to active turn** means the runtime accepted steering. Neither proves
that the model understood the request or completed it correctly. Errors,
cancellation, and interrupted delivery remain visible.

### Run controls

These live in the **Run** tab of the side panel, which offers only the actions
the room's current state allows rather than showing them all and disabling most.

| Control or state | Meaning |
|------------------|---------|
| Start | Begin the team run with the selected configuration and optional limits |
| Resume | Resume held work, or start a fresh run for stopped/failed peers without replacing their sessions or worktrees |
| Pause | Stop admitting new turns; current work can finish |
| Stop All / Stop | Request cancellation for the room or one peer |
| Waiting | No active work is being performed; this is not proof that the goal is solved |
| Needs Attention | A request, trust decision, or failure needs human review |

A peer has at most one admitted turn at a time. Ten peers can execute
concurrently, but real concurrency remains subject to account capacity, model
availability, quotas, and local resources.

## Choosing models and permissions

### A model for every Copilot

Each setup slot and saved peer has a searchable model popup in Room Settings.
The menu uses the local host's actual catalog; selecting a model for one peer
does not change the active chat's global selection or another peer's choice.

- Before Start, the selection is saved for that peer's first turn.
- An idle peer's selection can be applied or recorded without starting work.
- A busy peer keeps its current model for the active turn. A pending selection
  applies when it starts its next turn.
- The UI distinguishes the selected model from the last provider-confirmed
  model. **Provider Default** or an unconfirmed selection is not proof that a
  particular model is running.
- An unavailable or policy-rejected model produces an error rather than silently
  switching to another model. Model changes preserve session, chat, and worktree
  identity.

The desired/current/pending storage contract is documented in
[COLLABORATION.md](COLLABORATION.md). The picker does not expose extra model
configuration controls unless their persistence is supported.

### Autopilot is separate from approval level

New rooms start in **Autopilot with assisted approvals**, so routine tool calls
are not interrupted while elevated decisions still reach you; existing rooms keep
the level they already had. The **All peers**
menu changes the team's mode, permissions, and terminal sandbox choices when
those options are available. Individual choices made through peer sessions
remain synchronized with the room.

Autopilot controls how the agent continues work. It is not blanket permission
to execute every tool. **Manual permissions**, **Assisted permissions** when
available, and **Allow all** are separate choices. Elevated choices use the
existing warnings and policy checks; neither Autopilot nor Allow all overrides
mandatory managed approvals.

Configuration is saved and applied through the host. Rejected changes are
reported instead of briefly appearing selected and then silently reverting.

### Approvals and workspace trust

Use the header's **Needs Attention** action to reveal pending requests, even
when Room Settings is collapsed. Cards identify the peer and show the actual
tool request, result, question, or plan to review.

Responses stay pending until the host acknowledges and applies them. Rejection,
timeout, or disconnect is an error, not a successful approval. Hiding the panel
does not destroy form drafts. Changing rooms or ending a turn invalidates stale
requests.

Sending, starting, resuming, retrying, steering, and allowing work require the
appropriate authentication and workspace trust. These checks are not bypassed
to make collaboration more convenient.

## Using the room interface

```text
Sessions sidebar | Room title/status      Room Settings | Run | Agents | Rules | Approvals
                 |                                      |
                 | Shared conversation                  | Start / Pause / Stop All
                 |                                      | Needs Attention
                 | Copilot-1: findings...               | Optional run limits
                 | Copilot-2: reply...                  |
                 | You: guidance...                     |
                 |                       Jump to Latest |
                 | Message input                      ↑ |
```

The room view holds the conversation and nothing else. Its settings live in the
Agents window **side panel**, taking the place that Changes and Files hold in an
ordinary session: opening a room brings Room Settings forward, and closing it
restores whichever container was showing before. Because the workbench hosts the
panel, its width and visibility are the auxiliary bar's.

The panel has four tabs, whatever the room's size:

| Tab | Holds |
|-----|-------|
| Run | The run actions and the optional run limits |
| Agents | Every peer, with its model, state, and Stop/Retry actions |
| Rules | The room's goal, rules, folder and pinned base, plus shared configuration |
| Approvals | Workspace trust and anything awaiting a decision |

Giving each member its own tab made the strip grow with the room until it
scrolled, so members are a list inside one tab instead. Pending approvals and
member failures are badged, so an inactive tab still reports that it needs
attention.

Messages retain visible author names as well as stable accents. Body text uses
normal theme foreground colors, long paragraphs wrap, and agent-authored
Markdown uses the chat-safe rendering rules. Shared reports appear in the
conversation, not repeated in expanded roster cards.

Scroll upward to load earlier messages. New posts and delivery updates continue
to arrive without moving a reader who is above the live tail. **Jump to Latest**
returns to the newest content; virtualized rendering avoids creating a DOM row
for every loaded message.

Open a peer for its detailed transcript or changes, then use **Back to Room**
or the **Agent Collab** sidebar entry to return. Navigation does not restart
agents. Closing the room view does not delete its history or stop the host;
quitting VS Code is not a guarantee that work continues in an always-on service.

Keyboard support includes:

- Tab and Shift+Tab between controls; arrow keys and Page Up/Page Down in history.
- Enter to send, Shift+Enter for a newline, and Control/Command+Enter to steer.
- Arrow keys and Enter to choose a mention; Escape to dismiss suggestions.
- Room Settings, and Needs Attention, bring the side panel forward; Escape in
  the panel returns to the conversation.
- Accessibility Help and Accessible View for instructions and a plain-text view
  of participants, requests, and loaded messages.

## How peers collaborate

The expected cycle is: read shared context, choose complementary work, announce
intent, work in the assigned worktree, and publish evidence or ask for help.
A useful next step can continue the run; an agent with nothing useful left
should wait rather than repeatedly poll with paid model calls.

The host binds these tools to the caller's member identity:

| Tool | Purpose |
|------|---------|
| `room_read` | Read identity, goal, peer work, inbox, human guidance, messages, and published artifacts |
| `room_post` | Post an attributed message, work announcement, finding, or reply; explicitly mention peers to notify them |
| `room_share_patch` | Publish an immutable Git patch of the peer's contribution relative to the room baseline |
| `room_read_artifact` | Inspect the metadata and contents of a previously published patch |

Published patches are evidence for review, **not automatic integration**.
Another peer may inspect and explicitly apply a patch in its own worktree using
normally approved tools. Applying or merging it into the human's branch is a
separate decision. Missing or failed worktrees must not silently fall back to
the original repository.

The room is not a concatenation of private transcripts. Reports are explicit
shared posts; the UI does not extract hidden reasoning to invent progress.
Human requests take priority over an older plan, but the host cannot guarantee
research quality, eliminate semantic duplication, or force a useful model reply.

## Implementation map

The room runs through existing VS Code layers, rather than a separate hosted
dashboard:

```text
Agents Window room UI
        |
Observable collaboration service
        |
Local agent-host IPC
        |
Persistent room controller and delivery/admission checks
        |
Existing Copilot SDK sessions, one per peer
        |
Independent worktrees + explicit shared posts and patches
```

| Responsibility | Main source |
|----------------|-------------|
| Room contracts and capabilities | [agentHostRooms.ts](../platform/agentHost/common/agentHostRooms.ts) |
| Scheduling, inboxes, follow-ups, and turn ownership | [agentHostRooms.ts](../platform/agentHost/node/agentHostRooms.ts) |
| Persistence, worktrees, and artifact publication | [agentHostRoomsStorage.ts](../platform/agentHost/node/agentHostRoomsStorage.ts) |
| Existing session/runtime integration | [agentHostRoomsRuntime.ts](../platform/agentHost/node/agentHostRoomsRuntime.ts) |
| Model validation and synchronization | [agentHostRoomsModels.ts](../platform/agentHost/node/agentHostRoomsModels.ts), [roomModelContribution.ts](../platform/agentHost/node/chatContributions/rooms/roomModelContribution.ts) |
| IPC, including default model slots | [agentHostRoomsIpc.ts](../platform/agentHost/common/agentHostRoomsIpc.ts), [agentHostRoomsChannel.ts](../platform/agentHost/node/agentHostRoomsChannel.ts) |
| Renderer state and Send audience | [collaborationService.ts](services/collaboration/browser/collaborationService.ts) |
| Continuous history loading and merging | [collaborationHistory.ts](services/collaboration/browser/collaborationHistory.ts) |
| Approval receipts and workspace trust | [collaborationRoomRequests.ts](services/collaboration/browser/collaborationRoomRequests.ts), [collaborationWorkspaceTrust.ts](services/collaboration/browser/collaborationWorkspaceTrust.ts) |
| Room composition and layout | [collaborationRoomWidget.ts](contrib/collaboration/browser/collaborationRoomWidget.ts), [collaborationRoomLayout.ts](contrib/collaboration/browser/collaborationRoomLayout.ts) |
| Virtualized messages and per-peer model menus | [collaborationConversation.ts](contrib/collaboration/browser/collaborationConversation.ts), [collaborationModelPicker.ts](contrib/collaboration/browser/collaborationModelPicker.ts) |
| Registration and accessibility | [collaboration.contribution.ts](contrib/collaboration/browser/collaboration.contribution.ts), [collaborationAccessibility.ts](contrib/collaboration/browser/collaborationAccessibility.ts) |

The host owns durable room state and execution. The renderer owns presentation,
drafts, and view state. Rejected or stale operations cannot be represented as
success, and a late callback cannot revive a stopped run.

For detailed ownership and lifecycle rules, use
[COLLABORATION.md](COLLABORATION.md),
[LAYERS.md](LAYERS.md), and the
[Agent Host provider specification](contrib/providers/agentHost/AGENT_HOST_SESSIONS_PROVIDER.md).

## Validation

Automated coverage exercises concurrency, stable identities, model persistence,
real IPC serialization, failed provisioning, read receipts, optional limits,
Pause/Stop races, finished-peer follow-ups, and idempotent delivery. Renderer
coverage checks model-menu isolation, approvals, draft retention, history
merging, scroll anchors, long-message wrapping, and accessibility.

With a prepared checkout and fresh build output, focused test entry points are:

```sh
# focused: the room host, and the room renderer - 741 and 166 tests
./scripts/test.sh --runGlob '**/agentHost/test/**/{agentHostRooms*,copilotAgent,copilotSessionLauncher,chatContributions}.test.js'
./scripts/test.sh --runGlob '**/sessions/**/collaboration*.test.js'

# the surrounding suites this work has to keep green - 7676 and 3605 tests
./scripts/test.sh --runGlob '**/agentHost/**/*.test.js'
./scripts/test.sh --runGlob '**/sessions/**/*.test.js'
```

The [themed fixtures](contrib/collaboration/test/browser/collaborationRoom.fixture.ts)
cover different peer counts, initial model choices, pending/error states, long
conversations, approvals, the side-panel settings, narrow layouts, and high
contrast.

Every command above passes at the tip of this branch. The runs overlap, so the
counts are not a single combined total. `npm run typecheck-client`,
`npm run valid-layers-check`, and scoped hygiene also pass.

The build has been exercised against live rooms, not only fixtures: rooms and
worktrees survive a restart, the real model catalog is reachable per peer, and a
four-agent room on a Python optimisation task produced peers that claimed
separate routines in the shared conversation and reported measured speedups.
This is **not** a claim that ten paid agents were benchmarked simultaneously or
that the Gemma Challenge's results were reproduced.

## Limitations and troubleshooting

- This implementation is local, desktop, and Copilot-backed. Different models
  can be selected from that host's catalog; arbitrary agent providers, remote
  rooms, multi-human hosting, HF Jobs, taskforces, and challenge leaderboards are
  not implemented by this work.
- Worktrees are not security sandboxes. Keep normal trust, content exclusions,
  managed settings, and tool restrictions in effect.
- Published patches are not automatically merged; another peer inspects one and
  decides whether to apply it in its own worktree. The publication failures seen
  earlier in development are fixed: content exclusion is now checked against the
  member's own worktree, which is the session the policy is evaluated in, rather
  than also against the source repository, whose paths are outside that session
  and made the whole check report "unavailable" and fail closed.
- No agent is guaranteed to comply, respond usefully, or avoid overlapping
  ideas. Inspect evidence, and send guidance when necessary.
- Existing messages and worktrees survive room navigation. Process restart
  restores persistent state but does not silently replay ambiguous work or
  automatically resume spending.

| Symptom | What to check |
|---------|---------------|
| Agent Collab is missing | This build must include the feature; enable its setting and verify AI features and a compatible local host are available |
| Model picker has no usable choices | Check sign-in, catalog availability, and policy; an unconfirmed/default label is not a confirmed running model |
| A finished peer does not respond | New Send should address all peers unless mentions narrow the audience; inspect its delivery status, trust/authentication errors, Pause, or an in-progress Stop |
| An old post says no agents were notified | It retains its original audience; send a new request rather than expecting old history to wake agents |
| Allow or a form response stays pending | Wait for the host receipt; inspect rejection, timeout, disconnect, and request-content errors before retrying |
| A saved model differs from the running model | An active turn keeps its model; inspect the pending-next-turn label and any model application error |
| A patch cannot be published | Inspect the peer's detailed error and worktree/baseline; preserve local work and do not claim a merge or artifact exists |
| The room is Waiting | Check findings and requests; idle execution is not a success verdict |

## Sources

External references were checked on **2026-09-13**. They describe their own
projects and may evolve independently of this checkout.

1. [Hugging Face: Gemma collaboration lessons][gemma-lessons] -
   the motivation, experiment, results, and lessons that inspired this work.
   Direct links: [How an Agent Collaboration Works][gemma-how] and
   [The Gemma Challenge][gemma-section].
2. [The Fast Gemma Challenge][gemma-challenge] and its
   [live dashboard][gemma-dashboard] - the original challenge and its
   human-facing collaboration surface.
3. [huggingface/agent-collabs on GitHub][agent-collabs] -
   the reusable challenge template, backend, dashboard, and setup runbook.
   The earlier implementation comparison used
   [revision 9f18c7a35dc163d7aa151495b68e7a140006c50a][agent-collabs-revision].
4. [Gemma Challenge backend API design][gemma-api] -
   reference material for server-mediated authorship and shared storage.
5. [github/copilot-agent-runtime on GitHub][copilot-runtime] -
   the Copilot CLI/SDK runtime reference, not a promise of capabilities in
   every installed SDK.
6. [microsoft/vscode on GitHub][vscode] -
   the host editor and Agents Window codebase.

[gemma-lessons]: https://huggingface.co/spaces/agent-collaborations/gemma-collab-lessons
[gemma-how]: https://huggingface.co/spaces/agent-collaborations/gemma-collab-lessons#how-an-agent-collaboration-works
[gemma-section]: https://huggingface.co/spaces/agent-collaborations/gemma-collab-lessons#the-gemma-challenge
[gemma-challenge]: https://huggingface.co/gemma-challenge
[gemma-dashboard]: https://gemma-challenge-gemma-dashboard.hf.space
[agent-collabs]: https://github.com/huggingface/agent-collabs
[agent-collabs-revision]: https://github.com/huggingface/agent-collabs/tree/9f18c7a35dc163d7aa151495b68e7a140006c50a
[gemma-api]: https://huggingface.co/spaces/gemma-challenge/gemma-bucket-sync/blob/main/DESIGN.md
[copilot-runtime]: https://github.com/github/copilot-agent-runtime
[vscode]: https://github.com/microsoft/vscode
[fork]: https://github.com/federicobrancasi/vscode
[branch]: https://github.com/federicobrancasi/vscode/tree/fb/agent-collab
[vscode-development]: https://github.com/microsoft/vscode/wiki/How-to-Contribute
