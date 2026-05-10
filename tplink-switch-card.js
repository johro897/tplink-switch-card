/*
 * TP-Link Switch Card
 * Lovelace custom card for TP-Link Easy Smart switch overview.
 * - Switch overview: IP, MAC, gateway, total PoE consumption/remaining + bar
 * - Two sections: PoE ports (1-8) and regular ports (9-16)
 * - Per-port: link state, speed, PoE state, wattage, current, voltage, PD class
 * - Expandable detail rows only on ports that have toggles (poe_enabled / port_enabled)
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
        description: "Overview card for TP-Link Easy Smart switch with PoE monitoring.",
        preview: false,
      });
    }
  }

  class TplinkSwitchCard extends HTMLElement {
    constructor() {
      super();
      this._expanded = new Set();
    }

    setConfig(config) {
      if (!config) throw new Error("Missing configuration");
      this.config = {
        title: "TP-Link Switch",
        poe_ports: 8,
        total_ports: 16,
        entity_prefix: "tp_link_switch",
        ...config,
      };
      this.render();
    }

    set hass(hass) { this._hass = hass; this.render(); }
    connectedCallback() { this.render(); }
    getCardSize() { return 6; }

    _e(entityId) { return this._hass?.states[entityId] ?? null; }

    _portEntities(port) {
      const p = this.config.entity_prefix;
      return {
        state:       this._e(`binary_sensor.${p}_port_${port}_state`),
        poeState:    this._e(`binary_sensor.${p}_port_${port}_poe_state`),
        poeEnabled:  this._e(`switch.${p}_port_${port}_poe_enabled`),
        portEnabled: this._e(`switch.${p}_port_${port}_enabled`),
      };
    }

    _toggle(entityId) {
      if (!this._hass || !entityId) return;
      const e = this._hass.states[entityId];
      if (!e) return;
      const domain = entityId.split(".")[0];
      this._hass.callService(domain, e.state === "on" ? "turn_off" : "turn_on", { entity_id: entityId });
    }

    _toggleExpand(port) {
      if (this._expanded.has(port)) this._expanded.delete(port);
      else this._expanded.add(port);
      this.render();
    }

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
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 0.9rem;
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

        /* ── Overview grid ── */
        .overview {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
          gap: 0.4rem;
          margin-bottom: 1rem;
        }
        .ov-item {
          background: var(--secondary-background-color, rgba(128,128,128,0.06));
          border: 1px solid var(--divider-color, rgba(128,128,128,0.14));
          border-radius: 8px;
          padding: 0.45rem 0.6rem;
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

        /* PoE budget bar */
        .poe-bar-wrap {
          grid-column: 1 / -1;
          background: var(--secondary-background-color, rgba(128,128,128,0.06));
          border: 1px solid var(--divider-color, rgba(128,128,128,0.14));
          border-radius: 8px;
          padding: 0.45rem 0.6rem;
        }
        .poe-bar-header {
          display: flex; justify-content: space-between;
          margin-bottom: 0.35rem;
        }
        .poe-bar-track {
          height: 5px; border-radius: 999px;
          background: var(--divider-color, rgba(128,128,128,0.2));
          overflow: hidden;
        }
        .poe-bar-fill {
          height: 100%; border-radius: 999px;
          background: var(--primary-color, #03a9f4);
          transition: width 0.4s ease;
        }

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
        .section-stat {
          font-size: 0.63rem; color: var(--secondary-text-color);
          font-variant-numeric: tabular-nums;
        }
        .section-stat span { color: var(--primary-color, #03a9f4); font-weight: 600; }

        /* ── Port table ── */
        .port-table { width: 100%; border-collapse: collapse; }
        .port-row td {
          padding: 0.3rem 0.25rem; vertical-align: middle;
          border-bottom: 1px solid var(--divider-color, rgba(128,128,128,0.07));
        }
        .port-row.expandable { cursor: pointer; }
        .port-row.expandable:hover td {
          background: var(--secondary-background-color, rgba(128,128,128,0.05));
        }
        .port-row:last-child td { border-bottom: none; }

        .port-num {
          font-size: 0.7rem; font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: var(--secondary-text-color);
          width: 1.8rem; text-align: center;
        }
        .port-num.up { color: #2e8f57; }

        .link-dot {
          display: inline-block;
          width: 0.48rem; height: 0.48rem; border-radius: 50%;
          background: rgba(128,128,128,0.25); flex-shrink: 0;
        }
        .link-dot.up { background: #2e8f57; box-shadow: 0 0 4px rgba(46,143,87,0.45); }

        .port-info-cell { width: 100%; }
        .port-info { display: flex; align-items: center; gap: 0.4rem; }
        .port-speed { font-size: 0.65rem; color: var(--secondary-text-color); white-space: nowrap; }
        .port-speed.active { color: #2e8f57; }

        .poe-badge {
          font-size: 0.58rem; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.05em;
          padding: 0.1rem 0.38rem; border-radius: 999px;
          white-space: nowrap;
          background: rgba(128,128,128,0.1);
          color: var(--secondary-text-color);
          border: 1px solid transparent;
        }
        .poe-badge.active {
          background: rgba(3,169,244,0.1);
          color: var(--primary-color, #03a9f4);
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
          padding: 0.5rem 0.5rem 0.65rem 2.3rem;
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
        .d-value.bad  { color: var(--state-error-color, #c22040); }

        ha-switch { --mdc-switch-track-height: 14px; }
        .placeholder { padding: 1rem; color: var(--secondary-text-color); font-size: 0.9rem; }
      `;
    }

    _renderToggle(entityId) {
      if (!entityId) return `<span style="color:var(--secondary-text-color);font-size:0.72rem">—</span>`;
      const e = this._hass?.states[entityId];
      if (!e) return `<span style="color:var(--secondary-text-color);font-size:0.72rem">—</span>`;
      return `<ha-switch ${e.state === "on" ? "checked" : ""} data-entity="${entityId}"></ha-switch>`;
    }

    _renderOverview() {
      const pfx   = this.config.entity_prefix;
      const poeS  = this._e(`sensor.${pfx}_poe_consumption`);
      const netS  = this._e(`sensor.${pfx}_network_info`);

      const consumed = parseFloat(poeS?.state ?? 0) || 0;
      const limitW   = parseFloat(poeS?.attributes?.power_limit_w ?? 0) || 0;
      const remainW  = parseFloat(poeS?.attributes?.power_remain_w ?? 0) || 0;
      const pct      = limitW > 0 ? Math.min(100, (consumed / limitW) * 100) : 0;

      const ip      = netS?.state ?? "—";
      const mac     = netS?.attributes?.mac ?? "—";
      const gateway = netS?.attributes?.gateway ?? "—";
      const mask    = netS?.attributes?.netmask ?? "—";

      return `
        <div class="overview">
          <div class="ov-item">
            <div class="ov-label">IP address</div>
            <div class="ov-value">${ip}</div>
          </div>
          <div class="ov-item">
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
              <div class="ov-label">${consumed.toFixed(1)} / ${limitW} W &nbsp;(${pct.toFixed(0)}%)</div>
            </div>
            <div class="poe-bar-track">
              <div class="poe-bar-fill" style="width:${pct.toFixed(1)}%"></div>
            </div>
          </div>
        </div>`;
    }

    _renderPort(port, hasPoe) {
      const ent = this._portEntities(port);
      const isUp  = ent.state?.state === "on";
      const poeOn = ent.poeState?.state === "on";
      const watts = hasPoe ? (parseFloat(ent.poeState?.attributes?.power_w ?? 0) || 0) : 0;
      const speed = ent.state?.attributes?.speed ?? null;

      const pfx = this.config.entity_prefix;
      const poeEnabledId  = hasPoe && ent.poeEnabled  ? `switch.${pfx}_port_${port}_poe_enabled`  : null;
      const portEnabledId = ent.portEnabled ? `switch.${pfx}_port_${port}_enabled` : null;

      // Only expandable if there are toggles
      const hasToggles = !!(poeEnabledId || portEnabledId);
      const expanded   = hasToggles && this._expanded.has(port);

      const mainRow = `
        <tr class="port-row${hasToggles ? " expandable" : ""}" data-port="${port}">
          <td class="port-num ${isUp ? "up" : ""}">P${port}</td>
          <td class="port-info-cell">
            <div class="port-info">
              <span class="link-dot ${isUp ? "up" : ""}"></span>
              <span class="port-speed ${isUp ? "active" : ""}">${isUp && speed ? speed : isUp ? "Up" : "Down"}</span>
              ${hasPoe ? `<span class="poe-badge ${poeOn ? "active" : ""}">${poeOn ? "PoE" : "no PoE"}</span>` : ""}
            </div>
          </td>
          <td class="port-watt ${!hasPoe || watts === 0 ? "zero" : ""}">${hasPoe && watts > 0 ? watts.toFixed(1) + " W" : hasPoe ? "—" : ""}</td>
          <td class="chevron-cell">${hasToggles ? `<span class="chevron ${expanded ? "open" : ""}"></span>` : ""}</td>
        </tr>`;

      if (!expanded) return mainRow;

      const attr = ent.poeState?.attributes ?? {};

      const detailRow = `
        <tr class="detail-row">
          <td colspan="4">
            <div class="detail-inner">
              ${isUp && speed ? `<div class="d-item"><div class="d-label">Speed</div><div class="d-value good">${speed}</div></div>` : ""}
              ${hasPoe && poeOn ? `
                <div class="d-item"><div class="d-label">Power</div><div class="d-value poe">${watts.toFixed(1)} W</div></div>
                ${attr.current_ma != null ? `<div class="d-item"><div class="d-label">Current</div><div class="d-value">${attr.current_ma} mA</div></div>` : ""}
                ${attr.voltage_v  != null ? `<div class="d-item"><div class="d-label">Voltage</div><div class="d-value">${attr.voltage_v} V</div></div>` : ""}
                ${attr.pd_class        ? `<div class="d-item"><div class="d-label">PD class</div><div class="d-value">${attr.pd_class}</div></div>` : ""}
                ${attr.priority        ? `<div class="d-item"><div class="d-label">Priority</div><div class="d-value">${attr.priority}</div></div>` : ""}
                ${attr.power_limit     ? `<div class="d-item"><div class="d-label">Limit</div><div class="d-value">${attr.power_limit}</div></div>` : ""}
              ` : ""}
              ${poeEnabledId  ? `<div class="d-item"><div class="d-label">PoE enabled</div>${this._renderToggle(poeEnabledId)}</div>`  : ""}
              ${portEnabledId ? `<div class="d-item"><div class="d-label">Port enabled</div>${this._renderToggle(portEnabledId)}</div>` : ""}
            </div>
          </td>
        </tr>`;

      return mainRow + detailRow;
    }

    _totalWatts(ports) {
      return ports.reduce((sum, port) =>
        sum + (parseFloat(this._portEntities(port).poeState?.attributes?.power_w ?? 0) || 0), 0);
    }

    render() {
      if (!this.config) return;
      if (!this._hass) {
        this.innerHTML = `<div class="card"><style>${this._css()}</style><div class="placeholder">Waiting for Home Assistant…</div></div>`;
        return;
      }

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

    _bindEvents() {
      this.querySelectorAll(".port-row.expandable").forEach(row => {
        row.addEventListener("click", e => {
          if (e.target.closest("ha-switch")) return;
          this._toggleExpand(parseInt(row.dataset.port));
        });
      });

      this.querySelectorAll("ha-switch[data-entity]").forEach(sw => {
        sw.addEventListener("change", e => { e.stopPropagation(); this._toggle(sw.dataset.entity); });
        sw.addEventListener("click",  e => e.stopPropagation());
      });
    }
  }

  customElements.define(CARD_NAME, TplinkSwitchCard);
})();
