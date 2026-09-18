<!--
Copyright (c) Microsoft Corporation. All rights reserved.
Licensed under the MIT License. See License.txt in the project root for license information.
-->

# Test App in the Agents Window

## Purpose and scope

**Test App** is a contextual action above the Agents Window chat input. It asks the agent to verify the UI of the application it has built or changed, using the original requirements and implementation diffs as the starting point.

The intended workflow is:

```text
Implement an app change
        |
        v
Finish the agent turn
        |
        v
Offer Test App when the changes look UI-related
        |
        +-- Test App ------------> Ask the current agent to verify the UI
        |
        +-- Test with Subagent --> Ask it to delegate independent verification
                                      |
                                      v
                        Inspect requirements and changes
                                      |
                                      v
                        Launch and exercise the actual UI
                                      |
                                      v
                        Fix reproduced issues and retest
```

This document describes the implementation in this branch. It is a feature guide, not a new Sessions architecture specification. The implementation and committed tests remain the source of truth.

### What the feature is

- A small, provider-neutral UI component owned by the Agents Window.
- An inexpensive heuristic for recognizing likely UI changes.
- A shortcut that submits an explicit testing request into the owning chat.
- A one-off option to request a fresh testing subagent.
- An integration with existing chat, permissions, browser tools, and project tooling.

### What the feature is not

- A deterministic test runner or a guarantee that tests will pass.
- A new Playwright, computer-use, simulator, or desktop-automation engine.
- A semantic classifier that can reliably distinguish every UI app from every CLI or library.
- An automatic test run after every implementation turn.
- A separate command in the response footer or the regular editor's chat view.
- A persisted testing mode, new configuration setting, or remembered dropdown choice.
- A structured testing-results database or a test-coverage tracker.

There is no `suggest_app_test` language-model tool, agent-host protocol extension, or mandatory agent-generated eligibility signal. The button does not need the agent to remember to suggest testing.

## User experience

### Placement and appearance

The control appears at the right of the status row above the chat input, beside the existing Files, Artifacts, and References pills:

```text
[Files] [Artifacts] [References]             [Play Test App | v]
                                           +--------------------+
                                           | Test with Subagent |
                                           +--------------------+
+---------------------------------------------------------------+
| Chat input                                                    |
+---------------------------------------------------------------+
```

The primary action uses the standard themed button background and foreground. It is blue in the default themes, rather than a hardcoded blue that overrides custom or high-contrast themes. The play icon, compact sizing, separator, arrow, and dropdown behavior reuse the existing button primitives.

The status pills retain their existing implementation and scrolling behavior. A flex wrapper lets them occupy the remaining space while keeping the testing control right-aligned. The layout stays within the existing status-row height allocation; it does not add another composer row.

### Primary action: Test App

Activating the primary button submits the shared testing prompt into the same chat. It asks the current agent to:

1. Review the original requirements and relevant implementation diffs.
2. Identify affected behavior and regression risks.
3. Determine the actual application target from project instructions and configuration.
4. Launch and interact with the UI using suitable available tools.
5. Check requested features, user flows, edge cases, and runtime errors.
6. Fix issues uncovered by testing and rerun the affected flows.

The primary action does not add an instruction to delegate. It does not, however, prohibit the agent's normal orchestration choices.

### Secondary action: Test with Subagent

Opening the arrow menu reveals **Test with Subagent**. Selecting it immediately submits a testing request; it does not toggle a persistent preference.

The request contains the same shared prompt plus a delegation instruction. The main agent is asked to give a testing-capable subagent the original requirements, relevant changes, and project instructions, and to have it verify behavior independently.

The primary button remains **Test App** after this action. A later primary click does not retain the delegation instruction.

If a suitable subagent cannot be used, the prompt explicitly asks the main agent to tell the user:

> SORRY NO SUBAGENTS I WILL DO IT

It then asks the main agent to perform the same verification itself.

This fallback is an instruction to the model, not an enforced UI notification. The component does not negotiate subagent capabilities, launch a particular subagent API, choose another model, or verify that delegation actually occurred.

## Exactly when the button appears

Eligibility has two parts: the chat must be in a usable state, and the latest response must contain changes that look UI-related.

### Chat and response gates

All of the following must be true:

