# Browser extension release review — DRAFT, NOT SUBMITTED

## Single purpose

Allow the user’s explicitly authorized AI tasks to operate the user’s selected personal Chrome tabs through the installed ChatHand desktop application. No background browsing collection, advertising, sale of data or independent model requests.

## Permissions justification

- debugger: observe accessibility nodes, capture the requested tab and send defined input actions. Broad and security-sensitive; Chrome’s warning and cancellation must remain visible and effective.
- tabs: identify target tabs, open/select/close explicitly requested pages. Incognito and internal/file pages are excluded by code.
- tabGroups: place AI-used pages into the visibly named Ken Bridge group; personal tabs outside that group need explicit user intent.
- nativeMessaging: exchange bounded JSON messages with the exact registered `com.kenyu.chathand.browser` host and pinned extension origin.
- storage: remember the user’s enabled/disabled preference only.
- alarms: attempt reconnection while enabled after the desktop app becomes available; cannot override a saved disabled preference.

No content scripts, externally_connectable API, remote executable code, cookies API, or credentials export endpoint is declared. Fixed DOM select handling is packaged code, not caller-supplied JavaScript.

## Data flow disclosure

When a user requests page reading or screenshots, those results travel from Chrome to the local native host, then ChatHand and the user’s connected AI provider. Do not claim that all browsing data always stays on-device: requested results can enter cloud conversations. Idle connection heartbeats do not request page text. The extension itself has no external telemetry or model endpoint.

## Security self-review completed in source

Origins and host registration are pinned; messages and images are bounded; stale element references and navigation changes are rejected; requests are checked against an active task again immediately before execution; returned results are discarded after revocation/expiry; known password and OTP fields cannot be filled. User cancellation persistently disables automatic reconnection. Tests use simulated Chrome APIs unless an evidence report explicitly states otherwise.

1012 uses a fixed, pinned Playwright injected script in page-isolated worlds for semantic locator verification, actionability and sanitized aria snapshots. Tool arguments cannot contain JavaScript or arbitrary selectors. Each batch step rechecks the native task authorization; consequential controls require confirmation; failure returns receipts and the current snapshot (or explicitly stale previous observation after cancellation). Browser input does not monitor user activity or pause background operations. New/select preserve the user active tab and foreground window unless the user explicitly requests show:true; explicit stop, revocation and expiry still cancel work. Debugger sessions detach after 30 seconds of idle time. Chrome flat sessions route out-of-process frames without escaping the selected tab. These are source properties awaiting real Chrome acceptance.

## Still required before public submission

1. Real Chrome installation and control tests on supported Mac/Windows configurations, including reconnect after app/browser restart, DevTools conflicts, shutdown, cancellation, and multi-profile handling.
2. Store-assigned ID/public key must match the desktop host allowlist. Current manifest key is a stable development public key. No signing private key is included. A new store listing may require synchronizing the released ID/key and rebuilding; do not publish a desktop package with a mismatched ID.
3. Provide actual operator identity, contact, privacy-policy URL, support URL, screenshots and permission disclosures. This document is a technical draft, not a published privacy policy.
4. Complete Chrome Web Store developer enrollment and review. The desktop application also needs appropriate release signing/notarization for public distribution.
5. Independent security review and broader site compatibility testing remain outstanding. A passing unit suite is not external certification.

A store policy rejection, enterprise restriction, user revocation or security prompt is not something to work around with hidden Chrome flags or silent installation.
