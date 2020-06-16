# Upgrading the balena Supervisor

The balena Supervisor can be upgraded separately from the host OS. This can be done to apply bug fixes, or to take advantage of new features.

## Upgrade paths

Downgrades of the supervisor are not supported.

Upgrading to a new minor version is supported, and should be seamless.

Upgrading to a new major version should work; however, it is the user's responsibility to test those changes, and verify that they do not cause problems for their application. The changelog for the balena Supervisor can be found [here](https://github.com/balena-io/balena-supervisor/blob/master/CHANGELOG.md).

For devices managed by balenaCloud, we reserve the right to upgrade the supervisor when necessary, such as to apply bug fixes. (This does not apply to devices managed by balena On Prem installations, or by self-hosted openBalena instances.) We will make every effort to notify users in advance of such an update, and to respect constraints such as bandwidth. In addition, we will not upgrade between major versions without consulting with users.