| Gate | Reason |
|---|---|
| The latest request has a response | There must be an implementation turn to inspect. |
| The response is no longer incomplete and has state `Complete` | Do not offer testing during generation or on cancelled turns. |
| The response has no error details | Do not treat a failed response as a completed implementation. |
| The response is not marked for removal on send | Do not act on an invalidated response. |
| The response is not blocked or hidden from the transcript | Do not offer an action on unavailable content. |
| The displayed chat is fully interactive | Read-only or non-interactive chat views must not submit requests. |
| The chat model is not read-only | Preserve the model's write restrictions. |
| No request is in progress | Avoid starting a competing turn. |
| This component is not already submitting | Prevent duplicate submissions. |
| The current chat mode is Agent | The action needs an agent-capable interaction. |
| AI features are not hidden by entitlement sentiment | Do not surface the feature when AI is hidden. |
| At least one supplied change qualifies | Avoid offering UI testing for ordinary non-UI work. |

The host `ChatView` supplies the interactivity observable. It requires the transcript not to be loading, the widget model's session resource to match the viewed chat resource, and the matching chat to have `ChatInteractivity.Full`.

There is **no minimum file count**. A single qualifying change is sufficient. The "12 Files" label used in the fixture is example content, not a threshold.

### Which changes are inspected

The component looks at the latest request's response, not all changes accumulated across the session.

It obtains that response's change observable from:

1. `IChatResponseFileChangesService.getChangesForRequest(sessionResource, requestId)`.
2. If that service cannot supply a result, the response's editing session through `getDiffsForFilesInRequest(requestId)`.

An authoritative empty change list is not replaced with older edits. If neither source can provide changes, detection receives an empty list and the action remains hidden.

This reuses the per-response change source used by the chat's change-summary infrastructure. The button does not run Git, inspect arbitrary workspace modifications, or obtain diffs by parsing the agent's answer.

### Common filtering

Before matching a UI filename, detection:

- Ignores entries marked identical.
- Ignores entries marked deleted.
- Uses a path relative to the session working directory where possible.
- Falls back to the modified URI's basename when no relative path is available.
- Excludes the directory segments `test`, `tests`, `__tests__`, `__fixtures__`, `fixtures`, `docs`, and `documentation`.
- Excludes filenames ending in `.test.<extension>`, `.spec.<extension>`, or `.stories.<extension>`.

Matching is case-insensitive. Using a project-relative path avoids accidentally excluding every source file when the project directory itself is named `test`.

Deletion-only turns do not offer the button, even though removing UI code can require verification. The prompt's instruction to review deleted files applies once a testing request has started; it does not change this eligibility filter.

### Fast path: UI filenames

No manifest reads are needed if a remaining path matches one of these categories:

| Category | Recognized extensions or patterns |
|---|---|
| Web markup and components | `.htm`, `.html`, `.xhtml`, `.jsx`, `.tsx`, `.vue`, `.svelte`, `.astro` |
| Styles | `.css`, `.scss`, `.sass`, `.less` |
| Native or desktop UI-associated files | `.swift`, `.xaml`, `.axaml`, `.qml`, `.ui`, `.storyboard`, `.xib`, `.fxml` |
| Conventional source names | Basename `App`, or a stem ending in `view`, `screen`, `window`, `page`, `component`, `widget`, or `viewcontroller` |

For the conventional-name category, supported extensions are JavaScript/TypeScript, including `.mjs`, `.cjs`, `.mts`, and `.cts`, plus `.kt`, `.java`, `.cs`, `.dart`, `.m`, and `.mm`.

These are literal filename heuristics, not language or framework analysis. For example, `review.ts` ends in `view` and currently matches. All Swift source also matches, including a Swift CLI.

The fast path does not require a qualifying modified URI to be inside the working directory. It trusts the supplied per-response changes. The project-manifest fallback below does apply a working-directory containment check.

### Fallback: lightweight project configuration

If no UI filename matched, the component can recognize ordinary source filenames in a known UI project.

This requires a session working directory. Only remaining changes inside that directory participate. There is no recursive repository scan, ancestor walk, nearest-package search, or model request.

#### JavaScript and TypeScript

For changes ending in `.js`, `.ts`, `.mjs`, `.cjs`, `.mts`, or `.cts`, read `package.json` at the session working-directory root.

The file must parse as a JSON object. Either `dependencies` or `devDependencies` must contain a string-valued entry for at least one of:

