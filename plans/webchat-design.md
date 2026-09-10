# Webchat Dashboard Feature — Design Plan

**Date:** 9 Sep 2026
**Status:** Draft
**Scope:** Admin webchat with persistent memory, multiple conversations, inline document sends

---

## 1. Goal

Add a webchat interface to the AskJoe dashboard so Joe (single admin user) can:
- Query the RAG system directly from the browser
- Manage multiple persistent conversations
- Send documents inline from chat responses

No WhatsApp needed — this is a direct admin interface.

---

## 2. Architecture

### Current flow (WhatsApp):
```
WhatsApp → Twilio → askjoe-bridge (Node.js) → rag-api (FastAPI) → vLLM
```

### New flow (Webchat):
```
Browser → askjoe-bridge (Node.js) → rag-api (FastAPI) → vLLM
                      ↓
               chats.json (persistent storage)
```

The browser calls the Node.js bridge directly. The bridge proxies queries to the RAG API and manages chat persistence. This avoids exposing the RAG API key to the browser and keeps auth centralized.

### Why proxy through Node.js instead of calling RAG API directly?
- RAG API key stays server-side (not in localStorage)
- Chat persistence handled by the bridge (single source of truth)
- Existing auth middleware reused
- One fewer CORS concern

---

## 3. Data Model

### `storage/chats.json`

```json
{
  "chats": {
    "chat_1725900000000": {
      "id": "chat_1725900000000",
      "title": "7 Layers of Consulting",
      "created": 1725900000000,
      "updated": 1725900060000,
      "messages": [
        {
          "role": "user",
          "text": "What are the 7 layers?",
          "timestamp": 1725900000000
        },
        {
          "role": "assistant",
          "text": "The 7 layers of consulting high performance are...",
          "sources": ["7 Layers of Consulting High Performance.md"],
          "offer_file": null,
          "timestamp": 1725900001500
        }
      ]
    }
  },
  "meta": {
    "lastId": 1725900000000
  }
}
```

### Chat lifecycle:
- **Create:** `POST /api/chat/new` → returns new chat ID
- **List:** `GET /api/chat/list` → returns all chats (id, title, updated, message count)
- **Load:** `GET /api/chat/:id` → returns full chat with messages
- **Save:** `POST /api/chat/:id/message` → appends message pair (user + assistant), auto-titles from first user message
- **Delete:** `DELETE /api/chat/:id` → removes chat
- **Rename:** `PATCH /api/chat/:id` → updates title

### File structure:
```
askjoe-bridge/
├── src/
│   ├── chatStore.js      (new — CRUD for chats.json)
│   ├── chatRoutes.js     (new — Express routes for chat API)
│   └── server.js         (modified — mount chat routes)
├── storage/
│   └── chats.json        (auto-created on first write)
└── public/
    └── index.html         (modified — add Chat tab)
```

---

## 4. Backend Design

### `chatStore.js` — Simple JSON file store

```js
// Loads/saves storage/chats.json
// Thread-safe: single write lock, atomic writes (write to .tmp then rename)

export function listChats()
export function getChat(id)
export function createChat()
export function appendMessage(chatId, userMsg, assistantMsg)
export function deleteChat(id)
export function renameChat(id, title)
```

Pattern: same as `loadJson`/`saveJson` from `persistence.js` but with atomic writes.

### `chatRoutes.js` — Express routes

```
GET    /api/chat/list          → [{ id, title, updated, count }]
GET    /api/chat/:id           → { id, title, messages: [...] }
POST   /api/chat/new           → { id, title }
POST   /api/chat/:id/message   → { answer, sources, offer_file } (proxies to RAG, saves both)
DELETE /api/chat/:id           → { status: "deleted" }
PATCH  /api/chat/:id           → { status: "renamed" } (body: { title })
POST   /api/chat/send-file     → streams file download (from documents dir)
```

### Message flow (`POST /api/chat/:id/message`):

1. Validate chat exists, extract `question` from body
2. Load chat history (last 20 messages) from `chatStore`
3. Call `queryRag(question, history)` via existing `ragClient.js`
4. Save user message + assistant response to `chatStore`
5. Return response to browser

### File send (`POST /api/chat/send-file`):

1. Validate `filename` in body
2. Resolve path in documents dir (path traversal protection)
3. Stream file as download with correct MIME type
4. Rate-limited (reuse existing rate limiter)

### Auth:
All `/api/chat/*` routes go through existing dashboard auth middleware (Bearer token from `DASHBOARD_API_KEY`).

---

## 5. Frontend Design

