<details>
<summary>Changelog</summary>

<h3>0.4.0</h3>
<p>ntfy is now a fully supported notifier alongside the native Scrypted app and Home Assistant - optional, and off by default. Configure a Server URL and Topic under Notifiers > ntfy (an optional Access Token is also available for protected topics or self-hosted servers with auth enabled) to start receiving detections there too, with the same cropped thumbnail, tap-to-timeline link, and snooze buttons as the other notifiers. If your ntfy server doesn't have attachments enabled, notifications now fall back to text-only automatically instead of failing outright - see the README for the one-line server config needed to enable images on a self-hosted ntfy instance. Note: ntfy's own Android app only shows one snooze button in the pushed notification itself (its UI reserves two button slots for its own built-in "Open"/"Browse" actions whenever an image is attached), though all configured snooze durations are available and working from within the ntfy app's notification list. Per-rule notification category/icon customization (available for Home Assistant) isn't offered for ntfy - testing found neither has any effect in the ntfy client.</p>

<h3>0.3.1</h3>
<p>Fixed Home Assistant snooze buttons not working. The plugin was listening for the wrong iOS notification-action event name, and the connection to Home Assistant could silently stop reconnecting after a network hiccup or Home Assistant restart until the plugin itself was restarted. Both are fixed - snooze buttons on Home Assistant notifications should now work reliably, including recovering on their own after a brief Home Assistant outage.</p>

<h3>0.3.0</h3>
<p>Home Assistant is now a fully supported notifier alongside the native Scrypted app - optional, and off by default. Settings are reorganized into dedicated tabs: TV Overlay, Location, and a new Notifiers tab with sub-tabs per notifier type (Scrypted, Home Assistant, and placeholders for ntfy/Gotify support planned in a future release). When a Home Assistant notifier is selected, each detection rule gains optional Notification Category and Icon fields for that notifier. A new Tap Destination option lets HA notifications open either the Scrypted app (as before) or the Scrypted NVR timeline hosted inside Home Assistant's own UI. Snooze buttons now work on Home Assistant notifications too, via a direct connection this plugin opens to Home Assistant's own event stream (requires a Home Assistant URL and Long-Lived Access Token, entered once under Notifiers > Home Assistant) - no Home Assistant automation authoring or MQTT broker required. Home Assistant credentials are only requested and only stored if you actually configure a Home Assistant notifier; the plugin remains fully usable with zero third-party credentials if you stick to the native Scrypted notification path.</p>

<h3>0.2.8</h3>
<p>Fixed a rare crop error that could cause a notification to fall back to an uncropped full-frame image instead of the intended thumbnail. This only happened for detections positioned close enough to a camera frame edge to trigger an edge case in the crop rounding math - now fixed so the crop always stays within the frame.</p>

<h3>0.2.7</h3>
<p>Latitude/Longitude (used for night-mode sunrise/sunset) are now auto-detected from your server's public IP address on first install, instead of needing to be entered manually. Added a "Detect Location" button to re-run that lookup anytime, and a "Clear Location" button to reset it. If you already had coordinates configured, nothing changes for you - detection only runs when the fields are empty.</p>

<h3>0.2.6</h3>
<p>Reformatted this changelog for clearer display.</p>

<h3>0.2.2</h3>
<p>Faster phone push delivery right after a plugin restart: notification metadata (used for tap-to-timeline and snooze action buttons) is now pre-loaded at startup instead of being resolved on the first detection. Minor internal streamlining of how a notification's image and metadata are assembled before sending. No settings, detection behavior, or notification content changed.</p>

<h3>0.2.1</h3>
<p>Added a per-camera Camera Enabled switch, so you can temporarily disable detections for a single camera without deleting its rules. Fixed all on/off switches in the settings UI to render as toggle switches instead of checkboxes, matching the rest of Scrypted's UI.</p>

<h3>0.2.0</h3>
<p>Reworked the settings UI: cameras and rules are now added/removed as chips, the same pattern used by Scrypted's own built-in Zones field, instead of numbered tabs with Add/Remove buttons. A rule's name is now shown directly as its chip label. Fixed iOS snooze buttons to work correctly - the Scrypted iOS app uses its own fixed snooze action rather than this plugin's configurable ones, and the plugin now recognizes and handles that iOS-specific format so snoozing works on iPhone as well as Android.</p>

<h3>0.1.1</h3>
<p>Temporary diagnostic logging added while investigating the iOS snooze issue above, removed once the fix shipped in 0.2.0.</p>

<h3>0.1.0</h3>
<p>Initial public release. Routes Scrypted NVR object detections to Android TV overlays and phone push notifications, entirely through the native Scrypted SDK, no Home Assistant required. Cropped, subject-centered thumbnails with configurable padding and aspect ratio. Snooze action buttons on phone notifications (Android; see README for iOS behavior), with configurable durations. Tap-to-timeline: tapping a notification opens directly to that detection in the Scrypted app. Per-rule critical alerts, night-mode-only cameras, and debounce/duplicate suppression. Snooze durations are configurable on Android; on iOS, the Scrypted app substitutes its own fixed, built-in snooze action instead - snoozing still works, just at whatever duration the Scrypted iOS app itself hardcodes rather than the durations set in this plugin's settings.</p>

</details>
