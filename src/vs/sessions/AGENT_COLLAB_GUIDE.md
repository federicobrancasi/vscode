<!--
Copyright (c) Microsoft Corporation. All rights reserved.
Licensed under the MIT License. See License.txt in the project root for license information.
-->

# Agent Collab: inbox-first guide

Imagine several agents working on the same problem, each in its own checkout,
with a shared conversation and an inbox. One agent can ask another to review a
patch, the recipient can test it independently, and everyone can see the
exchange. The agents do not need a permanent manager model to pass messages.

Agent Collab implements that workflow in the VS Code Agents Window with **one
to ten local Copilot-backed peers**. Each peer has its own session, model choice,
and Git worktree. The host delivers messages; the normal Copilot runtime does
the work. This is an experimental development feature, not a claim of
availability in every released VS Code version.

The inbox-first implementation is developed on `fb/agent-collab-inbox`. It
replaces the coordinator experiment. Existing experiments remain read-only
archives; they are not migrated into a new live run.

See [COLLABORATION.md](COLLABORATION.md) for the architecture and invariants.

## Getting started

1. Use a desktop build containing the feature, with the local Copilot agent host
   enabled, an appropriate sign-in, and AI features enabled.
2. Enable the experimental setting:

   ```json
   { "chat.agentHost.collaboration.enabled": true }
   ```

3. Open **Agent Collab** in the Sessions sidebar, or use **Agents: Open
   Collaboration Room** in the Command Palette.
4. Enter a shared goal, select a local working folder, and choose the peers and
   their models. Shared rules and the committed baseline are advanced options.
5. Create the room. **Creation and navigation do not authorize inference.**
6. Review workspace trust and select a finite automatic-turn budget before
   starting the run.

Worktrees require a Git repository with a committed baseline. A plain folder can
be prepared only after explicit consent. An existing repository's uncommitted
changes are not silently included in the baseline, committed, or discarded.
Worktree provisioning must not fall back to the original working folder.

## Talking to peers

The room has one shared conversation. **Send addresses all non-removed peers**,
without an audience selector. Mention completion inserts a peer's name, but
does not change recipients. A reply links to an earlier message and still goes
to the whole room. To address one peer, use its individual chat.

Agent tools still use explicit recipient IDs; their empty-recipient posts are
passive room notes and wake nobody. A reply or mention does not grant
permissions or prove that a request has been fulfilled.

**Hide for Me** on a human post or room event removes it from this profile's conversation and
Accessible View, including after reopening the window. **Show Hidden Messages**
restores hidden posts for the current room. Hiding is not deletion or recall:
the room journal, delivery receipts, and any context already seen by agents stay
unchanged. To turn an old passive note into a request for the team, send it as a
new message.

An idle peer is still addressable. Addressed mail can start its next turn if the
run is enabled and budget remains. A busy peer finishes its current turn first:
new mail is queued, not injected midway through its work. An ordinary turn
ending with no new mail leaves the peer idle, without a continuation or polling
turn.

**Human Send is also the resume action.** With an existing run and remaining
budget, sending to peers reopens a paused or stopped room and re-enables the
addressed peers. There is no separate Resume step. Busy recipients keep their
current turn and receive the queued input afterward. Passive notes and
agent-authored messages cannot reopen a stopped run.

For example, in a peer's individual chat:

```text
Review the patch Ada published. Apply it only in your own worktree, run the
focused test, and send Ada the command and result.
```

To get an overview, use **Ask for Summary** with an existing peer, or send it an
ordinary message asking for a summary. This uses the same inbox and budget as
any other request. It does not create an always-running coordinator.

Individual worker chats show detailed tool output. Text follow-ups sent there
are shared back into the room and addressed to that worker. Unsupported
attachments are rejected explicitly. Use the room inbox instead of the native
Queue/Steer path for room members; ordinary non-room chats are unchanged.

## Budgets and controls

The budget counts **host-admitted turns**, including initial activations. A
native turn may itself make many model/tool calls: this is **not a guaranteed
token or currency cap**.

| Control or state | Meaning |
| --- | --- |
| Start | Enqueue each peer's initial task and admit within the chosen finite budget |
| Pause | Hold new admissions while current work settles; retain queued mail |
| Stop | Close admission before requesting cancellation; preserve mail and worktrees |
| Resume / Retry | Explicitly re-enable held or failed work, using the existing budget |
| Extend | Explicitly add turns to the existing run; do not reset its identity or counter |
| Idle | No current work; not a declaration that the goal is solved |
| Budget exhausted | Keep mail queued and require an explicit budget extension |
| Interrupted | Delivery or cancellation needs attention; inspect before retrying |

Sending a message, adding a peer, or resuming cannot replenish an exhausted
budget. Addressed sends require an existing finite budget and are refused while
stopping is still in progress. A later Pause or Stop still supersedes a send.
An unresponsive cancellation is an error to inspect, not a false report of
successful termination. Already-running external processes may have their own
lifetime.