### Layout (inside the existing dashboard shell):

```
┌──────────────────────────────────────────────────┐
│ [Sidebar: Status | Allowlist | Files | Chat]     │
├───────────┬──────────────────────────────────────┤
│ Chat List │ Chat Area                            │
│           │ ┌──────────────────────────────────┐ │
│ + New     │ │                                  │ │
│           │ │  [user message]                  │ │
│ Chat 1    │ │       [bot response]             │ │
│ Chat 2    │ │         [source chips]           │ │
│ Chat 3    │ │         [📄 Send document]       │ │
│           │ │  [user message]                  │ │
│           │ │       [bot response]             │ │
│           │ │                                  │ │
│           │ ├──────────────────────────────────┤ │
│           │ │ [input field]           [Send]   │ │
│           │ └──────────────────────────────────┘ │
└───────────┴──────────────────────────────────────┘
```

### Chat list panel (left, ~240px):
- "New Chat" button at top
- List of chats: title + relative time ("2h ago")
- Active chat highlighted
- Hover reveals delete (✕) icon
- Click to switch
- Click title to rename (inline edit)

### Chat area (right):
- Message history scrollable
- User messages: right-aligned, gold-tinted bubble
- Bot messages: left-aligned, dark bubble
- Source chips below bot responses (clickable, show filename)
- "📄 Send document" button when `offer_file` is present
- Typing indicator while waiting for response
- Auto-scroll to bottom on new messages

### Input bar (bottom):
- Text input with placeholder "Ask a question..."
- Send button (or Enter key)
- Disabled while waiting for response
- Shift+Enter for newline (multi-line support)

### Responsive:
- Mobile: chat list becomes a collapsible drawer (hamburger icon)
- Existing responsive breakpoints reused

---

## 6. Styling

Reuse existing CSS variables and design tokens:
- Bubbles use `--surface-card` and `--surface2`
- Active chat uses `--gold` accent
- Source chips use `--border2` with `--gold` text
- Send button matches `--btn-primary` style
- Transitions use existing cubic-bezier curves

No new fonts, no new dependencies. All CSS stays inline in `index.html` (matching existing pattern).

---

## 7. User Experience Details

### Auto-title:
First user message truncated to 40 chars becomes the chat title. User can rename by clicking the title.

### Conversation context:
Last 20 messages sent to RAG API as `conversation_history`. This matches the WhatsApp handler's behavior.

### File send flow:
1. Bot response includes `offer_file` (e.g., `"7 Layers of Consulting High Performance.md"`)
2. Below the response, show button: `📄 Send: 7 Layers...`
3. Click → browser downloads the file via `/api/chat/send-file`
4. Button shows "✓ Sent" briefly after download

### Error states:
- RAG API down → "Service unavailable. Check that rag-api is running."
- Empty response → "No answer generated. Try rephrasing."
- Network error → "Connection lost. Check your network."

### Keyboard shortcuts:
- `Enter` — send message
- `Shift+Enter` — newline in input
- `Escape` — close mobile chat list drawer

---

## 8. Files Changed

| File | Change | Est. Lines |
|------|--------|-----------|
| `src/chatStore.js` | **New** — JSON file CRUD for chats | ~80 |
| `src/chatRoutes.js` | **New** — Express routes for chat API | ~90 |
| `src/server.js` | Mount chat routes, add `send-file` endpoint | ~20 |
| `public/index.html` | Add Chat tab, chat UI, JS logic | ~350 |
| **Total** | | **~540** |

### No new dependencies.

---

## 9. Implementation Order

1. `chatStore.js` — data layer first (testable in isolation)
2. `chatRoutes.js` — API routes (testable with curl)
3. `server.js` — mount routes
4. `index.html` — Chat tab UI + frontend JS
5. Integration test — end-to-end chat flow

---

## 10. What's NOT in scope

- Streaming responses (one-shot for v0)
- User authentication beyond existing dashboard API key
- Chat export/import
- Search within chats
- Chat folders or tags
- Message editing or deletion
- File upload from chat (already in Files tab)
- Dark/light mode toggle

---

## 11. Risks

| Risk | Mitigation |
|------|-----------|
| `chats.json` grows large | Cap at 50 chats, oldest auto-deleted. Messages capped at 20 per chat (already sent to RAG). |
| Concurrent writes | Atomic write (tmp + rename). Single admin = low contention. |
| RAG API latency (~3.5s) | Show typing indicator. No streaming in v0. |
| File path traversal | Reuse existing `sanitizePath()` from server.js |

---

*Design ready for implementation review.*
