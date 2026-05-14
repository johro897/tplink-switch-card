/*
 * TP-Link Switch Card
 * Lovelace custom card for TP-Link Easy Smart switch overview.
 *
 * UX levels:
 *   1. Port row        — link dot, speed, PoE badge, wattage
 *   2. Detail row      — all read values + toggles + Configure button (PoE ports only)
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
    }

    setConfig(config) {
      if (!config) throw new Error("Missing configuration");
      this.config = {
        title: "TP-Link Switch",
        poe_ports: 8,
        total_ports: 16,
        entity_prefix: "tp_link_switch",
        max_poe_watts: null,
        ...config,
      };
      this._portEntitiesCache.clear();
      this.render();
    }

    set hass(hass) {
      const old = this._hass;
      this._hass = hass;
      if (old && !this._statesChanged(old, hass)) return;
      this.render();
    }

    connectedCallback() { this.render(); }
    getCardSize() { return 7; }

    // ── Change detection ──────────────────────────────────────────────────────

    _watchedEntities() {
      if (!this.config) return [];
      const p = this.config.entity_prefix;
      const ids = [`sensor.${p}_poe_consumption`, `sensor.${p}_network_info`];
      for (let i = 1; i <= this.config.total_ports; i++) {
        ids.push(`binary_sensor.${p}_port_${i}_state`);
        if (i <= this.config.poe_ports) {
          ids.push(`binary_sensor.${p}_port_${i}_poe_state`);
          ids.push(`switch.${p}_port_${i}_poe_enabled`);
        }
        ids.push(`switch.${p}_port_${i}_enabled`);
      }
      return ids;
    }

    _statesChanged(oldHass, newHass) {
      return this._watchedEntities().some(id => {
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
      const p = this.config.entity_prefix;
      const entities = {
        state:       this._e(`binary_sensor.${p}_port_${port}_state`),
        poeState:    this._e(`binary_sensor.${p}_port_${port}_poe_state`),
        poeEnabled:  this._e(`switch.${p}_port_${port}_poe_enabled`),
        portEnabled: this._e(`switch.${p}_port_${port}_enabled`),
      };
      this._portEntitiesCache.set(port, entities);
      return entities;
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
        .card-title { font-size: 1.05rem; font-weight: 700; }
        .summary-pills { display: flex; gap: 0.4rem; flex-wrap: wrap; }
        .pill {
          font-size: 0.62rem; font-weight: 700;
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
        .ov-item {
          background: var(--secondary-background-color, rgba(128,128,128,0.06));
          border: 1px solid var(--divider-color, rgba(128,128,128,0.14));
          border-radius: 8px; padding: 0.45rem 0.6rem;
          display: flex; flex-direction: column; gap: 0.12rem;
        }
        .ov-label {
          font-size: 0.56rem; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.08em;
          color: var(--secondary-text-color);
        }
        .ov-value {
          font-size: 0.82rem; font-weight: 600;
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
          width: 5rem; font-size: 0.78rem;
          padding: 0.2rem 0.4rem; border-radius: 5px;
          border: 1px solid var(--primary-color, #03a9f4);
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          font-variant-numeric: tabular-nums;
        }
        .limit-input:focus { outline: none; border-color: var(--primary-color); }
        .limit-unit { font-size: 0.72rem; color: var(--secondary-text-color); }
        .edit-pencil {
          background: none; border: none; cursor: pointer;
          color: var(--secondary-text-color); padding: 0 0.2rem;
          font-size: 0.75rem; line-height: 1;
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
          font-size: 0.63rem; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.1em;
          color: var(--secondary-text-color); flex: 1;
        }
        .section-stat { font-size: 0.63rem; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
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
          font-size: 0.7rem; font-weight: 700; font-variant-numeric: tabular-nums;
          color: var(--secondary-text-color); width: 1.8rem; text-align: center;
        }
        .port-num.up { color: #2e8f57; }

        .link-dot {
          display: inline-block; width: 0.48rem; height: 0.48rem;
          border-radius: 50%; background: rgba(128,128,128,0.25); flex-shrink: 0;
        }
        .link-dot.up { background: #2e8f57; box-shadow: 0 0 4px rgba(46,143,87,0.45); }

        .port-info-cell { width: 100%; }
        .port-info { display: flex; align-items: center; gap: 0.4rem; }
        .port-speed { font-size: 0.65rem; color: var(--secondary-text-color); white-space: nowrap; }
        .port-speed.active { color: #2e8f57; }

        .poe-badge {
          font-size: 0.58rem; font-weight: 700;
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
          font-size: 0.72rem; font-variant-numeric: tabular-nums;
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
          font-size: 0.56rem; text-transform: uppercase;
          letter-spacing: 0.08em; color: var(--secondary-text-color); font-weight: 700;
        }
        .d-value { font-size: 0.78rem; color: var(--primary-text-color); font-weight: 500; font-variant-numeric: tabular-nums; }
        .d-value.poe  { color: var(--primary-color, #03a9f4); }
        .d-value.good { color: #2e8f57; }
        .d-value.muted { color: var(--secondary-text-color); }

        /* Configure button */
        .btn-configure {
          font-size: 0.68rem; font-weight: 600;
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
          font-size: 0.62rem; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.09em;
          color: var(--primary-color, #03a9f4);
        }
        .configure-fields {
          display: flex; gap: 0.75rem 1.25rem; flex-wrap: wrap; align-items: flex-end;
        }
        .cfg-field { display: flex; flex-direction: column; gap: 0.22rem; }
        .cfg-label {
          font-size: 0.56rem; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.08em;
          color: var(--secondary-text-color);
        }
        .cfg-select {
          font-size: 0.78rem; font-family: inherit;
          padding: 0.25rem 0.5rem; border-radius: 6px;
          border: 1px solid var(--divider-color, rgba(128,128,128,0.3));
          background: var(--ha-card-background, var(--card-background-color));
          color: var(--primary-text-color); cursor: pointer;
          min-width: 90px;
        }
        .cfg-select:focus { outline: none; border-color: var(--primary-color); }
        .configure-actions { display: flex; gap: 0.5rem; }
        .btn-apply {
          font-size: 0.72rem; font-weight: 600;
          padding: 0.25rem 0.8rem; border-radius: 999px;
          border: none; background: var(--primary-color, #03a9f4);
          color: #fff; cursor: pointer;
          transition: opacity 0.15s ease;
        }
        .btn-apply:hover { opacity: 0.85; }
        .btn-apply:disabled { opacity: 0.45; cursor: not-allowed; }
        .btn-cancel {
          font-size: 0.72rem; font-weight: 600;
          padding: 0.25rem 0.8rem; border-radius: 999px;
          border: 1px solid var(--divider-color, rgba(128,128,128,0.3));
          background: transparent; color: var(--secondary-text-color);
          cursor: pointer; transition: border-color 0.15s ease, color 0.15s ease;
        }
        .btn-cancel:hover { border-color: var(--primary-text-color); color: var(--primary-text-color); }

        ha-switch { --mdc-switch-track-height: 14px; }
        .placeholder { padding: 1rem; color: var(--secondary-text-color); font-size: 0.9rem; }
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
      const pfx  = this.config.entity_prefix;
      const poeS = this._e(`sensor.${pfx}_poe_consumption`);
      const netS = this._e(`sensor.${pfx}_network_info`);

      const consumed = parseFloat(poeS?.state ?? 0) || 0;
      const limitW   = parseFloat(poeS?.attributes?.power_limit_w ?? 0) || 0;
      const remainW  = parseFloat(poeS?.attributes?.power_remain_w ?? 0) || 0;
      const pct      = limitW > 0 ? Math.min(100, (consumed / limitW) * 100) : 0;
      const barColor = pct > 95 ? "#c22040" : pct > 80 ? "#f4b942" : "var(--primary-color, #03a9f4)";

      const ip      = netS?.state ?? "—";
      const mac     = netS?.attributes?.mac ?? "—";
      const gateway = netS?.attributes?.gateway ?? "—";
      const mask    = netS?.attributes?.netmask ?? "—";

      const maxPoeW = this.config.max_poe_watts;
      const limitEditorHtml = this._editingLimit ? `
        <div class="limit-editor">
          <input class="limit-input" type="number" id="poe-limit-input"
            value="${this._pendingLimit || limitW}"
            min="1" max="${maxPoeW || 1000}" step="0.5">
          <span class="limit-unit">W</span>
          ${maxPoeW ? `<span class="limit-unit" style="color:var(--secondary-text-color)">max ${maxPoeW} W</span>` : ""}
          <span class="limit-error" id="poe-limit-error" style="display:none;color:#c22040;font-size:0.65rem"></span>
          <button class="btn-apply" id="poe-limit-apply" ${this._applyingLimit ? "disabled" : ""}>
            ${this._applyingLimit ? "Applying…" : "Set"}
          </button>
          <button class="btn-cancel" id="poe-limit-cancel">Cancel</button>
        </div>` : "";

      return `
        <div class="overview">
          <div class="ov-item copyable" data-copy="${ip}">
            <div class="ov-label">IP address</div>
            <div class="ov-value-row">
              <div class="ov-value" style="flex:1">${ip}</div>
              ${this._getSwitchUrl() ? `<a class="ui-link" href="${this._getSwitchUrl()}" target="_blank" rel="noreferrer" title="Open switch UI">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </a>` : ""}
            </div>
          </div>
          <div class="ov-item copyable" data-copy="${mac}">
            <div class="ov-label">MAC</div>
            <div class="ov-value" style="font-size:0.68rem;letter-spacing:0.02em">${mac}</div>
          </div>
          <div class="ov-item">
            <div class="ov-label">Gateway</div>
            <div class="ov-value">${gateway}</div>
          </div>
          <div class="ov-item">
            <div class="ov-label">Netmask</div>
            <div class="ov-value">${mask}</div>
          </div>
          <div class="ov-item">
            <div class="ov-label">PoE used</div>
            <div class="ov-value poe">${consumed.toFixed(1)} W</div>
          </div>
          <div class="ov-item">
            <div class="ov-label">PoE remaining</div>
            <div class="ov-value remain">${remainW.toFixed(1)} W</div>
          </div>
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
          </div>
        </div>`;
    }

    _renderPort(port, hasPoe) {
      const ent   = this._portEntities(port);
      const isUp  = ent.state?.state === "on";
      const poeOn = ent.poeState?.state === "on";
      const watts = hasPoe ? (parseFloat(ent.poeState?.attributes?.power_w ?? 0) || 0) : 0;
      const speed       = ent.state?.attributes?.speed ?? null;
      const speedConfig = ent.state?.attributes?.speed_config ?? null;

      const pfx         = this.config.entity_prefix;
      const poeEnabledId  = hasPoe && ent.poeEnabled  ? `switch.${pfx}_port_${port}_poe_enabled`  : null;
      const portEnabledId = ent.portEnabled ? `switch.${pfx}_port_${port}_enabled` : null;

      const hasToggles  = !!(poeEnabledId || portEnabledId);
      const expanded    = hasToggles && this._expanded.has(port);
      const configuring = this._configuring.has(port);
      const applying    = this._applying.has(port);

      const mainRow = `
        <tr class="port-row${hasToggles ? " expandable" : ""}" data-port="${port}"
          ${hasToggles ? `role="button" aria-expanded="${expanded}" aria-label="Port ${port} details"` : ""}>
          <td class="port-num ${isUp ? "up" : ""}">P${port}</td>
          <td class="port-info-cell">
            <div class="port-info">
              <span class="link-dot ${isUp ? "up" : ""}"></span>
              <span class="port-speed ${isUp ? "active" : ""}">${isUp && speed ? this._fmtSpeed(speed) : isUp ? "Up" : "Down"}</span>
              ${hasPoe ? `<span class="poe-badge ${poeOn ? "active" : ""}">${poeOn ? "PoE" : "no PoE"}</span>` : ""}
            </div>
          </td>
          <td class="port-watt ${!hasPoe || watts === 0 ? "zero" : ""}">${hasPoe && watts > 0 ? watts.toFixed(1) + " W" : hasPoe ? "—" : ""}</td>
          <td class="chevron-cell">${hasToggles ? `<span class="chevron ${expanded ? "open" : ""}"></span>` : ""}</td>
        </tr>`;

      if (!expanded) return mainRow;

      const attr    = ent.poeState?.attributes ?? {};
      const pending = this._pendingPoe.get(port) ?? {};

      // Detail row — read-only values + toggles + Configure button
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

      const poePorts     = Array.from({ length: this.config.poe_ports }, (_, i) => i + 1);
      const regularPorts = Array.from(
        { length: this.config.total_ports - this.config.poe_ports },
        (_, i) => i + this.config.poe_ports + 1
      );

      const totalWatts = this._totalWatts(poePorts);
      const portsUp    = [...poePorts, ...regularPorts].filter(p => this._portEntities(p).state?.state === "on").length;
      const poeActive  = poePorts.filter(p => this._portEntities(p).poeState?.state === "on").length;
      const pfx        = this.config.entity_prefix;
      const limitW     = parseFloat(this._e(`sensor.${pfx}_poe_consumption`)?.attributes?.power_limit_w ?? 0) || 0;

      this.innerHTML = `
        <div class="card">
          <style>${this._css()}</style>
          <div class="card-header">
            <div class="card-title">${this.config.title}</div>
            <div class="summary-pills">
              <div class="pill up">${portsUp} / ${this.config.total_ports} up</div>
              <div class="pill poe">${poeActive} PoE · ${totalWatts.toFixed(1)} W</div>
            </div>
          </div>

          ${this._renderOverview()}

          <div class="section">
            <div class="section-header">
              <div class="section-label">PoE ports 1–${this.config.poe_ports}</div>
              <div class="section-stat">Total <span>${totalWatts.toFixed(1)} W</span> of ${limitW} W</div>
            </div>
            <table class="port-table">
              <tbody>${poePorts.map(p => this._renderPort(p, true)).join("")}</tbody>
            </table>
          </div>

          <div class="section">
            <div class="section-header">
              <div class="section-label">Ports ${this.config.poe_ports + 1}–${this.config.total_ports}</div>
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
          if (e.target.closest("ha-switch, button, select")) return;
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
})();