Delivery labels describe transport, not task success. **Reserved** means a
batch and its budget charge were saved before native submission; **Submitted**
means it was handed to the host's native turn path, not accepted or fulfilled
by the provider. Retrying the same saved send
does not add another copy to the shared conversation. After an ambiguous crash,
however, the model might already have processed the input: there is no
exactly-once-processing guarantee.

## Models, approvals, and trust

Each peer has its own model picker backed by the connected host's catalog.
Changes preserve session and worktree identity. A busy peer finishes with its
current model; its pending choice applies between turns. Unavailable or
policy-rejected choices remain errors, not silent fallback selections.

New rooms use Autopilot with assisted approvals. Autopilot governs the native
agent loop, not the room's admission budget, and is not blanket permission to
execute tools. Room-wide and per-peer choices still use normal provider and
managed-setting enforcement.

The **Approvals** panel shows the actual peer requests: tool approvals,
questions, and plan reviews. Responses remain pending until acknowledged by the
host. Disconnection, rejection, or timeout must not look like success.

Trust applies to the source repository and exact room-owned worktrees, not their
shared parent directory. Peer messages cannot change permissions, policy,
membership, or lifecycle controls. Git worktrees prevent ordinary editing
collisions; **they are not an OS sandbox or an access-control boundary**.

## Exchanging useful work

The four session-bound room tools are:

| Tool | Purpose |
| --- | --- |
| `room_post` | Send a useful attributed message, with explicit recipients, reply and artifact references |
| `room_read` | Read bounded, paginated room history and member state without consuming mail |
| `room_share_patch` | Publish an immutable patch from the sender's own worktree |
| `room_read_artifact` | Inspect the metadata and contents of a published patch |

The recipient's next input contains the actual addressed message text and
provenance, not just an instruction to call `room_read`. Repeated history reads
do not acknowledge mail or start turns.

Review requests and results are ordinary messages referencing patches. There
is no mandatory assignment/result-verdict workflow or `room_yield` tool.
Share evidence rather than acknowledgement-only chatter. A peer may inspect and
apply a published patch in its own worktree using normally approved tools;
publication does not merge anything into another peer or the human's branch.

## History, navigation, and accessibility

Filter the conversation to a selected peer's inbox or return to all messages.
Filters are views of the same shared history and never consume deliveries.
Scroll upward for older messages; incoming posts preserve a reader's position
above the live tail. Draft text and peer selection should survive navigation.

Room Settings retains the Run, Agents, Rules, and Approvals controls. Open a
peer's ordinary chat for details, then return to the room. Closing the view does
not delete its data or stop a live host.

Keyboard navigation, Accessibility Help, Accessible View, and the collaboration
verbosity setting remain available. Names accompany author accents; delivery
state and actionable errors are not conveyed by color alone.

Archives retain original messages, historical participant/session links, and
patches. Structured legacy evidence is displayed as historical content. Old
delivery statuses are not retroactively treated as proof that the new inbox
engine delivered anything. Opening an archive cannot activate its old workers
or coordinator.

## Limitations and troubleshooting

- The first version is local, desktop, and Copilot-backed. The contracts are
  provider-neutral; arbitrary providers and distributed room hosting are not
  implemented.
- Account quotas, available models, and local resources limit real concurrency.
- Restart restores history and reconciles reservations. It does not silently
  resume spending or blindly replay uncertain input.
- A room can be idle while the task remains unfinished. Check queued mail,
  remaining budget, errors, and pending approvals before requesting more work.
- No model is guaranteed to comply, avoid overlapping ideas, or produce a useful
  result. Inspect evidence rather than treating message volume as progress.
- The redesign itself is not evidence of a VS Code performance improvement.
  A speedup claim requires comparable before/after measurements.

## References

- [Gemma collaboration lessons](https://huggingface.co/spaces/agent-collaborations/gemma-collab-lessons#how-an-agent-collaboration-works),
  [Fast Gemma Challenge](https://huggingface.co/gemma-challenge), and
  [challenge dashboard](https://gemma-challenge-gemma-dashboard.hf.space).
- [HF agent-collabs](https://github.com/huggingface/agent-collabs/tree/9f18c7a35dc163d7aa151495b68e7a140006c50a):
  durable attributed messages, recipient inboxes, and a watcher/harness boundary.
  Its watcher waking an HTTP request is not itself a model turn.
- [Microsoft Agent Framework Group Chat](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat):
  context broadcast and speaker activation are distinct; speaker selection may
  use code or a manager model.
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams):
  separate contexts and direct peer messages, with a lead-managed team.
- [OpenAI multi-agent patterns](https://github.com/openai/openai-agents-python/blob/main/docs/multi_agent.md)
  and [Anthropic's effective agents](https://www.anthropic.com/engineering/building-effective-agents):
  orchestration, handoff, parallel execution, and synthesis are separate choices.
- [GitHub Copilot Agent Runtime](https://github.com/github/copilot-agent-runtime):
  repository access may require authentication. This feature uses VS Code's
  installed SDK and host capabilities, not assumed support from another
  repository's main branch.
