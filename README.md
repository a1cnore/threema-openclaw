# threema-openclaw

Threema channel plugin for OpenClaw with a focus on high-quality chat UX:

- Edit-in-place group replies (stream-like updates via `GROUP_EDIT_MESSAGE`)
- Slash-style group session creation via `/group`
- Media + voice memo support in both DMs and groups

## Current Snapshot

This repository currently provides:

- Threema multi-device linking (`link-device`) and mediator connectivity
- Direct and group text send/receive
- Group reply evolution with optional partial streaming edits
- Direct and group media send/receive (image/audio)
- Voice memo reply synthesis (agent output -> outbound audio memo)
- Inbound audio transcription (voice memo -> transcript in context)
- Emoji reactions (apply/withdraw, direct + group)
- Typing indicator send/receive handling
- OpenClaw agent tools for group creation, media send, and reactions

## Quick Start

### 1) Clone and install

```bash
git clone https://github.com/a1cnore/threema-openclaw.git
cd threema-openclaw
npm install
```

### 2) Install plugin into OpenClaw

```bash
openclaw plugins install . --link
openclaw plugins enable threema-openclaw
```

If your gateway is already running, restart it so the plugin loads.

### 3) Link a Threema device

```bash
export THREEMA_DIR="$HOME/.openclaw/channels/threema/default"
mkdir -p "$THREEMA_DIR"
npx threema-openclaw link-device --data-dir "$THREEMA_DIR"
```

This writes:

- `identity.json`
- `contacts.json`
- `groups.json` (if groups exist)

### 4) Configure account paths

```bash
openclaw config set channels.threema.accounts.default.identityFile "$THREEMA_DIR/identity.json"
openclaw config set channels.threema.accounts.default.dataDir "$THREEMA_DIR"
```

### 5) Verify load status

```bash
openclaw plugins doctor
openclaw plugins info threema-openclaw
```

## Nifty Features

### 1) Stream-like group replies via message edits

When enabled, group replies are sent as an anchor message and then updated in-place via `GROUP_EDIT_MESSAGE`.

- Better group readability (one evolving message instead of many fragments)
- Optional partial streaming updates while model output is still arriving

Enable at channel level:

```bash
openclaw config set --json channels.threema.features.groupEvolvingReplies '{"enabled": true, "partialStreaming": {"enabled": true, "minIntervalMs": 120, "minCharsDelta": 1}}'
```

Per-account override (optional):

- `channels.threema.accounts.<accountId>.features.groupEvolvingReplies.enabled`
- `channels.threema.accounts.<accountId>.features.groupEvolvingReplies.partialStreaming.*`

### 2) Slash command style group creation with `/group`

Send this in chat:

```text
/group Product Sync
```

Behavior:

- Creates a real Threema group session with the current contact
- Posts a bootstrap message in the new group
- Returns the canonical chat id (for example `threema:group:CREATOR/GROUP_ID`)

### 3) Media and voice memos in DMs and groups

Outbound:

- Image/audio send for direct and group chats
- Voice memo replies generated from model output
- Optional `MEDIA:` directive from text replies, e.g. `MEDIA: /absolute/path/file.jpg`

Inbound:

- Auto-download/decrypt media
- Persist files under `<dataDir>/media/inbound/<sender>/...`
- Optional audio transcription injected into context

### 4) Reactions and typing

- Emoji reactions: apply/withdraw in direct and group chats
- Legacy receipt mapping handled where needed
- Typing indicators are emitted and consumed

### 5) Replay and reflection safety guards

Defaults are now conservative to avoid replay-triggered reply loops:

- `processReflectedOutgoing.enabled` defaults to `false`
- `startupReplayGuard.enabled` defaults to `true`
- inbound forwarding is delayed until `ReflectionQueueDry` (or warmup timeout)

Enable reflected outgoing processing only for explicit chats:

```bash
openclaw config set --json channels.threema.features.processReflectedOutgoing '{"enabled": true, "allowedChatIds": ["threema:group:ABCD1234/1234567890"]}'
```

Tune startup replay guard:

```bash
openclaw config set --json channels.threema.features.startupReplayGuard '{"enabled": true, "requireReflectionQueueDry": true, "maxWarmupMs": 120000}'
```

## Chat Target Formats

Direct:

- `ABCD1234`
- `threema:ABCD1234`

Group:

- `threema:group:<CREATOR>/<GROUP_ID>`
- `group:<CREATOR>/<GROUP_ID>`
- `threema:g-group-<creator>-<groupId>`
- `g-group-<creator>-<groupId>`

