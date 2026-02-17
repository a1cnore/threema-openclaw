# Security and Cryptography Notes

Audience: security auditors and cryptography professionals reviewing this repository.

This document describes the current implementation in `threema-openclaw` and maps
security claims to code. It is not a formal protocol specification.

## 1) Security Objectives and Non-Objectives

### Objectives

- Confidentiality and integrity of reflected D2M envelopes between linked devices.
- Confidentiality and integrity of CSP transport frames between this client and the
  chat server (via mediator proxy).
- End-to-end confidentiality and integrity of CSP message bodies to intended
  recipient devices.
- Confidentiality and integrity of media/blob payload bytes at rest on blob
  infrastructure.
- Protection of local long-term secrets (`clientKey`, `deviceGroupKey`,
  `deviceCookie`) from unauthorized access.

### Non-objectives and explicit limits

- No claim of independent third-party cryptographic audit for this codebase.
- No claim of security under full endpoint compromise (malware/root on host).
- No claim beyond the guarantees of upstream Threema protocol semantics and server
  behavior.
- No compatibility guarantee for unused/legacy crypto modules.

## 2) Threat Model and Trust Boundaries

### Trusted for confidentiality

- This linked device process and local OS account context.
- Other linked devices in the same device group holding the device-group key.
- Intended recipient devices holding recipient private keys.

### Not trusted for message plaintext confidentiality

- Mediator infrastructure.
- Blob infrastructure.
- Network path between client and servers.

### Expected visibility by component

- Mediator can observe D2M frame metadata (timing, sizes, frame types) but not
  decrypt reflected envelopes protected by `dgrk`.
- Chat server can process CSP transport payloads but message bodies remain
  E2E-encrypted per recipient.
- Blob servers store encrypted blob bytes and can observe blob IDs and access
  timing/patterns.

## 3) Cryptographic Primitive Inventory

Current runtime paths use the following primitives:

- `X25519` for Diffie-Hellman key agreement.
- `HSalsa20` transform for NaCl precomputation (`naclBoxBeforeNm` style keying).
- `XSalsa20-Poly1305` for authenticated encryption in:
  - reflected envelope protection,
  - CSP transport frame protection,
  - E2E message body protection,
  - E2E metadata container protection,
  - blob payload encryption.
- `BLAKE2b` keyed derivations with protocol-specific salt/personalization values.
- CSPRNG nonces/keys from `randomBytes` (Node.js / noble utility path).

Linking/rendezvous path also uses `ChaCha20-Poly1305` and BLAKE2b-MAC-256
derivation with personalization `"3ma-rendezvous"`.

## 4) Key Hierarchy and Derivation

### Root and persistent secrets (local)

- `clientKey` (32-byte X25519 secret): long-term client identity secret.
- `deviceGroupKey` (`dgk`, 32 bytes): root for multiple D2M subkeys.
- `deviceCookie` (16 bytes): used in CSP extension/login flow.

### Device-group derived keys

From `dgk`, the implementation derives:

- `dgpkSecret` via BLAKE2b keyed derivation (`salt='p'`, personal `"3ma-mdev"`),
  then `dgpkPublic = X25519(dgpkSecret * basepoint)`.
- `dgrk` via `salt='r'`: reflect envelope key.
- `dgdik` via `salt='di'`: encrypted device-info key.
- `dgsddk` via `salt='sdd'`: shared-device-data key.
- `dgtsk` via `salt='ts'`: transaction-scope key.

### CSP handshake/session material

- Client generates ephemeral `tckSecret/tckPublic` and random client cookie `cck`.
- Auth key for initial server challenge response:
  `naclBoxBeforeNm(tckSecret, CHAT_SERVER_KEY)`.
- Session transport key after server hello:
  `naclBoxBeforeNm(tckSecret, tskPublic)`.
- Vouch key and vouch value are BLAKE2b-derived using `ss1 || ss2`,
  `salt='v2'`, personal `"3ma-csp"`.

### Message-level keys

- E2E payload key per recipient:
  `naclBoxBeforeNm(clientSecretKey, recipientPublicKey)`.
- Message metadata key per recipient:
  `blake2b(key=sharedSecret, salt='mm', personal='3ma-csp', dkLen=32)`.
- Blob key: random 32-byte per media message.

## 5) Runtime Encryption Flows

### 5.1 D2M reflection envelope protection

- Outgoing reflected `d2d.Envelope` is encrypted with `dgrk` via
  `secretBoxEncryptWithRandomNonce`, serialized as:
  `nonce(24 bytes) || ciphertext`.
- Incoming reflected envelopes are decrypted with `dgrk` using the same
  nonce-ahead format.

### 5.2 CSP transport protection

- CSP proxy containers are encrypted with `transportKey` via XSalsa20-Poly1305.
- Nonce format is deterministic 24-byte:
  `cookie(16 bytes) || sequenceNumber_u64_le`.
- Separate client/server counters start at `1` and increment monotonically.

### 5.3 End-to-end message payload protection

For outgoing CSP message payloads:

- Message container plaintext:
  `type(1 byte) || paddedBody`.
- Body padding:
  PKCS#7-style pad bytes; random pad length in `1..255` with minimum padded
  total length >= 32 bytes.
- Container encryption:
  XSalsa20-Poly1305 with per-recipient shared key and 24-byte message nonce.

Message-with-metadata payload layout includes:

- sender ID (8)
- receiver ID (8)
- message ID (8)
- created-at seconds (4)
- flags (1)
- reserved (1)
- metadata length (2)
- legacy nickname field (32)
- encrypted metadata container
- message nonce (24)
- encrypted message container

