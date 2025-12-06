/*
 * License: GPLv3
 * Authors:
 *  Universal Blue Contributors
 * Based on: VanillaOS Update Check Extension
 * Copyright: 2025
 */

import St from "gi://St";
import GObject from "gi://GObject";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";

const GETTEXT_DOMAIN = "uupd-indicator";

/* D-Bus Constants */
const DBUS_NAME = "org.freedesktop.systemd1";
const DBUS_PATH = "/org/freedesktop/systemd1/unit/uupd_2eservice";
const DBUS_INTERFACE = "org.freedesktop.systemd1.Unit";
const DBUS_TIMER_PATH = "/org/freedesktop/systemd1/unit/uupd_2etimer";
const DBUS_MANAGER_INTERFACE = "org.freedesktop.systemd1.Manager";

const UupdIndicator = GObject.registerClass(
  {
    GTypeName: "UupdIndicator",
  },
  class UupdIndicator extends PanelMenu.Button {
    _init() {
      super._init(0.0, _("Universal Blue Update Indicator"));

      // Create icon and save reference for animation
      this._icon = new St.Icon({
        icon_name: "folder-download-symbolic",
        style_class: "system-status-icon",
      });
      this.add_child(this._icon);

      // Create popup menu
      let msgUpdateItem = new PopupMenu.PopupMenuItem(
        _("System update in progress...")
      );
      msgUpdateItem.setSensitive(false);
      this.menu.addMenuItem(msgUpdateItem);

      // Initially hide the indicator
      this.hide();

      // Animation state - toggle between two icons
      this._iconAnimation = null;
      this._iconToggle = false;

      // Initialize D-Bus proxy
      this._propertiesChangedId = null;
      this._timerPropertiesChangedId = null;
      this._timerEnabled = false;
      this._initDBusProxy();
    }

    /**
     * Initialize D-Bus proxy to monitor uupd.service
     */
    _initDBusProxy() {
      console.log("[uupd-indicator] Initializing D-Bus proxy...");

      // First check if uupd.timer is enabled
      this._timerProxy = new Gio.DBusProxy({
        g_connection: Gio.DBus.system,
        g_name: DBUS_NAME,
        g_object_path: DBUS_TIMER_PATH,
        g_interface_name: DBUS_INTERFACE,
      });

      this._timerProxy.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, result) => {
        try {
          proxy.init_finish(result);
          console.log("[uupd-indicator] Timer proxy initialized successfully");
          this._checkTimerEnabled();
        } catch (e) {
          console.error(`[uupd-indicator] Failed to initialize timer proxy: ${e.message}`);
          // If timer doesn't exist, hide indicator
          this.hide();
        }
      });

      this._proxy = new Gio.DBusProxy({
        g_connection: Gio.DBus.system,
        g_name: DBUS_NAME,
        g_object_path: DBUS_PATH,
        g_interface_name: DBUS_INTERFACE,
      });

      this._proxy.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, result) => {
        try {
          proxy.init_finish(result);
          console.log("[uupd-indicator] D-Bus proxy initialized successfully");
          this._onProxyReady();
        } catch (e) {
          console.error(`[uupd-indicator] Failed to initialize D-Bus proxy: ${e.message}`);
          // Graceful fallback - keep indicator hidden
          this.hide();
        }
      });
    }

    /**
     * Check if uupd.timer is enabled
     */
    _checkTimerEnabled() {
      const unitFileState = this._timerProxy.get_cached_property("UnitFileState");

      if (!unitFileState) {
        console.log("[uupd-indicator] UnitFileState property not available");
        this._timerEnabled = false;
        return;
      }

      const state = unitFileState.deep_unpack();
      this._timerEnabled = (state === "enabled");
      console.log(`[uupd-indicator] Timer state: ${state}, enabled: ${this._timerEnabled}`);

      // Monitor timer state changes (only connect once)
      if (!this._timerPropertiesChangedId) {
        this._timerPropertiesChangedId = this._timerProxy.connect(
          "g-properties-changed",
          this._onTimerPropertiesChanged.bind(this)
        );
      }
    }

    /**
     * Handle timer property changes
     */
    _onTimerPropertiesChanged() {
      this._checkTimerEnabled();
      // If timer was disabled, hide indicator immediately
      if (!this._timerEnabled) {
        this._stopIconAnimation();
        this.hide();
      }
    }

    /**
     * Called when D-Bus proxy is ready
     */
    _onProxyReady() {
      // Read initial state
      this._updateIndicatorState();

      // Connect to property changes
      this._propertiesChangedId = this._proxy.connect(
        "g-properties-changed",
        this._onPropertiesChanged.bind(this)
      );

      console.log("[uupd-indicator] Monitoring uupd.service state changes");
    }

    /**
     * Handle D-Bus property changes
     */
    _onPropertiesChanged(proxy, changed, invalidated) {
      const changedProps = changed.deep_unpack();

      if ("ActiveState" in changedProps) {
        console.log(`[uupd-indicator] ActiveState changed: ${changedProps.ActiveState}`);
        this._updateIndicatorState();
      }
    }

    /**
     * Start icon pulsing animation
     */
    _startIconAnimation() {
      if (this._iconAnimation) {
        return; // Already animating
      }

      console.log("[uupd-indicator] Starting icon pulsing animation");

      this._pulseDirection = 1; // 1 = fading out, -1 = fading in
      this._pulseOpacity = 255; // Start at full opacity

      // Pulse the icon opacity smoothly
      this._iconAnimation = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
        // Change opacity
        this._pulseOpacity += this._pulseDirection * 8;

        // Reverse direction at boundaries
        if (this._pulseOpacity <= 100) {
          this._pulseDirection = 1;
          this._pulseOpacity = 100;
        } else if (this._pulseOpacity >= 255) {
          this._pulseDirection = -1;
          this._pulseOpacity = 255;
        }

        // Set the opacity (0-255 range)
        this._icon.ease({
          opacity: this._pulseOpacity,
          duration: 80,
          mode: Clutter.AnimationMode.LINEAR
        });

        return GLib.SOURCE_CONTINUE;
      });
    }

    /**
     * Stop icon pulsing animation
     */
    _stopIconAnimation() {
      if (this._iconAnimation) {
        GLib.source_remove(this._iconAnimation);
        this._iconAnimation = null;
        // Reset to full opacity
        this._icon.opacity = 255;
      }
    }

    /**
     * Update indicator visibility based on service state
     */
    _updateIndicatorState() {
      // Check timer state first (in case it wasn't initialized yet)
      if (this._timerProxy) {
        const unitFileState = this._timerProxy.get_cached_property("UnitFileState");
        if (unitFileState) {
          const state = unitFileState.deep_unpack();
          this._timerEnabled = (state === "enabled");
        }
      }

      // Only show indicator if timer is enabled
      if (!this._timerEnabled) {
        console.log("[uupd-indicator] Timer is disabled, hiding indicator");
        this._stopIconAnimation();
        this.hide();
        return;
      }

      const activeState = this._proxy.get_cached_property("ActiveState");

      if (!activeState) {
        console.log("[uupd-indicator] ActiveState property not available");
        this._stopIconAnimation();
        this.hide();
        return;
      }

      const state = activeState.deep_unpack();
      console.log(`[uupd-indicator] Current state: ${state} (type: ${typeof state})`);
      console.log(`[uupd-indicator] State === 'activating': ${state === "activating"}`);
      console.log(`[uupd-indicator] State === 'active': ${state === "active"}`);

      // Show indicator when service is active or activating
      if (state === "active" || state === "activating") {
        console.log("[uupd-indicator] Service is active/activating - showing indicator");
        this.show();
        this._startIconAnimation();
      } else {
        console.log("[uupd-indicator] Service is not active - hiding indicator");
        this._stopIconAnimation();
        this.hide();
      }
    }

    /**
     * Cleanup when indicator is destroyed
     */
    destroy() {
      console.log("[uupd-indicator] Cleaning up...");

      // Stop animation
      this._stopIconAnimation();

      // Disconnect signals
      if (this._propertiesChangedId) {
        this._proxy.disconnect(this._propertiesChangedId);
        this._propertiesChangedId = null;
      }

      if (this._timerPropertiesChangedId) {
        this._timerProxy.disconnect(this._timerPropertiesChangedId);
        this._timerPropertiesChangedId = null;
      }

      // Destroy proxies
      this._proxy = null;
      this._timerProxy = null;

      // Call parent destroy
      super.destroy();
    }
  }
);

export default class UupdIndicatorExtension extends Extension {
  constructor(metadata) {
    super(metadata);
  }

  enable() {
    console.log("[uupd-indicator] Extension enabled");
    this._indicator = new UupdIndicator();
    Main.panel.addToStatusArea(this.uuid, this._indicator);
  }

  disable() {
    console.log("[uupd-indicator] Extension disabled");
    this._indicator.destroy();
    this._indicator = null;
  }
}
