# Working with the Supervisor

Service: `balena-supervisor.service`, or `resin-supervisor.service` if OS < v2.78.0

The balena Supervisor is the service that carries out the management of the
software release on a device, including determining when to download updates,
the changing of variables, ensuring services are restarted correctly, etc. 
It is the on-device agent for balenaCloud.

As such, it's imperative that the Supervisor is operational and healthy at all
times, even when a device is not connected to the Internet, as the Supervisor still
ensures the running of a device that is offline.

The Supervisor itself is a Docker service that runs alongside any installed
user services and the healthcheck container. One major advantage of running it as 
a Docker service is that it can be updated just like any other service, although 
carrying that out is slightly different than updating user containers. (See [Updating the Supervisor](#82-updating-the-supervisor)).

Before attempting to debug the Supervisor, it's recommended to upgrade the Supervisor to
the latest version, as we frequently release bugfixes and features that may resolve device issues.

Otherwise, assuming you're still logged into your development device, run the following:

```shell
root@debug-device:~# systemctl status balena-supervisor
● balena-supervisor.service - Balena supervisor
     Loaded: loaded (/lib/systemd/system/balena-supervisor.service; enabled; vendor preset: enabled)
     Active: active (running) since Fri 2022-08-19 18:08:59 UTC; 41s ago
    Process: 2296 ExecStartPre=/usr/bin/balena stop resin_supervisor (code=exited, status=1/FAILURE)
    Process: 2311 ExecStartPre=/usr/bin/balena stop balena_supervisor (code=exited, status=0/SUCCESS)
    Process: 2325 ExecStartPre=/bin/systemctl is-active balena.service (code=exited, status=0/SUCCESS)
   Main PID: 2326 (start-balena-su)
      Tasks: 10 (limit: 1878)
     Memory: 11.9M
     CGroup: /system.slice/balena-supervisor.service
             ├─2326 /bin/sh /usr/bin/start-balena-supervisor
             ├─2329 /proc/self/exe --healthcheck /usr/lib/balena-supervisor/balena-supervisor-healthcheck --pid 2326
             └─2486 balena start --attach balena_supervisor

Aug 19 18:09:07 debug-device balena-supervisor[2486]: [debug]   Starting target state poll
Aug 19 18:09:07 debug-device balena-supervisor[2486]: [debug]   Spawning journald with: chroot  /mnt/root journalctl -a --follow -o json >
Aug 19 18:09:07 debug-device balena-supervisor[2486]: [debug]   Finished applying target state
Aug 19 18:09:07 debug-device balena-supervisor[2486]: [success] Device state apply success
Aug 19 18:09:07 debug-device balena-supervisor[2486]: [info]    Applying target state
Aug 19 18:09:07 debug-device balena-supervisor[2486]: [info]    Reported current state to the cloud
Aug 19 18:09:07 debug-device balena-supervisor[2486]: [debug]   Finished applying target state
Aug 19 18:09:07 debug-device balena-supervisor[2486]: [success] Device state apply success
Aug 19 18:09:17 debug-device balena-supervisor[2486]: [info]    Internet Connectivity: OK
Aug 19 18:09:18 debug-device balena-supervisor[2486]: [info]    Reported current state to the cloud
```

You can see the Supervisor is just another `systemd` service
(`balena-supervisor.service`) and that it is started and run by balenaEngine.

Supervisor issues, due to their nature, vary significantly. Issues may commonly 
be misattributed to the Supervisor. As the Supervisor is verbose about its
state and actions, such as the download of images, it tends to be suspected of
problems when in fact there are usually other underlying issues. A few examples
are:

- Networking problems - The Supervisor reports failed downloads
  or attempts to retrieve the same images repeatedly, where in fact unstable
  networking is usually the cause.
- Service container restarts - The default policy for service containers is to
  restart if they exit, and this sometimes is misunderstood. If a container is
  restarting, it's worth ensuring it's not because the container itself is
  exiting either due to a bug in the service container code or
  because it has correctly come to the end of its running process.
- Release not being downloaded - For instance, a fleet/device has been pinned 
  to a particular version, and a new push is not being downloaded.

It's _always_ worth considering how the system is configured, how releases were
produced, how the fleet or device is configured and what the current
networking state is when investigating Supervisor issues, to ensure that there
isn't something else amiss that the Supervisor is merely exposing via logging.

Another point to note is that the Supervisor is started using
[`healthdog`](https://github.com/balena-os/healthdog-rs) which continually
ensures that the Supervisor is present by using balenaEngine to find the
Supervisor image. If the image isn't present, or balenaEngine doesn't respond,
then the Supervisor is restarted. The default period for this check is 180
seconds. Inspecting `/lib/systemd/system/balena-supervisor.service` on-device 
will show whether the timeout period is different for a particular device.
For example:

```shell
root@debug-device:~# cat /lib/systemd/system/balena-supervisor.service
[Unit]
Description=Balena supervisor
Requires=\
    resin\x2ddata.mount \
    balena-device-uuid.service \
    os-config-devicekey.service \
    bind-etc-balena-supervisor.service \
    extract-balena-ca.service
Wants=\
    migrate-supervisor-state.service
After=\
    balena.service \
    resin\x2ddata.mount \
    balena-device-uuid.service \
    os-config-devicekey.service \
    bind-etc-systemd-system-resin.target.wants.service \
    bind-etc-balena-supervisor.service \
    migrate-supervisor-state.service \
    extract-balena-ca.service
Wants=balena.service
ConditionPathExists=/etc/balena-supervisor/supervisor.conf

[Service]
Type=simple
Restart=always
RestartSec=10s
WatchdogSec=180
SyslogIdentifier=balena-supervisor
EnvironmentFile=/etc/balena-supervisor/supervisor.conf
EnvironmentFile=-/tmp/update-supervisor.conf
ExecStartPre=-/usr/bin/balena stop resin_supervisor
ExecStartPre=-/usr/bin/balena stop balena_supervisor
ExecStartPre=/bin/systemctl is-active balena.service
ExecStart=/usr/bin/healthdog --healthcheck=/usr/lib/balena-supervisor/balena-supervisor-healthcheck /usr/bin/start-balena-supervisor
ExecStop=-/usr/bin/balena stop balena_supervisor

[Install]
WantedBy=multi-user.target
Alias=resin-supervisor.service
```

#### 8.1 Restarting the Supervisor

It's rare to actually _need_ a Supervisor restart. The Supervisor will attempt to 
recover from issues that occur automatically, without the requirement for a restart. 
When in doubt about whether a restart is required, look at the Supervisor logs and 
double check other on-duty support agents if needed. If fairly certain, it's generally
safe to restart the Supervisor, as long as the user is aware that some extra bandwidth 
and device resources will be used on startup.

There are instances where the Supervisor is incorrectly restarted when in fact
the issue could be the corruption of service images, containers, volumes
or networking. In these cases, you're better off dealing with the underlying
balenaEngine to ensure that anything corrupt is recreated correctly. See the
balenaEngine section for more details.

If a restart is required, ensure that you have gathered as much information
as possible before a restart, including pertinent logs and symptoms so that
investigations can occur asynchronously to determine what occurred and how it
may be mitigated in the future. Enabling persistent logging may also be beneficial
in cases where symptoms are repeatedly occurring.

To restart the Supervisor, simply restart the `systemd` service:

```shell
root@debug-device:~# systemctl restart balena-supervisor.service
root@debug-device:~# systemctl status balena-supervisor.service
● balena-supervisor.service - Balena supervisor
     Loaded: loaded (/lib/systemd/system/balena-supervisor.service; enabled; vendor preset: enabled)
     Active: active (running) since Fri 2022-08-19 18:13:28 UTC; 10s ago
    Process: 3013 ExecStartPre=/usr/bin/balena stop resin_supervisor (code=exited, status=1/FAILURE)
    Process: 3021 ExecStartPre=/usr/bin/balena stop balena_supervisor (code=exited, status=0/SUCCESS)
    Process: 3030 ExecStartPre=/bin/systemctl is-active balena.service (code=exited, status=0/SUCCESS)
   Main PID: 3031 (start-balena-su)
      Tasks: 11 (limit: 1878)
     Memory: 11.8M
     CGroup: /system.slice/balena-supervisor.service
             ├─3031 /bin/sh /usr/bin/start-balena-supervisor
             ├─3032 /proc/self/exe --healthcheck /usr/lib/balena-supervisor/balena-supervisor-healthcheck --pid 3031
             └─3089 balena start --attach balena_supervisor

Aug 19 18:13:33 debug-device balena-supervisor[3089]: [info]    Waiting for connectivity...
Aug 19 18:13:33 debug-device balena-supervisor[3089]: [debug]   Starting current state report
Aug 19 18:13:33 debug-device balena-supervisor[3089]: [debug]   Starting target state poll
Aug 19 18:13:33 debug-device balena-supervisor[3089]: [debug]   Spawning journald with: chroot  /mnt/root journalctl -a --follow -o json >
Aug 19 18:13:33 debug-device balena-supervisor[3089]: [debug]   Finished applying target state
Aug 19 18:13:33 debug-device balena-supervisor[3089]: [success] Device state apply success
Aug 19 18:13:34 debug-device balena-supervisor[3089]: [info]    Applying target state
Aug 19 18:13:34 debug-device balena-supervisor[3089]: [info]    Reported current state to the cloud
Aug 19 18:13:34 debug-device balena-supervisor[3089]: [debug]   Finished applying target state
Aug 19 18:13:34 debug-device balena-supervisor[3089]: [success] Device state apply success
```

#### 8.2 Updating the Supervisor

Occasionally, there are situations where the Supervisor requires an update. This
may be because a device needs to use a new feature or because the version of
the Supervisor on a device is outdated and is causing an issue. Usually the best
way to achieve this is via a balenaOS update, either from the dashboard or via
the command line on the device.

If updating balenaOS is not desirable or a user prefers updating the Supervisor independently, this can easily be accomplished using [self-service](https://www.balena.io/docs/reference/supervisor/supervisor-upgrades/) Supervisor upgrades. Alternatively, this can be programmatically done by using the Node.js SDK method [device.setSupervisorRelease](https://www.balena.io/docs/reference/sdk/node-sdk/#devicesetsupervisorreleaseuuidorid-supervisorversionorid-%E2%87%92-codepromisecode).

You can additionally write a script to manage this for a fleet of devices in combination with other SDK functions such as [device.getAll](https://www.balena.io/docs/reference/sdk/node-sdk/#devicegetalloptions-%E2%87%92-codepromisecode).

**Note:** In order to update the Supervisor release for a device, you must have edit permissions on the device (i.e., more than just support access).

#### 8.3 The Supervisor Database

The Supervisor uses a SQLite database to store persistent state, so in the
case of going offline, or a reboot, it knows exactly what state an
app should be in, and which images, containers, volumes and networks
to apply to it.

This database is located at
`/mnt/data/resin-data/balena-supervisor/database.sqlite` and can be accessed
inside the Supervisor container at `/data/database.sqlite` by running Node. 
Assuming you're logged into your device, run the following:

```shell
root@debug-device:~# balena exec -ti balena_supervisor node
```

This will get you into a Node interpreter in the Supervisor service
container. From here, we can use the `sqlite3` NPM module used by
the Supervisor to make requests to the database:

```shell
> sqlite3 = require('sqlite3');
{
  Database: [Function: Database],
  Statement: [Function: Statement],
  Backup: [Function: Backup],
  OPEN_READONLY: 1,
  OPEN_READWRITE: 2,
  OPEN_CREATE: 4,
  OPEN_FULLMUTEX: 65536,
  OPEN_URI: 64,
  OPEN_SHAREDCACHE: 131072,
  OPEN_PRIVATECACHE: 262144,
  VERSION: '3.30.1',
  SOURCE_ID: '2019-10-10 20:19:45 18db032d058f1436ce3dea84081f4ee5a0f2259ad97301d43c426bc7f3df1b0b',
  VERSION_NUMBER: 3030001,
  OK: 0,
  ERROR: 1,
  INTERNAL: 2,
  PERM: 3,
  ABORT: 4,
  BUSY: 5,
  LOCKED: 6,
  NOMEM: 7,
  READONLY: 8,
  INTERRUPT: 9,
  IOERR: 10,
  CORRUPT: 11,
  NOTFOUND: 12,
  FULL: 13,
  CANTOPEN: 14,
  PROTOCOL: 15,
  EMPTY: 16,
  SCHEMA: 17,
  TOOBIG: 18,
  CONSTRAINT: 19,
  MISMATCH: 20,
  MISUSE: 21,
  NOLFS: 22,
  AUTH: 23,
  FORMAT: 24,
  RANGE: 25,
  NOTADB: 26,
  cached: { Database: [Function: Database], objects: {} },
  verbose: [Function]
}
> db = new sqlite3.Database('/data/database.sqlite');
Database {
  open: false,
  filename: '/data/database.sqlite',
  mode: 65542
}
```

You can get a list of all the tables used by the Supervisor by issuing:

```shell
> db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;", console.log);
Database { open: true, filename: '/data/database.sqlite', mode: 65542 }
> null [
  { name: 'apiSecret' },
  { name: 'app' },
  { name: 'config' },
  { name: 'containerLogs' },
  { name: 'currentCommit' },
  { name: 'deviceConfig' },
  { name: 'engineSnapshot' },
  { name: 'image' },
  { name: 'knex_migrations' },
  { name: 'knex_migrations_lock' },
  { name: 'logsChannelSecret' },
  { name: 'sqlite_sequence' }
]
```

With these, you can then examine and modify data, if required. Note that there's
usually little reason to do so, but this is included for completeness. For
example, to examine the configuration used by the Supervisor:

```shell
> db.all('SELECT * FROM config;', console.log);
Database { open: true, filename: '/data/database.sqlite', mode: 65542 }
> null [
  { key: 'localMode', value: 'false' },
  { key: 'initialConfigSaved', value: 'true' },
  {
    key: 'initialConfigReported',
    value: 'https://api.balena-cloud.com'
  },
  { key: 'name', value: 'shy-rain' },
  { key: 'targetStateSet', value: 'true' },
  { key: 'delta', value: 'true' },
  { key: 'deltaVersion', value: '3' }
]
```

Occasionally, should the Supervisor get into a state where it is unable to
determine which release images it should be downloading or running, it
is necessary to clear the database. This usually goes hand-in-hand with removing
the current containers and putting the Supervisor into a 'first boot' state,
whilst keeping the Supervisor and release images. This can be achieved by
carrying out the following:

```shell
root@debug-device:~# systemctl stop balena-supervisor.service update-balena-supervisor.timer
root@debug-device:~# balena rm -f $(balena ps -aq)
1db1d281a548
6c5cde1581e5
2a9f6e83578a
root@debug-device:~# rm /mnt/data/resin-data/balena-supervisor/database.sqlite
```

This:

- Stops the Supervisor (and the timer that will attempt to restart it).
- Removes all current service containers, including the Supervisor.
- Removes the Supervisor database.
  (If for some reason the images also need to be removed, run
  `balena rmi -f $(balena images -q)` which will remove all images _including_
  the Supervisor image).
  You can now restart the Supervisor:

```shell
root@debug-device:~# systemctl start update-balena-supervisor.timer balena-supervisor.service
```

If you deleted all the images, this will first download the Supervisor image
again before restarting it.
At this point, the Supervisor will start up as if the device has just been
provisioned and already registered, and the device's target release will
be freshly downloaded if images were removed before starting the service
containers.