```text
react
react-native
expo
next
vue
nuxt
svelte
astro
@angular/core
electron
```

Examples:

- A changed `src/index.ts` with a root React Native dependency qualifies.
- A changed `main.js` with Electron in root `devDependencies` qualifies.
- A changed `server.ts` with only Express does not qualify through this fallback.

The implementation does not inspect package scripts or prove that the changed source contributes to a UI. A React development dependency can therefore make a CLI source change qualify.

#### Dart and Flutter

For `.dart` changes, read `pubspec.yaml` at the session working-directory root using the existing YAML parser.

The required structure is:

```yaml
dependencies:
  flutter:
    sdk: flutter
```

The lookup follows the actual YAML nodes `dependencies` -> `flutter` -> `sdk`. It does not search for the word "flutter" anywhere in the file. Flow-style mappings and quoted scalar values are supported by the existing parser.

A Flutter `lib/main.dart` change qualifies; a Dart CLI with an `args` dependency alone does not. A description block containing example Flutter text is not sufficient.

#### Read and parse failures

- A missing manifest is an expected negative signal.
- Unexpected file access failures, invalid JSON objects, or YAML parse errors are logged with the `Test App: unable to read UI project configuration` warning.
- A failed candidate does not make the UI claim that detection or testing succeeded.
- File access uses `IFileService` and URIs rather than local-only filesystem APIs, allowing providers to service remote resources.

There is no persistent eligibility cache or file watcher. Manifest results are associated with the reactive evaluation that requested them. A configuration-only edit is not itself a qualifying JS/TS/Dart source change.

### Typical outcomes

These examples assume the chat/response gates are satisfied:

| Changes and project | Offered? | Explanation |
|---|---|---|
| `index.html` | Yes | UI-extension fast path. |
| `App.tsx` | Yes | UI-extension fast path. |
| `styles.css` | Yes | UI-extension fast path. |
| `src/index.ts` with root React Native dependency | Yes | Manifest fallback. |
| `lib/main.dart` with root Flutter SDK dependency | Yes | Manifest fallback. |
| `count_words.py` | No | No Python UI inference. |
| `server.ts` in an Express-only project | No | No recognized UI project hint. |
| `docs/index.html` | No | Excluded path. |
| `tests/App.tsx` | No | Excluded path. |
| `Button.stories.tsx` | No | Excluded filename. |
| Only unchanged or deleted entries | No | Filtered before detection. |
| Only root manifest changes | No | No qualifying source file. |
| Nested Flutter project with root working directory and no root manifest | Usually no | No nested manifest search; a UI-associated filename could still qualify. |

## What happens when testing was already performed

The component has no structured knowledge of whether a turn ran tests, which flows were checked, which revision was tested, or whether the agent's testing claims are reliable.

Current behavior is therefore:

| Most recent turn | Button afterward |
|---|---|
| Implements qualifying UI changes without testing | Offered. |
| Implements qualifying UI changes and tests them successfully in the same turn | Still offered. |
| Only tests the app, with no new code changes | Hidden. |
| Only changes excluded test files | Hidden. |
| Testing discovers and fixes a qualifying UI file | Can be offered again after completion. |
| Any next turn is still running | Hidden. |

Disappearance after a no-edit testing turn is a consequence of latest-response-only eligibility. It is **not** a verified "all testing complete" state.

The component does not automatically rerun tests, suppress itself because the agent wrote "tested," rename itself to "Retest," or track earlier implementation turns to keep the action available.

When the user requests testing again, the prompt still asks for actual UI verification. It does not explicitly tell the agent to reuse previous test evidence or concentrate on missing coverage. Consequently, another run may repeat earlier flows. A fresh tester may find additional cases, but broader coverage is not guaranteed.

## How the prompt chooses the testing approach

Framework detection affects whether the control is offered; it does not select a hardcoded execution pipeline. The agent receives one shared prompt and chooses tools from the actual project and target.

| Target | Intended approach |
|---|---|
| HTML, React, or another web application | Launch the web target and exercise browser flows with browser/Playwright tools. |
| React Native iOS/Android application | Use available native, simulator/emulator, or project-specific UI tooling. |
| Flutter web | Exercise the actual web build in a browser. |
| Flutter native mobile or desktop | Use tools suitable for the selected native target. |
| VS Code or another Electron/desktop application | Follow the project's launch and UI automation instructions. |
| Dart CLI or a non-UI library | Not the intended scope of this UI action. |

