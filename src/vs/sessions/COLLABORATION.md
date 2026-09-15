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

The room's home screen asks for a shared goal, a working folder, a coordinator
model, and one to ten workers with a model menu for each. The coordinator is a
separate participant and does not count toward the worker limit. Shared rules
and the committed baseline are under **Advanced**; the room title is taken from
the goal. Draft model choices
stay with their slots when the peer count changes or the view closes. Each draft
peer receives a unique lowercase AI-themed name such as `chaotic-cyborg`.
The name is saved with the draft, validated by the host at creation, and remains
the peer's identity across model changes, restarts, retirement, and resume.
The host generates the same style of names when an older client omits them;
existing rooms keep their recorded names unchanged.
Existing rooms are listed in the Sessions sidebar under
**Agent Collab**, which expands to open one directly; the section header itself
opens this creation screen.

Peers work in Git worktrees, so a room needs a repository. A plain folder is
accepted: the room offers to prepare it, showing the exact path, and only then
runs `git init` with a baseline commit. It is never initialized silently, and a
folder that is already inside a repository resolves to that repository.

**Create** records the room; it does not by itself authorize model execution.
**Start** runs the team continuously until the human pauses or stops it, a
member is blocked or fails, or the host shuts down. **Send** addresses every peer
when no `@mentions` are present, or only the mentioned peers otherwise. Guidance
for a stopped peer stays pending until **Resume**.
The host's default model is labeled as such rather than presented as a specific
model choice.

Model menus remain available for the coordinator and each worker after
creation. Changing a model saves only that participant's preference without
starting a turn. An active turn continues with its current model; a pending
choice applies on the next turn. Unavailable or policy-rejected choices are
errors, not requests to fall back silently. Changes made in an individual
member chat follow the same room-owned preference and application lifecycle.
Session, chat, and worktree identities do not change when the model changes.

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
also covers the exact coordinator and worker worktrees supplied by the local
room authority, never their shared parent directory. A coordinator created
after the workers receives its own exact trust grant before its chat becomes
executable. Sending direct worker messages, starting, resuming, retrying,
steering, and approving requests require trust. Reading history and choosing
models do not authorize execution.

The room picker reopens existing rooms. Use **Back to Sessions** or open a member
to inspect ordinary session details. Room history, worker transcripts and the
user's regular sessions are separate surfaces.

## Collaboration model

Workers share the same goal but keep independent execution transcripts. They
remain equal peers and may communicate without using the coordinator as a
relay. The host coordinates execution and delivery; a dedicated coordinator
helps the human understand and direct the room without becoming an authority
that workers must wait for.

