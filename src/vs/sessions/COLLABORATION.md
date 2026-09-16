<!--
Copyright (c) Microsoft Corporation. All rights reserved.
Licensed under the MIT License. See License.txt in the project root for license information.
-->

# Inbox-first collaboration rooms

Agent Collab is a shared conversation and durable inbox for independent local
Copilot sessions, each with its own model and Git worktree. It is not another
model/tool loop, a synthetic assistant transcript, or a permanent coordinator.
See [AGENT_COLLAB_GUIDE.md](AGENT_COLLAB_GUIDE.md) for the practical workflow.

## Ownership

```text
Human room UI       Peer A / worktree A
       |                | room_post
       +----------------+
                |
       Host-owned room state
       messages + recipient receipts
                |
       Deterministic admission
       eligibility + budget + reservation
           /                 \
   Peer B / worktree B   Peer C / worktree C
```

Three owners have separate responsibilities:

1. **Room state/store:** identities, immutable posts and artifacts, mutable
   recipient receipts, lifecycle, and run authorization.
2. **Dispatcher/runtime adapter:** one active turn per member, bounded input,
   durable reservation, normal Agent Host submission, and reconciliation.
   Copilot continues to own its native model/tool loop.
3. **Sessions presentation:** observable snapshots, history and inbox filters,
   drafts, peer models, approvals, navigation, and accessibility. Rendering
   never authorizes a turn.

The host and worker tools live in `vs/platform/agentHost`; the facade and UI
live in `vs/sessions`. Individual-chat follow-up routing lives in Workbench
without importing the Sessions layer. Lifecycle integration uses the existing
Agent Host contribution/admission seams, not new feature branches in
`AgentService` or `AgentSideEffects`.

## Mail and attribution

- A post has a stable ID, room sequence, host-bound sender, explicit recipient
  IDs, body, timestamp, and optional reply/artifact references.
- `mentions` is the transport field for explicit recipient IDs. The host never
  parses arbitrary body text to change its audience.
- The shared human composer always supplies all non-removed peer IDs, including
  for replies. Individual peer chats and peer tools can address a specific
  recipient; a hidden draft preference must not narrow the shared composer's
  audience.
- Empty recipients mean a passive room note. Broadcast is an explicit action,
  not a consequence of a status update or ordinary turn completion.
- Shared history and each peer's inbox are views of one canonical post.
- Commit the message and receipts before acknowledging send or admitting a
  recipient. Sending does not wait for another agent's answer.
- A stable idempotency key identifies the same attributed payload. Repeating
  it is a retry; reusing it for different content is an error.
- Removed peers retain attribution and artifacts but cannot receive new mail.

`room_read` and human history reads are pure, bounded and paginated. Sequence
cursors define ordering. Viewing history does not acknowledge a message,
consume an inbox, or request another turn.

The Sessions room-view service owns profile-local hidden-message markers.
They filter the conversation and Accessible View, not the host's message pages
or recipient inboxes. Hidden posts remain in the authoritative journal with
their original sequences and references; restoring visibility causes no
delivery or admission. History paging and new-message tracking continue to use
the unfiltered loaded page.

An admission attaches the actual addressed messages to the recipient's input,
including authors and message IDs. The batch is limited to **20 messages and
16,000 message-body characters**; each post is limited to **8,000 characters**.
Remaining mail stays pending in sequence order. Peer content is clearly
attributed context, not human or system authority.

Transport states are `pending`, `reserved`, `submitted`, `failed`, `interrupted`,
and `cancelled`. `reserved` means the immutable batch and budget charge were
persisted, before preparation/native submission. `submitted` means the input
was handed to the native host path, not acknowledged by the provider or
fulfilled by the model. Runtime and crash diagnostics remain separate from task
outcomes. There is no transport `completed` verdict.

## Admission and budgets

Creating or opening a room is not permission to spend. The first Start requires
a finite positive turn cap. Initial tasks and later inbox activations use the
same admission path and budget.

