---
title: Update locks
excerpt: Locking updates to the release that is running on your balenaOS devices.
---

# Update locks

Locking updates means that the balena Supervisor will not be able to kill the services running on the device for an update. This is meant to be used at critical sections of your code where you don't want the process to be interrupted, or to ensure that updates are installed only at certain times. Moreover, any configuration changes that will reboot the device won't trigger reboots if locks are applied. Config changes not requiring a reboot will be applied as usual.

In order to do this, users can create a lockfile in a way that it has exclusive access, which will prevent the device Supervisor from killing and restarting the app. As with any other lockfile, the Supervisor itself will create such a file before killing the app, so you should only create it in exclusive mode. This means that the lockfile should only be created if it doesn't already exist. The exclusive access is achieved by opening the lockfile with the [O_EXCL and O_CREAT flags](https://linux.die.net/man/3/open), and several tools exist to simplify this process with examples given [below](#creating-the-lockfile).

For multicontainer releases, a release will only be updated if all of the services can be updated. While locks are per-service, having the update lock in a single service will prevent all services from updating to a new release.

The presence of a lockfile will ensure that your services do not get killed, but updates will still be downloaded by the Supervisor, ready to be applied once the lockfile no longer exists.

On devices running Supervisor v13.1.0 or newer, the Supervisor creates lockfiles as the `nobody` user, with UID 65534.

### Location of the lockfile

__Note:__ Trying to remove `/tmp/balena` or legacy `/tmp/resin` directories will result in a `resource busy` error.

On devices running Supervisor v7.22.0 and higher, the lockfile is located at `/tmp/balena/updates.lock`. This lock is cleared automatically when the device reboots, so the user app must take it every time it starts up.

On older devices (with v4.0.0 <= Supervisor version < v7.22.0), the lock is located at `/tmp/resin/resin-updates.lock`. The latest Supervisor versions still take the lock at this legacy path for backwards compatibility.

Legacy Supervisors (< v4.0.0) have the lock at `/data/resin-updates.lock`. This lock is only supported on devices running balenaOS 1.X.
This old lock has the problem that the Supervisor has to clear whenever it starts up to avoid deadlocks. If the user app
has taken the lock before the Supervisor starts up, the lock will be cleared and the app can operate under the false
assumption that updates are locked (see [issue #20](https://github.com/balena-os/balena-Supervisor/issues/20)). We therefore strongly recommend switching to the new lock location as soon as possible.

### Creating the lockfile

There are many different tools and libraries to provide proper lockfile functionality and a few common examples are shown below.

__Note:__ Just creating the lockfile, for example by using `touch /tmp/balena/updates.lock`, is not adequate. You must hold an exclusive flock on the file for the duration of the critical section so that both the Supervisor and the host OS update logic respect the lock.

#### Shell

Use [flock](https://linux.die.net/man/1/flock) (e.g. Debian: `linux-utils` package). The lock file is opened and an exclusive flock is held for the duration of the command:

```shell
flock /tmp/balena/updates.lock -c '... (command to run while locked)'
```

For more examples and explanation of the functionality, check the links to the specific tools above.

#### Javascript

Using the [`lockfile` library](https://www.npmjs.com/package/lockfile), the lock can be acquired like in this example:
```javascript
import lockFile from 'lockfile';

lockFile.lock('/tmp/balena/updates.lock', function(err) {
	// A non-null err probably means the Supervisor is about to kill us
	if (err != null) { throw new Error('Could not acquire lock: ', err); }

	// Here we have the lock, so we can do critical stuff:
	doTheHarlemShake();

	// Now we release the lock, and we can be killed again
	return lockFile.unlock('/tmp/balena/updates.lock', function(err) {
		// If err is not null here, something went really wrong
		if (err != null) { throw err; }
	});
});
```

#### Python

Open the file with exclusive create and hold an exclusive flock for the duration :

```python
import fcntl
import os
import time

LOCK_PATH = '/tmp/balena/updates.lock'

def with_update_lock(fn):
    fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        fn()
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
        try:
            os.unlink(LOCK_PATH)
        except OSError:
            pass

with_update_lock(do_the_harlem_shake)

```

### Overriding the lock

The update lock can be overridden in case you need to force an update, for instance, if your app has hung in a critical section.

The recommended way to do this is to use the 'Override the update lock ...' toggle in the [Fleet or Device Configuration][device-configuration] page. Go to the configuration page of the device or fleet, locate the 'Override the update lock ...' item from the list, click the activate button, and set the toggle to enabled. After disabling the toggle, update locks may be set again and will be respected.

Also, you can programatically override locks one time by querying the `/v1/update` endpoint of the [Supervisor HTTP API][supervisor-api], with `{ "force": true }` as body. Note that this will not set the lock override config var.

Please note that setting the override is a one-time action. Locks set previously are deleted upon setting the config var, and will need to be recreated.


[device-configuration]:/learn/manage/configuration/#managing-device-configuration-variables
[supervisor-api]:/reference/supervisor/supervisor-api