The workflow follows [Hugging Face agent collaborations](https://github.com/huggingface/agent-collabs):

1. Read the room once before beginning work.
2. Choose an avenue and work privately in the member's own Git worktree for as
   many turns as needed.
3. After implementing and verifying a meaningful result, publish one concise
   finding and any code patch.
4. Read messages newer than the last seen sequence.
5. Use useful peer evidence or continue improving the member's own approach.

The comparison was checked against HF revision
[`9f18c7a`](https://github.com/huggingface/agent-collabs/tree/9f18c7a35dc163d7aa151495b68e7a140006c50a).
HF provides explicit organizer broadcasts, attributed readable artifacts and a
unified inbox watcher. Its watcher delivers data to the agent harness; it does
not itself inject instructions into an in-flight model call. Our local runtime
bridge supplies that steering boundary. Neither implementation can guarantee
model compliance or automatically detect semantically duplicate research.

### Coordinator and assignments

The coordinator is one persistent Agent Host session and chat associated with
the room separately from `members`. It has its own stable session, chat,
worktree, model lifecycle, cursor, execution state, and event cursor. Existing
journals without coordinator state remain valid; preparing the coordinator adds
it without rewriting worker identity.

The coordinator's standard chat is the human-facing surface for broad guidance
and questions such as "How is the work going?". Its outgoing turns receive a
deterministic room snapshot containing worker state, assignments, explicit
pairings, results, verifications, blockers, failures, pending human guidance,
unowned work, and immutable evidence IDs. Model prose interprets this snapshot;
it does not overwrite or become authoritative room state.

The coordinator may inspect the snapshot, append an informational Activity
note, or create an immutable structured assignment. An assignment names one or
more assignees, a work or verification objective, expected evidence, and
optional result and superseded-assignment IDs. Multiple assignees are the only
authoritative representation of a pair. Assignment deliveries use the normal
room scheduler. Assignments created in one coordinator turn are admitted as a
batch when that turn finishes, so several distinct role assignments can start
together without the first targeted assignment retiring the others. Eligible
workers wake, busy workers receive the assignment on a later admitted turn, and
explicitly stopped workers keep it pending until the human resumes them.
Creating an assignment does not schedule the coordinator from its own event.

The coordinator cannot edit worker files, launch nested agents, stop, resume,
add or remove workers, answer approvals, or change room permissions. Those
operations remain direct human actions. A coordinator failure never blocks
worker turns, direct human guidance, Activity, or room persistence.

## Authorship and delivery

Room messages have a stable ID, ordering, authoritative author and optional
reply/mention targets. The host derives an agent's identity from its bound
session; it does not trust a model-supplied display name.

Everyone can read shared history. Reading permission is separate from turn
activation:

- A normal human **Send** with no mentions addresses every peer.
- A human mention addresses only the named peers.
- Running peers receive guidance in their active or next admitted turn. Guidance
  sent after Stop stays pending until explicit Resume.
- The composer sends explicit recipient IDs and authorizes execution before
  posting. This works with older local hosts as well. The host's lower-level
  context-only posts and previously saved messages keep their original audience;
  opening a room does not reinterpret or redeliver old posts.
- Agent mentions are optional peer evidence discovered through `room_read`.
  They are never inserted into model prompts and cannot restart stopped peers.
- Structured results and verification records are shared, immutable history.
  They do not carry mentions, create inbox deliveries, or wake peers.
- Structured assignments are shared, immutable history. Their deliveries notify
  the named workers, while informational coordinator notes do not wake anyone.
- Agents do not receive inbox deliveries for mentioning themselves.
- A busy recipient receives the message at its next admitted turn.
- Posting never waits synchronously for another agent's answer.
- Advice does not change the recipient's tool permissions.

### Human steering

**Send** notifies mentioned peers, or the whole room when there are no mentions.
Sending is one action: when the host advertises steering and a peer is mid-turn,
the post is delivered as live guidance so it lands during that turn; otherwise
the same human-guidance prompt is used for the next admitted turn.
Control/Command+Enter steers explicitly.

Steering is persisted before delivery. For an active peer the host injects it
into the existing SDK turn instead of waiting for that turn to finish or
creating another turn behind the room scheduler. A peer that becomes idle
during delivery receives it through its next scheduled turn. Pause holds new
guidance. Stop cancels pending/in-flight delivery, later guidance remains saved
until Resume, and late acknowledgements cannot revive work. No polling prompts
or hidden extra agent runs are needed.

Delivery states distinguish **Sending guidance**, **Sent to active turn**, and
terminal outcomes. Runtime acceptance is not evidence that the model understood
or obeyed the message, and cannot stop an external command that has already
started. At the next normal tool boundary the peer must read newly available
human guidance. Errors remain visible rather than success-shaped.

Send falls back to an ordinary post when the host does not advertise steering, so
an older host is never asked to interpret a steering request as passive
discussion.

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
**Back to Room**. Pause holds these messages, and messages sent after Stop stay
pending until Resume. **Retry Delivery** marks a saved cancelled or failed
request pending without publishing it twice, but it does not bypass Stop.
Attachments are rejected explicitly rather than silently dropped. Ordinary
non-room sessions keep their normal send path.

Member chats disable the native Queue and Steer commands before a request can
enter the client queue. They remain interactive for approvals and idle
follow-ups, with an input notice linking back to the room for live guidance.
The room's durable inbox, rather than the ordinary chat queue, owns delivery.

The room owns durable pending delivery records. The live session pending queue
is not sufficient on its own: an automatically draining queue must not bypass
Pause or Stop. On restart, reconcile known turn bindings and expose
ambiguous/interrupted submissions rather than silently repeating work.

## Execution and lifetime

The local agent host owns the room store and run controller. Copilot workers are
ordinary independently addressable sessions, identified before concurrent
startup rather than inferred from whichever session appears next in a cache.

Every initial turn, continuation and targeted activation passes the same
admission checks. The current room UI creates uncapped runs. Legacy clients and
stored records may still contain finite run limits, which remain readable for
compatibility. An ordinary SDK turn ending does not mean the shared goal has
been solved.

A peer receives the full room brief only when its preserved chat is first
started. It explains the private-work rules once. After an ordinary turn
finishes, the next admitted turn says:

> Share what you completed with the room. Publish changed code with
> room_share_patch and publish meaningful completed work with
> room_publish_result, including evidence. Use room_post for focused questions
> and conversational replies.
>
> Call room_read with after set to the latest sequence you saw, review peer ideas
> and feedback, and independently verify a useful peer result when appropriate.
> Never verify your own result.
>
> Ask a focused question in the room if you need help.

Only an explicit Resume or Retry uses:

> Continue working in the existing collaboration room.

Pending human guidance takes precedence over both prompts. It uses the
human-guidance prompt either inside the active turn or as the next turn. Peer
messages never become prompt blocks.

Every room keeps admitting turns after ordinary idle completion. A member
chooses what to work on next, not whether the room should stop. If peer evidence
is useful it may build on it; otherwise it continues improving its own approach.
Pause, Stop, removal, a genuine blocked or failed state, and host shutdown stop
admission. This is a scheduling rule, not a promise of useful work.

A room's roster is not fixed at creation. **Add Agent** gives it one more peer,
with its own session and worktree; a peer added to a room that has already run
joins the next run rather than being retired as finished by a run it was not
addressed in. **Remove** retires a peer after confirming: its posts and published
patches stay in the room, so the identity is kept rather than deleted and the
conversation still resolves it, but it takes no further turns and is no longer a
recipient. A room keeps at least one agent, and removed peers do not count
against the ten-member limit.

Each peer offers the one action that applies to it: **Stop** while it can still
be stopped, otherwise **Resume** — named **Retry** when it stopped because it
failed. Resume explicitly reopens admission for that peer and preserves its
session, worktree, and pending human guidance.

- **Resume** retries failed or stopped peers without changing their sessions or
  worktrees. Resuming while paused turns are still active releases held guidance.
- **Pause** stops admitting new turns while current work finishes.
- **Stop** closes admission before requesting cancellation.
- **Stopping** remains distinct from confirmed termination.
- **Idle** does not mean success; members can be waiting for advice or work.
- Late completions, human messages, and peer messages cannot restart a stopped
  room. Human guidance remains pending until Resume.

Workers read the room after publishing meaningful work; they do not consume
turns only to poll for messages. Already-running external processes may have a
separate termination lifecycle.

Closing the room view does not delete the room or stop the live host. Quitting
VS Code is not an always-on-server guarantee: restore persistent history and
member/worktree bindings, mark interrupted work honestly, and require an explicit
human request or Resume before spending again.

The coordinator is persistent but event-driven. Direct human chat messages run
it immediately. Structured results and verdicts, blocked/failed/needs-input
workers, completed or superseded assignments, and roster changes open one
durable 15-minute coalescing window. At the end of that window the host submits
one proactive follow-up with the latest snapshot. Ordinary chatter and every
worker turn do not. Events that arrive while the coordinator runs remain
pending for the next coalesced window rather than building an unbounded queue.

## Worktrees and shared artifacts

Each member works from an explicit repository baseline in a unique worktree.
Provisioning failures must not silently fall back to the user's working folder.
Dirty user changes are not automatically committed or included in that baseline.

`room_read` returns the caller's identity, current peer work, pending inbox,
recent addressed human guidance, published artifacts, structured results,
verification records and a pageable message history. `limit` requests a bounded
latest page; `after` requests messages newer than a previously seen sequence;
`before` reads older history. Sequence cursors, not timestamps, define
deterministic ordering. One initial read authorizes private work across later
continuation turns. A fresh read is required at the next safe tool boundary when
newer human guidance arrives.

`room_read_artifact` exposes an explicitly published patch, its author/revisions,
the canonical read-only patch path and paginated contents. Peers inspect that
evidence and may explicitly apply the patch to their own worktree using their
normally approved Git tools. Empty files in one worktree are not proof that
other peers have done nothing.

Sharing publishes an attributed immutable contribution with its baseline and
content identity. A mutable live diff is not a published snapshot. Longer
evidence belongs in artifacts instead of repeated long room messages.

### Structured results and independent verification

`room_publish_result` records a completed implementation or investigation as an
immutable result with a stable ID, title, summary, outcome, one or more evidence
items, and optional references to patches already published by that author.
Outcomes are **Success**, **Negative**, **Inconclusive**, or **Blocked**.
Publishing starts in **Pending**; a success claim is not independent
verification. A blocked result also uses the existing blocked-member lifecycle.

`room_verify_result` lets another admitted peer append an attributed
**Verified** or **Rejected** verdict with evidence after reading through the
target result. An author cannot verify its own result. The human can use
**Review Result** in the conversation to append the same kind of record without
starting or authenticating an agent turn.

Verification state is derived from the complete immutable history rather than
stored separately. The latest human verdict is authoritative. Without a human
verdict, any peer rejection wins conservatively over peer verification; absent
either, the result remains pending. A verdict reviews the stated result and
evidence only: it is not patch approval and does not apply, merge, or grant
permission to code.

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

The main room surface has **Coordinator** and **Activity** tabs. Coordinator is
the default after its persistent session resolves and hosts the real Sessions
`ChatView`, preserving standard chat rendering, input, keyboard behavior, and
accessibility. Activity owns the virtualized shared worker log and its direct
`@worker` composer. Direct Activity guidance bypasses the coordinator. Its
badge counts unread meaningful assignments, findings, artifacts, results, and
verifications rather than routine chatter.

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
classes, so it reads as that input rather than a second kind of composer: a short
mention affordance instead of prose, and one round icon Send rather than labelled
buttons. Neither the room nor the
panel writes pixel sizes into its own layout: both fill their host through CSS,
because measuring and writing back left content larger than its container
whenever the surface resized without a fresh layout pass.

The room still owns that DOM and publishes it through the collaboration
view-state service; the side-panel pane only adopts it while a room is open, and
hands it back on dispose. Inside, the tab strip alone is pinned at the top, above
an independently scrolling body.

There are four tabs, whatever the room's size: **Run** holds the run actions,
offering only the actions the current state allows — Start before a run, Pause
and Stop All during one — rather than showing every
action and disabling most of them; **Agents** lists every peer;
**Rules** shows the room's brief as labelled fields alongside the shared
configuration; **Approvals** holds workspace trust and pending decisions. Giving
each member its own tab made the strip grow with the room until it scrolled, so
members are a list inside one tab instead. The strip is a real tablist with
roving focus and arrow, Home and End navigation; pending approvals and member
failures are badged so an inactive tab still reports that it needs attention. It
carries the shared modern editor-tab classes that the Agents window composite bar
also adopts, so room tabs match the rest of the window rather than inventing
their own appearance, and each is sized to its label so a word is never clipped
down the middle. Opening a room also widens the side panel if it sits below the
width those tabs need: a session's Changes and Files read fine in a narrow panel,
the room's settings do not.

The Agents panel shows coordinator model and state separately above the worker
roster and never numbers it as a worker. A member's row shows its model, state,
and actual runtime activity;
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

Keyboard users can navigate Coordinator and Activity, the roster, messages and
composer, mention or reply to members, open their sessions and use run controls.
Accessibility Help explains the coordinator's authority and direct Activity
routing. Accessible View presents deterministic coordinator state with evidence
IDs followed by shared Activity as plain text; it does not duplicate the
standard coordinator chat transcript.
The collaboration verbosity setting controls the help hint. Important targeted
updates may be announced, but do not announce every tool delta or duplicate
existing approval signals.

Preserve focus and scroll position while work arrives. Follow new messages only
when already at the latest message; otherwise expose a new-messages indicator.
Background activity must not switch the selected room/member/workspace.

## Architecture boundaries

- Host-side room contracts, persistence, worker tools and execution remain in
  `vs/platform/agentHost`. This includes coordinator identity, event admission,
  deterministic projection, restricted tools, assignments, and chat
  contributions.
- The renderer consumes a provider-independent observable collaboration facade
  in `vs/sessions/services/collaboration`.
- Concrete room UI lives in `vs/sessions/contrib/collaboration`.
- `ICustomViewService` hosts the room as a native full-surface custom view.
  The Agent Collab sidebar shortcut opens that view without changing the
  Sessions Part or taking ownership of its active session.
- The view owns its internal split layout. Its conversation uses the existing
  virtualized list infrastructure; the renderer facade owns continuous history
  loading, merge/deduplication, and cancellation when the room or host changes.
- The coordinator surface resolves its room-owned session and chat through the
  local Agent Host provider, then embeds the Sessions-owned `ChatView` factory.
  Worker Activity remains a room journal rather than a synthetic chat model.
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
explicit artifact sharing. Coordinator coverage additionally includes migration,
model persistence, deterministic projection, assignment delivery, event
coalescing, tool denial, trust scope, standard-chat binding, fallback behavior,
and worker progress during coordinator failure. Browser tests and themed
fixtures cover the real room component, not an imitation.

Live concurrency depends on account limits, model availability and resources.
Controlled tests prove the local scheduling contract; paid live runs require
separate authorization and must report the versions and limits actually tested.