Metadata container is separately encrypted with a different key (`mm` derivation)
but currently reuses the same nonce value used for message-body encryption.
Key separation is relied upon here.

### 5.4 Media/blob protection

- Media bytes are encrypted before upload:
  XSalsa20-Poly1305 with random 32-byte `blobKey`.
- File nonce is fixed constant `BLOB_FILE_NONCE`.
- Thumbnail nonce is fixed constant `BLOB_THUMBNAIL_NONCE`.
- Blob key is transmitted inside E2E-encrypted message payload JSON.
- Blob storage receives ciphertext bytes only.

Security note: fixed nonces are acceptable only because blob keys are generated
fresh per media message. Blob-key reuse with same nonce would be unsafe.

### 5.5 Linking/rendezvous (join phase)

- Rendezvous auth and transport key derivations use BLAKE2b-MAC-256 and X25519
  shared material transformed via HSalsa20.
- Frame encryption in rendezvous flow uses ChaCha20-Poly1305 with nonce format:
  `u32_le(pathId) || u32_le(sequenceNumber) || 0x00000000`.

## 6) Nonce and Replay Considerations

- Reflection envelope nonces are random and prepended to ciphertext.
- CSP transport nonces are deterministic cookie+counter and stateful.
- E2E payload nonces are 24-byte random values (or preallocated values used for
  reflection/CSP parity in group fan-out).
- Blob encryption uses fixed nonces with per-message random blob keys.
- Incoming duplicate suppression is implemented via
  `incoming-message-dedupe.json` keyed by `identity#messageId`. This is an
  application-level dedupe control, not a cryptographic replay proof.

## 7) Security-Critical Failure Behavior

- Decrypt/authentication failures generally drop messages and log diagnostic
  context; malformed payloads are rejected.
- Outgoing CSP sends are tracked with ACK timeouts; failures reject pending
  send promises.
- Reflection ACK timeouts are enforced for reflected envelopes.
- Some operations support reflection-only fallback when CSP leadership/readiness
  is unavailable. In that mode, delivery to remote contacts is delegated to the
  current leader device.

## 8) Secret Handling and Operational Controls

Treat the entire configured `dataDir` as sensitive.

### High-impact secrets and artifacts

- `identity.json`:
  - `clientKey` (long-term identity secret),
  - `deviceGroupKey` (root for D2M keys),
  - `deviceCookie`,
  - `deviceId` (routing/identity metadata).
- `media/` content and transcription artifacts.
- `incoming-message-dedupe.json` (message metadata history).
- `contacts.json` / `groups.json` (social graph and identifiers).

### Operational recommendations

- Do not commit `dataDir` artifacts to version control.
- Restrict file permissions (for example owner-only directory and file access).
- Keep encrypted/offline backups if retention is required.
- Avoid sharing verbose logs externally.
- If secret leakage is suspected:
  1. Stop the process.
  2. Revoke/remove linked device in Threema.
  3. Rotate by re-linking and replacing local identity material.
  4. Reassess host compromise before restoring operations.

## 9) Claim-to-Code Verification Matrix

| Claim | Primary code anchors |
| --- | --- |
| Device-group key derivation (`p`, `r`, `di`, `sdd`, `ts`) | `src/mediator-client.ts` `deriveDeviceGroupKey`, `deriveDeviceGroupKeys` |
| NaCl-style precomputation (`X25519 + HSalsa20`) | `src/mediator-client.ts` `naclBoxBeforeNm`; `src/csp-handler.ts` `naclBoxBeforeNm` |
| D2M reflected envelope AEAD with nonce-ahead format | `src/mediator-client.ts` `secretBoxEncryptWithRandomNonce`, `secretBoxDecryptWithNonceAhead`, `reflectOutgoingMessage`, `handleReflected` |
| CSP nonce format `cookie || seq_u64_le` | `src/csp-handler.ts` `buildNonce`, `nextClientNonce`, `nextServerNonce` |
| CSP handshake keying and login/vouch | `src/csp-handler.ts` `startHandshake`, `tryParseServerHello`, `completeServerHello`, `buildLoginDataPlaintext` |
| E2E payload encryption and padding | `src/mediator-client.ts` `encryptE2ePayload`, `padMessageBody`, `decodeCspIncomingMessage`, `unpadMessageBody` |
| Metadata container encryption (`salt='mm'`, personal `3ma-csp`) | `src/mediator-client.ts` `deriveMessageMetadataKey`, `encryptMessageMetadata`, `encodeMessageMetadata` |
| Blob encryption/decryption | `src/mediator-client.ts` `encryptBlobWithKey`, `decryptBlobWithKey`, `BLOB_FILE_NONCE`, `BLOB_THUMBNAIL_NONCE` |
| Linking/rendezvous crypto path | `src/rendezvous-crypto.ts` `deriveAuthKeys`, `deriveTransportKeys`, `RendezvousCipher`, `x25519DH`; `src/rendezvous.ts` |

## 10) Modules Outside the Main Runtime Path

`src/gateway-client.ts` and `src/crypto.ts` provide Gateway/directory
cryptographic helpers (including webhook MAC verification and libsodium-based
helpers). The current default mediator/CSP runtime path does not depend on them
for message transport security.

## 11) Vulnerability Reporting

Report security issues privately before public disclosure.

- Prefer private maintainer channels or GitHub private vulnerability reporting,
  if available for this repository.
- Include:
  - impact and threat model,
  - affected code paths/commits,
  - reproduction steps or proof of concept,
  - recommended mitigations.

Avoid posting exploitable details in public issues before a coordinated fix and
release window.