| Event | Behavior |
| --- | --- |
| First Start | Enqueue an initial task for each selected worker |
| New addressed human Send | Reopen the existing enabled/budgeted run and re-enable addressed stopped, failed, or interrupted peers |
| Addressed mail to eligible idle peer | Admit one bounded batch if budget remains |
| Mail to busy peer | Persist and wait for the native terminal boundary |
| Native completion, no pending mail | Become idle; do not synthesize a continuation |
| Read, receipt update, status display | No activation |
| Pause | Hold admission while current work settles |
| Stop | Close admission before aborting; preserve queued mail/worktrees |
| Stopped peer receives agent-authored mail | Keep it pending; peer mail cannot authorize resumption |
| Failed/disconnected peer | Keep mail and expose diagnostics; no infinite retry |
| Budget exhausted | Hold admission and expose the reason and pending mail |
| Extend | Add to the existing cap without resetting run identity/counter |
| Restart | Restore history and reconcile, without automatically spending |

Room/member Stop, removal, late events, retries, and model changes cannot bypass
admission. Adding a peer or posting more mail cannot create an uncapped run.
An unresponsive abort must become a visible diagnostic rather than unexplained
permanent Stopping or falsely confirmed Stopped.

A new addressed human Send is explicit resumption authorization, committed
atomically with its message and receipts. It requires an existing, unexpired
run with remaining budget. It must not seed another initial task, replenish
limits, interrupt a busy recipient, or re-enable unaddressed stopped peers.
An idempotent repeat of an old send does not renew that authorization. A later
Pause or Stop wins the race; sends during an unsettled cancellation are refused.

A turn cap bounds host admissions, not individual model/tool calls, tokens, or
currency. Ordinary SDK approval, usage, and cancellation controls still apply.
An idle peer is addressable, and an idle room is not a success verdict.

There is no coordinator event timer or quorum, forced Continue/Wait protocol,
model-authored permission bureaucracy, or second automatic continuation loop.
Any existing peer can be asked to plan, pair, review, or summarize through the
same ordinary messages and budget.

## Persistence and recovery

[agentHostRoomsStorage.ts](../platform/agentHost/node/agentHostRoomsStorage.ts)
owns atomic per-room journals. It does not run a second orchestration engine.
New writable files are isolated under the local room root:

```text
agent-host-rooms/
  rooms/                    original v1 journals: read-only archives
  worktrees/                original worktrees: retained
  artifacts/                original patches: retained
  v2/
    rooms/                  writable v2 journals
    worktrees/              new peer worktrees
    artifacts/              immutable new patches
    indexes/                temporary private Git indexes
    git/                    private Git temporary files
```

V2 journals separate immutable `messages` from mutable
`receipts: [{ messageId, deliveries }]`. The runtime storage interface combines
them into presentation snapshots without giving reads acknowledgement behavior.
Messages are append-only; persisted sender/content/reply/artifact identities
cannot be rewritten. Member session, chat, name, and worktree identities remain
stable. Published artifact metadata is immutable.

Load/index identities when restoring storage, not by rescanning every room on
each save. Explicit reload can revalidate disk state. Persist meaningful mail,
admission, budget, model, and lifecycle transitions; obtain transient streamed
tool activity from the normal runtime instead of repeatedly rewriting history.

Reserve a stable turn ID and charge its budget in one durable transition before
submission. After a crash, use authoritative runtime evidence to reconcile a
known turn. Ambiguous input must be surfaced as interrupted, not silently sent
again. Exactly-once model processing is not promised.

[agentHostRoomArchive.ts](../platform/agentHost/node/agentHostRoomArchive.ts) is
the only v1 adapter. It projects history without modifying original bytes or
restoring an execution loop. Legacy assignment/result/review details remain
readable, with reply and patch references. `archivedSessions` preserves links
for all old participants, including the coordinator, without inventing a new
worker or a turn count. All those sessions are read-only for admission.
Legacy completion/steering receipts are displayed with an explicit historical
diagnostic rather than treated as reconciled v2 delivery.

Archives cannot be started, messaged, reconfigured, or made executable by
opening their session links. A new room is required for new work.

