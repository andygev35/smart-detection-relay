# Smart Detection Relay

Routes Scrypted NVR's object-detection events to **Android TV overlays** and **phone push notifications** — with cropped thumbnails, snooze buttons, and tap-to-timeline deep links. Notifications are delivered through the native Scrypted SDK by default, with no third-party credentials required. Home Assistant and ntfy are both available as additional, fully optional notifiers. Home Assistant enabling lets you use HA-specific notification options (categories, icons, and a tap destination that opens Home Assistant's own Scrypted NVR timeline), and is the only case where this plugin stores Home Assistant credentials (a Home Assistant URL and Long-Lived Access Token, used solely to power snooze buttons on HA notifications). ntfy needs only a server URL and topic (and, optionally, an access token for a protected topic).

[![npm version](https://img.shields.io/npm/v/@andygev35/smart-detection-relay.svg)](https://www.npmjs.com/package/@andygev35/smart-detection-relay)

**Source & issues:** [github.com/andygev35/smart-detection-relay](https://github.com/andygev35/smart-detection-relay) — found a bug or have a feature request? [Open an issue](https://github.com/andygev35/smart-detection-relay/issues/new).

## Requirements

- **A Scrypted NVR license/subscription active on your Scrypted server.** This plugin relies entirely on Scrypted NVR's own object detection (bounding boxes, classes, scores) — it does not run its own detection model.
- **Zones already defined on each camera you want to use**, via Scrypted's object detection settings for that camera. The plugin reads zone names directly from the camera; a rule can't match a zone that doesn't exist yet.
- **TvOverlay installed and running on any Android/Google TV device(s)** you want overlays to appear on — only required if you use the TV overlay feature (it can be turned off entirely if you only want phone push). Install it from the [Google Play Store](https://play.google.com/store/apps/details?id=com.tabdeveloper.tvoverlay) on the TV itself; see the [TvOverlay GitHub repo](https://github.com/gugutab/TvOverlay) for its full REST API and setup docs.
- **At least one Scrypted device implementing the `Notifier` interface**, for phone push — e.g. the native Scrypted app on your phone, linked via Scrypted Cloud. Only required if you use phone push (leave `Notify Services` empty if you only want TV overlays).
- **Optional: Home Assistant**, if you want to use it as an additional notifier. Requires the [Scrypted Home Assistant plugin](https://github.com/scryptedapp/homeassistant) installed and configured (this syncs your HA `notify.` targets into Scrypted). For the "Home Assistant" tap destination and for snooze buttons on HA notifications, you'll also need a Scrypted Integration Token (from Home Assistant's own Scrypted custom component) and a Home Assistant URL + Long-Lived Access Token, respectively — see the Home Assistant Notifier section below. None of this is required if you only use the native Scrypted notifier.
- **Optional: ntfy**, if you want to use it as an additional notifier. Just a Server URL and Topic (an [ntfy.sh](https://ntfy.sh) account isn't required — topics are created on the fly). If self-hosting, your server needs attachments enabled to receive thumbnails — see the ntfy Notifier section below.

## Setup

1. Install the plugin and open its settings.
2. Under the **Cameras** tab, add a camera by picking it from the **Cameras** field - it appears as a chip, and a new tab named after that camera appears below.
3. In that camera's tab, add a rule under **Rules**: type a name (e.g. "Frontyard Person") and press enter - it appears as a chip, and a settings section with that name appears below it.
4. In that rule's section, pick a **Class Name** and **Zone** (zones populate automatically once the camera is selected), then set a **Score Threshold**. Optional filters (`Min Width/Height`, `Max X/Y`, `Fixed Crop`, `Critical Alert`) are available per rule.
5. Repeat for each camera/rule you want. Remove a camera or rule at any time by removing its chip - this clears its settings. Each camera also has its own **Camera Enabled** switch, for turning detection off for just that camera without deleting its rules.
6. Under the **Notifiers** tab, pick **Scrypted** for the native Scrypted app path (select which `Notifier` device(s) should receive phone push notifications), **Home Assistant** for the optional HA path (see the Home Assistant Notifier section below), and/or **ntfy** for the optional ntfy path (see the ntfy Notifier section below).
7. Under the **TV Overlay** tab, enter the base URL(s) of your TvOverlay instance(s), comma-separated (e.g. `http://192.168.1.50:5001`).
8. Adjust global options as needed — debounce, snooze durations (Android only, see below), bounding-box padding/crop ratio. Under the **Location** tab, Latitude/Longitude (used only for night-mode sunrise/sunset) are auto-detected from your server's public IP address on first install; use **Detect Location** to re-run that lookup anytime, or enter coordinates manually for more precision. **Clear Location** wipes both fields (night-mode-only cameras simply stop suppressing notifications until a location is set again).

`Plugin Enabled` and `TV Overlay Enabled` are independent switches, both on by default: the former is a master kill switch for all detection processing, the latter only gates TV overlay delivery and can be left off if you're not using TvOverlay at all.

## Home Assistant Notifier (optional)

Home Assistant is not required, but can be enabled as an additional notifier under **Notifiers > Home Assistant**:

- **HA Notifier** — pick the HA-exposed `notify.` target (e.g. `mobile_app_yourphone`) to also receive phone push.
- **Notification Category / Icon** — once an HA Notifier is selected, every detection rule (under that camera's own tab) gains optional **HA Notification Category** and **HA Notification Icon** fields, letting you assign a distinct notification channel/sound or a Material Design status-bar icon per rule.
- **Tap Destination** — choose whether tapping an HA notification opens the Scrypted app (`nvr.scrypted.app`, the default) or Home Assistant's own Scrypted NVR timeline instead. The latter requires a **Scrypted Integration Token** (found in Home Assistant: open a camera's playback view, click the settings icon, and copy the token from the "Integration URL" shown there).
- **Snooze buttons on HA notifications** require a **Home Assistant URL** and **Long-Lived Access Token** (generated from your HA profile → Security → Long-Lived Access Tokens). These power a direct connection this plugin opens to Home Assistant's own event stream so snooze taps are picked up immediately — no Home Assistant automation authoring, no MQTT broker.

None of these credentials are requested or stored unless you actually fill them in - the plugin works entirely without Home Assistant if you don't need it.

## ntfy Notifier (optional)

[ntfy](https://ntfy.sh) is not required, but can be enabled as an additional notifier under **Notifiers > ntfy**:

- **Server URL** — `https://ntfy.sh` for the free public service, or your own self-hosted URL.
- **Topic** — the ntfy topic to publish detections to. On a public server, anyone who knows the exact topic name can subscribe to it, so pick something hard to guess rather than something obvious.
- **Access Token** (optional) — only needed for a protected topic or a self-hosted server with auth enabled.

Once ntfy is configured, each detection rule (under that camera's own tab) gains an optional **ntfy Priority** field (Min/Low/Default/High/Max) for controlling vibration/sound behavior per rule on Android (untested on iOS - ntfy's docs don't call out iOS-specific differences by priority). Left on "Auto" (the default), it falls back to the rule's existing **Critical Alert** setting instead (Critical → Max, otherwise Default).

Notifications include the same cropped thumbnail, tap-to-timeline link, and snooze buttons as the other notifiers. A few things worth knowing:

- **Self-hosted servers need attachments enabled to receive thumbnails.** If yours doesn't, notifications automatically fall back to text-only (title/tap/snooze still work) rather than failing outright — you'll see a warning in the log if this happens. To enable attachments, add `base-url` and `attachment-cache-dir` to your server's `server.yml` and restart the service. See [ntfy's attachments docs](https://docs.ntfy.sh/config/#attachments) for the full option list (size/expiry limits, etc.). On Windows, the config file defaults to `%ProgramData%\ntfy\server.yml`.
- **Self-hosted servers may not push to iOS at all without extra config.** Apple requires push to go through APNs using a signing key only ntfy's own maintainers have, so a self-hosted server can't push directly to an iPhone — messages will still show up when you manually open the ntfy app, but no notification (lock screen or otherwise) arrives on its own. To fix this: add `upstream-base-url: "https://ntfy.sh"` to your server's `server.yml` and restart, **and** make sure the ntfy iOS app's own Settings → Default Server exactly matches your server's `base-url` (protocol, host, and port all have to match — a mismatch is a common cause of this same symptom persisting). If you instead start seeing generic "New message" notifications with no real content after this fix, that's a different, separate problem — your phone can reach ntfy.sh for the push nudge but not your own server afterward to fetch the actual message (a network/firewall/DNS issue reaching your server from outside your LAN).
- **Only one snooze button shows in the pushed notification itself.** ntfy's Android app reserves two of its three available button slots for its own built-in "Open"/"Browse" actions whenever a notification has both an attachment and a tap-through link — this is a known ntfy client limitation, not something this plugin can control (see [ntfy issue #1641](https://github.com/binwiederhier/ntfy/issues/1641)). All configured snooze durations are still available and working, though — they're just accessible from within the ntfy app's own notification list rather than the push itself. Tapping the notification's title/body opens the Scrypted timeline; tapping the thumbnail image opens ntfy's own image preview.

Per-rule notification category/icon customization (available for Home Assistant) isn't offered for ntfy — testing found neither has any effect in the ntfy client.

## Features

- **Chip-based settings UI** — add/remove cameras and rules as removable chips (the same pattern Scrypted's own built-in object detection settings use for zones); each addition reveals its own settings section automatically, no raw JSON editing.
- **Organized settings tabs** — General, TV Overlay, Location, and Notifiers (with sub-tabs per notifier type) keep global options grouped by what they affect, instead of one long list.
- **Optional Home Assistant notifier** — send to an HA `notify.` target alongside or instead of the native Scrypted app, with per-rule notification category/icon, a choice of tap destination (Scrypted app or Home Assistant's own NVR timeline), and working snooze buttons via a direct connection to HA's event stream. Entirely opt-in; no HA credentials are requested unless you configure it.
- **Optional ntfy notifier** — send to any ntfy server (ntfy.sh or self-hosted) alongside the other notifiers, with the same thumbnail, tap-to-timeline, and snooze buttons, plus a per-rule Priority setting (Min/Low/Default/High/Max). Just a server URL and topic; no account required.
- **Per-camera enable/disable** — each camera has its own `Camera Enabled` switch, independent of the global `Plugin Enabled` switch, for turning off just one camera's detections temporarily without losing its configured rules.
- **Smart thumbnail cropping** — crops are centered on the detected subject and fit to a configurable aspect ratio (square by default), always growing to fully contain the subject rather than cropping into it.
- **Snooze buttons (Android only)** — configurable durations, delivered as native notification actions; tapping one suppresses further notifications for that camera/class. On iOS, the Scrypted app uses its own fixed, built-in snooze action instead of these custom buttons - see Notes below.
- **Tap-to-timeline** — tapping a notification opens directly to that detection's event in the Scrypted app.
- **Per-rule critical alerts** — flag specific rules (e.g. a person at the front door) to send with a higher-priority alert tier.
- **Night-mode-only cameras** — suppress notifications during the day for cameras where you only care about after-dark activity, based on sunrise/sunset for your configured location. Location is auto-detected from your server's public IP on first install (city-level accuracy), with a **Detect Location** button to re-run it and a **Clear Location** button to reset it.
- **Debounce & duplicate suppression** — configurable per-camera/class cooldown, plus detection-ID deduplication.
- **Multiple notify targets** — select any number of `Notifier` devices to push to simultaneously.

## Notes

- This plugin does not perform its own image analysis — it relies entirely on detection results and zone definitions already configured in Scrypted NVR.
- If you rename a `Notifier` device in Scrypted, you'll need to reselect it under **Notify Services** — the dropdown is keyed on the device's display name for readability.
- Plugin restarts reset in-memory debounce and snooze state.
- **Snooze duration configuration only applies on Android.** The Scrypted iOS app doesn't render this plugin's custom snooze buttons at all - it substitutes its own fixed, built-in snooze action instead. Snoozing still works on iOS, but at whatever duration the Scrypted app itself hardcodes, not the `Snooze Durations` setting.
- **Home Assistant credentials are opt-in.** The Scrypted Integration Token and Home Assistant URL/Long-Lived Access Token are only requested if you actually configure the Home Assistant Tap Destination or want HA snooze buttons - the plugin never asks for or stores them otherwise.
- **ntfy attachments require server-side config.** A self-hosted ntfy server without `attachment-cache-dir` set will reject the thumbnail; notifications fall back to text-only automatically rather than failing. See the ntfy Notifier section above.

## Issues & Contributing

Found a bug, have a feature request, or hit unexpected behavior? Please [open an issue on GitHub](https://github.com/andygev35/smart-detection-relay/issues/new) rather than leaving an npm review — it's much easier to track and follow up on there. Include your Scrypted server version, camera/device type, and any relevant log output if you can.

The full source is available at [github.com/andygev35/smart-detection-relay](https://github.com/andygev35/smart-detection-relay). Pull requests are welcome, but please open an issue first to discuss any non-trivial change before putting in the work.
