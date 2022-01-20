# Firewall

> Disclaimer: Firewall control in the Supervisor is still an experimental feature, so expect changes to come.

Starting with `Supervisor v11.9.1`, the balena Supervisor comes with the ability to control the device's firewall through the [`iptables` package](https://linux.die.net/man/8/iptables). The Supervisor manipulates the `filter` table to control network traffic.


## Firewall Modes

To switch between firewall modes, the `HOST_FIREWALL_MODE` (with `BALENA_` or legacy `RESIN_` prefix) configuration variable may be defined on a fleet or device level through the dashboard, and has three valid settings: `on`, `off`, and `auto`, with `off` being the default mode.

**Note:** Configuration variables defined in the dashboard will not apply to devices in local mode.

| Mode | Description | 
|------|-------------|
| on   | Only traffic for core services provided by balena and containers on the host network are allowed. |
| off  | All network traffic is allowed. |
| auto | If there _are_ host network services, behaves as if `FIREWALL_MODE` = `on`. If there _aren't_ host network services, behaves as if `FIREWALL_MODE` = `off`. |


## Issues

The Supervisor's implementation of `BALENA_HOST_FIREWALL_MODE` is not yet ideal. As such, please feel free to raise an issue. There is one notable issue where manually-set firewall rules to the `filter` table will be overwritten by the Supervisor (read more [here](https://github.com/balena-os/balena-supervisor/issues/1482)). The current workaround is to set these rules in the `raw` table.
