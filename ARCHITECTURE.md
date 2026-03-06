# Ramclouds Cursor Proxy — Architecture

## Tổng quan

Reverse proxy chạy local, đứng giữa Cursor IDE và Ramclouds API.
Nhận request OpenAI Chat Completions format, routing đến provider phù hợp (Claude hoặc OpenAI).

## Cấu trúc thư mục

```
main.cjs                              ← Entry point (~85 lines): Express + route dispatch
lib/
  config.js                           ← Configuration (env, model-map, URLs)
  router.js                           ← Model routing (resolveModel, isAnthropicModel)
  helpers.js                          ← Shared utils (hash, merge, trim, inject)
  session.js                          ← Session cache (get/set/merge/commit)
  handlers/
    claude-handler.js                 ← Claude: OpenAI → Claude Messages → SSE → OpenAI
    openai-handler.js                 ← GPT: Chat Completions → Responses API → SSE → Chat
    openai-stream.js                  ← Responses API SSE → Chat Completions SSE
  middleware/
    session-merge.js                  ← OpenAI-format session merge (overlap + tool pairing)
    token-guard.js                    ← Token limits + summarization trigger
  openai_to_claude.js                 ← OpenAI → Claude format conversion
  claude_sse_to_openai.js             ← Claude SSE → OpenAI SSE translation
  message-converter.js                ← Chat ↔ Responses API format conversion
  tool-enricher.js                    ← Schema enrichment, unwrap, client-side detection
  tools.js                            ← Tool normalization + trim
  token.js                            ← Token estimation
  summarize.js                        ← Context summarization
  sanitize.js                         ← System prompt cleanup
  http.js                             ← HTTP fetch utilities
  images.js                           ← Cursor image_files → Claude base64
```

## Request Flow

```
POST /v1/chat/completions
  │
  ├─ router.resolveModel(model)
  │    → resolved model name
  │
  ├─ router.isAnthropicModel(resolved)?
  │    YES → claude-handler.handleClaude()
  │    NO  → openai-handler.handleOpenAI()
  │
  ├─ Claude path:
  │    openaiToClaudeRequest() → session merge → token guard
  │    → summarize? → fetchJson() → translateClaudeSSEToOpenAI()
  │    → commitAssistantTurn()
  │
  └─ OpenAI path:
       normalize → session merge → token guard → summarize?
       → chatCompletionsToResponsesInput() → enrichTools()
       → fetch Responses API → streamResponsesAPIToChat()
       → commitAssistantTurn()
```

## Thêm provider mới

1. `lib/handlers/<provider>-handler.js` — implement handler
2. `lib/router.js` — thêm `is<Provider>Model()` detection
3. `main.cjs` — thêm `else if` trong route dispatch

## Module Dependencies

```
main.cjs
  ├─ lib/config.js
  ├─ lib/router.js
  ├─ lib/session.js
  ├─ lib/handlers/claude-handler.js
  │    ├─ lib/helpers.js
  │    ├─ lib/openai_to_claude.js → lib/images.js
  │    ├─ lib/claude_sse_to_openai.js
  │    ├─ lib/sanitize.js
  │    ├─ lib/tools.js
  │    ├─ lib/token.js
  │    ├─ lib/http.js
  │    ├─ lib/summarize.js → lib/sanitize.js
  │    └─ lib/middleware/token-guard.js
  └─ lib/handlers/openai-handler.js
       ├─ lib/message-converter.js
       ├─ lib/tool-enricher.js
       ├─ lib/tools.js
       ├─ lib/handlers/openai-stream.js → lib/tool-enricher.js
       ├─ lib/middleware/session-merge.js → lib/tool-enricher.js
       └─ lib/middleware/token-guard.js
```

## Bugs đã fix (context cho refactor)

1. **hasOwnProperty** cho pendingFcItems lookup (index 0 falsy bug)
2. **arguments.done backfill** — done event là authoritative source cho full args
3. **ApplyPatch unwrap** — `{patch:"..."}` → raw string cho Cursor
4. **custom_tool_call convert** — Cursor sends as user message JSON
5. **CLIENT_SIDE_TOOLS** — ApplyPatch, CreatePlan, Task → synthetic results
6. **Trailing user messages** — preserve after tool result merge
7. **Original params restore** — normalizeOpenAITools strips schemas
