# Local collaboration rooms

A collaboration room is a shared conversation between a human and a bounded
team of Copilot workers in the Agents window. It is not a synthetic assistant
session: the shared room history and each worker's private execution transcript
have different authorship, visibility and lifetime.

## Opening a room

The desktop-only experimental feature is off by default. Enable the local
Copilot agent host and `chat.agentHost.collaboration.enabled`, then open
**Agent Collab** in the Sessions sidebar to create or reopen a room.
**Agents: Open Collaboration Room** is also available from the Command Palette.
AI features must be enabled and a compatible local host available.

The room's home screen asks for a shared goal, a working folder, and one to ten
peers with a model menu for each. Shared rules, the committed baseline and
optional run limits are under **Advanced**; the room title is taken from the
goal. Draft model choices stay with their slots when the peer count changes or
the view closes. Existing rooms are listed in the Sessions sidebar under
**Agent Collab**, which expands to open one directly; the section header itself
opens this creation screen.

Peers work in Git worktrees, so a room needs a repository. A plain folder is
accepted: the room offers to prepare it, showing the exact path, and only then
runs `git init` with a baseline commit. It is never initialized silently, and a
folder that is already inside a repository resolves to that repository.

**Create** records the room; it does not by itself authorize
model execution. **Start** runs the team. **Send** requests a response from every
peer when no `@mentions` are present, or only the mentioned peers otherwise.
Finished and stopped peers wake for the new message without a separate Resume.
Turn caps and deadlines are optional and unset by default, under
**Optional run limits**.
The host's default model is labeled as such rather than presented as a specific
model choice.

Model menus remain available in each peer's row after creation. Changing a
model saves that peer's preference without starting a turn or changing another
peer. An active turn continues with its current model; a pending choice applies
on the next turn. Unavailable or policy-rejected choices are errors, not requests
to fall back silently. Changes made in an individual member chat follow the same
room-owned preference and application lifecycle. Session, chat, and worktree
identities do not change when the model changes.

The member's desired selection and last provider-acknowledged selection are
separate state. `modelSelection` is the acknowledgement; an absent value is
unconfirmed, not implicit Auto. `pendingModel` stores the next choice (with
`null` representing an explicit Auto reset), while the legacy `model` field
mirrors the desired ID and must not be presented as proof of the currently
running model. Model-application failures remain in `modelError`. An omitted
creation slot retains the legacy/provider fallback; an explicit reset of an
existing member requires Auto to be available in the current catalog.

New rooms start in **Autopilot** with assisted approvals, so ordinary tool calls
are not interrupted while elevated decisions still reach the human. Existing and
legacy rooms keep whatever level they already had; reopening a room never
silently escalates it. The **All peers**
mode and permissions menu changes the whole room; individual peer choices
remain valid as well. Explicit selections are persisted and retained through
Stop, Resume, and application restart. Autopilot governs the agent's autonomous
work loop; Allow all is a separate approval choice, and neither overrides
mandatory managed approvals or sandbox policy. A level the provider or policy
refuses is clamped when resolved, rather than failing the room.

The host resolves and pins the selected branch, tag or commit using its
sanitized Git environment.

Workspace trust is handled from the room. A single source-repository consent
also covers the exact peer worktrees supplied by the local room authority,
never their shared parent directory. Sending messages, starting, resuming,
retrying, steering, and approving requests require that trust. Reading history
and choosing models do not authorize execution.

The room picker reopens existing rooms. Use **Back to Sessions** or open a member
to inspect ordinary session details. Room history, worker transcripts and the
user's regular sessions are separate surfaces.

## Collaboration model

Workers are peers. Each reads the same goal and room context, chooses useful
work, announces its approach, and shares findings or asks another worker for
help. There is no mandatory lead agent. The host coordinates execution and
delivery, not research direction.

