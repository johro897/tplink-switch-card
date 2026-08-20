/*
 * TP-Link Switch Card
 * Lovelace custom card for TP-Link Easy Smart switch overview.
 *
 * UX levels:
 *   1. Port row        — link dot, speed, PoE badge, wattage
 *   2. Detail row      — all read values + toggles + label editor + Configure button (PoE ports only)
 *   3. Configure panel — inline PoE priority + power limit editor with Apply/Cancel
 *
 * Overview:
 *   - Network info tile (IP, MAC, gateway, netmask)
 *   - PoE tiles (used, remaining)
 *   - PoE budget bar with inline limit editor (pencil icon)
 *
 * Services used:
 *   tplink_easy_smart.set_port_poe_settings  — priority, power_limit per port
 *   tplink_easy_smart.set_general_poe_limit  — global PoE budget limit
 */

(function () {
  const CARD_NAME = "tplink-switch-card";
  if (customElements.get(CARD_NAME)) return;

  if (typeof window !== "undefined") {
    window.customCards = window.customCards || [];
    if (!window.customCards.some((c) => c.type === CARD_NAME)) {
      window.customCards.push({
        type: CARD_NAME,
        name: "TP-Link Switch Card",
        description: "Overview card for TP-Link Easy Smart switch with PoE monitoring and configuration.",
        preview: false,
      });
    }
  }

  const POE_PRIORITIES   = ["Low", "Middle", "High"];
  const POE_POWER_LIMITS = ["Auto", "Class 1", "Class 2", "Class 3", "Class 4", "Manual"];
  const DEFAULT_OVERVIEW_FIELDS = Object.freeze([
    "ip", "mac", "gateway", "netmask", "poe_used", "poe_remaining", "poe_budget",
  ]);
  const OVERVIEW_FIELD_LABELS = Object.freeze({
    ip: "IP address",
    mac: "MAC address",
    gateway: "Gateway",
    netmask: "Netmask",
    poe_used: "PoE used",
    poe_remaining: "PoE remaining",
    poe_budget: "PoE budget bar",
  });
  const OVERVIEW_FIELD_SET = new Set(DEFAULT_OVERVIEW_FIELDS);
  const OVERVIEW_LAYOUTS = new Set(["tiles", "compact", "hidden"]);
  const MAX_LABEL_LENGTH = 40;

  class TplinkSwitchCard extends HTMLElement {
    constructor() {
      super();
      this._expanded      = new Set(); // ports with open detail row
      this._configuring   = new Set(); // ports with open configure panel
      this._editingLimit  = false;     // overview PoE limit editor open
      this._portEntitiesCache = new Map();

      // Pending configure values — keyed by port
      this._pendingPoe    = new Map(); // port → { priority, power_limit }
      this._pendingLimit  = "";        // draft global PoE limit
      this._applying      = new Set(); // ports currently awaiting service call
      this._applyingLimit = false;

      // Label editing
      this._labelDrafts   = new Map(); // port → unsaved input text (survives re-renders)
      this._savingLabel   = new Set(); // ports currently persisting a label
      this._localLabelsCache = null;   // per-render cache of localStorage overrides
    }

    setConfig(config) {
      if (!config) throw new Error("Missing configuration");
      this._rawConfig = config; // untouched original — used to locate this card in the Lovelace config
      this.config = {
        title: "TP-Link Switch",
        has_poe: true,
        poe_ports: 8,
        total_ports: 16,
        entity_prefix: "tp_link_switch",
        max_poe_watts: null,
        overview_layout: "tiles",
        overview_fields: [...DEFAULT_OVERVIEW_FIELDS],
        show_switch_link: true,
        port_labels: {},
        editable_labels: true,
        font_scale: 1,
        ...config,
      };
      this.config.has_poe = this.config.has_poe !== false;
      if (!this.config.has_poe) this.config.poe_ports = 0;

      if (!OVERVIEW_LAYOUTS.has(this.config.overview_layout)) {
        this.config.overview_layout = "tiles";
      }

      const scale = Number(this.config.font_scale);
      this.config.font_scale = Number.isFinite(scale)
        ? Math.min(2, Math.max(0.7, scale))
        : 1;
      this.config.editable_labels = this.config.editable_labels !== false;

      const requestedOverviewFields = Array.isArray(this.config.overview_fields)
        ? this.config.overview_fields
        : DEFAULT_OVERVIEW_FIELDS;
      this.config.overview_fields = [...new Set(
        requestedOverviewFields.filter(field => OVERVIEW_FIELD_SET.has(field))
      )];
      this.config.show_switch_link = this.config.show_switch_link !== false;

      const requestedPortLabels = this.config.port_labels;
      const portLabels = {};
      if (requestedPortLabels && typeof requestedPortLabels === "object" && !Array.isArray(requestedPortLabels)) {
        Object.entries(requestedPortLabels).forEach(([key, rawLabel]) => {
          const port = Number(key);
          if (!Number.isInteger(port) || port < 1 || port > this.config.total_ports || rawLabel == null) return;
          const label = String(rawLabel).trim();
          if (label) portLabels[port] = label;
        });
      }
      this.config.port_labels = portLabels;

      this._portEntitiesCache.clear();
      // Only depends on entity_prefix/has_poe/total_ports/poe_ports, all fixed
      // above — recompute once per config change instead of on every hass tick.
      this._watchedEntitiesCache = this._watchedEntities();
      this.render();
    }

    set hass(hass) {
      const old = this._hass;
      this._hass = hass;
      if (old && !this._statesChanged(old, hass)) return;
      this.render();
    }

    connectedCallback() { this.render(); }

    static getConfigElement() {
      return document.createElement(`${CARD_NAME}-editor`);
    }

    static getStubConfig() {
      return { type: `custom:${CARD_NAME}`, entity_prefix: "tp_link_switch" };
    }

    getCardSize() {
      const baseSize = this.config?.has_poe === false ? 5 : 7;
      const overviewHidden = this.config?.overview_layout === "hidden" ||
        this.config?.overview_fields?.length === 0;
      return Math.max(3, baseSize - (overviewHidden ? 1 : 0));
    }

    // ── Change detection ──────────────────────────────────────────────────────

    _watchedEntities() {
      if (!this.config) return [];
      const p = this.config.entity_prefix;
      const ids = [`sensor.${p}_network_info`];
      if (this.config.has_poe) ids.push(`sensor.${p}_poe_consumption`);
      for (let i = 1; i <= this.config.total_ports; i++) {
        ids.push(`binary_sensor.${p}_port_${i}_state`);
        if (this.config.has_poe && i <= this.config.poe_ports) {
          ids.push(`binary_sensor.${p}_port_${i}_poe_state`);
          ids.push(`switch.${p}_port_${i}_poe_enabled`);
        }
        ids.push(`switch.${p}_port_${i}_enabled`);
      }
      return ids;
    }

    _statesChanged(oldHass, newHass) {
      const ids = this._watchedEntitiesCache || this._watchedEntities();
      return ids.some(id => {
        const o = oldHass.states[id];
        const n = newHass.states[id];
        if (o?.state !== n?.state) return true;
        const oa = o?.attributes ?? {};
        const na = n?.attributes ?? {};
        return oa.power_w !== na.power_w ||
               oa.current_ma !== na.current_ma ||
               oa.voltage_v !== na.voltage_v ||
               oa.speed !== na.speed ||
               oa.speed_config !== na.speed_config ||
               oa.priority !== na.priority ||
               oa.power_limit !== na.power_limit ||
               oa.power_limit_w !== na.power_limit_w ||
               oa.power_remain_w !== na.power_remain_w;
      });
    }

    // ── Entity helpers ────────────────────────────────────────────────────────

    _escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    // Scaled font size — base rem value multiplied by config font_scale
    _fs(rem) {
      const s = this.config?.font_scale ?? 1;
      return `${+(rem * s).toFixed(3)}rem`;
    }

    _e(entityId) { return this._hass?.states[entityId] ?? null; }

    _getMacAddress() {
      const pfx  = this.config.entity_prefix;
      const netS = this._e(`sensor.${pfx}_network_info`);
      return netS?.attributes?.mac ?? null;
    }

    _getSwitchUrl() {
      const pfx  = this.config.entity_prefix;
      const netS = this._e(`sensor.${pfx}_network_info`);
      const ip   = netS?.state;
      if (!ip || ip === "unknown" || ip === "unavailable") return null;
      return `http://${ip}`;
    }

    _portEntities(port) {
      if (this._portEntitiesCache.has(port)) return this._portEntitiesCache.get(port);
      const p      = this.config.entity_prefix;
      const hasPoe = this.config.has_poe && port <= this.config.poe_ports;
      const entities = {
        state:       this._e(`binary_sensor.${p}_port_${port}_state`),
        poeState:    hasPoe ? this._e(`binary_sensor.${p}_port_${port}_poe_state`) : null,
        poeEnabled:  hasPoe ? this._e(`switch.${p}_port_${port}_poe_enabled`) : null,
        portEnabled: this._e(`switch.${p}_port_${port}_enabled`),
      };
      this._portEntitiesCache.set(port, entities);
      return entities;
    }

    // ── Port labels ───────────────────────────────────────────────────────────

    _labelStorageKey() {
      const id = this._getMacAddress() ?? this.config.entity_prefix;
      return `${CARD_NAME}:labels:${id}`;
    }

    _localLabels() {
      if (this._localLabelsCache) return this._localLabelsCache;
      let labels = {};
      try {
        const raw = localStorage.getItem(this._labelStorageKey());
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) labels = parsed;
      } catch (err) {
        console.warn("tplink-switch-card: could not read local labels", err);
      }
      this._localLabelsCache = labels;
      return labels;
    }

    _writeLocalLabels(labels) {
      this._localLabelsCache = null;
      try {
        if (Object.keys(labels).length === 0) {
          localStorage.removeItem(this._labelStorageKey());
        } else {
          localStorage.setItem(this._labelStorageKey(), JSON.stringify(labels));
        }
      } catch (err) {
        console.warn("tplink-switch-card: could not write local labels", err);
      }
    }

    // Effective label: localStorage override (may be "" = removed) wins over config
    _effectiveLabel(port) {
      const local = this._localLabels();
      const value = Object.prototype.hasOwnProperty.call(local, port)
        ? local[port]
        : this.config.port_labels?.[port];
      return value ? String(value) : "";
    }

    // Locate the hui-root lovelace object by walking the HA DOM
    _getLovelace() {
      try {
        let node = document.querySelector("home-assistant");
        node = node?.shadowRoot?.querySelector("home-assistant-main");
        node = node?.shadowRoot;
        node = node?.querySelector("ha-drawer partial-panel-resolver")
            ?? node?.querySelector("partial-panel-resolver")
            ?? node?.querySelector("app-drawer-layout partial-panel-resolver");
        node = (node?.shadowRoot ?? node)?.querySelector("ha-panel-lovelace");
        node = node?.shadowRoot?.querySelector("hui-root");
        return node?.lovelace ?? null;
      } catch (err) {
        return null;
      }
    }

    // Recursively collect all tplink-switch-card configs inside a Lovelace config tree
    _collectCardConfigs(node, matches) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(item => this._collectCardConfigs(item, matches));
        return;
      }
      if (node.type === `custom:${CARD_NAME}`) matches.push(node);
      ["views", "sections", "cards", "card", "rows", "elements"].forEach(key => {
        if (node[key]) this._collectCardConfigs(node[key], matches);
      });
    }

    /*
     * Persist labels into the dashboard config via lovelace.saveConfig.
     * Returns true on success. Fails gracefully (→ localStorage fallback) when:
     *   - the dashboard runs in YAML mode
     *   - the card cannot be uniquely located in the config
     *   - the HA DOM layout changed and hui-root is not found
     */
    async _persistLabelsToLovelace(labels) {
      const lovelace = this._getLovelace();
      if (!lovelace || lovelace.mode !== "storage" || typeof lovelace.saveConfig !== "function") {
        return false;
      }
      const target = JSON.stringify(this._rawConfig ?? {});
      const cloned = JSON.parse(JSON.stringify(lovelace.config));
      const matches = [];
      this._collectCardConfigs(cloned, matches);
      const found = matches.filter(card => JSON.stringify(card) === target);
      if (found.length !== 1) {
        console.warn(`tplink-switch-card: found ${found.length} matching card config(s); falling back to local label storage`);
        return false;
      }
      if (Object.keys(labels).length > 0) {
        found[0].port_labels = labels;
      } else {
        delete found[0].port_labels;
      }
      await lovelace.saveConfig(cloned);
      return true;
    }

    async _saveLabel(port, rawValue) {
      const value = String(rawValue ?? "").trim().slice(0, MAX_LABEL_LENGTH);
      if (value === this._effectiveLabel(port)) {
        this._labelDrafts.delete(port);
        this.render();
        return;
      }

      // Full desired label set = config labels + local overrides + this change
      const merged = { ...this.config.port_labels };
      const local = this._localLabels();
      Object.entries(local).forEach(([p, v]) => {
        if (v) merged[p] = v; else delete merged[p];
      });
      if (value) merged[port] = value; else delete merged[port];

      this._savingLabel.add(port);
      this.render();

      let saved = false;
      try {
        saved = await this._persistLabelsToLovelace(merged);
      } catch (err) {
        console.warn("tplink-switch-card: saving label to dashboard failed", err);
      }

      this._savingLabel.delete(port);
      this._labelDrafts.delete(port);

      if (saved) {
        // Dashboard config now holds every label — local overrides are obsolete
        this._writeLocalLabels({});
        this.config.port_labels = merged; // instant UI update; setConfig follows from HA
      } else {
        const updatedLocal = { ...this._localLabels() };
        if (value) {
          updatedLocal[port] = value;
        } else if (this.config.port_labels?.[port]) {
          updatedLocal[port] = ""; // override config label with "removed"
        } else {
          delete updatedLocal[port];
        }
        this._writeLocalLabels(updatedLocal);
      }
      this.render();
    }

    // ── Service calls ─────────────────────────────────────────────────────────

    _toggle(entityId) {
      if (!this._hass || !entityId) return;
      const e = this._hass.states[entityId];
      if (!e) return;
      const domain = entityId.split(".")[0];
      this._hass.callService(domain, e.state === "on" ? "turn_off" : "turn_on", { entity_id: entityId });
    }

    async _applyPortPoe(port) {
      const pending = this._pendingPoe.get(port);
      if (!pending || !this._hass) return;
      this._applying.add(port);
      this.render();
      try {
        const poeEnt = this._portEntities(port);
        const isEnabled = poeEnt.poeEnabled?.state === "on";
        await this._hass.callService("tplink_easy_smart", "set_port_poe_settings", {
          mac_address: this._getMacAddress(),
          port_number: port,
          enabled: isEnabled,
          priority: pending.priority,
          power_limit: pending.power_limit,
        });
      } catch (err) {
        console.error("tplink-switch-card: set_port_poe_settings failed", err);
      } finally {
        this._applying.delete(port);
        this._configuring.delete(port);
        this._pendingPoe.delete(port);
        this.render();
      }
    }

    _showLimitError(msg) {
      const el = this.querySelector("#poe-limit-error");
      const input = this.querySelector("#poe-limit-input");
      if (el) { el.textContent = msg; el.style.display = "inline"; }
      if (input) input.style.borderColor = "#c22040";
    }

    _clearLimitError() {
      const el = this.querySelector("#poe-limit-error");
      const input = this.querySelector("#poe-limit-input");
      if (el) { el.textContent = ""; el.style.display = "none"; }
      if (input) input.style.borderColor = "";
    }

    async _applyPoeLimitGlobal() {
      // Read current value directly from DOM so we don't need a re-render
      const inputEl = this.querySelector("#poe-limit-input");
      if (inputEl) this._pendingLimit = inputEl.value;

      const val  = parseFloat(this._pendingLimit);
      const maxW = this.config.max_poe_watts;

      if (isNaN(val) || val <= 0) {
        this._showLimitError("Enter a value greater than 0");
        return;
      }
      if (maxW && val > maxW) {
        this._showLimitError(`Cannot exceed hardware max of ${maxW} W`);
        return;
      }
      if (!this._hass) return;
      this._clearLimitError();
      this._applyingLimit = true;
      this.render();
      try {
        await this._hass.callService("tplink_easy_smart", "set_general_poe_limit", {
          mac_address: this._getMacAddress(),
          power_limit: val,
        });
      } catch (err) {
        console.error("tplink-switch-card: set_general_poe_limit failed", err);
      } finally {
        this._applyingLimit = false;
        this._editingLimit = false;
        this._pendingLimit = "";
        this.render();
      }
    }

    // ── Expand / configure state ──────────────────────────────────────────────

    _toggleExpand(port) {
      if (this._expanded.has(port)) {
        this._expanded.delete(port);
        this._configuring.delete(port);
        this._pendingPoe.delete(port);
        this._labelDrafts.delete(port);
      } else {
        this._expanded.add(port);
      }
      this.render();
    }

    _openConfigure(port) {
      const ent  = this._portEntities(port);
      const attr = ent.poeState?.attributes ?? {};
      // Pre-fill with current values from entity
      this._pendingPoe.set(port, {
        priority:    attr.priority    ?? POE_PRIORITIES[0],
        power_limit: attr.power_limit ?? POE_POWER_LIMITS[0],
      });
      this._configuring.add(port);
      this.render();
    }

    _cancelConfigure(port) {
      this._configuring.delete(port);
      this._pendingPoe.delete(port);
      this.render();
    }

    // ── CSS ───────────────────────────────────────────────────────────────────

    _css() {
      const fs = v => this._fs(v);
      return `
        :host { display: block; }
        * { box-sizing: border-box; }
        .card {
          background: var(--ha-card-background, var(--card-background-color));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none);
          padding: 1rem 1.25rem 1.25rem;
          color: var(--primary-text-color);
          font-family: var(--primary-font-family, inherit);
        }

        /* ── Header ── */
        .card-header {
          display: flex; align-items: center;
          justify-content: space-between; margin-bottom: 0.9rem;
        }
        .card-title { font-size: ${fs(1.1)}; font-weight: 700; }
        .summary-pills { display: flex; gap: 0.4rem; flex-wrap: wrap; }
        .pill {
          font-size: ${fs(0.7)}; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.07em;
          padding: 0.18rem 0.55rem; border-radius: 999px;
          background: var(--secondary-background-color);
          color: var(--secondary-text-color);
          border: 1px solid var(--divider-color, rgba(128,128,128,0.2));
          white-space: nowrap;
        }
        .pill.up  { background: rgba(46,143,87,0.13); color: #2e8f57; border-color: rgba(46,143,87,0.28); }
        .pill.poe { background: rgba(3,169,244,0.1); color: var(--primary-color,#03a9f4); border-color: rgba(3,169,244,0.28); }

        /* ── Overview ── */
        .overview {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
          gap: 0.4rem; margin-bottom: 1rem;
        }
        .overview.compact {
          display: flex; flex-wrap: wrap; align-items: stretch;
          gap: 0.35rem; padding: 0.45rem; margin-bottom: 1rem;
          background: var(--secondary-background-color, rgba(128,128,128,0.06));
          border: 1px solid var(--divider-color, rgba(128,128,128,0.14));
          border-radius: 8px;
        }
        .overview.compact .ov-item {
          flex: 1 1 145px; min-width: 0;
          flex-direction: row; align-items: center; justify-content: space-between;
          gap: 0.6rem; padding: 0.35rem 0.5rem;
          background: transparent; border: none; border-radius: 6px;
        }
        .overview.compact .ov-item.copyable:hover {
          background: var(--secondary-background-color, rgba(128,128,128,0.08));
        }
        .overview.compact .ov-item.copyable:hover .ov-label::after,
        .overview.compact .ov-item.copied .ov-label::after {
          content: none;
        }
        .overview.compact .ov-label { flex-shrink: 0; }
        .overview.compact .ov-value { text-align: right; }
        .overview.compact .ov-value-row { margin-left: auto; min-width: 0; }
        .overview.compact .poe-bar-wrap {
          flex: 1 0 100%;
          border: none;
          border-top: 1px solid var(--divider-color, rgba(128,128,128,0.14));
          border-radius: 0;
          padding: 0.55rem 0.5rem 0.2rem;
        }
        .ov-item {
          background: var(--secondary-background-color, rgba(128,128,128,0.06));
          border: 1px solid var(--divider-color, rgba(128,128,128,0.14));
          border-radius: 8px; padding: 0.45rem 0.6rem;
          display: flex; flex-direction: column; gap: 0.12rem;
        }
        .ov-label {
          font-size: ${fs(0.64)}; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.08em;
          color: var(--secondary-text-color);
        }
        .ov-value {
          font-size: ${fs(0.9)}; font-weight: 600;
          color: var(--primary-text-color);
          font-variant-numeric: tabular-nums;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .ov-value.poe    { color: var(--primary-color, #03a9f4); }
        .ov-value.remain { color: #2e8f57; }

        /* Copyable overview tiles */
        .ov-item.copyable { cursor: pointer; transition: border-color 0.15s ease; }
        .ov-item.copyable:hover { border-color: var(--primary-color, #03a9f4); }
        .ov-item.copyable:hover .ov-label::after {
          content: " · click to copy";
          font-weight: 400; opacity: 0.7; text-transform: none; letter-spacing: 0;
        }
        .ov-item.copied { border-color: #2e8f57 !important; }
        .ov-item.copied .ov-label::after {
          content: " · copied!";
          color: #2e8f57; font-weight: 400; text-transform: none; letter-spacing: 0;
        }

        /* Switch UI link */
        .ui-link {
          display: inline-flex; align-items: center; justify-content: center;
          width: 1.3rem; height: 1.3rem; border-radius: 4px;
          color: var(--secondary-text-color);
          background: none; border: none; cursor: pointer; padding: 0;
          transition: color 0.15s ease; text-decoration: none; flex-shrink: 0;
        }
        .ui-link:hover { color: var(--primary-color, #03a9f4); }
        .ov-value-row { display: flex; align-items: center; gap: 0.3rem; }

        /* PoE budget bar */
        .poe-bar-wrap {
          grid-column: 1 / -1;
          background: var(--secondary-background-color, rgba(128,128,128,0.06));
          border: 1px solid var(--divider-color, rgba(128,128,128,0.14));
          border-radius: 8px; padding: 0.45rem 0.6rem;
        }
        .poe-bar-header {
          display: flex; justify-content: space-between;
          align-items: center; margin-bottom: 0.35rem;
        }
        .poe-bar-track {
          height: 5px; border-radius: 999px;
          background: var(--divider-color, rgba(128,128,128,0.2)); overflow: hidden;
        }
        .poe-bar-fill {
          height: 100%; border-radius: 999px;
          background: var(--primary-color, #03a9f4);
          transition: width 0.4s ease;
        }

        /* Limit editor */
        .limit-editor {
          display: flex; align-items: center; gap: 0.4rem;
          margin-top: 0.45rem; flex-wrap: wrap;
        }
        .limit-input {
          width: 5rem; font-size: ${fs(0.85)};
          padding: 0.2rem 0.4rem; border-radius: 5px;
          border: 1px solid var(--primary-color, #03a9f4);
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          font-variant-numeric: tabular-nums;
        }
        .limit-input:focus { outline: none; border-color: var(--primary-color); }
        .limit-unit { font-size: ${fs(0.78)}; color: var(--secondary-text-color); }
        .edit-pencil {
          background: none; border: none; cursor: pointer;
          color: var(--secondary-text-color); padding: 0 0.2rem;
          font-size: ${fs(0.8)}; line-height: 1;
          transition: color 0.15s ease;
        }
        .edit-pencil:hover { color: var(--primary-color); }

        /* ── Section ── */
        .section { margin-bottom: 0.75rem; }
        .section:last-child { margin-bottom: 0; }
        .section-header {
          display: flex; align-items: center; gap: 0.5rem;
          margin-bottom: 0.35rem; padding-bottom: 0.3rem;
          border-bottom: 1px solid var(--divider-color, rgba(128,128,128,0.14));
        }
        .section-label {
          font-size: ${fs(0.7)}; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.1em;
          color: var(--secondary-text-color); flex: 1;
        }
        .section-stat { font-size: ${fs(0.7)}; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
        .section-stat span { color: var(--primary-color, #03a9f4); font-weight: 600; }

        /* ── Port table ── */
        .port-table { width: 100%; border-collapse: collapse; }
        .port-row td {
          padding: 0.3rem 0.25rem; vertical-align: middle;
          border-bottom: 1px solid var(--divider-color, rgba(128,128,128,0.07));
        }
        .port-row.expandable { cursor: pointer; }
        .port-row.expandable:hover td { background: var(--secondary-background-color, rgba(128,128,128,0.05)); }
        .port-row:last-child td { border-bottom: none; }

        .port-num {
          font-size: ${fs(0.8)}; font-weight: 700; font-variant-numeric: tabular-nums;
          color: var(--secondary-text-color); width: 2rem; text-align: center;
        }
        .port-num.up { color: #2e8f57; }

        .link-dot {
          display: inline-block; width: 0.48rem; height: 0.48rem;
          border-radius: 50%; background: rgba(128,128,128,0.25); flex-shrink: 0;
        }
        .link-dot.up { background: #2e8f57; box-shadow: 0 0 4px rgba(46,143,87,0.45); }

        .port-info-cell { width: 100%; }
        .port-info { display: flex; align-items: center; gap: 0.4rem; }
        .port-speed { font-size: ${fs(0.75)}; color: var(--secondary-text-color); white-space: nowrap; }
        .port-speed.active { color: #2e8f57; }
        .port-label {
          min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font-size: ${fs(0.8)}; font-weight: 500; color: var(--primary-text-color);
        }
        .port-label::before {
          content: "·"; margin-right: 0.4rem; color: var(--secondary-text-color);
        }

        .poe-badge {
          font-size: ${fs(0.66)}; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.05em;
          padding: 0.1rem 0.38rem; border-radius: 999px; white-space: nowrap;
          background: rgba(128,128,128,0.1); color: var(--secondary-text-color);
          border: 1px solid transparent;
        }
        .poe-badge.active {
          background: rgba(3,169,244,0.1); color: var(--primary-color, #03a9f4);
          border-color: rgba(3,169,244,0.22);
        }

        .port-watt {
          font-size: ${fs(0.8)}; font-variant-numeric: tabular-nums;
          color: var(--primary-color, #03a9f4); font-weight: 600;
          white-space: nowrap; min-width: 3.2rem;
          text-align: right; padding-right: 0.35rem;
        }
        .port-watt.zero { color: var(--secondary-text-color); font-weight: 400; }

        .chevron-cell { width: 1.2rem; text-align: center; }
        .chevron {
          display: inline-block; width: 0; height: 0; border-style: solid;
          border-width: 0.26rem 0.2rem 0 0.2rem;
          border-color: var(--secondary-text-color) transparent transparent transparent;
          transition: transform 0.15s ease; opacity: 0.45; vertical-align: middle;
        }
        .chevron.open { transform: rotate(180deg); }

        /* ── Detail row ── */
        .detail-row td {
          padding: 0;
          border-bottom: 1px solid var(--divider-color, rgba(128,128,128,0.07));
        }
        .detail-inner {
          padding: 0.5rem 0.5rem 0.6rem 2.3rem;
          display: flex; gap: 0.6rem 1rem; flex-wrap: wrap;
          background: var(--secondary-background-color, rgba(128,128,128,0.04));
        }
        .d-item { display: flex; flex-direction: column; gap: 0.12rem; min-width: 70px; }
        .d-label {
          font-size: ${fs(0.64)}; text-transform: uppercase;
          letter-spacing: 0.08em; color: var(--secondary-text-color); font-weight: 700;
        }
        .d-value { font-size: ${fs(0.86)}; color: var(--primary-text-color); font-weight: 500; font-variant-numeric: tabular-nums; }
        .d-value.poe  { color: var(--primary-color, #03a9f4); }
        .d-value.good { color: #2e8f57; }
        .d-value.muted { color: var(--secondary-text-color); }

        /* Label editor */
        .label-edit-row { display: flex; align-items: center; gap: 0.35rem; }
        .label-input {
          width: 9.5rem; max-width: 40vw;
          font-size: ${fs(0.85)}; font-family: inherit;
          padding: 0.22rem 0.45rem; border-radius: 5px;
          border: 1px solid var(--divider-color, rgba(128,128,128,0.3));
          background: var(--ha-card-background, var(--card-background-color));
          color: var(--primary-text-color);
        }
        .label-input:focus { outline: none; border-color: var(--primary-color, #03a9f4); }
        .label-input::placeholder { color: var(--secondary-text-color); opacity: 0.7; }

        /* Configure button */
        .btn-configure {
          font-size: ${fs(0.76)}; font-weight: 600;
          padding: 0.22rem 0.65rem; border-radius: 999px;
          border: 1px solid rgba(3,169,244,0.4);
          background: rgba(3,169,244,0.07);
          color: var(--primary-color, #03a9f4);
          cursor: pointer; white-space: nowrap;
          transition: background 0.15s ease, border-color 0.15s ease;
          align-self: center;
        }
        .btn-configure:hover { background: rgba(3,169,244,0.14); border-color: var(--primary-color); }
        .btn-configure:disabled { opacity: 0.45; cursor: not-allowed; }

        /* ── Configure panel ── */
        .configure-row td {
          padding: 0;
          border-bottom: 1px solid var(--divider-color, rgba(128,128,128,0.07));
        }
        .configure-inner {
          padding: 0.65rem 0.65rem 0.75rem 2.3rem;
          background: var(--secondary-background-color, rgba(128,128,128,0.04));
          border-top: 1px solid rgba(3,169,244,0.2);
          display: flex; flex-direction: column; gap: 0.6rem;
        }
        .configure-title {
          font-size: ${fs(0.7)}; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.09em;
          color: var(--primary-color, #03a9f4);
        }
        .configure-fields {
          display: flex; gap: 0.75rem 1.25rem; flex-wrap: wrap; align-items: flex-end;
        }
        .cfg-field { display: flex; flex-direction: column; gap: 0.22rem; }
        .cfg-label {
          font-size: ${fs(0.64)}; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.08em;
          color: var(--secondary-text-color);
        }
        .cfg-select {
          font-size: ${fs(0.86)}; font-family: inherit;
          padding: 0.25rem 0.5rem; border-radius: 6px;
          border: 1px solid var(--divider-color, rgba(128,128,128,0.3));
          background: var(--ha-card-background, var(--card-background-color));
          color: var(--primary-text-color); cursor: pointer;
          min-width: 90px;
        }
        .cfg-select:focus { outline: none; border-color: var(--primary-color); }
        .configure-actions { display: flex; gap: 0.5rem; }
        .btn-apply {
          font-size: ${fs(0.8)}; font-weight: 600;
          padding: 0.25rem 0.8rem; border-radius: 999px;
          border: none; background: var(--primary-color, #03a9f4);
          color: #fff; cursor: pointer;
          transition: opacity 0.15s ease;
        }
        .btn-apply:hover { opacity: 0.85; }
        .btn-apply:disabled { opacity: 0.45; cursor: not-allowed; }
        .btn-cancel {
          font-size: ${fs(0.8)}; font-weight: 600;
          padding: 0.25rem 0.8rem; border-radius: 999px;
          border: 1px solid var(--divider-color, rgba(128,128,128,0.3));
          background: transparent; color: var(--secondary-text-color);
          cursor: pointer; transition: border-color 0.15s ease, color 0.15s ease;
        }
        .btn-cancel:hover { border-color: var(--primary-text-color); color: var(--primary-text-color); }

        ha-switch { --mdc-switch-track-height: 14px; }
        .placeholder { padding: 1rem; color: var(--secondary-text-color); font-size: ${fs(0.9)}; }
      `;
    }

    // ── Render helpers ────────────────────────────────────────────────────────

    _renderToggle(entityId) {
      if (!entityId) return `<span class="d-value muted">—</span>`;
      const e = this._hass?.states[entityId];
      if (!e)  return `<span class="d-value muted">—</span>`;
      return `<ha-switch ${e.state === "on" ? "checked" : ""} data-entity="${entityId}"></ha-switch>`;
    }

    _fmtSpeed(raw) {
      if (!raw) return null;
      const m = raw.match(/(\d+)/);
      if (!m) return raw;
      const n = parseInt(m[1]);
      if (n >= 10000) return "10G";
      if (n >= 2500)  return "2.5G";
      if (n >= 1000)  return "1G";
      if (n >= 100)   return "100M";
      return `${n}M`;
    }

    _renderOverview() {
      const pfx    = this.config.entity_prefix;
      const hasPoe = this.config.has_poe;
      const layout = this.config.overview_layout;
      const fields = this.config.overview_fields;

      if (layout === "hidden" || fields.length === 0) return "";

      const poeS = hasPoe ? this._e(`sensor.${pfx}_poe_consumption`) : null;
      const netS = this._e(`sensor.${pfx}_network_info`);

      const consumed = parseFloat(poeS?.state ?? 0) || 0;
      const limitW   = parseFloat(poeS?.attributes?.power_limit_w ?? 0) || 0;
      const remainW  = parseFloat(poeS?.attributes?.power_remain_w ?? 0) || 0;
      const pct      = limitW > 0 ? Math.min(100, (consumed / limitW) * 100) : 0;
      const barColor = pct > 95 ? "#c22040" : pct > 80 ? "#f4b942" : "var(--primary-color, #03a9f4)";

      const ip        = netS?.state ?? "—";
      const mac       = netS?.attributes?.mac ?? "—";
      const gateway   = netS?.attributes?.gateway ?? "—";
      const mask      = netS?.attributes?.netmask ?? "—";
      const switchUrl = this.config.show_switch_link ? this._getSwitchUrl() : null;

      const maxPoeW = this.config.max_poe_watts;
      const limitEditorHtml = hasPoe && this._editingLimit ? `
        <div class="limit-editor">
          <input class="limit-input" type="number" id="poe-limit-input"
            value="${this._pendingLimit || limitW}"
            min="1" max="${maxPoeW || 1000}" step="0.5">
          <span class="limit-unit">W</span>
          ${maxPoeW ? `<span class="limit-unit" style="color:var(--secondary-text-color)">max ${maxPoeW} W</span>` : ""}
          <span class="limit-error" id="poe-limit-error" style="display:none;color:#c22040;font-size:${this._fs(0.72)}"></span>
          <button class="btn-apply" id="poe-limit-apply" ${this._applyingLimit ? "disabled" : ""}>
            ${this._applyingLimit ? "Applying…" : "Set"}
          </button>
          <button class="btn-cancel" id="poe-limit-cancel">Cancel</button>
        </div>` : "";

      const renderField = field => {
        switch (field) {
          case "ip":
            return `
              <div class="ov-item copyable" data-copy="${this._escapeHtml(ip)}">
                <div class="ov-label">IP address</div>
                <div class="ov-value-row">
                  <div class="ov-value" style="flex:1">${this._escapeHtml(ip)}</div>
                  ${switchUrl ? `<a class="ui-link" href="${this._escapeHtml(switchUrl)}" target="_blank" rel="noreferrer" title="Open switch UI">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                      <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                  </a>` : ""}
                </div>
              </div>`;

          case "mac":
            return `
              <div class="ov-item copyable" data-copy="${this._escapeHtml(mac)}">
                <div class="ov-label">MAC</div>
                <div class="ov-value" style="font-size:${this._fs(0.76)};letter-spacing:0.02em">${this._escapeHtml(mac)}</div>
              </div>`;

          case "gateway":
            return `
              <div class="ov-item">
                <div class="ov-label">Gateway</div>
                <div class="ov-value">${this._escapeHtml(gateway)}</div>
              </div>`;

          case "netmask":
            return `
              <div class="ov-item">
                <div class="ov-label">Netmask</div>
                <div class="ov-value">${this._escapeHtml(mask)}</div>
              </div>`;

          case "poe_used":
            return hasPoe ? `
              <div class="ov-item">
                <div class="ov-label">PoE used</div>
                <div class="ov-value poe">${consumed.toFixed(1)} W</div>
              </div>` : "";

          case "poe_remaining":
            return hasPoe ? `
              <div class="ov-item">
                <div class="ov-label">PoE remaining</div>
                <div class="ov-value remain">${remainW.toFixed(1)} W</div>
              </div>` : "";

          case "poe_budget":
            return hasPoe ? `
              <div class="poe-bar-wrap">
                <div class="poe-bar-header">
                  <div class="ov-label">PoE budget</div>
                  <div style="display:flex;align-items:center;gap:0.3rem">
                    <div class="ov-label">${consumed.toFixed(1)} / ${limitW} W (${pct.toFixed(0)}%)</div>
                    <button class="edit-pencil" id="poe-limit-edit" title="Edit PoE budget limit">✏️</button>
                  </div>
                </div>
                <div class="poe-bar-track">
                  <div class="poe-bar-fill" style="width:${pct.toFixed(1)}%;background:${barColor}"></div>
                </div>
                ${limitEditorHtml}
              </div>` : "";

          default:
            return "";
        }
      };

      const overviewHtml = fields.map(renderField).join("");
      if (!overviewHtml.trim()) return "";

      return `
        <div class="overview ${layout === "compact" ? "compact" : ""}">
          ${overviewHtml}
        </div>`;
    }

    _renderPort(port, hasPoe) {
      const ent   = this._portEntities(port);
      const isUp  = ent.state?.state === "on";
      const poeOn = ent.poeState?.state === "on";
      const watts = hasPoe ? (parseFloat(ent.poeState?.attributes?.power_w ?? 0) || 0) : 0;
      const speed       = ent.state?.attributes?.speed ?? null;
      const speedConfig = ent.state?.attributes?.speed_config ?? null;
      const portLabel   = this._effectiveLabel(port);
      const safeLabel   = portLabel ? this._escapeHtml(portLabel) : "";

      const pfx         = this.config.entity_prefix;
      const poeEnabledId  = hasPoe && ent.poeEnabled  ? `switch.${pfx}_port_${port}_poe_enabled`  : null;
      const portEnabledId = ent.portEnabled ? `switch.${pfx}_port_${port}_enabled` : null;

      const hasToggles  = !!(poeEnabledId || portEnabledId);
      const canExpand   = hasToggles || this.config.editable_labels;
      const expanded    = canExpand && this._expanded.has(port);
      const configuring = this._configuring.has(port);
      const applying    = this._applying.has(port);

      const mainRow = `
        <tr class="port-row${canExpand ? " expandable" : ""}" data-port="${port}"
          ${canExpand ? `role="button" aria-expanded="${expanded}" aria-label="Port ${port}${safeLabel ? ` ${safeLabel}` : ""} details"` : ""}>
          <td class="port-num ${isUp ? "up" : ""}">P${port}</td>
          <td class="port-info-cell">
            <div class="port-info">
              <span class="link-dot ${isUp ? "up" : ""}"></span>
              <span class="port-speed ${isUp ? "active" : ""}">${isUp && speed ? this._fmtSpeed(speed) : isUp ? "Up" : "Down"}</span>
              ${safeLabel ? `<span class="port-label" title="${safeLabel}">${safeLabel}</span>` : ""}
              ${hasPoe ? `<span class="poe-badge ${poeOn ? "active" : ""}">${poeOn ? "PoE" : "no PoE"}</span>` : ""}
            </div>
          </td>
          <td class="port-watt ${!hasPoe || watts === 0 ? "zero" : ""}">${hasPoe && watts > 0 ? watts.toFixed(1) + " W" : hasPoe ? "—" : ""}</td>
          <td class="chevron-cell">${canExpand ? `<span class="chevron ${expanded ? "open" : ""}"></span>` : ""}</td>
        </tr>`;

      if (!expanded) return mainRow;

      const attr    = ent.poeState?.attributes ?? {};
      const pending = this._pendingPoe.get(port) ?? {};

      // Inline label editor — draft survives re-renders triggered by entity updates
      const savingLabel = this._savingLabel.has(port);
      const draft       = this._labelDrafts.get(port);
      const labelEditor = this.config.editable_labels ? `
        <div class="d-item">
          <div class="d-label">Label</div>
          <div class="label-edit-row">
            <input class="label-input" type="text" maxlength="${MAX_LABEL_LENGTH}"
              placeholder="Port name" data-label-port="${port}"
              value="${this._escapeHtml(draft ?? portLabel)}">
            <button class="btn-apply" data-label-save="${port}" ${savingLabel ? "disabled" : ""}>
              ${savingLabel ? "Saving…" : "Save"}
            </button>
          </div>
        </div>` : "";

      // Detail row — read-only values + toggles + label editor + Configure button
      const detailRow = `
        <tr class="detail-row">
          <td colspan="4">
            <div class="detail-inner">
              ${isUp && speed ? `<div class="d-item"><div class="d-label">Speed</div><div class="d-value good">${this._fmtSpeed(speed)}</div></div>` : ""}
              ${speedConfig   ? `<div class="d-item"><div class="d-label">Configured</div><div class="d-value muted">${speedConfig}</div></div>` : ""}
              ${hasPoe && poeOn ? `
                <div class="d-item"><div class="d-label">Power</div><div class="d-value poe">${watts.toFixed(1)} W</div></div>
                ${attr.current_ma != null ? `<div class="d-item"><div class="d-label">Current</div><div class="d-value">${attr.current_ma} mA</div></div>` : ""}
                ${attr.voltage_v  != null ? `<div class="d-item"><div class="d-label">Voltage</div><div class="d-value">${attr.voltage_v} V</div></div>` : ""}
                ${attr.pd_class   ? `<div class="d-item"><div class="d-label">PD class</div><div class="d-value">${attr.pd_class}</div></div>` : ""}
              ` : ""}
              ${hasPoe && attr.priority    ? `<div class="d-item"><div class="d-label">Priority</div><div class="d-value">${attr.priority}</div></div>` : ""}
              ${hasPoe && attr.power_limit ? `<div class="d-item"><div class="d-label">Limit</div><div class="d-value">${attr.power_limit}</div></div>` : ""}
              ${poeEnabledId  ? `<div class="d-item"><div class="d-label">PoE enabled</div>${this._renderToggle(poeEnabledId)}</div>`  : ""}
              ${portEnabledId ? `<div class="d-item"><div class="d-label">Port enabled</div>${this._renderToggle(portEnabledId)}</div>` : ""}
              ${labelEditor}
              ${hasPoe ? `<button class="btn-configure" data-configure="${port}" ${applying ? "disabled" : ""}>
                ${applying ? "Applying…" : "Configure PoE"}
              </button>` : ""}
            </div>
          </td>
        </tr>`;

      // Configure panel — shown below detail row when open
      const configureRow = configuring ? `
        <tr class="configure-row">
          <td colspan="4">
            <div class="configure-inner">
              <div class="configure-title">Port ${port} — PoE Settings</div>
              <div class="configure-fields">
                <div class="cfg-field">
                  <div class="cfg-label">Priority</div>
                  <select class="cfg-select" data-cfg-port="${port}" data-cfg-key="priority">
                    ${POE_PRIORITIES.map(v => `<option value="${v}" ${(pending.priority ?? attr.priority) === v ? "selected" : ""}>${v}</option>`).join("")}
                  </select>
                </div>
                <div class="cfg-field">
                  <div class="cfg-label">Power limit</div>
                  <select class="cfg-select" data-cfg-port="${port}" data-cfg-key="power_limit">
                    ${POE_POWER_LIMITS.map(v => `<option value="${v}" ${(pending.power_limit ?? attr.power_limit) === v ? "selected" : ""}>${v}</option>`).join("")}
                  </select>
                </div>
              </div>
              <div class="configure-actions">
                <button class="btn-apply" data-apply-port="${port}" ${applying ? "disabled" : ""}>
                  ${applying ? "Applying…" : "Apply"}
                </button>
                <button class="btn-cancel" data-cancel-port="${port}">Cancel</button>
              </div>
            </div>
          </td>
        </tr>` : "";

      return mainRow + detailRow + configureRow;
    }

    _totalWatts(ports) {
      return ports.reduce((sum, port) =>
        sum + (parseFloat(this._portEntities(port).poeState?.attributes?.power_w ?? 0) || 0), 0);
    }

    // ── Main render ───────────────────────────────────────────────────────────

    render() {
      if (!this.config) return;
      if (!this._hass) {
        this.innerHTML = `<div class="card"><style>${this._css()}</style><div class="placeholder">Waiting for Home Assistant…</div></div>`;
        return;
      }

      this._portEntitiesCache.clear();
      this._localLabelsCache = null;

      const hasPoe       = this.config.has_poe;
      const poePorts     = hasPoe ? Array.from({ length: this.config.poe_ports }, (_, i) => i + 1) : [];
      const regularPorts = Array.from(
        { length: this.config.total_ports - poePorts.length },
        (_, i) => i + poePorts.length + 1
      );

      const totalWatts = this._totalWatts(poePorts);
      const portsUp    = [...poePorts, ...regularPorts].filter(p => this._portEntities(p).state?.state === "on").length;
      const poeActive  = poePorts.filter(p => this._portEntities(p).poeState?.state === "on").length;
      const pfx        = this.config.entity_prefix;
      const limitW     = hasPoe
        ? (parseFloat(this._e(`sensor.${pfx}_poe_consumption`)?.attributes?.power_limit_w ?? 0) || 0)
        : 0;

      this.innerHTML = `
        <div class="card">
          <style>${this._css()}</style>
          <div class="card-header">
            <div class="card-title">${this.config.title}</div>
            <div class="summary-pills">
              <div class="pill up">${portsUp} / ${this.config.total_ports} up</div>
              ${hasPoe ? `<div class="pill poe">${poeActive} PoE · ${totalWatts.toFixed(1)} W</div>` : ""}
            </div>
          </div>

          ${this._renderOverview()}

          ${hasPoe ? `
          <div class="section">
            <div class="section-header">
              <div class="section-label">PoE ports 1–${this.config.poe_ports}</div>
              <div class="section-stat">Total <span>${totalWatts.toFixed(1)} W</span> of ${limitW} W</div>
            </div>
            <table class="port-table">
              <tbody>${poePorts.map(p => this._renderPort(p, true)).join("")}</tbody>
            </table>
          </div>
          ` : ""}

          <div class="section">
            <div class="section-header">
              <div class="section-label">${hasPoe ? `Ports ${this.config.poe_ports + 1}–${this.config.total_ports}` : `Ports 1–${this.config.total_ports}`}</div>
            </div>
            <table class="port-table">
              <tbody>${regularPorts.map(p => this._renderPort(p, false)).join("")}</tbody>
            </table>
          </div>
        </div>`;

      this._bindEvents();
    }

    // ── Event binding ─────────────────────────────────────────────────────────

    _clipboardFallback(text, onSuccess) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok && onSuccess) onSuccess();
      } catch (err) {
        console.warn("tplink-switch-card: clipboard copy failed", err);
      }
    }

    _bindEvents() {
      // Port row expand/collapse
      this.querySelectorAll(".port-row.expandable").forEach(row => {
        row.addEventListener("click", e => {
          if (e.target.closest("ha-switch, button, select, input, a")) return;
          this._toggleExpand(parseInt(row.dataset.port));
        });
      });

      // Toggle switches
      this.querySelectorAll("ha-switch[data-entity]").forEach(sw => {
        sw.addEventListener("change", e => { e.stopPropagation(); this._toggle(sw.dataset.entity); });
        sw.addEventListener("click",  e => e.stopPropagation());
      });

      // Configure PoE button
      this.querySelectorAll("[data-configure]").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          this._openConfigure(parseInt(btn.dataset.configure));
        });
      });

      // Configure panel — select change
      this.querySelectorAll(".cfg-select[data-cfg-port]").forEach(sel => {
        sel.addEventListener("change", e => {
          e.stopPropagation();
          const port = parseInt(sel.dataset.cfgPort);
          const key  = sel.dataset.cfgKey;
          const cur  = this._pendingPoe.get(port) ?? {};
          this._pendingPoe.set(port, { ...cur, [key]: sel.value });
        });
      });

      // Apply button
      this.querySelectorAll("[data-apply-port]").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          this._applyPortPoe(parseInt(btn.dataset.applyPort));
        });
      });

      // Cancel button
      this.querySelectorAll("[data-cancel-port]").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          this._cancelConfigure(parseInt(btn.dataset.cancelPort));
        });
      });

      // Label editor — input keeps a draft (no re-render), Enter or Save persists
      this.querySelectorAll(".label-input[data-label-port]").forEach(inp => {
        const port = parseInt(inp.dataset.labelPort);
        inp.addEventListener("click", e => e.stopPropagation());
        inp.addEventListener("input", () => {
          this._labelDrafts.set(port, inp.value);
        });
        inp.addEventListener("keydown", e => {
          e.stopPropagation();
          if (e.key === "Enter") this._saveLabel(port, inp.value);
          if (e.key === "Escape") {
            this._labelDrafts.delete(port);
            this.render();
          }
        });
      });
      this.querySelectorAll("[data-label-save]").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          const port = parseInt(btn.dataset.labelSave);
          const inp  = this.querySelector(`.label-input[data-label-port="${port}"]`);
          this._saveLabel(port, inp?.value ?? "");
        });
      });

      // Copyable tiles
      this.querySelectorAll(".ov-item.copyable[data-copy]").forEach(tile => {
        tile.addEventListener("click", e => {
          if (e.target.closest("a")) return;
          const val = tile.dataset.copy;
          if (!val || val === "—") return;

          const markCopied = () => {
            tile.classList.add("copied");
            setTimeout(() => tile.classList.remove("copied"), 1500);
          };

          // Modern clipboard API (requires HTTPS or localhost)
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(val).then(markCopied).catch(() => {
              this._clipboardFallback(val, markCopied);
            });
          } else {
            this._clipboardFallback(val, markCopied);
          }
        });
      });

      // PoE limit edit pencil
      this.querySelector("#poe-limit-edit")?.addEventListener("click", e => {
        e.stopPropagation();
        const pfx  = this.config.entity_prefix;
        const limitW = parseFloat(this._e(`sensor.${pfx}_poe_consumption`)?.attributes?.power_limit_w ?? 0) || 0;
        this._pendingLimit = String(limitW);
        this._editingLimit = true;
        this.render();
      });

      // PoE limit input — only sync value, no re-render
      this.querySelector("#poe-limit-input")?.addEventListener("input", e => {
        this._pendingLimit = e.target.value;
      });

      // PoE limit apply
      this.querySelector("#poe-limit-apply")?.addEventListener("click", e => {
        e.stopPropagation();
        this._applyPoeLimitGlobal();
      });

      // PoE limit cancel
      this.querySelector("#poe-limit-cancel")?.addEventListener("click", e => {
        e.stopPropagation();
        this._editingLimit = false;
        this._pendingLimit = "";
        this.render();
      });
    }
  }

  customElements.define(CARD_NAME, TplinkSwitchCard);

  // ── Visual editor ──────────────────────────────────────────────────────────
  //
  // Built on ha-form (Home Assistant's built-in schema-driven form component,
  // globally available in the frontend — same pattern already relied on for
  // ha-switch elsewhere in this file). port_labels is deliberately NOT exposed
  // here: it already has a better, WYSIWYG editing flow directly in the card
  // itself (click a port row → Label field), so duplicating it as a form list
  // would be redundant and worse UX. overview_fields is a simple multi-select
  // (fixed order) rather than a reorderable list — full drag-reordering isn't
  // worth the complexity for a card editor.

  class TplinkSwitchCardEditor extends HTMLElement {
    setConfig(config) {
      this._config = config;
      this._render();
    }

    set hass(hass) {
      this._hass = hass;
      this._render();
    }

    connectedCallback() {
      this._render();
    }

    // Suggests entity prefixes actually present in this HA instance, since a
    // mismatched entity_prefix (the #1 setup mistake) silently shows no data.
    _entityPrefixSelector() {
      const suffix = "_network_info";
      const states = this._hass?.states ?? {};
      const prefixes = Object.keys(states)
        .filter(id => id.startsWith("sensor.") && id.endsWith(suffix))
        .map(id => id.slice("sensor.".length, -suffix.length));
      if (!prefixes.length) return { text: {} };
      return { select: { mode: "dropdown", custom_value: true, options: [...new Set(prefixes)] } };
    }

    _schema() {
      const hasPoe = this._config?.has_poe !== false;
      const schema = [
        { name: "title", selector: { text: {} } },
        { name: "entity_prefix", selector: this._entityPrefixSelector() },
        { name: "has_poe", selector: { boolean: {} } },
      ];
      if (hasPoe) {
        schema.push(
          { name: "poe_ports", selector: { number: { min: 0, max: 48, mode: "box" } } },
          { name: "max_poe_watts", selector: { number: { min: 0, mode: "box" } } },
        );
      }
      schema.push(
        { name: "total_ports", selector: { number: { min: 1, max: 48, mode: "box" } } },
        { name: "overview_layout", selector: { select: { mode: "dropdown", options: [
          { value: "tiles", label: "Tiles" },
          { value: "compact", label: "Compact" },
          { value: "hidden", label: "Hidden" },
        ] } } },
        { name: "overview_fields", selector: { select: {
          multiple: true,
          mode: "list",
          options: DEFAULT_OVERVIEW_FIELDS.map(f => ({ value: f, label: OVERVIEW_FIELD_LABELS[f] })),
        } } },
        { name: "show_switch_link", selector: { boolean: {} } },
        { name: "font_scale", selector: { number: { min: 0.7, max: 2, step: 0.1, mode: "slider" } } },
        { name: "editable_labels", selector: { boolean: {} } },
      );
      return schema;
    }

    _computeLabel(schema) {
      const labels = {
        title: "Title",
        entity_prefix: "Entity prefix",
        has_poe: "Switch has PoE",
        poe_ports: "Number of PoE ports",
        max_poe_watts: "Hardware PoE max (W)",
        total_ports: "Total ports",
        overview_layout: "Overview layout",
        overview_fields: "Overview fields",
        show_switch_link: "Show switch web-UI link",
        font_scale: "Font scale",
        editable_labels: "Allow inline label editing",
      };
      return labels[schema.name] ?? schema.name;
    }

    _render() {
      if (!this._config || !this._hass) return;
      let form = this.querySelector("ha-form");
      if (!form) {
        form = document.createElement("ha-form");
        form.addEventListener("value-changed", e => {
          e.stopPropagation();
          this.dispatchEvent(new CustomEvent("config-changed", {
            detail: { config: e.detail.value },
            bubbles: true,
            composed: true,
          }));
        });
        this.innerHTML = "";
        this.appendChild(form);
      }
      form.hass = this._hass;
      form.data = this._config;
      form.schema = this._schema();
      form.computeLabel = this._computeLabel;
    }
  }

  customElements.define(`${CARD_NAME}-editor`, TplinkSwitchCardEditor);
})();
