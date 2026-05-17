# Bridge UI Surfaces

Bridge UI surfaces are the stable way for the bridge to show new provider or harness details in the mobile app without adding provider-specific React Native screens.

Use this contract when a provider adds a new workflow concept, status object, or action prompt that can be represented with existing primitives. Examples include Codex goals, quota warnings, compaction notices, model-switch suggestions, background task status, and provider-specific warnings.

Do not send arbitrary HTML, JavaScript, React component names, or provider-native payloads to mobile. The bridge owns provider-specific translation. Mobile owns rendering these safe primitives.

## Notifications

The bridge broadcasts surfaces over the existing JSON-RPC notification stream:

- `bridge/ui.present`: show a new surface.
- `bridge/ui.update`: replace an existing surface with the same `id`.
- `bridge/ui.dismiss`: remove a surface.
- `bridge/ui.resolved`: emitted after mobile resolves an action.

Notifications are replayable through `bridge/events/replay` like other bridge notifications.

## Bridge RPC Methods

The bridge also exposes RPC helpers. These are useful for bridge-internal adapters, tests, and future provider integrations:

- `bridge/ui/present`
- `bridge/ui/update`
- `bridge/ui/dismiss`
- `bridge/ui/resolve`

`bridge/ui/present` and `bridge/ui/update` accept a full `BridgeUiSurface`. `bridge/ui/dismiss` accepts `{ "id": "...", "threadId": "..." }`. `bridge/ui/resolve` accepts `{ "id": "...", "threadId": "...", "turnId": "...", "actionId": "..." }`.

## Surface Schema

```ts
type BridgeUiSurface = {
  id: string;
  threadId: string;
  turnId?: string | null;
  kind?: string | null;
  presentation: 'workflowCard' | 'modal' | 'banner';
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  title: string;
  subtitle?: string | null;
  bodyMarkdown?: string | null;
  blocks?: BridgeUiBlock[];
  actions?: BridgeUiAction[];
  dismissible?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};
```

Supported block primitives:

```ts
type BridgeUiBlock =
  | { type: 'text'; text: string }
  | { type: 'markdown'; markdown: string }
  | {
      type: 'checklist';
      items: Array<{
        label: string;
        status?: 'pending' | 'inProgress' | 'completed';
        detail?: string;
      }>;
    }
  | {
      type: 'keyValue';
      items: Array<{ label: string; value: string }>;
    }
  | { type: 'code'; text: string; language?: string | null }
  | {
      type: 'progress';
      label: string;
      value: number;
      max: number;
      detail?: string | null;
    };
```

Supported actions:

```ts
type BridgeUiAction = {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'destructive';
  dismissesSurface?: boolean;
};
```

## Presentation Guidance

- Use `workflowCard` for turn-scoped details that should sit near the existing plan card.
- Use `modal` for blocking or user-decision details.
- Use `banner` for compact warnings or status updates near the composer.
- Keep `title` short and user-facing.
- Put provider-specific raw data in `code` only when it helps the user act.
- Keep `kind` stable for semantic grouping, for example `goal`, `quota`, `compaction`, or `provider-warning`.

## Codex Goal Example

Codex writes goal tool results as `function_call_output` rollout items. The Rust bridge maps any output with a top-level `goal` object into a generic UI surface with `kind: "goal"` and `presentation: "workflowCard"`. That means a real `create_goal`, `get_goal`, or `update_goal` call can show on mobile without adding a goal-specific React Native component.

The bridge uses a stable surface id per Codex thread:

```text
goal-codex:<thread-id>
```

Repeated goal updates should broadcast `bridge/ui.update` with the same id so mobile replaces the current goal card.

The normalized card shape is:

```json
{
  "id": "goal-codex:019e2a-thread",
  "threadId": "codex:019e2a-thread",
  "turnId": null,
  "kind": "goal",
  "presentation": "workflowCard",
  "tone": "info",
  "title": "Goal",
  "subtitle": "Active",
  "bodyMarkdown": "Implement generic bridge-driven UI surfaces.",
  "blocks": [
    {
      "type": "keyValue",
      "items": [
        { "label": "Status", "value": "Active" },
        { "label": "Tokens used", "value": "4200" },
        { "label": "Time used", "value": "12m 4s" },
        { "label": "Remaining tokens", "value": "7800" }
      ]
    },
    {
      "type": "markdown",
      "markdown": "Completion budget report text, when Codex includes it."
    }
  ],
  "actions": [
    {
      "id": "dismiss",
      "label": "Dismiss",
      "style": "secondary",
      "dismissesSurface": true
    }
  ],
  "dismissible": true,
  "createdAt": "2026-05-16T00:00:00Z",
  "updatedAt": "2026-05-16T00:05:00Z"
}
```

For a local smoke test of the generic renderer only, open a chat in the mobile app and run:

```bash
npm run bridge:ui:demo
```

That sends a sample `goal` workflow card to the latest chat. Use `npm run bridge:ui:demo -- --modal` or `npm run bridge:ui:demo -- --banner` to test the other presentations. Use `npm run bridge:ui:demo -- --thread <thread-id>` when the latest chat is not the one visible on the phone.

## Rules For Future Integrations

- Add provider-specific parsing in the bridge adapter, not in mobile UI.
- Map provider-specific terms into the stable block primitives above.
- Do not add new block types unless the existing primitives cannot represent the workflow.
- Keep action IDs stable because mobile sends them back through `bridge/ui/resolve`.
- Include `threadId`; the mobile app scopes surfaces to the active chat.
- Include `turnId` when the surface belongs to a specific turn.
