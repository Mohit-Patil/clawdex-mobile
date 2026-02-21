# Codex-Style UI Redesign

**Date**: 2026-02-21
**Status**: Approved
**Approach**: Full retheme + component extraction (Approach 1)

## Goal

Redesign the mobile chat UI to match the OpenAI Codex aesthetic: flat near-black background, no gradients or frosted glass, terminal-inspired typography, gold/amber accents for tool blocks, clean message layout without bubbles for assistant messages.

## Color Palette

| Token | Value | Usage |
|---|---|---|
| `bg.main` | `#0D0D0D` | Main screen background |
| `bg.sidebar` | `#1A1A1A` | Drawer background |
| `bg.input` | `rgba(255,255,255,0.06)` | Input field background |
| `bg.inputBorder` | `rgba(255,255,255,0.12)` | Input field border |
| `bg.userBubble` | `#1E1E1E` | User message bubble |
| `bg.toolBlock` | `rgba(255,255,255,0.04)` | Tool execution block |
| `accent` | `#C8A946` | Gold/amber for tool borders, status text, inline code |
| `text.primary` | `#E8E8E8` | Main body text |
| `text.secondary` | `#999999` | Muted/secondary text |
| `text.code` | `#D4A843` | Inline code text |
| `border.userBubble` | `rgba(255,255,255,0.1)` | User message border |
| `border.toolBlock` | `#C8A946` | Left border on tool blocks (3px) |

## Message Layout

### Assistant Messages
- No bubble or background
- Text rendered directly on main background
- Markdown via react-native-markdown-display
- Inline code: gold text, dark rounded bg
- Code fences: dark bg, monospace, no syntax highlighting

### User Messages
- Dark pill (`#1E1E1E`), right-aligned
- Rounded corners (16px)
- Monospace font
- Subtle border `rgba(255,255,255,0.1)`

### Tool Execution Blocks
- Gold left border (3px solid `#C8A946`)
- Dark background `rgba(255,255,255,0.04)`
- Folder/terminal icon + truncated command text
- Expandable/collapsible with chevron
- Status: checkmark + timing on success, spinner while running
- Rendered from mac-bridge tool call events

### Status Lines
- Italic amber/gold text
- Detected from `**...**` patterns on their own line in assistant messages

### Typing Indicator
- Three animated dots at bottom of chat when assistant is generating

## Header
- Left: Hamburger menu icon (opens drawer)
- Center-left: Model name (e.g. "Codex") + ">" chevron
- Right: Sparkle/settings icon
- Flat `bg.main` background, no blur

## Input Bar
- Left: "+" circle button (creates new thread)
- Center: Text input, placeholder "Message Codex..."
- Rounded rectangle, subtle border
- Bottom-positioned with keyboard avoidance

## Component Structure

```
src/components/
  ChatMessage.tsx      - single message renderer (user/assistant/system)
  ToolBlock.tsx        - collapsible tool execution block
  StatusLine.tsx       - italic gold status text
  TypingIndicator.tsx  - three-dot animation
  ChatInput.tsx        - bottom input bar with + button
  ChatHeader.tsx       - top header with menu/model/sparkle
```

MainScreen.tsx becomes thin orchestrator wiring components together.

## Files Modified
- `src/theme.ts` - New flat dark palette
- `src/screens/MainScreen.tsx` - Refactored to use extracted components
- `src/navigation/DrawerContent.tsx` - Rethemed to match

## Files Created
- `src/components/ChatMessage.tsx`
- `src/components/ToolBlock.tsx`
- `src/components/StatusLine.tsx`
- `src/components/TypingIndicator.tsx`
- `src/components/ChatInput.tsx`
- `src/components/ChatHeader.tsx`

## Dependencies
No new dependencies needed. Uses existing:
- react-native-markdown-display
- @expo/vector-icons (Ionicons)
- react-native-reanimated (for animations)
