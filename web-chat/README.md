# OE DESK public chat

The GitHub Pages artifact is built from `web-chat/public`. The browser page sends
only the question and the last eight turns to the server-side `/api/chat`
endpoint. API credentials never belong in this directory.

The server URL is configured in `public/chat-config.js`. The default backend
is the OE DESK Chat API site. This URL is public configuration, not a secret.