A browser preview does not verify a native target. A recognized framework does not prove that a simulator, SDK, browser, or automation tool is available.

The implementation neither installs tools nor changes permissions. If the environment cannot support the requested verification, the resulting agent response and normal tool failures must communicate the limitation; the button does not maintain its own per-target readiness state.

## Exact prompts

The strings are localized in [sessionTestAppButton.ts](browser/sessionTestAppButton.ts). The English text below matches the implementation at the time this guide was written.

### Shared prompt

```text
Test the UI of the app built or changed in this chat.

First review the original requirements and the relevant implementation diffs, including added and deleted files. Identify the affected behavior and regression risks. Use the implementation changes in this chat as the scope, not unrelated workspace edits, and do not assume an unstaged git diff contains every change.

Identify the actual app target from the project's instructions and configuration. Launch it and interact with its actual UI. Use browser/Playwright tools for web targets, or available computer-use, native, simulator/emulator, and project-specific UI tools for native or desktop targets. A browser preview does not verify a native target.

Verify the requested features, the affected user flows, and relevant edge cases. Check for visible failures and console/runtime errors where available. Reading the code or running unit tests alone does not count as UI verification.

Fix issues you find, then rerun the affected UI flows to confirm the fixes. Keep changes focused on issues uncovered by testing.
```

### Additional instruction for Test with Subagent

```text
Delegate UI verification to a testing-capable subagent with fresh context where supported. Give it the original requirements, relevant implementation changes, and project instructions; ask it to verify behavior independently rather than rely on the implementation agent's conclusions. Use its reproduced findings to make focused fixes, then delegate verification of the affected flows again.

If using a suitable subagent is not possible, clearly tell the user "SORRY NO SUBAGENTS I WILL DO IT", then perform the same verification yourself.
```

The component joins these localized sections with a blank line. It does not attach an agent-generated suggestion, a computed diff, or a separate machine-readable test plan. The agent must use the chat history and available tools to establish the relevant changes and requirements.

There is no mandatory report schema or screenshot requirement in these prompts. The final response is the agent's normal chat response, not a UI-rendered pass/fail result.

## Submission, permissions, and independence

### Shared submission path

Both actions use the same submission function:

```typescript
widget.acceptInput(prompt, {
	preserveInput: true,
	enableImplicitContext: false
});
```

The widget is the one passed to the component by its owning `ChatView`; the action does not resolve some other globally active chat at click time.

Submission proceeds as follows:

1. Reject the action if the component was disposed or is no longer eligible.
2. Focus the owning chat input.
3. Set the local submission guard, hiding the button and blocking another activation.
4. Build the shared prompt, adding the delegation section only for the menu action.
5. Submit through the existing widget API.
6. Report a rejected/undefined submission result or thrown error through `INotificationService`.
7. Clear the local guard in `finally`.

After a request is admitted, the normal chat request-in-progress state keeps the button hidden. The component does not own the agent turn or cancel it when the view is disposed.

### Preserving the draft

`preserveInput: true` keeps unrelated composer text and attachments in place. The existing [chat widget](../../../workbench/contrib/chat/browser/widget/chatWidget.ts) treats those attachments as belonging to the preserved draft and does not send them with this programmatic query.

`enableImplicitContext: false` also makes the lack of implicit input context explicit. It does not erase conversation history or prevent normal project instructions and tool access.

Existing model, provider, mode, and permission behavior remain under the normal chat pipeline. This action does not elevate tool approvals, automatically approve terminal/browser requests, or switch models.

### What "with subagent" guarantees

The UI guarantees that the selected action submits the additional delegation instruction. It does not guarantee:

- The provider exposes a subagent tool.
- A testing-capable subagent has all required browser/native tools.
- The model follows the delegation request.
- The provider gives the subagent completely isolated context.
- A different model is used.
- The subagent discovers a defect or tests more comprehensively.

Fresh context can reduce anchoring on the builder's conclusions. It does not make a model unbiased. The requested workflow separates verification from implementation: the tester reports reproduced failures, the main agent makes focused fixes, and verification is delegated again where possible.

## Implementation structure

### Files and responsibilities

