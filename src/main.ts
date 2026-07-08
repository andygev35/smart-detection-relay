import sdk, { ScryptedDeviceBase, ScryptedInterface, Setting, Settings, SettingValue, EventListenerRegister, MediaObject, HttpRequestHandler, HttpRequest, HttpResponse, NotifierOptions, EventDetails, ScryptedMimeTypes } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';

const { systemManager, mediaManager, endpointManager } = sdk;

const NUM_CAMERA_SLOTS = 10;
const NUM_RULE_SLOTS = 8;
// Common Scrypted NVR / object-detection-plugin class names. Presented as a
// combobox (choices + freeform) since some detectors report additional or
// custom class names (e.g. specific animal subtypes) not in this preset list.
const DETECTION_CLASS_CHOICES = ['person', 'vehicle', 'animal', 'package', 'face', 'plate'];
// All the per-rule storage key suffixes - used to bulk-clear a rule slot on removal.
const RULE_FIELD_SUFFIXES = ['Name', 'ClassName', 'Zone', 'ScoreThreshold', 'Critical', 'FixedCrop', 'MinWidth', 'MinHeight', 'MaxX', 'MaxY'];
const GET_DETECTION_INPUT_RETRIES = [0, 300, 700, 1200, 2000];
const MIN_PLAUSIBLE_IMAGE_BYTES = 5000;
// Scrypted's Home Assistant plugin still syncs its own Notifier-interface devices
// into the system even though smart-detection-relay no longer talks to HA at all. Filter
// those out so they don't show up as selectable notify targets in settings.
const HOMEASSISTANT_PLUGIN_ID = '@scrypted/homeassistant';

// Snooze durations offered as notification action buttons.
const ACTION_PREFIX = 'tvosnooze';

interface ClassZoneRule {
    name?: string;        // optional friendly label, shown in settings and log lines
    className: string;
    zone: string;
    scoreThreshold: number;
    minWidth?: number;   // minimum bounding box width in pixels
    minHeight?: number;  // minimum bounding box height in pixels
    maxX?: number;       // skip detections whose bounding box starts beyond this x coordinate
    maxY?: number;       // skip detections whose bounding box starts beyond this y coordinate
    fixedCrop?: [number, number, number, number]; // [x, y, width, height] fixed crop bypassing bounding box
    critical?: boolean;  // send as a critical push notification (louder/bypassing-DND alert sound) instead of normal
}

interface CameraRelayConfig {
    id: string;
    enabled: boolean;
    nightModeOnly: boolean;
    rules: ClassZoneRule[];
    thumbnailWindow: number;
}

function buildSnoozeAction(cameraId: string, className: string, minutes: number): string {
    return `${ACTION_PREFIX}_${minutes}_${cameraId}_${className}`;
}

function parseSnoozeAction(action: string): { cameraId: string, className: string, minutes: number } | undefined {
    const parts = action.split('_');
    if (parts.length !== 4 || parts[0] !== ACTION_PREFIX)
        return undefined;
    const minutes = parseInt(parts[1], 10);
    if (!Number.isFinite(minutes))
        return undefined;
    return { minutes, cameraId: parts[2], className: parts[3] };
}

