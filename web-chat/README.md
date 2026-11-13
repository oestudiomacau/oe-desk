# OE DESK public chat

The GitHub Pages artifact is built from `web-chat/public`. The browser page sends
only the question and the last 24 messages to the server-side `/api/chat`
endpoint. API credentials never belong in this directory.

The server URL is configured in `public/chat-config.js`. The default backend
is the OE DESK Chat API site. This URL is public configuration, not a secret.

Only `public/` is uploaded to GitHub Pages. The backend is hosted separately
using Sites; its source is in `backend/worker.js`. Its runtime secrets are
`DEEPSEEK_API_KEY` and `CUSTOMER_SERVICE_PROMPT_1` through
`CUSTOMER_SERVICE_PROMPT_8`. The latter are a private snapshot of the operator's
prompt and enabled skills, split to fit the runtime's per-variable size limit.
They are never committed. Desktop prompt changes are not automatically synced.

The public backend does not expose desktop administration, platform accounts,
local message history, private knowledge files or the local RAG API. To publish
verified product knowledge later, add a separate authorized retrieval service.
Order changes, refunds and human transfers must be completed on the purchase
platform; this webpage does not execute these actions.

The API validates origins and limits message length, request size, concurrent
requests and bursts. Its in-isolate rate limits are best-effort across Worker
instances; an account-level provider spending cap is the final cost control.