| File | Responsibility |
|---|---|
| [sessionTestAppButton.ts](browser/sessionTestAppButton.ts) | Eligibility, manifest hints, split button, localized prompts, submission guard, error reporting, and focus entry point. |
| [chatView.ts](browser/chatView.ts) | Instantiates the component, supplies chat interactivity, mounts it beside the pills, combines visibility, and integrates Shift+Tab. |
| [chatView.css](browser/media/chatView.css) | Flex row, right alignment, compact icon styling, and existing composer styling. |
| [sessionChatInputToolbar.ts](browser/sessionChatInputToolbar.ts) | Existing status-pill component; reused rather than replaced. |
| [chatAccessibilityHelp.ts](../../../workbench/contrib/chat/browser/actions/chatAccessibilityHelp.ts) | Adds Agents Window-only help for the button and submenu. |
| [sessionTestAppButton.test.ts](test/browser/sessionTestAppButton.test.ts) | Component tests with a real chat model and controlled file, menu, notification, and widget dependencies. |
| [sessionTestAppButton.fixture.ts](test/browser/sessionTestAppButton.fixture.ts) | Themed composer, narrow, hidden, and open-menu visual fixtures. |
| [chatAccessibilityHelp.test.ts](../../../workbench/contrib/chat/test/browser/accessibility/chatAccessibilityHelp.test.ts) | Ensures the feature's help is scoped to the Agents Window. |

### Existing services and primitives

- `IChatResponseFileChangesService`: provider-neutral per-response edits.
- `IChatEntitlementService`: AI-visibility sentiment.
- `INotificationService`: submission errors.
- `IContextMenuService`: the submenu.
- `IFileService`: URI-based manifest reads.
- `ILogService`: unexpected manifest-read/parse diagnostics.
- `ButtonWithDropdown`: standard split-button, action, focus, menu, and theme behavior.
- `IChatWidget`: the existing request submission path.

All services are declared as constructor dependencies. There is no new service registration or import from a provider implementation. Sessions continues to depend on workbench and lower layers, not the reverse.

### Reactive state and lifecycle

The component observes the widget's model, its latest response, completion state, per-request diffs, interactivity, mode, and entitlement state.

Completion is observed explicitly through `isIncomplete`, because a response can complete without being replaced by a new object. Change-list observables allow file changes that arrive after the response to update eligibility.

The manifest fallback is wrapped in a promise-backed observable. Recomputing eligibility for another response, change list, or chat switches the active dependency to the new evaluation. A previous read can finish, but its old result no longer controls the current UI. Tests cover this behavior after changed files, a new turn, a chat switch, and disposal.

This is not cancellation of the underlying filesystem read. There is no long-lived cache or watcher; independent configuration changes are not actively monitored.

The button, listeners, and autorun are registered for disposal. A previously captured menu action rechecks eligibility and disposal before submission.

## Keyboard access, screen readers, and theming

- **Shift+Tab from the input** reaches Test App when it is visible; otherwise the existing status-pill focus path is used.
- **Enter or Space** activates the focused primary button.
- **Tab from Test App** reaches the arrow, labeled **App Testing Options**.
- **Enter or Space** opens the menu; normal menu keyboard navigation selects **Test with Subagent**.
- **Escape** dismisses the menu using the shared menu implementation.
- If either button half has focus when the component becomes hidden, focus returns to the chat input.
- The play icon is decorative and marked `aria-hidden`; the primary button has the explicit accessible name **Test App**.
- The dropdown primitive supplies expanded/menu semantics rather than custom ad hoc handlers.
- The accessibility-help addition is conditional on `isSessionsWindow`; it does not describe a nonexistent action in ordinary editor chat.
- Styling uses existing button theme tokens and compact icon sizing, with light, dark, and high-contrast fixture coverage.

The feature does not announce "tests passed" itself. Testing results and permission requests use the normal chat and tool surfaces.

## Validation and reproducibility

### Committed unit coverage

The [component suite](test/browser/sessionTestAppButton.test.ts) covers:

- Positive and negative UI-filename examples, including a project directory named `test`.
- Identical, deleted, and empty changes.
- Completion, delayed file changes, next-turn behavior, interactivity, Agent mode, and AI hiding.
- Root React Native/Electron manifests and Flutter block/flow YAML.
- Negative Express-only, Dart CLI, invalid dependency, and YAML-description examples.
- Remote resource URIs.
- Avoiding manifest reads on UI fast paths, excluded paths, outside source files, and busy chats.
- Missing manifests versus logged parse/access failures.
- Stale asynchronous results.
- One-off primary/subagent/primary prompt selection.
- Requirements/diff-first instructions, native-target distinction, and explicit subagent fallback.
- Focus restoration, stale menu actions, and disposal.
- Duplicate-submission protection, draft-preserving options, themed play button, errors, and retries.
- Failed and cancelled responses.

To run the focused suites from the repository root with current build output:

```bash
./scripts/test.sh --reporter dot \
  --run src/vs/sessions/contrib/chat/test/browser/sessionTestAppButton.test.ts \
  --run src/vs/sessions/contrib/chat/test/browser/chatView.test.ts \
  --run src/vs/workbench/contrib/chat/test/browser/accessibility/chatAccessibilityHelp.test.ts
```

Use the repository's normal development build/watch workflow. If output needs refreshing solely for these tests, `npm run transpile-client` is the fast output-only option; it is not a substitute for a type check when types changed.

### Component fixtures

The fixture group is `sessions/testApp/sessionTestAppButton/`:

| Scenario | Themes |
|---|---|
| `AboveComposer` | Dark, Light, DarkHighContrast, LightHighContrast |
| `Narrow` | Dark, Light |
| `SubagentMenu` | Dark, Light, DarkHighContrast, LightHighContrast |
| `Script` | Dark, Light |

The fixture uses the existing chat renderer and status-pill components, plus real context-menu services. Its submit handler writes the chosen prompt into the preview input instead of sending a paid agent request. Fixture success therefore proves rendering and interaction, not actual LLM compliance or application verification.

For setup and rendering commands, use the repository's [component-fixtures skill](../../../../../.github/skills/component-fixtures/SKILL.md). The fixture filter is `sessions/testApp/sessionTestAppButton/`.

### Real-agent validation snapshot

Validation performed on September 17, 2026 used an isolated macOS Code OSS Dev 1.139.0 window with the Copilot agent-host provider. The testing workspace, profile, servers, and automation were disposable; no user project was used.

| Scenario | Observed result |
|---|---|
| Create and CLI-test a Python word counter | Test App did not appear. |
| Create a single-file HTML counter without UI testing | Test App appeared after completion. |
| Click Test App with an unrelated draft present | A real testing turn started, the button hid while busy, and the draft remained intact. |
| Primary testing turn | Agent launched the page, used browser controls and keyboard actions, checked zero/reset behavior, accessibility metadata, responsive layout, and runtime errors. |
| Successful testing-only turn with no edits | Button disappeared despite earlier UI changes. |
| Add an Add 5 control and self-test in the same turn | Agent exercised pointer/keyboard flows and runtime checks; Test App was still offered afterward. |
| Activate Test with Subagent using the keyboard | A genuine fresh-context tester ran, opened a separate browser, and checked desktop and narrow layouts plus the main flows. |

The independent tester used the same model as the parent; a different model was not requested. It checked the updated layout at 1280x720 and 320x568. Neither run reproduced an app defect, so the automatic fix-and-retest path was not exercised against a real failure.

At that validation point:

- The three focused unit suites passed 82 tests.
- Client type checking and targeted lint passed.
- All 12 fixtures rendered without errors.
- An independent checker reran the 11-test component suite and executed three temporary probe tests spanning 36 cases/scenarios.
- Those temporary probes were exploratory validation, not additional committed regression tests.

Evidence limitations:

- One automated mouse menu selection closed without submitting; keyboard selection succeeded. This was not established as a reproducible product defect.
- The Code OSS host emitted browser screenshot-capture and disposable/hover warnings during validation. Browser interaction continued; the sample application's runtime checks reported no errors. This was not a clean host-log run.
- Actual native React Native/Flutter execution was not performed. Unit-level project recognition must not be reported as native UI verification.
- The unavailable-subagent fallback was asserted in the submitted prompt, not forced in a live unsupported-provider run.
- Real validation covered one provider/model combination, not every supported provider.

### Manual validation checklist