## OpenClaw Agent Tools

The plugin exposes:

- `threema_create_group`
- `threema_send_media`
- `threema_react_to_message`

## CLI Commands

From this repo (after `npm install`):

```bash
npx threema-openclaw <command>
```

Supported commands:

- `link-device [--data-dir <path>]`
- `connect-mediator [--data-dir <path>]`

`--data-dir` sets `THREEMA_DATA_DIR` for the command.

## Useful Runtime Toggles

Media:

- `THREEMA_MEDIA_AUTO_DOWNLOAD` (`1`/`0`, default `1`)
- `THREEMA_MEDIA_DOWNLOAD_MAX_BYTES`

Transcription:

- `THREEMA_TRANSCRIBE_AUDIO` (`1`/`0`, default `1`)
- `THREEMA_TRANSCRIBE_MAX_BYTES`
- `OPENAI_API_KEY` (required for OpenAI transcription)

Voice replies:

- `THREEMA_VOICE_REPLY_ENABLED` (`1`/`0`, default `1`)
- `THREEMA_VOICE_REPLY_AUTO_ON_REQUEST` (`1`/`0`, default `1`)
- `THREEMA_VOICE_REPLY_SEND_TEXT_ALSO` (`1`/`0`, default `0`)
- `THREEMA_AUDIO_FORCE_M4A` (`1`/`0`, default `1`)

## Data and Security

Your configured `dataDir` contains secrets and message artifacts.

Sensitive files include:

- `identity.json` (client keys/device secrets)
- media/transcript artifacts under `media/`

Do not commit these files. See `SECURITY.md`.

## Encryption and Security Model

This section is a high-level technical map. The full auditor-oriented document is
`SECURITY.md`.

### Runtime crypto planes

- D2M reflection plane:
  reflected envelopes are encrypted with a device-group-derived key (`dgrk`)
  using XSalsa20-Poly1305 in nonce-ahead format (`nonce || ciphertext`).
- CSP proxy/transport plane:
  CSP frames are encrypted with a transport key derived during CSP handshake;
  nonces are `cookie(16) || sequence_u64_le`.
- E2E message plane:
  message bodies are encrypted per recipient using NaCl-style shared keys
  (`X25519 + HSalsa20` precomputation) and XSalsa20-Poly1305.
- E2E metadata plane:
  metadata containers are encrypted with a separate key derivation
  (`salt='mm'`, personal `3ma-csp`).
- Media/blob plane:
  media bytes are encrypted client-side with a random 32-byte blob key before
  upload; blob key distribution happens inside E2E-encrypted message payloads.

### Primary long-term secrets

- `identity.json` stores:
  - `clientKey` (identity private key),
  - `deviceGroupKey` (root for D2M keys),
  - `deviceCookie`.

Compromise of these values can allow impersonation and/or decryption of protected
traffic for linked-device flows.

### Review posture

- This repository does not claim an independent cryptographic audit.
- Security claims should be interpreted with the threat model in `SECURITY.md`.
- `SECURITY.md` includes a claim-to-code verification matrix for reviewers.

## Development and Validation

Current focused checks:

```bash
npm run test:reflected-ack
```

Live/manual flows (requires linked account + connectivity):

- Set `TEST_TARGET_ID` for recipient-targeted runs (for example `TEST_TARGET_ID=YOURID01 npm run test-send`)
- Run all integration scripts in sequence: `npm run test:integration`
- `npm run connect-mediator`
- `npm run test-send`
- `npm run test-send-media`
- `npm run test-group-media`
- `npm run test-send-to-group` (requires `TEST_GROUP_CREATOR` + `TEST_GROUP_ID`)
- `npm run test-group-e2e`
- `npm run test-group-evolving`
- `npm run test-reactions`

## Troubleshooting

### Plugin not loading

```bash
openclaw plugins doctor
openclaw plugins info threema-openclaw
```

### Group sends wait for leader/CSP

For strict CSP paths (group create/edit/media), leadership matters. If needed, temporarily close Threema on phone so this linked device can become leader.

### Missing identity

Run linking again:

```bash
npx threema-openclaw link-device --data-dir "$THREEMA_DIR"
```

### Large reflection replay or slot mismatch (`4115`)

If logs show very large `queueLen` plus repeated `Device slot state mismatch`:

1. Stop the gateway.
2. Ensure this Mac uses its own linked `identity.json` (do not share another device's file).
3. Relink this Mac and keep `identityFile`/`dataDir` consistent.
4. Start again and wait for `Reflection queue dry` before testing automation flows.