// The Scrypted iOS app has its own fixed, built-in "Snooze N Minutes" action -
// entirely separate from the custom NotifierOptions.actions[] array this plugin
// builds via buildSnoozeAction()/ACTION_PREFIX, which only Android renders and
// honors. iOS ignores that array (including the configured titles) and instead
// POSTs its own hardcoded action id (observed live 7/3: actionId="snooze10") to
// data.actionUrl - but it does still forward data.snoozeId, which is already
// exactly `${cameraId}-${className}` (see snoozeKey()), so the camera/class can
// still be recovered even though the identifier scheme itself is iOS's own, not
// this plugin's. Confirmed via live console log: body =
// {"actionId":"snooze10","snoozeId":"274-person"}.
function parseNativeIosSnoozeAction(actionId: string | undefined, snoozeId: string | undefined): { cameraId: string, className: string, minutes: number } | undefined {
    if (!actionId || !snoozeId)
        return undefined;
    const match = /^snooze(\d+)$/i.exec(actionId);
    if (!match)
        return undefined;
    const minutes = parseInt(match[1], 10);
    if (!Number.isFinite(minutes))
        return undefined;
    // snoozeId is `${cameraId}-${className}` - split on the first "-" rather than
    // the last, since Scrypted device ids are numeric (no "-") but this keeps the
    // parsing robust either way.
    const dashIndex = snoozeId.indexOf('-');
    if (dashIndex === -1)
        return undefined;
    const cameraId = snoozeId.slice(0, dashIndex);
    const className = snoozeId.slice(dashIndex + 1);
    if (!cameraId || !className)
        return undefined;
    return { minutes, cameraId, className };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// YYYY-MM-DD in the plugin process's local timezone (not UTC).
function localDateString(d: Date = new Date()): string {
    const y = d.getFullYear();
    const m = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${day}`;
}

class SmartDetectionRelayPlugin extends ScryptedDeviceBase implements Settings, HttpRequestHandler {
    listenerRegistrations: EventListenerRegister[] = [];
    lastNotified: Record<string, number> = {};
    recentDetectionIds = new Set<string>();
    snoozedUntil: Record<string, number> = {};
    isNightMode: boolean = false;
    sunTimer: NodeJS.Timeout | null = null;
    cachedNotifier: any | undefined;
    // Native Scrypted app push support: tap-to-timeline and action buttons need
    // fields (data.hash/data.localAddresses, data.actionUrl/data.snoozeId) that are
    // undocumented in the SDK - discovered by reading scrypted-advanced-notifier's
    // source (src/main.ts getUrls/initPluginSettings, src/utils.ts getWebHookUrls).
    cachedServerId: string | undefined;
    cachedLocalAddresses: string[] | undefined;
    cachedActionUrl: string | undefined;
    // key: `${cameraId}-${className}`, value: best detection seen so far during window
    pendingDetections: Map<string, { detection: any, eventData: any, eventDetails: EventDetails, camera: any, config: CameraRelayConfig, fixedCrop?: [number, number, number, number], critical?: boolean, timer: NodeJS.Timeout }> = new Map();

    settingsStorage = new StorageSettings(this, {
        // ---- Global: General ----
        pluginEnabled: {
            title: 'Plugin Enabled',
            description: 'Master switch. Disable to stop all detection processing, TV overlay notifications, and phone push notifications without losing your configuration.',
            type: 'boolean',
            value: true,
            immediate: true,
        },
        tvOverlayEnabled: {
            title: 'TV Overlay Enabled',
            description: 'Send detection snapshots to the TV Overlay hosts below. Turn off if you are not using the Android TV overlay app - phone push notifications are unaffected either way.',
            type: 'boolean',
            value: true,
            immediate: true,
        },
        // ---- Global: Notifications ----
        notifyServices: {
            title: 'Notify Services',
            description: 'Select one or more Scrypted Notifier-interface devices to deliver phone push notifications to (e.g. the native Scrypted NVR user-device for your phone).',
            type: 'string',
            value: '',
            multiple: true,
            onGet: async () => ({ choices: this.getScryptedNotifierChoices() }),
        },
        // ---- Global: TV Overlay ----
        tvHosts: {
            title: 'TV Overlay Hosts',
            description: 'Comma-separated list of TvOverlay base URLs (e.g. http://192.168.3.135:5001, http://192.168.3.181:5001)',
            type: 'string',
            value: 'http://192.168.3.135:5001, http://192.168.3.181:5001',
        },
        notificationDurationSeconds: {
            title: 'Notification Duration (seconds)',
            description: 'How long TV overlay notifications are displayed.',
            type: 'number',
            value: 10,
        },
        // ---- Global: Detection ----
        debounceSeconds: {
            title: 'Debounce (seconds)',
            description: 'Minimum time between repeated notifications for the same camera/class.',
            type: 'number',
            value: 180,
        },
        paddingFactor: {
            title: 'Bounding Box Padding',
            description: 'Padding added around the detected subject as a fraction of the bounding box size. 0.15 = tight, 0.5 = loose, 1.0 = very wide.',
            type: 'number',
            value: 0.5,
        },
        maxHeightRatio: {
            title: 'Max Height Ratio',
            description: 'Target crop aspect ratio, height relative to width (e.g. 1.0 = square, 1.5 = portrait, 0.75 = landscape). The crop is sized to fully contain the bounding box plus padding at this ratio - if the padded box does not fit, the shorter axis grows to fit it rather than cropping into the subject. 0 = no ratio constraint (crop matches the padded bounding box as-is).',
            type: 'number',
            value: 1.0,
        },
        maxLongSide: {
            title: 'Max Image Size (pixels)',
            description: 'Maximum size of the longest side of the crop in pixels. Image is scaled down proportionally. Keeps file sizes manageable. 0 = no limit.',
            type: 'number',
            value: 800,
        },

        snoozeMinutes: {
            title: 'Snooze Durations (minutes) - Android only',
            description: 'Comma-separated snooze durations offered as notification action buttons (e.g. 10, 30, 60). Android only - the Scrypted iOS app uses its own fixed, built-in snooze action instead of these custom buttons, so this setting has no effect on iPhone notifications.',
            type: 'string',
            value: '10, 30, 60',
        },
        // ---- Global: Sun schedule ----
        // No hardcoded default coordinates here on purpose - this is a public
        // plugin, and a baked-in lat/long would silently apply the author's own
        // location to every fresh install that doesn't touch these fields. Left
        // blank, ensureLocationDetected() auto-fills them via IP geolocation on
        // first startup, and detectLocationButton lets it be re-run anytime.
        latitude: {
            title: 'Latitude',
            description: 'Your latitude for sunrise/sunset calculation. Auto-filled on first install via "Detect Location" below (IP-based lookup) - edit directly for precision, or leave as detected.',
            type: 'number',
            placeholder: 'e.g. 33.7490',
        },
        longitude: {
            title: 'Longitude',
            description: 'Your longitude for sunrise/sunset calculation.',
            type: 'number',
            placeholder: 'e.g. -84.3880',
        },
        detectLocationButton: {
            title: 'Detect Location',
            description: 'Looks up an approximate location from this Scrypted server\'s public IP address and fills in Latitude/Longitude above. Tries a couple of free geolocation services in order in case one is temporarily rate-limited. Accurate to roughly city-level - safe to nudge the values afterward for precision. Runs automatically once on first install if Latitude/Longitude are still blank.',
            type: 'button',
            noStore: true,
            onPut: async (oldValue: any, newValue: any) => {
                await this.detectLocation();
            },
        },
        clearLocationButton: {
            title: 'Clear Location',
            description: 'Clears Latitude/Longitude. Night-mode-only cameras stop respecting sunrise/sunset until a location is set again (via "Detect Location" or manual entry) - they simply won\'t suppress notifications in the meantime.',
            type: 'button',
            noStore: true,
            onPut: async (oldValue: any, newValue: any) => {
                await this.clearLocation();
            },
        },
        // ---- Cameras (chip-style add/remove, matches Scrypted's own "Zones" field pattern) ----
        camerasField: {
            title: 'Cameras',
            description: 'Camera devices to configure detection routing for. Add a camera to reveal its own settings tab below (rules, night mode, thumbnail options); remove it here to delete it and all of its rules.',
            type: 'device',
            deviceFilter: `interfaces.includes('${ScryptedInterface.ObjectDetector}')`,
            multiple: true,
            group: 'Cameras',
            noStore: true,
            onPut: async (oldValue: any, newValue: any) => {
                await this.applyCameraSelection(Array.isArray(newValue) ? newValue.map(String) : (newValue ? [String(newValue)] : []));
            },
        },
        // ---- Per-camera slots (dynamic add/remove - see buildAllCameraSettings) ----
        ...this.buildAllCameraSettings(),
    });

    // ---- Dynamic camera/rule slot generation ----
    //
    // Scrypted's Settings/StorageSettings framework has no native "add row"
    // widget - the schema is a flat, statically-defined key list. A generous
    // static ceiling of slots is defined (NUM_CAMERA_SLOTS cameras x
    // NUM_RULE_SLOTS rules each) and used purely as internal storage; the UI
    // no longer exposes numbered slots, "+ Add" tabs, or per-slot Remove
    // buttons directly. Instead, two chip-style multi-select fields (the same
    // pattern Scrypted's own built-in object detection settings use for
    // "Zones" - type a value, get a removable pill) drive slot assignment:
    //   - `camerasField` (global, one field): chips are camera devices. Its
    //     `onPut` diffs the new chip list against currently-assigned slots and
    //     claims/frees slots accordingly (`applyCameraSelection`).
    //   - `cam{N}RulesField` (one per camera slot): chips are freeform rule
    //     names typed by the user. Its `onPut` diffs against that camera's
    //     rule slots the same way (`applyRuleSelection`).
    // Both chip fields are `noStore: true` - nothing is persisted under their
    // own key. The real storage of record is still the per-slot keys
    // (`cam{N}Device`, `cam{N}Rule{M}Name`, etc.), and `getSettings()` injects
    // the chip fields' displayed `value` by reading those slots fresh on every
    // load (`getAssignedCameraDeviceIds()` / `getRuleNamesForSlot()`).
    // A rule's Name field is now its identity (previously optional, used only
    // for display) - it's hidden from the UI since it's managed via the chip
    // list, not edited directly. Every other per-camera/per-rule setting keeps
    // its previous `onGet`-driven `group`/`subgroup`/`hide` recompute, now
    // keyed off "is this slot's Device/Name set" rather than the old
    // "<= highest configured + 1" trailing-slot visibility rule.

    private resolveCameraDeviceId(camSlot: number): string | undefined {
        const raw = this.storage.getItem(`cam${camSlot}Device`);
        return raw ? raw.replace(/^ScryptedDevice-/, '') : undefined;
    }

    private resolveCameraDeviceName(camSlot: number): string | undefined {
        const deviceId = this.resolveCameraDeviceId(camSlot);
        if (!deviceId)
            return undefined;
        try {
            return systemManager.getDeviceById(deviceId)?.name || undefined;
        }
        catch (e) {
            return undefined;
        }
    }

    private cameraGroupTitle(camSlot: number): string {
        return this.resolveCameraDeviceName(camSlot) ?? `Camera ${camSlot}`;
    }

    private isCameraSlotAssigned(camSlot: number): boolean {
        return Boolean(this.storage.getItem(`cam${camSlot}Device`));
    }

    private ruleName(camSlot: number, ruleSlot: number): string | undefined {
        return this.storage.getItem(`cam${camSlot}Rule${ruleSlot}Name`) || undefined;
    }

    // ---- Cameras chip field support ----

    private getAssignedCameraDeviceIds(): string[] {
        const ids: string[] = [];
        for (let camSlot = 1; camSlot <= NUM_CAMERA_SLOTS; camSlot++) {
            const raw = this.storage.getItem(`cam${camSlot}Device`);
            if (raw)
                ids.push(raw);
        }
        return ids;
    }

    private findFreeCameraSlot(): number | undefined {
        for (let camSlot = 1; camSlot <= NUM_CAMERA_SLOTS; camSlot++) {
            if (!this.isCameraSlotAssigned(camSlot))
                return camSlot;
        }
        return undefined;
    }

    // Diffs the new chip list (raw device id strings, as received from the
    // "Cameras" field) against currently-assigned slots: frees any slot whose
    // device is no longer selected (clearing that camera and all its rules),
    // then claims a free slot for any newly-selected device.
    async applyCameraSelection(newDeviceIds: string[]): Promise<void> {
        const normalize = (id: string) => id.replace(/^ScryptedDevice-/, '');
        const desiredNormalized = new Set(newDeviceIds.map(normalize));

        for (let camSlot = 1; camSlot <= NUM_CAMERA_SLOTS; camSlot++) {
            const raw = this.storage.getItem(`cam${camSlot}Device`);
            if (raw && !desiredNormalized.has(normalize(raw)))
                this.clearCameraSlot(camSlot);
        }

        const currentlyAssignedNormalized = new Set(this.getAssignedCameraDeviceIds().map(normalize));
        for (const deviceId of newDeviceIds) {
            if (currentlyAssignedNormalized.has(normalize(deviceId)))
                continue;
            const freeSlot = this.findFreeCameraSlot();
            if (freeSlot === undefined) {
                this.console.warn(`[${new Date().toLocaleTimeString()}]`, `No free camera slots available (max ${NUM_CAMERA_SLOTS} reached) - cannot add device ${deviceId}. Increase NUM_CAMERA_SLOTS in main.ts if you need more.`);
                continue;
            }
            this.storage.setItem(`cam${freeSlot}Device`, deviceId);
            currentlyAssignedNormalized.add(normalize(deviceId));
            this.console.log(`[${new Date().toLocaleTimeString()}]`, `Camera slot ${freeSlot}: assigned device ${deviceId}`);
        }
    }

    // ---- Rules chip field support (per camera slot) ----

    private getRuleNamesForSlot(camSlot: number): string[] {
        const names: string[] = [];
        for (let ruleSlot = 1; ruleSlot <= NUM_RULE_SLOTS; ruleSlot++) {
            const name = this.ruleName(camSlot, ruleSlot);
            if (name)
                names.push(name);
        }
        return names;
    }

    private findFreeRuleSlot(camSlot: number): number | undefined {
        for (let ruleSlot = 1; ruleSlot <= NUM_RULE_SLOTS; ruleSlot++) {
            if (!this.ruleName(camSlot, ruleSlot))
                return ruleSlot;
        }
        return undefined;
    }

    // Diffs the new chip list (freeform rule name strings) against this
    // camera's currently-named rule slots: frees any slot whose name was
    // removed, then claims a free slot (setting just its Name) for any
    // newly-typed name - the rest of that rule's fields default until the
    // user fills them in in the settings group that appears for it.
    async applyRuleSelection(camSlot: number, newNames: string[]): Promise<void> {
        const desired = newNames.map(n => n.trim()).filter(Boolean);
        const desiredSet = new Set(desired);

        for (let ruleSlot = 1; ruleSlot <= NUM_RULE_SLOTS; ruleSlot++) {
            const name = this.ruleName(camSlot, ruleSlot);
            if (name && !desiredSet.has(name))
                this.clearRuleSlot(camSlot, ruleSlot);
        }

        const currentNames = new Set(this.getRuleNamesForSlot(camSlot));
        for (const name of desired) {
            if (currentNames.has(name))
                continue;
            const freeSlot = this.findFreeRuleSlot(camSlot);
            if (freeSlot === undefined) {
                this.console.warn(`[${new Date().toLocaleTimeString()}]`, `Camera ${camSlot}: no free rule slots available (max ${NUM_RULE_SLOTS} reached) - cannot add rule "${name}". Increase NUM_RULE_SLOTS in main.ts if you need more.`);
                continue;
            }
            this.storage.setItem(`cam${camSlot}Rule${freeSlot}Name`, name);
            currentNames.add(name);
            this.console.log(`[${new Date().toLocaleTimeString()}]`, `Camera ${camSlot}: rule "${name}" added in slot ${freeSlot}`);
        }
    }

    private clearRuleSlot(camSlot: number, ruleSlot: number, log = true) {
        const cs = camSlot.toString();
        const rs = ruleSlot.toString();
        for (const suffix of RULE_FIELD_SUFFIXES)
            this.storage.removeItem(`cam${cs}Rule${rs}${suffix}`);
        if (log)
            this.console.log(`[${new Date().toLocaleTimeString()}]`, `Camera ${camSlot} Rule ${ruleSlot}: removed.`);
    }

    private clearCameraSlot(camSlot: number) {
        const cs = camSlot.toString();
        this.storage.removeItem(`cam${cs}Device`);
        this.storage.removeItem(`cam${cs}Enabled`);
        this.storage.removeItem(`cam${cs}NightModeOnly`);
        this.storage.removeItem(`cam${cs}ThumbnailWindow`);
        for (let ruleSlot = 1; ruleSlot <= NUM_RULE_SLOTS; ruleSlot++)
            this.clearRuleSlot(camSlot, ruleSlot, false);
        this.console.log(`[${new Date().toLocaleTimeString()}]`, `Camera ${camSlot}: removed (device and all its rules cleared).`);
    }

    private makeCameraSettings(camSlot: number): Record<string, any> {
        const cs = camSlot.toString();
        const onGet = async () => ({
            group: this.cameraGroupTitle(camSlot),
            hide: !this.isCameraSlotAssigned(camSlot),
        });
        return {
            // Underlying storage for which device occupies this slot - assigned
            // only via the top-level "Cameras" chip field's onPut
            // (applyCameraSelection), never rendered/edited directly.
            [`cam${cs}Device`]: {
                title: 'Camera Device',
                type: 'device',
                deviceFilter: `interfaces.includes('${ScryptedInterface.ObjectDetector}')`,
                hide: true,
            },
            [`cam${cs}Enabled`]: {
                title: 'Camera Enabled',
                description: 'Master switch for this camera. When off, no detections are processed and no rules fire for it, without losing its configuration.',
                type: 'boolean',
                value: true,
                immediate: true,
                onGet,
            },
            [`cam${cs}RulesField`]: {
                title: 'Rules',
                description: 'Add a rule by typing a name and pressing enter (e.g. "Frontyard Person"). A settings section for it appears below once added. Remove a rule by removing its chip here.',
                type: 'string',
                multiple: true,
                combobox: true,
                choices: [],
                noStore: true,
                onGet,
                onPut: async (oldValue: any, newValue: any) => {
                    await this.applyRuleSelection(camSlot, Array.isArray(newValue) ? newValue.map(String) : (newValue ? [String(newValue)] : []));
                },
            },
            [`cam${cs}NightModeOnly`]: {
                title: 'Night Mode Only',
                description: 'Only send notifications when night mode is active (after sunset).',
                type: 'boolean',
                value: false,
                immediate: true,
                onGet,
            },
            [`cam${cs}ThumbnailWindow`]: {
                title: 'Thumbnail Selection Window (seconds)',
                description: 'Collect detections for this many seconds and use the one with the widest bounding box for the thumbnail. 0 = use first detection frame immediately.',
                type: 'number',
                value: 0,
                onGet,
            },
        };
    }

    // One rule = one (className, zone) match for a single camera, rendered as
    // its own subgroup ("tab") within the camera's group, titled from the
    // rule's Name - which is now its identity, set only via that camera's
    // "Rules" chip field (applyRuleSelection), not edited directly here.
    private makeRuleSettings(camSlot: number, ruleSlot: number): Record<string, any> {
        const cs = camSlot.toString();
        const rs = ruleSlot.toString();
        const onGet = async () => ({
            group: this.cameraGroupTitle(camSlot),
            subgroup: this.ruleName(camSlot, ruleSlot),
            hide: !this.ruleName(camSlot, ruleSlot),
        });
        return {
            [`cam${cs}Rule${rs}Name`]: {
                title: 'Name',
                type: 'string',
                hide: true,
            },
            [`cam${cs}Rule${rs}ClassName`]: {
                title: 'Class Name',
                description: 'Detection class this rule matches.',
                type: 'string',
                combobox: true,
                choices: DETECTION_CLASS_CHOICES,
                onGet,
            },
            [`cam${cs}Rule${rs}Zone`]: {
                title: 'Zone',
                description: 'NVR zone this rule matches. Choices populate once a camera device is selected above.',
                type: 'string',
                combobox: true,
                choices: [],
                onGet: async () => {
                    const deviceId = this.resolveCameraDeviceId(camSlot);
                    const choices = deviceId ? await this.getCameraZoneChoices(deviceId) : [];
                    return {
                        group: this.cameraGroupTitle(camSlot),
                        subgroup: this.ruleName(camSlot, ruleSlot),
                        hide: !this.ruleName(camSlot, ruleSlot),
                        choices,
                    };
                },
            },
            [`cam${cs}Rule${rs}ScoreThreshold`]: {
                title: 'Score Threshold',
                description: 'Minimum detection confidence (0.0-1.0) required to match this rule.',
                type: 'number',
                range: [0, 1],
                value: 0.7,
                onGet,
            },
            [`cam${cs}Rule${rs}Critical`]: {
                title: 'Critical Alert',
                description: 'Send as a critical push notification (louder/DND-bypassing alert sound) instead of normal.',
                type: 'boolean',
                value: false,
                immediate: true,
                onGet,
            },
            [`cam${cs}Rule${rs}FixedCrop`]: {
                title: 'Fixed Crop',
                description: 'Optional "x,y,width,height" - bypasses the bounding-box crop entirely and always crops this fixed region instead.',
                type: 'string',
                placeholder: 'x,y,width,height',
                onGet,
            },
            [`cam${cs}Rule${rs}MinWidth`]: {
                title: 'Min Width (px)',
                description: 'Optional - skip detections whose bounding box width is smaller than this.',
                type: 'number',
                onGet,
            },
            [`cam${cs}Rule${rs}MinHeight`]: {
                title: 'Min Height (px)',
                description: 'Optional - skip detections whose bounding box height is smaller than this.',
                type: 'number',
                onGet,
            },
            [`cam${cs}Rule${rs}MaxX`]: {
                title: 'Max X (px)',
                description: 'Optional - skip detections whose bounding box starts beyond this x coordinate.',
                type: 'number',
                onGet,
            },
            [`cam${cs}Rule${rs}MaxY`]: {
                title: 'Max Y (px)',
                description: 'Optional - skip detections whose bounding box starts beyond this y coordinate.',
                type: 'number',
                onGet,
            },
        };
    }

    private makeRuleSettingsForCamera(camSlot: number): Record<string, any> {
        let merged: Record<string, any> = {};
        for (let ruleSlot = 1; ruleSlot <= NUM_RULE_SLOTS; ruleSlot++)
            merged = { ...merged, ...this.makeRuleSettings(camSlot, ruleSlot) };
        return merged;
    }

    private buildAllCameraSettings(): Record<string, any> {
        let merged: Record<string, any> = {};
        for (let camSlot = 1; camSlot <= NUM_CAMERA_SLOTS; camSlot++)
            merged = { ...merged, ...this.makeCameraSettings(camSlot), ...this.makeRuleSettingsForCamera(camSlot) };
        return merged;
    }

    constructor() {
        super();
        this.migrateLegacyRuleSettings()
            .then(() => this.migrateRuleNamesForChipUI())
            .then(() => this.ensureLocationDetected())
            .catch(e => this.console.error(`[${new Date().toLocaleTimeString()}]`, 'startup migration failed', e))
            .finally(() => {
                this.setupListeners();
                this.logWebhookUrl();
                this.scheduleSun();
                // Pre-warm the native-app notification metadata caches (serverId,
                // localAddresses, actionUrl) at startup instead of lazily on the
                // first real detection. These are independent, cacheable lookups
                // (see getServerId/getLocalAddresses/getActionCallbackUrl) that
                // used to add their full uncached latency, serially, to whichever
                // notification happened to fire first after every plugin restart.
                // Fire-and-forget: any resolution failure here just means the
                // normal lazy-resolve-and-cache path in sendPhonePush() runs as
                // before, so this is a pure optimization with no new failure mode.
                Promise.all([
                    this.getServerId(),
                    this.getLocalAddresses(),
                    this.getActionCallbackUrl(),
                ]).catch(e => this.console.warn(`[${new Date().toLocaleTimeString()}]`, 'Pre-warming notification metadata caches failed (will retry lazily on first notification)', e));
            });
    }

    // One-time migration: earlier plugin versions stored rules as a JSON blob per
    // camera (cam{N}Rules, a free-text textarea). That's replaced by structured
    // per-rule-slot settings (cam{N}Rule{M}ClassName/Zone/etc.) for a proper
    // dropdown-based UI. If a legacy JSON value is still present and the new
    // slots for that camera haven't been touched yet, parse it once, populate
    // the new fields, then clear the old key so it doesn't linger as dead,
    // confusing storage. No-ops quickly (a handful of sync storage reads) once
    // migration has already happened.
    async migrateLegacyRuleSettings(): Promise<void> {
        for (let camSlot = 1; camSlot <= NUM_CAMERA_SLOTS; camSlot++) {
            const cs = camSlot.toString();
            const legacyRaw = this.storage.getItem(`cam${cs}Rules`);
            if (!legacyRaw)
                continue;

            // Already migrated, or the user already configured rule 1 manually - don't clobber.
            if (this.storage.getItem(`cam${cs}Rule1ClassName`))
                continue;

            let legacyRules: any[];
            try {
                legacyRules = JSON.parse(legacyRaw);
                if (!Array.isArray(legacyRules))
                    throw new Error('not an array');
            }
            catch (e) {
                this.console.warn(`[${new Date().toLocaleTimeString()}]`, `Camera ${camSlot}: could not parse legacy cam${cs}Rules JSON for migration, leaving it as-is`, e);
                continue;
            }

            if (legacyRules.length > NUM_RULE_SLOTS) {
                this.console.warn(`[${new Date().toLocaleTimeString()}]`, `Camera ${camSlot}: legacy rules JSON has ${legacyRules.length} rules but only ${NUM_RULE_SLOTS} rule slots are available - the extra ${legacyRules.length - NUM_RULE_SLOTS} will be dropped. Increase NUM_RULE_SLOTS in main.ts if you need more.`);
            }

            const migrateCount = Math.min(legacyRules.length, NUM_RULE_SLOTS);
            for (let i = 0; i < migrateCount; i++) {
                const rule = legacyRules[i] ?? {};
                const rs = (i + 1).toString();
                if (rule.className) await this.settingsStorage.putSetting(`cam${cs}Rule${rs}ClassName`, rule.className);
                if (rule.zone) await this.settingsStorage.putSetting(`cam${cs}Rule${rs}Zone`, rule.zone);
                if (rule.scoreThreshold !== undefined) await this.settingsStorage.putSetting(`cam${cs}Rule${rs}ScoreThreshold`, rule.scoreThreshold);
                if (rule.critical !== undefined) await this.settingsStorage.putSetting(`cam${cs}Rule${rs}Critical`, !!rule.critical);
                if (rule.minWidth !== undefined) await this.settingsStorage.putSetting(`cam${cs}Rule${rs}MinWidth`, rule.minWidth);
                if (rule.minHeight !== undefined) await this.settingsStorage.putSetting(`cam${cs}Rule${rs}MinHeight`, rule.minHeight);
                if (rule.maxX !== undefined) await this.settingsStorage.putSetting(`cam${cs}Rule${rs}MaxX`, rule.maxX);
                if (rule.maxY !== undefined) await this.settingsStorage.putSetting(`cam${cs}Rule${rs}MaxY`, rule.maxY);
                if (Array.isArray(rule.fixedCrop) && rule.fixedCrop.length === 4) await this.settingsStorage.putSetting(`cam${cs}Rule${rs}FixedCrop`, rule.fixedCrop.join(','));
            }

            this.storage.removeItem(`cam${cs}Rules`);
            this.console.log(`[${new Date().toLocaleTimeString()}]`, `Camera ${camSlot}: migrated ${migrateCount} legacy rule(s) from cam${cs}Rules JSON into the new structured rule settings.`);
        }
    }

    // One-time migration for the chip-based Rules UI: a rule's Name field is
    // now its identity (it's what appears as a chip, and what drives that
    // rule's settings section being shown at all) - previously Name was
    // optional, used only for display/log lines. Any existing rule that has a
    // ClassName (i.e. is a real, working rule) but no Name would otherwise be
    // invisible in the new UI, since unnamed slots render as if empty. Runs
    // once at startup, after the legacy JSON migration above; auto-generates
    // a Name exactly the way the previous UI's fallback subgroup title did
    // ("{className} in {zone}", or just "{className}" if no zone yet), so
    // every pre-existing rule shows up as a chip immediately after upgrading
    // with no re-entry required. No-ops on subsequent startups once every
    // rule has a Name.
    async migrateRuleNamesForChipUI(): Promise<void> {
        for (let camSlot = 1; camSlot <= NUM_CAMERA_SLOTS; camSlot++) {
            const cs = camSlot.toString();
            for (let ruleSlot = 1; ruleSlot <= NUM_RULE_SLOTS; ruleSlot++) {
                const rs = ruleSlot.toString();
                const className = this.storage.getItem(`cam${cs}Rule${rs}ClassName`);
                if (!className)
                    continue; // slot unused
                const nameKey = `cam${cs}Rule${rs}Name`;
                if (this.storage.getItem(nameKey))
                    continue; // already named
                const zone = this.storage.getItem(`cam${cs}Rule${rs}Zone`);
                const generatedName = zone ? `${className} in ${zone}` : className;
                this.storage.setItem(nameKey, generatedName);
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Camera ${camSlot} Rule ${ruleSlot}: auto-generated Name "${generatedName}" so this pre-existing rule appears as a chip in the new Rules UI.`);
            }
        }
    }

    getScryptedNotifierDevices(): { id: string, key: string }[] {
        try {
            return Object.entries(systemManager.getSystemState())
                .filter(([, d]: [string, any]) => d?.interfaces?.value?.includes(ScryptedInterface.Notifier))
                .filter(([id]) => {
                    // Exclude Notifier devices synced in by the HA plugin - HA is no
                    // longer part of the notification path, so these shouldn't be
                    // selectable here even though the HA plugin itself may still be
                    // running on this server for other purposes.
                    try {
                        return systemManager.getDeviceById(id)?.pluginId !== HOMEASSISTANT_PLUGIN_ID;
                    } catch (e) {
                        return true;
                    }
                })
                .map(([id, d]: [string, any]) => {
                    // Prefer the device's own display name - far more intuitive in the
                    // settings dropdown than a raw nativeId (e.g. "114:a3753ebf" for the
                    // native Scrypted NVR user-device). Falls back to nativeId (domain
                    // prefix stripped, e.g. "notify:foo" -> "foo") or the raw device id
                    // only if the device has no name at all.
                    const name = d?.name?.value as string;
                    const nativeId = d?.nativeId?.value as string;
                    const strippedNativeId = nativeId?.includes(':') ? nativeId.split(':').slice(1).join(':') : nativeId;
                    const key = name || strippedNativeId || id;
                    return { id, key };
                })
                .filter(entry => Boolean(entry.key) && entry.key !== 'notify'); // exclude generic catch-all
        } catch (e) {
            this.console.warn(`[${new Date().toLocaleTimeString()}]`, 'Failed to get Scrypted notifier devices:', e);
            return [];
        }
    }

    getScryptedNotifierChoices(): string[] {
        return this.getScryptedNotifierDevices().map(d => d.key).sort();
    }

    getNotifierDeviceIdMap(): Record<string, string> {
        const map: Record<string, string> = {};
        for (const { id, key } of this.getScryptedNotifierDevices())
            map[key] = id;
        return map;
    }

    // Zone names aren't exposed as a first-class SDK property - they live inside
    // the object detection plugin's own settings on the camera device, under a key
    // matching /objectdetectionplugin:.*:zones/. Confirmed by reading
    // scrypted-advanced-notifier's source (src/cameraMixin.ts getObserveZones()).
    // Cached briefly per device id, since each visible rule slot's Zone dropdown
    // calls this independently via its own onGet - without a cache, a camera with
    // several rule slots would trigger that many redundant device.getSettings()
    // round trips on every single settings-panel load.
    zoneChoicesCache: Map<string, { choices: string[], expires: number }> = new Map();

    async getCameraZoneChoices(cameraDeviceId: string): Promise<string[]> {
        const cached = this.zoneChoicesCache.get(cameraDeviceId);
        if (cached && cached.expires > Date.now())
            return cached.choices;
        try {
            const device: any = systemManager.getDeviceById(cameraDeviceId);
            if (!device || typeof device.getSettings !== 'function')
                return [];
            const deviceSettings: any[] = await device.getSettings();
            const zonesSetting = deviceSettings.find((setting: any) =>
                /objectdetectionplugin:.*:zones/.test(setting?.key ?? '')
            );
            const zones = zonesSetting?.value;
            const choices = Array.isArray(zones) ? zones.filter(Boolean) : [];
            this.zoneChoicesCache.set(cameraDeviceId, { choices, expires: Date.now() + 5000 });
            return choices;
        }
        catch (e) {
            this.console.warn(`[${new Date().toLocaleTimeString()}]`, `Failed to enumerate zones for camera device ${cameraDeviceId}:`, e);
            return [];
        }
    }

    async getSettings(): Promise<Setting[]> {
        const settings = await this.settingsStorage.getSettings();
        // The Cameras/Rules chip fields are noStore - nothing is persisted
        // under their own key, so their displayed value is computed fresh
        // here on every load by reading the actual per-slot storage of
        // record (cam{N}Device / cam{N}Rule{M}Name), rather than relying on
        // StorageSettings' normal value-from-storage lookup.
        for (const s of settings) {
            if (s.key === 'camerasField') {
                (s as any).value = this.getAssignedCameraDeviceIds();
                continue;
            }
            const match = /^cam(\d+)RulesField$/.exec(s.key ?? '');
            if (match)
                (s as any).value = this.getRuleNamesForSlot(parseInt(match[1], 10));
        }
        return settings;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        // Validate the new structured rule fields before saving
        if (/^cam\d+Rule\d+FixedCrop$/.test(key) && value) {
            const parts = String(value).split(',').map(s => s.trim());
            if (parts.length !== 4 || parts.some(p => !Number.isFinite(Number(p))))
                throw new Error('"Fixed Crop" must be four comma-separated numbers: x,y,width,height');
        }
        if (/^cam\d+Rule\d+ScoreThreshold$/.test(key) && value !== '' && value !== undefined) {
            const num = Number(value);
            if (!Number.isFinite(num) || num < 0 || num > 1)
                throw new Error('"Score Threshold" must be a number between 0 and 1');
        }
        await this.settingsStorage.putSetting(key, value);
        // Re-setup listeners if a camera or rule field changed, or the master switch was flipped
        if (key.startsWith('cam') || key === 'pluginEnabled') {
            this.setupListeners();
        }
        // Re-schedule sun if lat/lng changed
        if (key === 'latitude' || key === 'longitude') {
            this.scheduleSun();
        }
    }

    // ---- Settings helpers ----

    get pluginEnabled(): boolean {
        return this.settingsStorage.values.pluginEnabled !== false;
    }

    get tvOverlayEnabled(): boolean {
        return this.settingsStorage.values.tvOverlayEnabled !== false;
    }

    get notifyServices(): string[] {
        const val = this.settingsStorage.values.notifyServices;
        if (Array.isArray(val)) return val.filter(Boolean);
        if (typeof val === 'string' && val) return [val];
        return [];
    }

    get tvHosts(): string[] {
        const raw = (this.settingsStorage.values.tvHosts as string) || '';
        return raw.split(',').map(s => s.trim()).filter(Boolean);
    }

    get notificationDurationSeconds(): number {
        return Number(this.settingsStorage.values.notificationDurationSeconds) || 10;
    }

    get debounceSeconds(): number {
        return Number(this.settingsStorage.values.debounceSeconds) || 180;
    }

    get paddingFactor(): number {
        const val = Number(this.settingsStorage.values.paddingFactor);
        return Number.isFinite(val) && val >= 0 ? val : 0.5;
    }

    get maxHeightRatio(): number {
        const raw = this.settingsStorage.values.maxHeightRatio;
        // An unset/blank value should fall back to the schema default (1.0,
        // square) - not silently disable the ratio cap. Only a genuine
        // numeric 0 (or negative/garbage) means "no limit". Number('') is 0,
        // not NaN, so without this explicit check an empty stored value was
        // indistinguishable from someone deliberately typing 0.
        if (raw === undefined || raw === null || raw === '')
            return 1.0;
        const val = Number(raw);
        return Number.isFinite(val) && val > 0 ? val : 0;
    }

    get maxLongSide(): number {
        const val = Number(this.settingsStorage.values.maxLongSide);
        return Number.isFinite(val) && val > 0 ? val : 0;
    }


    get snoozeOptions(): { title: string, minutes: number }[] {
        const raw = (this.settingsStorage.values.snoozeMinutes as string) || '10, 30, 60';
        return raw.split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => Number.isFinite(n) && n > 0)
            .map(minutes => ({
                // Plain-text titles (no emoji) - the snooze *duration* actually applied
                // is fully determined by the `minutes` value baked into the action id
                // itself (buildSnoozeAction), not by this title, so this is purely
                // cosmetic. Kept emoji-free to rule out any chance of a client-side
                // rendering/encoding quirk with non-ASCII title content, since iOS
                // was observed not honoring the configured title at all - see
                // PROJECT-CONTEXT.md "iOS action buttons" notes.
                title: minutes >= 60 && minutes % 60 === 0
                    ? `Snooze ${minutes / 60}hr${minutes / 60 > 1 ? 's' : ''}`
                    : `Snooze ${minutes}min`,
                minutes,
            }));
    }

    // Unlike the other numeric getters in this file, these deliberately have no
    // hardcoded fallback value - there's no location that's a sane default for
    // every installer of a public plugin. `undefined` means "not configured yet"
    // and is handled explicitly by scheduleSun() (night mode simply stays off
    // until a location is set via ensureLocationDetected()/detectLocation() or
    // manual entry).
    get latitude(): number | undefined {
        const raw = this.settingsStorage.values.latitude;
        if (raw === undefined || raw === null || raw === '')
            return undefined;
        const val = Number(raw);
        return Number.isFinite(val) ? val : undefined;
    }

    get longitude(): number | undefined {
        const raw = this.settingsStorage.values.longitude;
        if (raw === undefined || raw === null || raw === '')
            return undefined;
        const val = Number(raw);
        return Number.isFinite(val) ? val : undefined;
    }

    getCameraConfigs(): CameraRelayConfig[] {
        const configs: CameraRelayConfig[] = [];
        for (let slot = 1; slot <= NUM_CAMERA_SLOTS; slot++) {
            const s = slot.toString();
            const rawDeviceId = this.settingsStorage.values[`cam${s}Device`];
            if (!rawDeviceId)
                continue;
            // Device picker may return a string like "ScryptedDevice-272" or a numeric id
            const rawStr = String(rawDeviceId);
            const deviceId = rawStr.replace(/^ScryptedDevice-/, '');

            const rules: ClassZoneRule[] = [];
            for (let ruleSlot = 1; ruleSlot <= NUM_RULE_SLOTS; ruleSlot++) {
                const rs = ruleSlot.toString();
                const className = (this.settingsStorage.values[`cam${s}Rule${rs}ClassName`] as string || '').trim();
                const zone = (this.settingsStorage.values[`cam${s}Rule${rs}Zone`] as string || '').trim();
                if (!className || !zone)
                    continue; // unused rule slot

                const name = (this.settingsStorage.values[`cam${s}Rule${rs}Name`] as string || '').trim() || undefined;
                const scoreThresholdRaw = this.settingsStorage.values[`cam${s}Rule${rs}ScoreThreshold`];
                const scoreThreshold = Number.isFinite(Number(scoreThresholdRaw)) ? Number(scoreThresholdRaw) : 0.7;
                const critical = Boolean(this.settingsStorage.values[`cam${s}Rule${rs}Critical`]);

                const rule: ClassZoneRule = { name, className, zone, scoreThreshold, critical };

                const minWidthRaw = this.settingsStorage.values[`cam${s}Rule${rs}MinWidth`];
                if (minWidthRaw !== undefined && minWidthRaw !== '' && Number.isFinite(Number(minWidthRaw)))
                    rule.minWidth = Number(minWidthRaw);
                const minHeightRaw = this.settingsStorage.values[`cam${s}Rule${rs}MinHeight`];
                if (minHeightRaw !== undefined && minHeightRaw !== '' && Number.isFinite(Number(minHeightRaw)))
                    rule.minHeight = Number(minHeightRaw);
                const maxXRaw = this.settingsStorage.values[`cam${s}Rule${rs}MaxX`];
                if (maxXRaw !== undefined && maxXRaw !== '' && Number.isFinite(Number(maxXRaw)))
                    rule.maxX = Number(maxXRaw);
                const maxYRaw = this.settingsStorage.values[`cam${s}Rule${rs}MaxY`];
                if (maxYRaw !== undefined && maxYRaw !== '' && Number.isFinite(Number(maxYRaw)))
                    rule.maxY = Number(maxYRaw);

                const fixedCropRaw = (this.settingsStorage.values[`cam${s}Rule${rs}FixedCrop`] as string || '').trim();
                if (fixedCropRaw) {
                    const parts = fixedCropRaw.split(',').map(p => Number(p.trim()));
                    if (parts.length === 4 && parts.every(Number.isFinite))
                        rule.fixedCrop = parts as [number, number, number, number];
                    else
                        this.console.warn(`[${new Date().toLocaleTimeString()}]`, `Camera ${slot} Rule ${ruleSlot}: invalid Fixed Crop "${fixedCropRaw}", ignoring`);
                }

                rules.push(rule);
            }

            const enabled = this.settingsStorage.values[`cam${s}Enabled`] !== false;
            const nightModeOnly = Boolean(this.settingsStorage.values[`cam${s}NightModeOnly`]);

            const thumbnailWindow = Number(this.settingsStorage.values[`cam${s}ThumbnailWindow`]) || 0;
            configs.push({ id: deviceId, enabled, nightModeOnly, rules, thumbnailWindow });
        }
        return configs;
    }

    // ---- Snooze handling ----

    snoozeKey(cameraId: string, className: string): string {
        return `${cameraId}-${className}`;
    }

    isSnoozed(cameraId: string, className: string): boolean {
        const key = this.snoozeKey(cameraId, className);
        const until = this.snoozedUntil[key];
        return typeof until === 'number' && Date.now() < until;
    }

    setSnoozed(cameraId: string, className: string, minutes: number) {
        const key = this.snoozeKey(cameraId, className);
        this.snoozedUntil[key] = Date.now() + minutes * 60 * 1000;
        this.console.log(`[${new Date().toLocaleTimeString()}]`, `Snoozed ${key} for ${minutes} minutes`);
    }

    // ---- Webhook URL ----

    async logWebhookUrl() {
        const em: any = endpointManager;
        const attempts: { label: string, fn: () => Promise<string> }[] = [
            { label: 'getInsecurePublicLocalEndpoint', fn: () => em.getInsecurePublicLocalEndpoint?.() },
            { label: 'getPublicLocalEndpoint', fn: () => em.getPublicLocalEndpoint?.() },
            { label: 'getLocalEndpoint', fn: () => em.getLocalEndpoint?.() },
            { label: 'getPublicCloudEndpoint', fn: () => em.getPublicCloudEndpoint?.() },
        ];

        for (const attempt of attempts) {
            try {
                const url = await attempt.fn();
                if (url)
                    this.console.log(`[${new Date().toLocaleTimeString()}]`, `Webhook URL (${attempt.label}): ${url}`);
            }
            catch (e) {
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `endpointManager.${attempt.label} not available or failed`, e?.message ?? e);
            }
        }
    }

    // ---- HTTP handler (snooze webhook) ----

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        try {
            const url = new URL(request.url, 'http://localhost');

            let actionString = url.searchParams.get('action');
            let actionIdFromBody: string | undefined;
            let snoozeIdFromBody: string | undefined;
            if (!actionString && request.body) {
                try {
                    const parsed = JSON.parse(request.body);
                    // Native Scrypted app POSTs { snoozeId, actionId } when a
                    // notification action button is tapped. { action } and the
                    // ?action= query param are also accepted as generic fallbacks
                    // (e.g. manual testing via curl) - snoozeId isn't needed for
                    // this plugin's own action strings since they're already
                    // self-describing (see buildSnoozeAction), but it IS needed
                    // below to decode iOS's own native snooze action format.
                    actionIdFromBody = parsed?.actionId;
                    snoozeIdFromBody = parsed?.snoozeId;
                    actionString = parsed?.action ?? parsed?.actionId;
                }
                catch (e) {
                    actionString = request.body;
                }
            }

            // Try this plugin's own action format first (Android, and manual/curl
            // testing), then fall back to decoding iOS's built-in native snooze
            // action format (see parseNativeIosSnoozeAction) before giving up.
            const parsedAction = parseSnoozeAction(actionString ?? '')
                ?? parseNativeIosSnoozeAction(actionIdFromBody, snoozeIdFromBody);
            if (!parsedAction) {
                this.console.warn(`[${new Date().toLocaleTimeString()}]`, `onRequest: could not parse snooze action from actionString="${actionString}" actionId="${actionIdFromBody}" snoozeId="${snoozeIdFromBody}"`);
                response.send(`Could not parse snooze action from: ${actionString}`, { code: 400 });
                return;
            }

            this.setSnoozed(parsedAction.cameraId, parsedAction.className, parsedAction.minutes);
            response.send(`Snoozed ${parsedAction.className} on camera ${parsedAction.cameraId} for ${parsedAction.minutes} minutes.`, { code: 200 });
        }
        catch (e) {
            this.console.error(`[${new Date().toLocaleTimeString()}]`, 'onRequest (snooze webhook) failed', e);
            response.send('Internal error', { code: 500 });
        }
    }

    // ---- Native Scrypted app notification support ----
    // The Scrypted app's own push notifications read an undocumented set of
    // NotifierOptions.data fields. These three helpers resolve what
    // scrypted-advanced-notifier's source showed is needed.

    async getServerId(): Promise<string | undefined> {
        if (this.cachedServerId)
            return this.cachedServerId;
        try {
            const mo = await mediaManager.createMediaObject('', 'text/plain');
            const serverId: string = await mediaManager.convertMediaObject(mo, ScryptedMimeTypes.ServerId);
            this.cachedServerId = serverId;
            return serverId;
        }
        catch (e) {
            this.console.warn(`[${new Date().toLocaleTimeString()}]`, 'Failed to resolve Scrypted server id (needed for native app timeline deep link)', e);
            return undefined;
        }
    }

    async getLocalAddresses(): Promise<string[] | undefined> {
        if (this.cachedLocalAddresses)
            return this.cachedLocalAddresses;
        try {
            const em: any = endpointManager;
            const addresses = await em.getLocalAddresses?.();
            if (addresses)
                this.cachedLocalAddresses = addresses;
            return addresses;
        }
        catch (e) {
            this.console.warn(`[${new Date().toLocaleTimeString()}]`, 'Failed to resolve local addresses (needed for native app timeline deep link)', e);
            return undefined;
        }
    }

    // Public URL the native Scrypted app POSTs { snoozeId, actionId } to when a
    // notification action button is tapped. Must be reachable from the phone itself
    // (not just localhost), so this prefers the public cloud endpoint - matches this
    // deployment's existing cloud-mode setup via home.scrypted.app.
    async getActionCallbackUrl(): Promise<string | undefined> {
        if (this.cachedActionUrl)
            return this.cachedActionUrl;
        const em: any = endpointManager;
        const attempts: (() => Promise<string>)[] = [
            () => em.getCloudEndpoint?.(undefined, { public: true }),
            () => em.getPublicCloudEndpoint?.(),
            () => em.getPublicLocalEndpoint?.(),
            () => em.getLocalEndpoint?.(),
        ];
        for (const attempt of attempts) {
            try {
                const url = await attempt();
                if (url) {
                    this.cachedActionUrl = url;
                    return url;
                }
            }
            catch (e) {
                // try next
            }
        }
        this.console.warn(`[${new Date().toLocaleTimeString()}]`, 'Could not resolve a public webhook URL for native Scrypted notification action callbacks');
        return undefined;
    }

    // ---- Phone push ----

    async sendPhonePush(cameraName: string, cameraId: string, className: string, title: string, thumbnail: { dataUrl: string, buffer: Buffer } | undefined, eventData?: any, eventDetails?: EventDetails, critical?: boolean) {
        const actions = this.snoozeOptions.map(opt => ({
            action: buildSnoozeAction(cameraId, className, opt.minutes),
            title: opt.title,
        }));

        const channel = className.charAt(0).toUpperCase() + className.slice(1);

        // These four are all independent of each other (three cached metadata
        // lookups + one MediaObject conversion) - resolved in parallel rather than
        // as four sequential awaits. After the first notification following a
        // plugin restart, the metadata three are cache hits anyway (see the
        // startup pre-warm in the constructor), so this mainly shortens that
        // first-notification-after-restart case plus the always-uncached media
        // conversion.
        const mediaPromise: Promise<MediaObject | undefined> = thumbnail?.buffer
            ? mediaManager.createMediaObject(thumbnail.buffer, 'image/jpeg')
                .catch(e => {
                    this.console.warn(`[${new Date().toLocaleTimeString()}]`, 'Failed to create MediaObject for phone push image', e);
                    return undefined;
                })
            : Promise.resolve(undefined);

        const [serverId, localAddresses, actionUrl, media] = await Promise.all([
            this.getServerId(),
            this.getLocalAddresses(),
            this.getActionCallbackUrl(),
            mediaPromise,
        ]);
        const snoozeId = this.snoozeKey(cameraId, className);
        // Tap-to-timeline route for the native Scrypted app: a bare hash fragment with
        // a serverId, since that's the shape the app's own internal navigation expects
        // (confirmed via scrypted-advanced-notifier's getUrls()).
        const nativeHash = `#/timeline/${cameraId}?time=${Date.now()}&from=notification&serverId=${serverId ?? ''}&disableTransition=true`;

        const notifierOptions: NotifierOptions = {
            body: `${channel} Detected. Tap to view.`,
            // android.channel is not read by the native Scrypted notifier (only by
            // the HA companion app, which is no longer in the loop) - omitted.
            // critical is an official NotifierOptions field the native app does read;
            // it's the closest equivalent to HA's per-channel custom sound assignment
            // now available without HA in the loop - set per rule via ClassZoneRule's
            // "critical" flag. The distinct alert sound itself is still configured
            // once on the phone's own OS notification settings for this app, same as
            // it would be for any Android/iOS critical-alert channel.
            critical: !!critical,
            actions,
            data: {
                // Fields read by the native Scrypted app (undocumented in the SDK -
                // discovered by reading scrypted-advanced-notifier's source).
                // hash/localAddresses drive tap-to-open-timeline; actionUrl/snoozeId are
                // required for the app to POST back { snoozeId, actionId } when an
                // action button is tapped - without them the buttons either don't
                // render or do nothing when tapped.
                hash: nativeHash,
                localAddresses,
                actionUrl,
                snoozeId,
            },
        };

        const deviceIdMap = this.getNotifierDeviceIdMap();
        await Promise.all(this.notifyServices.map(async service => {
            const deviceId = deviceIdMap[service];
            const device: any = deviceId ? systemManager.getDeviceById(deviceId) : undefined;
            if (!device) {
                this.console.warn(`[${new Date().toLocaleTimeString()}]`, `Notifier device not found for service: ${service}`);
                return;
            }
            try {
                await device.sendNotification(title, notifierOptions, media);
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Sent notification for ${cameraName} ${className} via ${service}`);
            }
            catch (e) {
                this.console.error(`[${new Date().toLocaleTimeString()}]`, `sendPhonePush (Notifier) failed for ${service}`, e);
            }
        }));
    }

    // ---- TV overlay ----

    async notifyTvs(cameraName: string, className: string, imageDataUrl: string | undefined) {
        if (!this.tvOverlayEnabled)
            return;

        const rawBase64 = imageDataUrl?.includes(',')
            ? imageDataUrl.substring(imageDataUrl.indexOf(',') + 1)
            : imageDataUrl;

        const payload = {
            title: cameraName,
            message: `${className.charAt(0).toUpperCase()}${className.slice(1)} Detected`,
            image: rawBase64 ?? null,
            largeIcon: className === 'vehicle' ? 'mdi:car-side' : 'mdi:motion-sensor',
            corner: 'bottom_end',
            seconds: this.notificationDurationSeconds,
        };

        for (const tvHost of this.tvHosts) {
            fetch(`${tvHost}/notify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
                .then(res => this.console.log(`[${new Date().toLocaleTimeString()}]`, `TvOverlay response from ${tvHost}: ${res.status}`))
                .catch(e => this.console.warn(`[${new Date().toLocaleTimeString()}]`, 'TvOverlay relay failed for', tvHost, e));
        }
    }

    // ---- Sun scheduling ----

    // ---- Location detection ----
    // Resolves an approximate Latitude/Longitude from this Scrypted server's own
    // public IP address. Tries a short chain of free, no-key IP-geolocation
    // APIs in order rather than depending on a single one - ipapi.co's free
    // tier rate-limits fairly aggressively (HTTP 429s observed live, especially
    // since every plugin restart during testing re-triggers this via
    // ensureLocationDetected() whenever lat/long are still blank, and shared/
    // cloud IPs can be rate-limited server-side regardless of request volume).
    // Each provider has its own response shape, hence the per-provider `parse`.
    static readonly IP_LOCATION_PROVIDERS: {
        name: string;
        url: string;
        parse: (data: any) => { latitude: number, longitude: number, place?: string } | undefined;
    }[] = [
        {
            name: 'ipapi.co',
            url: 'https://ipapi.co/json/',
            parse: (data: any) => (typeof data?.latitude === 'number' && typeof data?.longitude === 'number')
                ? { latitude: data.latitude, longitude: data.longitude, place: [data.city, data.region].filter(Boolean).join(', ') }
                : undefined,
        },
        {
            name: 'ipwho.is',
            url: 'https://ipwho.is/',
            parse: (data: any) => (data?.success !== false && typeof data?.latitude === 'number' && typeof data?.longitude === 'number')
                ? { latitude: data.latitude, longitude: data.longitude, place: [data.city, data.region].filter(Boolean).join(', ') }
                : undefined,
        },
        {
            name: 'freeipapi.com',
            url: 'https://freeipapi.com/api/json',
            parse: (data: any) => (typeof data?.latitude === 'number' && typeof data?.longitude === 'number')
                ? { latitude: data.latitude, longitude: data.longitude, place: [data.cityName, data.regionName].filter(Boolean).join(', ') }
                : undefined,
        },
    ];

    // Writes through settingsStorage.putSetting() rather than this.storage
    // directly so the existing putSetting() hook (which already re-runs
    // scheduleSun() whenever latitude/longitude change) fires normally - no
    // separate reschedule call needed here.
    async detectLocation(): Promise<boolean> {
        for (const provider of SmartDetectionRelayPlugin.IP_LOCATION_PROVIDERS) {
            try {
                const response = await fetch(provider.url);
                if (!response.ok) {
                    this.console.warn(`[${new Date().toLocaleTimeString()}]`, `Location detection via ${provider.name} failed: HTTP ${response.status}${response.status === 429 ? ' (rate limited)' : ''} - trying next provider`);
                    continue;
                }
                const data = await response.json();
                const parsed = provider.parse(data);
                if (!parsed) {
                    this.console.warn(`[${new Date().toLocaleTimeString()}]`, `Location detection via ${provider.name} returned an unusable response: ${JSON.stringify(data)} - trying next provider`);
                    continue;
                }

                await this.settingsStorage.putSetting('latitude', parsed.latitude);
                await this.settingsStorage.putSetting('longitude', parsed.longitude);
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Detected location via IP geolocation (${provider.name}): ${parsed.latitude}, ${parsed.longitude}${parsed.place ? ` (near ${parsed.place})` : ''}`);
                return true;
            }
            catch (e) {
                this.console.warn(`[${new Date().toLocaleTimeString()}]`, `Location detection via ${provider.name} failed`, e);
            }
        }
        this.console.warn(`[${new Date().toLocaleTimeString()}]`, 'Location detection failed on all providers - enter Latitude/Longitude manually if night-mode-only cameras are used');
        return false;
    }

    // Clears both fields directly via this.storage (consistent with how
    // clearCameraSlot()/clearRuleSlot() already bypass putSetting() for bulk
    // clears) and stops any in-flight sun timer immediately, rather than
    // waiting for scheduleSun() to notice on its next callback.
    async clearLocation(): Promise<void> {
        this.storage.removeItem('latitude');
        this.storage.removeItem('longitude');
        if (this.sunTimer) {
            clearTimeout(this.sunTimer);
            this.sunTimer = null;
        }
        this.isNightMode = false;
        this.console.log(`[${new Date().toLocaleTimeString()}]`, 'Location cleared - night mode disabled (night-mode-only cameras will not suppress notifications) until a location is set again via "Detect Location" or manual entry.');
    }

    // Called once at startup (see constructor). Only auto-detects if
    // Latitude/Longitude are genuinely unset - never overwrites a value the
    // user (or a prior detectLocation() run) already put there, so upgrading
    // an existing install with manually-entered coordinates is a no-op here.
    async ensureLocationDetected(): Promise<void> {
        if (this.latitude !== undefined && this.longitude !== undefined) {
            this.console.log(`[${new Date().toLocaleTimeString()}]`, `Using previously-configured location: ${this.latitude}, ${this.longitude}`);
            return;
        }
        this.console.log(`[${new Date().toLocaleTimeString()}]`, 'No Latitude/Longitude configured yet - attempting automatic IP-based location detection...');
        await this.detectLocation();
    }

    private async fetchSunTimes(latitude: number, longitude: number, dateStr?: string): Promise<{ sunrise: Date; sunset: Date }> {
        // Always pass an explicit date rather than relying on the API's own
        // "today" default. Right around local midnight that default has been
        // observed to resolve to the previous calendar day, which caused
        // scheduleSun() to keep re-arming a "wait until next midnight" timer
        // instead of ever hitting the sunrise branch (night mode stuck ON).
        const date = dateStr ?? localDateString();
        const url = `https://api.sunrisesunset.io/json?lat=${latitude}&lng=${longitude}&formatted=0&date=${date}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.status !== 'OK')
            throw new Error(`sunrisesunset.io API error: ${data.status}`);
        return {
            sunrise: new Date(data.results.sunrise),
            sunset:  new Date(data.results.sunset),
        };
    }

    private async scheduleSun() {
        if (this.sunTimer) clearTimeout(this.sunTimer);

        // No location configured yet (fresh install where auto-detect failed,
        // or explicitly cleared via clearLocation()) - night-mode-only cameras
        // just won't suppress anything until Latitude/Longitude are set, rather
        // than scheduling against a meaningless placeholder coordinate.
        const { latitude, longitude } = this;
        if (latitude === undefined || longitude === undefined) {
            this.isNightMode = false;
            this.console.log(`[${new Date().toLocaleTimeString()}]`, 'scheduleSun: no Latitude/Longitude configured - night mode disabled (night-mode-only cameras will not suppress notifications) until a location is set via "Detect Location" or manual entry.');
            return;
        }

        try {
            const now = new Date();
            let { sunrise, sunset } = await this.fetchSunTimes(latitude, longitude, localDateString(now));

            // Safety net: if the API still handed back a stale/previous day's
            // times (both already in the past), explicitly re-fetch for
            // tomorrow's date instead of falling into the "wait 24h" branch
            // below, which would leave night mode stuck ON for a full day.
            if (now >= sunrise && now >= sunset) {
                const tomorrow = new Date(now);
                tomorrow.setDate(tomorrow.getDate() + 1);
                this.console.warn(`[${new Date().toLocaleTimeString()}]`, `scheduleSun: fetched sun times (sunrise=${sunrise.toLocaleTimeString()}, sunset=${sunset.toLocaleTimeString()}) are both already in the past - retrying with tomorrow's date (${localDateString(tomorrow)}) to avoid getting stuck in night mode.`);
                ({ sunrise, sunset } = await this.fetchSunTimes(latitude, longitude, localDateString(tomorrow)));
            }

            if (now < sunrise) {
                this.isNightMode = true;
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Night mode ON. Sunrise at ${sunrise.toLocaleTimeString()}, in ${Math.round((sunrise.getTime() - now.getTime()) / 60000)} minutes.`);
                this.sunTimer = setTimeout(() => {
                    this.isNightMode = false;
                    this.console.log(`[${new Date().toLocaleTimeString()}]`, 'Night mode OFF (sunrise)');
                    this.scheduleSun();
                }, sunrise.getTime() - now.getTime());
            } else if (now < sunset) {
                this.isNightMode = false;
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Night mode OFF. Sunset at ${sunset.toLocaleTimeString()}, in ${Math.round((sunset.getTime() - now.getTime()) / 60000)} minutes.`);
                this.sunTimer = setTimeout(() => {
                    this.isNightMode = true;
                    this.console.log(`[${new Date().toLocaleTimeString()}]`, 'Night mode ON (sunset)');
                    this.scheduleSun();
                }, sunset.getTime() - now.getTime());
            } else {
                this.isNightMode = true;
                this.console.log(`[${new Date().toLocaleTimeString()}]`, "Night mode ON. Rescheduling after midnight for tomorrow's times.");
                const midnight = new Date();
                midnight.setHours(24, 1, 0, 0);
                const delayToMidnight = midnight.getTime() - now.getTime();
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Midnight reschedule in ${Math.round(delayToMidnight / 60000)} minutes.`);
                this.sunTimer = setTimeout(() => {
                    this.console.log(`[${new Date().toLocaleTimeString()}]`, 'Midnight callback fired, fetching tomorrow sun times...');
                    this.scheduleSun();
                }, delayToMidnight);
            }
        } catch (e) {
            this.console.error(`[${new Date().toLocaleTimeString()}]`, `scheduleSun error: ${e}. Retrying in 5 minutes.`);
            this.sunTimer = setTimeout(() => {
                this.console.log(`[${new Date().toLocaleTimeString()}]`, 'scheduleSun retry after error...');
                this.scheduleSun();
            }, 5 * 60 * 1000);
        }
    }

    // ---- Listeners ----

    setupListeners() {
        for (const reg of this.listenerRegistrations) {
            try { reg.removeListener(); }
            catch (e) { this.console.warn(`[${new Date().toLocaleTimeString()}]`, 'Failed to remove a previous listener', e); }
        }
        this.listenerRegistrations = [];

        if (!this.pluginEnabled) {
            this.console.log(`[${new Date().toLocaleTimeString()}]`, 'Plugin disabled (Plugin Enabled = false) - not registering any detection listeners.');
            return;
        }

        const configs = this.getCameraConfigs();
        for (const config of configs) {
            const camera = systemManager.getDeviceById(config.id);
            if (!camera) {
                this.console.warn(`[${new Date().toLocaleTimeString()}]`, `Camera not found for id: ${config.id}`);
                continue;
            }

            if (!config.enabled) {
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Camera ${camera.name} (id=${config.id}) disabled (Camera Enabled = false) - not registering a detection listener.`);
                continue;
            }

            const registration = systemManager.listenDevice(camera.id, ScryptedInterface.ObjectDetector, (eventSource, eventDetails, eventData) => {
                this.handleDetectionEvent(config, camera, eventData, eventDetails)
                    .catch(e => this.console.error(`[${new Date().toLocaleTimeString()}]`, `Error handling detection for ${camera.name} (${config.id})`, e));
            });
            this.listenerRegistrations.push(registration);
            this.console.log(`[${new Date().toLocaleTimeString()}]`, `Listening for detections on ${camera.name} (id=${config.id}, nightModeOnly=${config.nightModeOnly})`);
        }
    }

    // ---- Detection helpers ----

    shouldDebounce(cameraId: string, className: string): boolean {
        const key = `${cameraId}-${className}`;
        const now = Date.now();
        const last = this.lastNotified[key] ?? 0;
        if (now - last < this.debounceSeconds * 1000)
            return true;
        this.lastNotified[key] = now;
        return false;
    }

    isDuplicateDetectionId(detectionId: string | undefined): boolean {
        if (!detectionId)
            return false;
        if (this.recentDetectionIds.has(detectionId))
            return true;
        this.recentDetectionIds.add(detectionId);
        setTimeout(() => this.recentDetectionIds.delete(detectionId), 5000);
        return false;
    }

    async getDetectionInputWithRetry(camera: any, detectionId: string): Promise<MediaObject | undefined> {
        for (let attempt = 0; attempt < GET_DETECTION_INPUT_RETRIES.length; attempt++) {
            const delay = GET_DETECTION_INPUT_RETRIES[attempt];
            if (delay > 0)
                await sleep(delay);

            try {
                const mediaObject = await camera.getDetectionInput(detectionId);
                if (!mediaObject)
                    continue;

                const buffer = await mediaManager.convertMediaObjectToBuffer(mediaObject, 'image/jpeg');
                if (buffer.length >= MIN_PLAUSIBLE_IMAGE_BYTES) {
                    this.console.log(`[${new Date().toLocaleTimeString()}]`, `getDetectionInput succeeded on attempt ${attempt + 1} (after ${delay}ms wait), ${buffer.length} bytes`);
                    return mediaObject;
                }

                this.console.log(`[${new Date().toLocaleTimeString()}]`, `getDetectionInput attempt ${attempt + 1} returned a suspiciously small image (${buffer.length} bytes), retrying...`);
            }
            catch (e) {
                this.console.warn(`[${new Date().toLocaleTimeString()}]`, `getDetectionInput attempt ${attempt + 1} failed`, e);
            }
        }

        this.console.warn(`[${new Date().toLocaleTimeString()}]`, `getDetectionInput never returned a plausible image for detectionId=${detectionId} after ${GET_DETECTION_INPUT_RETRIES.length} attempts`);
        return undefined;
    }

    async mediaObjectToResizedDataUrl(mediaObject: MediaObject, boundingBox?: number[], fixedCrop?: [number, number, number, number]): Promise<{ dataUrl: string, buffer: Buffer } | undefined> {
        try {
            const image: any = await mediaManager.convertMediaObject(mediaObject, 'x-scrypted/x-scrypted-image');

            let toBufferOptions: any = {
                format: 'jpg',
            };

            if (fixedCrop) {
                const [fcX, fcY, fcW, fcH] = fixedCrop;
                const maxLongSide = this.maxLongSide;
                const longSide = Math.max(fcW, fcH);
                const scale = maxLongSide > 0 && longSide > maxLongSide ? maxLongSide / longSide : 1;
                toBufferOptions = {
                    crop: { left: fcX, top: fcY, width: fcW, height: fcH },
                    ...(scale < 1 ? { resize: { width: Math.round(fcW * scale), height: Math.round(fcH * scale) } } : {}),
                    format: 'jpg',
                };
            } else if (Array.isArray(boundingBox) && boundingBox.length === 4) {
                const [bx, by, bw, bh] = boundingBox;
                const padFactor = this.paddingFactor;
                const padX = bw * padFactor;
                const padY = bh * padFactor;

                const imgWidth: number = image.width ?? Number.MAX_SAFE_INTEGER;
                const imgHeight: number = image.height ?? Number.MAX_SAFE_INTEGER;

                // Padded bounding box size - the minimum area that must stay fully
                // visible in the crop; nothing below should ever shrink under this.
                const paddedWidth = bw + padX * 2;
                const paddedHeight = bh + padY * 2;

                // Fit a rectangle at the configured aspect ratio (maxHeightRatio =
                // height/width, 1.0 = square) AROUND the padded bbox, rather than
                // cropping down to it. Size off the width first; if that doesn't
                // leave enough height to contain the padded bbox, size off the
                // height instead - either way the padded bbox always fits entirely
                // on both axes, and only the "spare" axis grows to hit the ratio.
                // (Fixes a real-world bug: with a tall/narrow person bbox and the
                // ratio cap sizing purely off width, low padding could shrink the
                // crop height below the bbox's own height and crop into the
                // subject; high padding produced a lopsided, far-from-square crop
                // instead of the intended square framing.)
                let cropWidth = paddedWidth;
                let cropHeight = paddedHeight;
                const maxHeightRatio = this.maxHeightRatio;
                if (maxHeightRatio > 0) {
                    cropHeight = cropWidth * maxHeightRatio;
                    if (cropHeight < paddedHeight) {
                        cropHeight = paddedHeight;
                        cropWidth = paddedHeight / maxHeightRatio;
                    }
                }

                // If the fitted rectangle is still bigger than the frame, scale
                // both dimensions down together so the target ratio (square, by
                // default) is preserved rather than clamping one axis alone and
                // distorting it.
                const fitScale = Math.min(imgWidth / cropWidth, imgHeight / cropHeight, 1);
                cropWidth *= fitScale;
                cropHeight *= fitScale;

                // Center the crop on the bounding box's own center - not anchored
                // to its top edge. The old logic anchored a fixed 20%-of-bbox-height
                // buffer above the bbox top whenever the height-ratio cap kicked in,
                // which chopped off the top of the subject any time the bbox was
                // taller than the capped height (e.g. someone walking out of a
                // doorway close to camera - confirmed via live notification 7/2).
                const bcx = bx + bw / 2;
                const bcy = by + bh / 2;
                let cropX = bcx - cropWidth / 2;
                let cropY = bcy - cropHeight / 2;

                // Clamp so the crop stays within the frame.
                cropX = Math.min(Math.max(cropX, 0), imgWidth - cropWidth);
                cropY = Math.min(Math.max(cropY, 0), imgHeight - cropHeight);

                // If the bounding box itself touches an edge of the frame, that same
                // edge must be the crop boundary regardless of padding/centering -
                // there are no pixels beyond it to pad with, so trying to center
                // would just re-chop the subject from the opposite side instead.
                if (by <= 0)
                    cropY = 0;
                if (by + bh >= imgHeight)
                    cropY = imgHeight - cropHeight;
                if (bx <= 0)
                    cropX = 0;
                if (bx + bw >= imgWidth)
                    cropX = imgWidth - cropWidth;

                // Round edges first, then derive width/height from the rounded
                // edges - never round position and size independently. With an
                // unrounded crop landing exactly on a frame boundary (e.g. the
                // clamp above resolving to a "*.5" value), rounding cropX and
                // cropWidth separately can each round up on their own, pushing
                // cropX + cropWidth one pixel past the actual frame width even
                // though the pre-rounding crop was exactly in bounds - Sharp then
                // rejects the extract as out-of-bounds (confirmed live 7/6:
                // cropX=2282.5/cropWidth=277.5 both rounded up independently to
                // 2283/278, against a 2560px-wide frame, "extract_area: bad
                // extract area").
                let left = Math.round(cropX);
                let top = Math.round(cropY);
                let right = Math.round(cropX + cropWidth);
                let bottom = Math.round(cropY + cropHeight);

                // Final safety clamp in case of any remaining float slop.
                left = Math.max(0, Math.min(left, imgWidth - 1));
                top = Math.max(0, Math.min(top, imgHeight - 1));
                right = Math.max(left + 1, Math.min(right, imgWidth));
                bottom = Math.max(top + 1, Math.min(bottom, imgHeight));

                cropX = left;
                cropY = top;
                cropWidth = right - left;
                cropHeight = bottom - top;

                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Bbox crop: bbox=${bw}x${bh} padFactor=${padFactor} ratio=${maxHeightRatio} -> crop=${cropWidth}x${cropHeight} at (${cropX},${cropY})`);

                const maxLongSide = this.maxLongSide;
                const longSide = Math.max(cropWidth, cropHeight);
                const scale = maxLongSide > 0 && longSide > maxLongSide ? maxLongSide / longSide : 1;
                toBufferOptions = {
                    crop: { left: cropX, top: cropY, width: cropWidth, height: cropHeight },
                    ...(scale < 1 ? { resize: { width: Math.round(cropWidth * scale), height: Math.round(cropHeight * scale) } } : {}),
                    format: 'jpg',
                };
            }

            let buffer: Buffer;
            try {
                buffer = await image.toBuffer(toBufferOptions);
            }
            catch (cropErr) {
                this.console.warn(`[${new Date().toLocaleTimeString()}]`, 'Crop failed, falling back to resize-only (full frame)', cropErr);
                buffer = await image.toBuffer({ format: 'jpg' });
            }

            const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
            this.console.log(`[${new Date().toLocaleTimeString()}]`, `Resized image, ${buffer.length} bytes`);
            return { dataUrl, buffer };
        }
        catch (e) {
            this.console.warn(`[${new Date().toLocaleTimeString()}]`, 'Image resize failed, falling back to unresized JPEG', e);
            try {
                const buffer = await mediaManager.convertMediaObjectToBuffer(mediaObject, 'image/jpeg');
                return { dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`, buffer };
            }
            catch (e2) {
                this.console.error(`[${new Date().toLocaleTimeString()}]`, 'Unresized JPEG conversion also failed', e2);
                return undefined;
            }
        }
    }

    async snapshotToDataUrl(camera: any): Promise<{ dataUrl: string, buffer: Buffer } | undefined> {
        try {
            const mediaObject = await camera.takePicture();
            return await this.mediaObjectToResizedDataUrl(mediaObject);
        }
        catch (e) {
            this.console.error(`[${new Date().toLocaleTimeString()}]`, 'snapshotToDataUrl failed', e);
            return undefined;
        }
    }

    async eventThumbnail(camera: any, eventData: any, matchedDetection: any, fixedCrop?: [number, number, number, number]): Promise<{ dataUrl: string, buffer: Buffer } | undefined> {
        if (eventData?.detectionId && typeof camera.getDetectionInput === 'function') {
            const mediaObject = await this.getDetectionInputWithRetry(camera, eventData.detectionId);
            if (mediaObject) {
                return await this.mediaObjectToResizedDataUrl(mediaObject, fixedCrop ? undefined : matchedDetection?.boundingBox, fixedCrop);
            }
        }
        return this.snapshotToDataUrl(camera);
    }

    async fireNotification(config: CameraRelayConfig, camera: any, cameraName: string, detection: any, eventData: any, eventDetails: EventDetails, fixedCrop?: [number, number, number, number], critical?: boolean) {
        // Belt-and-suspenders: setupListeners() already stops new detections from
        // reaching here when disabled (globally or per-camera), but a
        // thumbnailWindow timer armed just before the switch was flipped can
        // still be in flight - catch that here too.
        if (!this.pluginEnabled) {
            this.console.log(`[${new Date().toLocaleTimeString()}]`, `Plugin disabled - suppressing notification for ${cameraName} ${detection.className} (was already in flight)`);
            return;
        }
        if (!config.enabled) {
            this.console.log(`[${new Date().toLocaleTimeString()}]`, `Camera ${cameraName} disabled - suppressing notification for ${detection.className} (was already in flight)`);
            return;
        }

        const thumbnail = await this.eventThumbnail(camera, eventData, detection, fixedCrop);

        await Promise.all([
            this.notifyTvs(cameraName, detection.className, thumbnail?.dataUrl),
            this.sendPhonePush(cameraName, config.id, detection.className, cameraName, thumbnail, eventData, eventDetails, critical),
        ]);
    }

    async firePendingDetection(pendingKey: string) {
        const pending = this.pendingDetections.get(pendingKey);
        if (!pending) return;
        this.pendingDetections.delete(pendingKey);
        const { detection, eventData, eventDetails, camera, config, fixedCrop, critical } = pending;
        const cameraName = camera.name ?? config.id;
        const [, , bw] = Array.isArray(detection.boundingBox) ? detection.boundingBox : [0, 0, 0, 0];
        this.console.log(`[${new Date().toLocaleTimeString()}]`, `Firing pending detection for ${cameraName} ${detection.className} with best bounding box width ${bw}px`);
        await this.fireNotification(config, camera, cameraName, detection, eventData, eventDetails, fixedCrop, critical);
    }

    // ---- Main detection handler ----

    async handleDetectionEvent(config: CameraRelayConfig, camera: any, eventData: any, eventDetails: EventDetails) {
        if (!eventData?.detectionId)
            return;

        const detections = eventData?.detections;
        if (!Array.isArray(detections))
            return;

        const cameraName = camera.name ?? config.id;

        if (this.isDuplicateDetectionId(String(eventData.detectionId)))
            return;

        if (config.nightModeOnly && !this.isNightMode) {
            this.console.log(`[${new Date().toLocaleTimeString()}]`, `Night mode OFF - skipping notification for ${cameraName}`);
            return;
        }

        for (const detection of detections) {
            const detectionZones: string[] = Array.isArray(detection.zones) ? detection.zones : [];

            const matchedRule = config.rules.find(rule =>
                rule.className === detection.className &&
                detectionZones.includes(rule.zone) &&
                (typeof detection.score !== 'number' || detection.score >= rule.scoreThreshold)
            );

            if (!matchedRule)
                continue;

            const [, , bw, bh] = Array.isArray(detection.boundingBox) ? detection.boundingBox : [0, 0, 0, 0]; // bx/by extracted below if needed
            if (matchedRule.minWidth && bw < matchedRule.minWidth) {
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Skipping ${cameraName} ${detection.className}: bounding box width ${bw}px < minWidth ${matchedRule.minWidth}px`);
                continue;
            }
            if (matchedRule.minHeight && bh < matchedRule.minHeight) {
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Skipping ${cameraName} ${detection.className}: bounding box height ${bh}px < minHeight ${matchedRule.minHeight}px`);
                continue;
            }
            const [bx, by] = Array.isArray(detection.boundingBox) ? detection.boundingBox : [0, 0, 0, 0];
            if (matchedRule.maxX && bx > matchedRule.maxX) {
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Skipping ${cameraName} ${detection.className}: bounding box x ${bx}px > maxX ${matchedRule.maxX}px`);
                continue;
            }
            if (matchedRule.maxY && by > matchedRule.maxY) {
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Skipping ${cameraName} ${detection.className}: bounding box y ${by}px > maxY ${matchedRule.maxY}px`);
                continue;
            }

            if (this.isSnoozed(config.id, detection.className)) {
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Snoozed: ${cameraName} ${detection.className}, skipping notification`);
                return;
            }

            if (this.shouldDebounce(config.id, detection.className)) {
                this.console.log(`[${new Date().toLocaleTimeString()}]`, `Debounced: ${cameraName} ${detection.className}`);
                return;
            }

            this.console.log(`[${new Date().toLocaleTimeString()}]`, `Detection matched on ${cameraName}${matchedRule.name ? ` (rule: "${matchedRule.name}")` : ''}: ${detection.className} in ${matchedRule.zone} (score=${detection.score}) boundingBox=${JSON.stringify(detection.boundingBox)}`);

            if (config.thumbnailWindow > 0) {
                const pendingKey = `${config.id}-${detection.className}`;
                const existing = this.pendingDetections.get(pendingKey);
                const [, , bw] = Array.isArray(detection.boundingBox) ? detection.boundingBox : [0, 0, 0, 0];
                const [, , existingBw] = existing && Array.isArray(existing.detection.boundingBox) ? existing.detection.boundingBox : [0, 0, 0, 0];

                if (existing) {
                    // Update if this detection has a wider bounding box
                    if (bw > existingBw) {
                        clearTimeout(existing.timer);
                        const timer = setTimeout(() => this.firePendingDetection(pendingKey), config.thumbnailWindow * 1000);
                        this.pendingDetections.set(pendingKey, { detection, eventData, eventDetails, camera, config, fixedCrop: matchedRule.fixedCrop, critical: matchedRule.critical, timer });
                        this.console.log(`[${new Date().toLocaleTimeString()}]`, `Updated pending detection for ${cameraName} ${detection.className}: wider box ${bw}px > ${existingBw}px`);
                    }
                } else {
                    // First detection in window — commit debounce now, start window
                    const timer = setTimeout(() => this.firePendingDetection(pendingKey), config.thumbnailWindow * 1000);
                    this.pendingDetections.set(pendingKey, { detection, eventData, eventDetails, camera, config, fixedCrop: matchedRule.fixedCrop, critical: matchedRule.critical, timer });
                    this.console.log(`[${new Date().toLocaleTimeString()}]`, `Started thumbnail window for ${cameraName} ${detection.className}: ${config.thumbnailWindow}s`);
                }
                return;
            }

            await this.fireNotification(config, camera, cameraName, detection, eventData, eventDetails, matchedRule.fixedCrop, matchedRule.critical);
            return;
        }
    }
}

export default SmartDetectionRelayPlugin;