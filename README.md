# Smart Detection Relay

Routes Scrypted NVR's object-detection events to **Android TV overlays** and **phone push notifications** — with cropped thumbnails, snooze buttons, and tap-to-timeline deep links. No Home Assistant required; notifications are delivered entirely through the Scrypted SDK, and the plugin stores no third-party credentials of any kind.

[![npm version](https://img.shields.io/npm/v/@andygev35/smart-detection-relay.svg)](https://www.npmjs.com/package/@andygev35/smart-detection-relay)

**Source & issues:** [github.com/andygev35/smart-detection-relay](https://github.com/andygev35/smart-detection-relay) — found a bug or have a feature request? [Open an issue](https://github.com/andygev35/smart-detection-relay/issues/new).

## Requirements

- **A Scrypted NVR license/subscription active on your Scrypted server.** This plugin relies entirely on Scrypted NVR's own object detection (bounding boxes, classes, scores) — it does not run its own detection model.
- **Zones already defined on each camera you want to use**, via Scrypted's object detection settings for that camera. The plugin reads zone names directly from the camera; a rule can't match a zone that doesn't exist yet.
- **TvOverlay installed and running on any Android/Google TV device(s)** you want overlays to appear on — only required if you use the TV overlay feature (it can be turned off entirely if you only want phone push). Install it from the [Google Play Store](https://play.google.com/store/apps/details?id=com.tabdeveloper.tvoverlay) on the TV itself; see the [TvOverlay GitHub repo](https://github.com/gugutab/TvOverlay) for its full REST API and setup docs.
- **At least one Scrypted device implementing the `Notifier` interface**, for phone push — e.g. the native Scrypted app on your phone, linked via Scrypted Cloud. Only required if you use phone push (leave `Notify Services` empty if you only want TV overlays).

## Setup

1. Install the plugin and open its settings.
2. Under the **Cameras** tab, add a camera by picking it from the **Cameras** field - it appears as a chip, and a new tab named after that camera appears below.
3. In that camera's tab, add a rule under **Rules**: type a name (e.g. "Frontyard Person") and press enter - it appears as a chip, and a settings section with that name appears below it.
4. In that rule's section, pick a **Class Name** and **Zone** (zones populate automatically once the camera is selected), then set a **Score Threshold**. Optional filters (`Min Width/Height`, `Max X/Y`, `Fixed Crop`, `Critical Alert`) are available per rule.
5. Repeat for each camera/rule you want. Remove a camera or rule at any time by removing its chip - this clears its settings. Each camera also has its own **Camera Enabled** switch, for turning detection off for just that camera without deleting its rules.
6. Under **Notify Services**, select which `Notifier` device(s) should receive phone push notifications.
7. Under **TV Overlay Hosts**, enter the base URL(s) of your TvOverlay instance(s), comma-separated (e.g. `http://192.168.1.50:5001`).
8. Adjust global options as needed — debounce, snooze durations (Android only, see below), bounding-box padding/crop ratio, night-mode latitude/longitude, etc. Latitude/Longitude (used only for night-mode sunrise/sunset) are auto-detected from your server's public IP address on first install; use **Detect Location** to re-run that lookup anytime, or enter coordinates manually for more precision. **Clear Location** wipes both fields (night-mode-only cameras simply stop suppressing notifications until a location is set again).

`Plugin Enabled` and `TV Overlay Enabled` are independent switches, both on by default: the former is a master kill switch for all detection processing, the latter only gates TV overlay delivery and can be left off if you're not using TvOverlay at all.

## Features

- **Chip-based settings UI** — add/remove cameras and rules as removable chips (the same pattern Scrypted's own built-in object detection settings use for zones); each addition reveals its own settings section automatically, no raw JSON editing.
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

## Issues & Contributing

Found a bug, have a feature request, or hit unexpected behavior? Please [open an issue on GitHub](https://github.com/andygev35/smart-detection-relay/issues/new) rather than leaving an npm review — it's much easier to track and follow up on there. Include your Scrypted server version, camera/device type, and any relevant log output if you can.

The full source is available at [github.com/andygev35/smart-detection-relay](https://github.com/andygev35/smart-detection-relay). Pull requests are welcome, but please open an issue first to discuss any non-trivial change before putting in the work.
