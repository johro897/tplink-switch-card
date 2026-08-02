# TP-Link Switch Card

A custom Lovelace card for Home Assistant that gives you a clean, compact overview of your TP-Link Easy Smart switch — including PoE and non-PoE models, configurable overview fields, port states, link speeds and per-port controls.

Built for the [TP-Link Easy Smart](https://github.com/vmakeev/hass_tplink_easy_smart) custom integration. No templates, shell commands, or extra helpers required.

![](screenshots/overview.png)

---

## Quick start

Install the card, then add this to your dashboard:

```yaml
type: custom:tplink-switch-card
title: TP-Link Switch
entity_prefix: tp_link_switch   # match your integration's entity prefix
has_poe: true                   # default: true
poe_ports: 8                    # number of PoE-capable ports (counted from port 1)
total_ports: 16                 # total number of switch ports
max_poe_watts: 150              # optional: hardware PoE cap (blocks budget editor above this)
overview_layout: tiles            # tiles, compact or hidden
overview_fields:                  # optional: visible fields and their order
  - ip
  - mac
  - gateway
  - netmask
  - poe_used
  - poe_remaining
  - poe_budget
show_switch_link: true            # show web UI shortcut beside the IP address
port_labels:                     # optional labels; omitted ports stay unlabeled
  1: Router
  3: Office PC
  8: Access Point
```

That's it. MAC address, IP and switch URL are all read automatically from the integration — nothing else to configure.

For a switch without PoE support, disable PoE completely:

```yaml
type: custom:tplink-switch-card
title: TP-Link Switch
entity_prefix: tp_link_switch
has_poe: false
total_ports: 16
```

With `has_poe: false`, the card does not watch PoE entities and hides the PoE summary, consumption tiles, budget editor, badges, power values, toggles and configuration controls.

A compact overview for the TL-SG1024DE can show only the useful network information:

```yaml
type: custom:tplink-switch-card
title: TP-Link Switch Verwaltung
entity_prefix: tp_link_switch
has_poe: false
total_ports: 24
overview_layout: compact
overview_fields:
  - ip
  - gateway
show_switch_link: true
```

Set `overview_layout: hidden` or `overview_fields: []` to remove the overview completely.

---

## Features

- **Configurable switch overview** — choose visible fields and their order; use tile, compact or hidden layout
- **PoE budget bar** — turns amber above 80% and red above 95% load; click ✏️ to edit the budget limit inline
- **Adaptive port sections** — PoE and regular ports are separated on PoE switches; non-PoE switches show one port list
- **Optional port labels** — add readable names to selected ports without configuring every port
- **Per-port status** — link state dot, formatted link speed (1G / 100M / 2.5G), PoE badge and wattage
- **Expandable detail rows** — click a port to reveal voltage, current, PD class, configured speed, priority, power limit and enable toggles
- **PoE configuration panel** — configure PoE priority and power limit per port with Apply/Cancel directly in the card
- **Click to copy** — click the IP address or MAC tile to copy the value to clipboard; works on both HTTP and HTTPS
- **Switch UI shortcut** — link icon next to IP opens the switch web UI in a new tab; derived automatically from the integration, no URL to configure
- **PoE hardware cap** — optional `max_poe_watts` shows the physical limit in the budget editor and blocks Apply if exceeded
- **Theme-aware** — uses HA CSS variables throughout, works with any theme
- **Efficient rendering** — only re-renders when a watched entity actually changes state or attribute

---

## Requirements

- Home Assistant 2025.8 or newer
- [hass_tplink_easy_smart](https://github.com/vmakeev/hass_tplink_easy_smart) custom integration installed and configured

---

## Installation

### Via HACS (recommended)

1. In HACS, go to **Frontend → ⋮ → Custom repositories**
2. Paste `https://github.com/johro897/tplink-switch-card` and choose **Dashboard**
3. Click **Add**, locate **TP-Link Switch Card** and install it
4. Reload Lovelace resources

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=johro897&repository=tplink-switch-card&category=dashboard)

### Manual install

1. Copy `tplink-switch-card.js` to `/config/www/tplink-switch-card/tplink-switch-card.js`
2. Add the resource via **Settings → Dashboards → Resources → +**:
   ```
   /local/tplink-switch-card/tplink-switch-card.js
   ```
3. Hard-refresh your browser (`Ctrl/Cmd + Shift + R`)

---

## How to use the card

The card has three interaction levels:

**1. Port row** — always visible. Shows link state, speed, PoE badge and wattage at a glance.

**2. Detail row** — click any port that has controllable entities to expand. Shows all sensor values (voltage, current, PD class, configured speed) plus PoE enabled and port enabled toggles.

![](screenshots/port_detail.png)

**3. Configure panel** — click **Configure PoE** inside the detail row to open an inline editor for PoE priority and power limit. Hit **Apply** to send the change to the switch, or **Cancel** to close without saving.

![](screenshots/configure_panel.png)

> Ports without any controllable entities (no `poe_enabled` or `port_enabled` switch) are not expandable — they show status only.

---

## Configuration

### Card options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `title` | No | `TP-Link Switch` | Card header text |
| `entity_prefix` | No | `tp_link_switch` | Prefix used to build all entity IDs — must match the prefix your integration uses |
| `has_poe` | No | `true` | Set to `false` for switches without PoE. Hides all PoE UI and stops watching PoE entities |
| `poe_ports` | No | `8` | Number of PoE-capable ports, counted from port 1. Ignored when `has_poe` is `false` |
| `total_ports` | No | `16` | Total number of switch ports |
| `max_poe_watts` | No | — | Hardware PoE maximum in watts (e.g. `150` for TL-SG1016PE). Ignored when `has_poe` is `false` |
| `overview_layout` | No | `tiles` | Overview design: `tiles`, `compact`, or `hidden` |
| `overview_fields` | No | all fields | Ordered list of visible overview fields. An empty list hides the overview |
| `show_switch_link` | No | `true` | Show the switch web-interface shortcut beside the IP address |
| `port_labels` | No | `{}` | Optional mapping of port numbers to labels. Ports not listed remain unlabeled |

### Port labels

Use a sparse YAML mapping so only the ports that need a name have to be listed:

```yaml
port_labels:
  1: Router
  3: Office PC
  7: NAS
  8: Access Point Wohnzimmer
  24: Uplink
```

Port numbers may be omitted between entries and do not need to be sorted. Empty labels, invalid port numbers and ports above `total_ports` are ignored. Long labels are shortened visually in the row; hovering shows the complete text.

### Overview options

Supported `overview_fields` values are:

- `ip`
- `mac`
- `gateway`
- `netmask`
- `poe_used`
- `poe_remaining`
- `poe_budget`

The list order is also the display order. PoE fields are ignored automatically when `has_poe` is `false`. IP and MAC remain clickable for copying when visible.

Minimal tile overview:

```yaml
overview_layout: tiles
overview_fields:
  - ip
```

Compact network overview:

```yaml
overview_layout: compact
overview_fields:
  - ip
  - gateway
  - netmask
```

Keep the IP address but hide the web-interface shortcut:

```yaml
show_switch_link: false
overview_fields:
  - ip
  - mac
```

Hide the complete overview:

```yaml
overview_layout: hidden
```

### Services used for write operations

The card calls two services from the `tplink_easy_smart` integration. Both identify the switch via `mac_address`, which is read automatically from the `network_info` sensor — no manual configuration needed.

| Service | Description |
| --- | --- |
| `tplink_easy_smart.set_port_poe_settings` | Sets PoE priority and power limit per port |
| `tplink_easy_smart.set_general_poe_limit` | Sets the global PoE budget for the switch |

**Priority values:** `Low`, `Middle`, `High`

**Power limit values:** `Auto`, `Class 1`, `Class 2`, `Class 3`, `Class 4`, `Manual`

---

## Entity naming

The card builds all entity IDs automatically from `entity_prefix`. No manual entity mapping is needed.

### Overview sensors

| Entity | Description |
| --- | --- |
| `sensor.{prefix}_network_info` | IP address (state), MAC, gateway, netmask (attributes) |
| `sensor.{prefix}_poe_consumption` | Total PoE consumption (state, W) with `power_limit_w` and `power_remain_w` attributes |

### Per-port entities

| Entity | Description |
| --- | --- |
| `binary_sensor.{prefix}_port_{n}_state` | Port link state — `on` = connected; attributes include `speed` and `speed_config` |
| `binary_sensor.{prefix}_port_{n}_poe_state` | PoE state — attributes: `power_w`, `current_ma`, `voltage_v`, `pd_class`, `priority`, `power_limit` |
| `switch.{prefix}_port_{n}_poe_enabled` | PoE enable/disable toggle |
| `switch.{prefix}_port_{n}_enabled` | Port enable/disable toggle |

Entities that are missing or unavailable are handled gracefully — the corresponding field is hidden or shows `—`. When `has_poe` is `false`, PoE entities are not read or watched at all.

---

## Screenshots

### Full card overview
![Full card overview](screenshots/overview.png)
*Switch overview tiles, PoE budget bar, PoE port section and regular port section.*

### Overview tiles — copy and UI link
![Overview tiles with IP copy and link icon](screenshots/overview_tiles.png)
*Click the IP or MAC tile to copy the value. The link icon opens the switch web UI in a new tab.*

### Expanded port detail
![Expanded port detail row](screenshots/port_detail.png)
*Expand a port to see all sensor values, configured speed and enable toggles.*

### PoE configure panel
![PoE configure panel with priority and power limit dropdowns](screenshots/configure_panel.png)
*Configure PoE priority and power limit per port directly in the card.*

### PoE budget editor with hardware cap
![PoE budget editor showing max_poe_watts warning](screenshots/poe_budget_editor.png)
*The budget editor shows the hardware cap and blocks Apply if the value exceeds it.*

### PoE budget warning
![PoE bar turning amber at high load](screenshots/poe_warning.png)
*Budget bar turns amber above 80% and red above 95% load.*

---

## Troubleshooting

| Problem | Solution |
| --- | --- |
| Card not found | Verify the resource URL is registered and hard-refresh the browser |
| All ports show "Down" | Check that `entity_prefix` matches the prefix your integration uses — look up one entity in Developer Tools → States to confirm |
| Ports are not expandable | The port has no `switch.*_poe_enabled` or `switch.*_enabled` entity — check the integration has created them; some switch models don't support all features |
| Configure PoE button missing | Only shown on PoE ports (ports 1–`poe_ports`) that have a `poe_state` entity |
| PoE Apply fails | Check that `mac_address` is available on `sensor.{prefix}_network_info` — open the entity in Developer Tools → States and look for the `mac` attribute |
| Copy doesn't work | On HTTP installs `navigator.clipboard` is blocked by the browser; the card falls back to `execCommand` automatically — if that also fails, switch HA to HTTPS |
| Budget editor blocks Apply | The value exceeds `max_poe_watts`; lower the value or remove `max_poe_watts` from the config if you want no cap |
| Budget editor shows stale value | The editor pre-fills from the current `power_limit_w` attribute — if the switch hasn't reported the new value yet, wait a few seconds and reopen |

---

## Tested with

| Device | Hardware | Firmware |
| --- | --- | --- |
| TL-SG1016PE | — | 2.0 |
| TL-SG1024DE | 7.0 | 1.0.0 Build 20230616 Rel.34205 |

Other TP-Link Easy Smart switches using the same integration should work as long as their entities follow the same naming pattern.

---

## Changelog
### 1.1.0

**Port labels**
- Added sparse `port_labels` mapping for optional per-port names
- Labels are validated, HTML-escaped and truncated cleanly in narrow cards

**Configurable overview**
- Added `overview_layout` with `tiles`, `compact`, and `hidden`
- Added ordered `overview_fields` selection
- Added `show_switch_link` to hide the switch web-interface shortcut

### v1.0.0
Verified version. Now official release

### v0.9.0
**PoE configuration**
- Inline configure panel per PoE port — set priority (Low/Middle/High) and power limit (Auto/Class 1–4/Manual) with Apply/Cancel
- Global PoE budget editor via ✏️ icon in the budget bar
- Optional `max_poe_watts` config key shows hardware cap and blocks Apply if exceeded
- Budget validation on Set click with inline error message — no re-render on input
- All service calls use `mac_address` read automatically from `network_info` sensor

**Overview**
- Click IP or MAC tile to copy value to clipboard; falls back to `execCommand` on HTTP
- Link icon next to IP opens switch web UI in new tab
- PoE budget bar turns amber above 80% and red above 95%

**Port details**
- `speed_config` shown as "Configured" in detail row
- Speed formatter: `1000MF` → `1G`, `2500M` → `2.5G` etc.
- `role="button"` and `aria-expanded` on expandable rows

**Performance**
- Dirty-check on `hass` updates — skips re-render when no watched entity changes
- Per-render entity cache via `_portEntitiesCache`

### v0.1.0
- Initial release
- Switch overview: IP, MAC, gateway, netmask, PoE consumption, budget bar
- Two port sections: PoE ports and regular ports
- Expandable detail rows with voltage, current, PD class, speed, toggles
- Port enable and PoE enable toggles per port

---

## Development

Single self-contained ES2021 file — no build tooling required.

## License

MIT © 2026