The workflow follows [Hugging Face agent collaborations](https://github.com/huggingface/agent-collabs):

1. Read the goal, recent posts, current work and unread messages.
2. Choose an avenue, considering what other members are already doing.
3. Announce the work.
4. Work in the member's own Git worktree.
5. Publish findings, including unsuccessful approaches, with evidence or patches.
6. Continue while the run permits, or wait when blocked or without useful work.

The comparison was checked against HF revision
[`9f18c7a`](https://github.com/huggingface/agent-collabs/tree/9f18c7a35dc163d7aa151495b68e7a140006c50a).
HF provides explicit organizer broadcasts, attributed readable artifacts and a
unified inbox watcher. Its watcher delivers data to the agent harness; it does
not itself inject instructions into an in-flight model call. Our local runtime
bridge supplies that steering boundary. Neither implementation can guarantee
model compliance or automatically detect semantically duplicate research.

## Authorship and delivery

Room messages have a stable ID, ordering, authoritative author and optional
reply/mention targets. The host derives an agent's identity from its bound
session; it does not trust a model-supplied display name.

Everyone can read shared history. Reading permission is separate from turn
activation:

- A normal human **Send** with no mentions addresses every peer and requests a
  response, including after peers have finished or a previous run has stopped.
- A human mention authorizes the named peer to respond, including after a
  previous run has stopped. It does not restart the rest of a stopped team.
- The composer sends explicit recipient IDs and authorizes execution before
  posting. This works with older local hosts as well. The host's lower-level
  context-only posts and previously saved messages keep their original audience;
  opening a room does not reinterpret or redeliver old posts.
- Agent mentions can coordinate already available peers within the active run,
  but cannot restart a stopped room or revive stopped peers.
- Agents do not receive inbox deliveries for mentioning themselves.
- A busy recipient receives the message at its next admitted turn.
- Posting never waits synchronously for another agent's answer.
- Advice does not change the recipient's tool permissions.

### Human steering

**Send** notifies mentioned peers, or the whole room when there are no mentions.
It wakes finished peers and queues messages for busy peers. **Steer Agents**
(Control/Command+Enter in the composer) uses the same audience but sends guidance
into an active turn instead of waiting for the next one.

Steering is persisted before delivery. For an active peer the host injects it
into the existing SDK turn instead of waiting for that turn to finish or
creating another turn behind the room scheduler. A peer that becomes idle
during delivery receives it through its next scheduled turn. Pause holds new
guidance; Stop cancels pending/in-flight delivery and late acknowledgements
cannot revive work. No polling prompts or hidden extra agent runs are needed.

Delivery states distinguish **Sending guidance**, **Sent to active turn**, and
terminal outcomes. Runtime acceptance is not evidence that the model understood
or obeyed the message, and cannot stop an external command that has already
started. At the next normal tool boundary the peer must read newly available
human guidance. Errors remain visible rather than success-shaped.

The UI only offers live steering when the host advertises support. An older
host must not silently interpret a steering request as passive discussion.

Acknowledged room steering also records its SDK message identity alongside the
original turn boundary. History reconstruction uses that association so a
reload does not turn guidance into an extra cancelled user turn. An SDK
acknowledgement confirms submission, not model compliance; the SDK does not
offer an atomic expected-turn argument for remote races.

After the host acknowledges a human post, the chat reveals that saved message
and returns to the live tail. Loaded scrollback must not hide the user's
own successful send. The acknowledgement remains visible if refreshing surrounding
history fails; no duplicate send is required. Ordinary incoming posts still
preserve the user's position in older history.

History is one continuously growing, ordered conversation rather than separate
older/newer pages. Scrolling upward fetches earlier messages and preserves the
visible message anchor. New posts and updated delivery states continue to merge
into loaded history without moving a reader who is above the live tail.
**Jump to Latest** returns to the live conversation. Failed loads retain the
already-loaded messages and expose retry; only visible rows are rendered.

Historical context-only messages remain labeled as not having notified agents;
they are not replayed when the room opens. New sends show their actual delivery
states. Delivery and turn submission do not guarantee that a model follows the
request correctly.

Text follow-ups submitted from a member's individual chat use the same room
inbox and target that member. The response is a delivery acknowledgement, not a
raw SDK turn bypassing the room controller; it identifies the room and offers
**Back to Room**. New human requests can create a fresh uncapped run for their
recipients after a previous run finishes. Limits chosen for a team run apply to
that run, not to subsequent explicit human requests. Pause and an in-progress
Stop hold messages; **Retry Delivery** can activate a saved pending human request
once stopping completes, without publishing it twice. Attachments are rejected explicitly
rather than silently dropped. Ordinary non-room sessions keep their normal
send path.

Member chats disable the native Queue and Steer commands before a request can
enter the client queue. They remain interactive for approvals and idle
follow-ups, with an input notice linking back to the room for live guidance.
The room's durable inbox, rather than the ordinary chat queue, owns delivery.

The room owns durable pending delivery records. The live session pending queue
is not sufficient on its own: an automatically draining queue must not bypass
Pause, Stop or a run limit. On restart, reconcile known turn bindings and expose
ambiguous/interrupted submissions rather than silently repeating work.

## Execution and lifetime

The local agent host owns the room store and run controller. Copilot workers are
ordinary independently addressable sessions, identified before concurrent
startup rather than inferred from whichever session appears next in a cache.

Every initial turn, continuation and targeted activation passes the same
admission checks. Runs have no implicit turn cap or deadline; optional limits
must be finite positive values when supplied. An ordinary SDK turn ending
does not mean the shared goal has been solved.

A **continuous** room keeps admitting turns for an idle member that proposed no
next step, because an open-ended goal is never finished by the model deciding it
is. New rooms are continuous; existing and legacy rooms are not, and the setting
is togglable. Continuous rooms still stop at Pause, Stop, an optional turn cap or
deadline, and a failed or blocked member is not rewoken. This is a scheduling
rule, not a promise of useful work.

Peer artifacts are surfaced to a member on a turn interval rather than every
turn. A shared board that every member reads continuously collapses the
diversity that having several members is meant to buy; the interval is an
advisory island model, since the room tools remain available to a running turn.

- **Resume** retries failed or stopped peers in a fresh run without changing
  their sessions or worktrees. Resuming while paused turns are still active
  instead keeps their existing run and limits, and releases held guidance.
- **Pause** stops admitting new turns while current work finishes.
- **Stop** closes admission before requesting cancellation.
- **Stopping** remains distinct from confirmed termination.
- **Idle** does not mean success; members can be waiting for advice or work.
- Late completions and peer messages from a stopped/superseded run cannot
  restart it. A new human request is a separate explicit authorization.

Dormant workers must not issue repeated model calls merely to poll for
messages. Run deadlines require cancellation, not only a timeout on a caller
waiting for a result. Already-running external processes may have a separate
termination lifecycle.

Closing the room view does not delete the room or stop the live host. Quitting
VS Code is not an always-on-server guarantee: restore persistent history and
member/worktree bindings, mark interrupted work honestly, and require an explicit
human request or Resume before spending again.

## Worktrees and shared artifacts

Each member works from an explicit repository baseline in a unique worktree.
Provisioning failures must not silently fall back to the user's working folder.
Dirty user changes are not automatically committed or included in that baseline.

`room_read` returns the caller's identity, current peer work, pending inbox,
recent addressed human guidance, published artifacts and a pageable message
history. If another peer announced work between reading and a first work
announcement, the caller must reread before claiming its own approach. This
does not assign tasks or attempt semantic deduplication; it prevents claims
based on a stale view of peer activity.

`room_read_artifact` exposes an explicitly published patch, its author/revisions,
the canonical read-only patch path and paginated contents. Peers inspect that
evidence and may explicitly apply the patch to their own worktree using their
normally approved Git tools. Empty files in one worktree are not proof that
other peers have done nothing.

Sharing publishes an attributed immutable contribution with its baseline and
content identity. A mutable live diff is not a published snapshot. Longer
evidence belongs in artifacts instead of repeated long room messages.

Publication does not merge or apply changes to another member or the user's
branch. Adoption and conflict handling are explicit. Stop, reconnect and member
removal must preserve unreviewed contributions and dirty worktrees; deletion is
a separate user decision.

Worktrees prevent ordinary file-editing collisions. They are not an OS sandbox
or an access-control equivalent to Hugging Face bucket permissions. Preserve
workspace trust, content exclusions, tool approvals and execution restrictions.

Peers inspect published work before adopting it in their own worktree, rather
than copying into the original repository. Follow-ups prioritize the latest
addressed human request and evidence-linked findings.

## UI and accessibility

The room view holds the multi-author conversation with a bottom composer, and
nothing else. Room settings live in the Agents window side panel, taking the
place that Changes and Files hold in an ordinary session: opening a room brings
Room Settings forward, and closing it restores whichever container was showing
before. Because the workbench hosts the panel, its width, visibility and
persistence are the auxiliary bar's, not the room's.

A custom view normally replaces the side panel along with the sessions grid, so
the room's descriptor sets `allowsSidePanel`. That keeps the auxiliary bar beside
the view, keeps the side panel toggle live, and stands the single-pane detail
coordinator down so Changes and Files cannot claim the panel back from a room.
The editor area is then only a host for the docked panel, so its tab strip stays
hidden rather than showing the previous session's editors.

The composer borrows the Agents window chat input's container and toolbar
classes, so it reads as that input rather than a second kind of composer, and
carries a short mention affordance instead of prose. Neither the room nor the
panel writes pixel sizes into its own layout: both fill their host through CSS,
because measuring and writing back left content larger than its container
whenever the surface resized without a fresh layout pass.

The room still owns that DOM and publishes it through the collaboration
view-state service; the side-panel pane only adopts it while a room is open, and
hands it back on dispose. Inside, run controls and the tab strip stay pinned
above an independently scrolling body, so the tabs never scroll out of reach.
The tabs are one per member, then the shared rules and configuration, then
approvals. The tab strip is a real tablist with roving focus and arrow, Home and
End navigation; pending approvals and member failures are badged so an inactive
tab still reports that it needs attention. It carries the shared modern
editor-tab classes that the Agents window composite bar also adopts, so room tabs
match the rest of the window rather than inventing their own appearance.

A member's tab shows its model, state, and actual runtime activity;
explicit work reports appear in the shared conversation without duplicate
previews or expanded report blocks. Author accents are stable
within the room, theme-aware, and accompanied by visible names. Users
can open individual sessions for detailed tool output or changes.
Full transcripts are not loaded solely to populate the roster.

The room's **Approvals and questions** section observes each member's
server-confirmed active requests. It supports tool and result approvals,
questions, and plan reviews without opening the individual chats. Supplied
approval choices remain authoritative, and required managed approvals remain
one-time. Responses stay pending until the host acknowledges and applies them;
rejection, disconnection, or timeout is visible and does not report success.
Changing rooms or ending the turn invalidates stale approval controls.
Hiding the side panel does not dispose request cards or their drafts.
Room Settings in the room header, and the needs-attention action, both open the
side panel and focus the pending request.

Shared posts use the agent chat's own row structure and presentational classes,
so a room post reads as a chat turn and the author accent identifies the speaker
on the avatar. The chat's renderer is not reusable - it is driven by a chat view
model the room does not have - but its appearance is, and the room imports that
stylesheet directly rather than depending on the chat widget being loaded.

Distinguish explicit shared posts, member-reported work and runtime events.
Do not manufacture chat messages by extracting hidden reasoning or concatenating
private worker transcripts. Coalesce repetitive activity instead of flooding
the room with every streamed token.

Keyboard users can navigate the roster, messages and composer, mention or reply
to members, open their sessions and use run controls. Accessibility Help explains
those interactions; Accessible View presents shared room content as plain text.
The collaboration verbosity setting controls the help hint. Important targeted
updates may be announced, but do not announce every tool delta or duplicate
existing approval signals.

Preserve focus and scroll position while work arrives. Follow new messages only
when already at the latest message; otherwise expose a new-messages indicator.
Background activity must not switch the selected room/member/workspace.

## Architecture boundaries

- Host-side room contracts, persistence, worker tools and execution remain in
  `vs/platform/agentHost`.
- The renderer consumes a provider-independent observable collaboration facade
  in `vs/sessions/services/collaboration`.
- Concrete room UI lives in `vs/sessions/contrib/collaboration`.
- `ICustomViewService` hosts the room as a native full-surface custom view.
  The Agent Collab sidebar shortcut opens that view without changing the
  Sessions Part or taking ownership of its active session.
- The view owns its internal split layout. Its conversation uses the existing
  virtualized list infrastructure; the renderer facade owns continuous history
  loading, merge/deduplication, and cancellation when the room or host changes.
- Backend session/chat identities are resolved by the owning provider.
  Shared room UI opens the resulting chat through `ISessionsService`.
- Ordinary `ISession` and chat behavior remain independent of room navigation.

The first version is local and Copilot-backed. A room must not appear as runnable
on an unsupported host or when AI features are disabled. Private runtime APIs
and newer agent-host protocol documentation do not imply local SDK support.

## Validation

Coverage must include equal-peer startup, bounded overlapping execution, targeted
delivery without broadcast activation, partial startup failures, pause/stop
races, reconnect recovery, honest activity state, worktree preservation and
explicit artifact sharing. Browser tests and themed fixtures cover the real room
component, not an imitation.

Live concurrency depends on account limits, model availability and resources.
Controlled tests prove the local scheduling contract; paid live runs require
separate authorization and must report the versions and limits actually tested.