1. Use an isolated Agents Window and a disposable workspace.
2. Create a plain CLI script; finish the turn and verify no testing action appears.
3. Create a qualifying UI file; verify the action appears above the input and not in the response footer.
4. Start another turn; verify the action hides while busy.
5. Put unrelated text and attachments in the input, click Test App, and verify the testing request does not consume them.
6. Inspect actual tool calls and interactions, not only the final success statement.
7. Check the button after a no-edit testing turn and after an edit-plus-testing turn.
8. Exercise the arrow with both mouse and keyboard; check submenu naming, focus, Escape, and one-off behavior.
9. Select Test with Subagent; verify actual delegation or an explicit self-testing fallback in the transcript.
10. Check light, dark, high-contrast, and narrow layouts.
11. Close only the test servers/windows and remove their temporary profiles.

## Known limitations and open decisions

### Heuristic false positives

The feature recognizes likely UI work, not only UI work. Examples confirmed by independent probes:

- `review.ts` matches the `view` suffix.
- A CLI's `main.swift` qualifies through its extension.
- A backend `DatabaseView.cs` can qualify through its name.
- A React dependency or development dependency can make backend/CLI JavaScript qualify.

### Incomplete test and generated-output exclusions

The current exclusion list does not include every ecosystem convention. For example, these can qualify:

- React `e2e/login.ts` through a UI-project manifest.
- Flutter `integration_test/app_test.dart` through its root Flutter manifest.
- `coverage/index.html` or `testdata/template.html` through the fast path.

The conventional `tests`/`test`, documentation, fixture, and `.test`/`.spec`/`.stories` examples listed earlier are excluded. Additional exclusions have been identified as follow-up work, not implemented by this document.

### Missed projects and changes

- Nested manifests are not discovered from a repository-root working directory.
- Python UI applications are not inferred from `.py`.
- Some native/UI source naming conventions are not covered.
- Manifest-only and deletion-only changes do not independently qualify.
- Without a working directory, directory exclusions can only use the basename fallback, and project-manifest detection is unavailable.
- The UI-filename fast path can accept supplied changes outside the workspace, unlike the manifest fallback.
- A file or manifest changed outside the observed turn data is not monitored by a dedicated watcher.

### Retesting and coverage

Current visibility does not encode verification status. A no-edit turn can remove access to the contextual button, while a self-tested implementation turn can retain it. There is no persistent evidence tied to a source revision, and the prompt does not explicitly avoid redundant testing.

Possible future improvements, requiring an explicit behavior decision:

1. Keep the action tied to the latest relevant implementation after test-only or discussion turns.
2. Ask the agent to review prior test evidence, confirm it still applies, and prioritize missing coverage and regression risks.
3. Expand conventional test/output exclusions without turning detection into a repository-wide classifier.
4. Improve suffix matching to avoid obvious accidental matches such as `review.ts`.
5. If a guaranteed independent-testing action is ever required, add capability-aware orchestration rather than claiming a prompt alone provides that guarantee.

These are proposals, not current behavior. Maintaining the small implementation means avoiding a new framework registry, model-based eligibility request, or persisted testing-state system unless its product value justifies the extra complexity.

## Troubleshooting

| Symptom | Checks |
|---|---|
| No button after an app was built | Confirm Agents Window, Agent mode, writable/interactive state, successful completion, and qualifying changes on the latest response. |
| Button disappeared after testing | Check whether the last turn made no code changes; this is current latest-response-only behavior, not a coverage result. |
| Button still present after self-testing | Expected if the same completed turn edited a qualifying UI file. |
| Flutter/React Native source is missed | Confirm the session working directory contains the root manifest and a qualifying source file changed. Nested manifests are not searched. |
| Button offered for non-UI or test work | Check filename suffixes, recognized package dependencies, and gaps in the exclusion list. |
| Manifest recognition fails | Inspect logged configuration read/parse warnings and verify the expected JSON/YAML structure. |
| Request does not start | Check standard notifications; the component reports thrown submission failures and undefined submission results. Also check read-only/model-selection/request state in the owning widget. |
| Subagent option runs in the parent | Inspect whether delegation tools were available and whether the requested fallback was announced. This option is best-effort. |
| Agent only reads source or runs unit tests | That does not satisfy the prompt's UI-verification requirement. Inspect tool availability and ask for actual target interaction or an explicit blocker. |
| Updated control not visible in a running dev window | Ensure current build output is loaded. Workbench source changes require reload/restart; a newly introduced CSS dependency can require a full dev-process restart. |
