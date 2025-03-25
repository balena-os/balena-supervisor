# Firewall

Starting with `Supervisor v11.9.1`, the balena Supervisor comes with the ability to control the device's firewall through the [`iptables` package](https://linux.die.net/man/8/iptables). The Supervisor manipulates the `filter` table to control network traffic.

## Firewall Modes

To switch between firewall modes, the `HOST_FIREWALL_MODE` (with `BALENA_` or legacy `RESIN_` prefix) configuration variable may be defined on a fleet or device level through the dashboard, and has three valid settings: `on`, `off`, and `auto`, with `off` being the default mode.

> [!NOTE] Configuration variables defined in the dashboard will not apply to devices in local mode.

| Mode | Description |
| ---- | ----------- |
| on   | Only traffic for core services provided by balena are allowed. Any other ports, including those used by containers with host networking, are blocked unless explicitly configured. |
| off  | All network traffic is allowed. |
| auto | If there _are_ host network services, behaves as if `FIREWALL_MODE` = `on`. If there _aren't_ host network services, behaves as if `FIREWALL_MODE` = `off`. |

## Issues

Before [v14.9.2](https://github.com/balena-os/balena-supervisor/blob/master/CHANGELOG.md#v1492) manually-set firewall rules to the `filter` table will be overwritten by the Supervisor ([related issue](https://github.com/balena-os/balena-supervisor/issues/1482)). Please update your supervisor if you observe this behavior.