## Worktrees and evidence

[agentHostRoomWorktrees.ts](../platform/agentHost/node/agentHostRoomWorktrees.ts)
owns repository resolution, preserved worktrees and patch operations separately
from mailbox storage. A plain folder requires explicit initialization consent.
Existing repositories retain their uncommitted changes.

Each worktree must remain a real directory belonging to the pinned repository,
with a HEAD descended from the shared baseline. Missing preserved worktrees
must not be silently recreated. No fallback may edit the original repository.

Patch publication captures committed, staged, unstaged and eligible untracked
changes using a private index, preserving both real indexes and working trees.
Content exclusions are checked before publishing or delivering content.
Artifacts are immutable and read by their host-owned identity, never by treating
an arbitrary caller-supplied URI as read access.

The four room tools are `room_post`, `room_read`, `room_share_patch` and
`room_read_artifact`. Sender identity is bound to the admitted session.
Review requests and evidence are ordinary messages. Publication does not apply
or merge a patch; adoption uses the recipient's normally approved tools.
Nested teams and room-management actions are not peer tools.

Worktrees prevent file-editing collisions but are not an OS security boundary.
Retain normal trust, approvals, content exclusions, sandbox and managed policy.
Peer text cannot authorize tools or change those controls.

## Models, approvals, and presentation

Each peer retains its own desired, pending and provider-acknowledged model.
`modelSelection` records the acknowledgement; `pendingModel` records the next
choice, with `null` meaning explicit Auto. The legacy-named `model` alias reflects
the desired ID, not proof of which model is currently running. A busy turn
finishes with its current choice; errors remain visible without silent fallback.

Room and member configuration use the existing provider schemas and managed
settings. New rooms use Autopilot with assisted approvals; neither bypasses
mandatory policy or the finite room budget. Opening a room does not escalate
its stored permissions.

The main surface is one virtualized shared conversation with recipient inbox
filters, an all-peer composer, patch references and visible budget.
There is no Coordinator/Activity split or coordinator-specific chat creation.
Normal peer-chat navigation uses the owning Sessions provider.

Human text follow-ups in worker chats use the same authenticated room inbox and
disclose their shared visibility. There is no competing native room queue or
live steering path. Ordinary non-room Queue/Steer remains unchanged.

Reuse the existing model pickers, Run/Agents/Rules/Approvals settings, request
cards, workspace trust, draft retention and scroll anchoring. Approval responses
remain pending until acknowledged; stale/disconnected controls cannot report
success. Do not scrape hidden reasoning or private transcripts into the room.

Keep Accessibility Help, Accessible View and the verbosity setting current.
Inbox filters and sender/recipient/delivery labels must be understandable
without color. Preserve keyboard navigation, focus restoration and scroll
position, and avoid announcing every transient tool update.

The experimental AI gate and a negotiated inbox-v2 capability are required.
An incompatible host/client must be explicitly read-only or unavailable, never
silently reinterpret a new inbox request as old steering behavior.

## Validation contract

Focused tests must verify behavior, not merely total passing counts:

- Scripted A -> B -> A with actual peer content, attribution and patch evidence.
- Concurrent peers, never concurrent turns for one peer; busy mail queues.
- Repeated reads and extended idle time cause zero model admissions.
- Exact idempotency, batch-size/body limits and finite ping-pong exhaustion.
- Pause, Stop, removal, late callbacks, failed preparation and abort timeout.
- Persisted reservation/submission crash windows and explicit ambiguous retry.
- Byte-preserved archives and read-only old workers/coordinator.
- Isolated model changes, approvals/content checks and preserved worktrees.
- Real UI rendering without inference, with filters, budgets, retained drafts,
  keyboard access, focus and scroll stability.

Run selected unit suites against fresh output, and scoped lint/type/layer checks
when the changed boundaries warrant them. Do not run tests while a transpilation
cleans their output. Real-model pilots require explicit model and paid-turn
authorization after deterministic validation.

Reliable delivery is not proof of better task quality or faster VS Code startup.
Any performance claim needs a separate controlled measurement and review.
