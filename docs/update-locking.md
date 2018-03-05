---
title: Application update locks
excerpt: Locking application updates on your resin.io devices
---

# Application update locks

Locking updates means that the resin.io device supervisor will not be able to kill your application. This is meant to be used at critical sections of your code where you don't want to be interrupted, or to ensure that updates are only installed at certain times.

In order to do this, users can create a lockfile called `resin-updates.lock` in a way that it has exclusive access, which will prevent the device supervisor from killing and restarting the app. As with any other lockfile, the supervisor itself will create such a file before killing the app, so you should only create it in exclusive mode. This means that the lockfile should only be created if it doesn't already exist. The exclusive access is achieved by opening the lockfile with the [O_EXCL and O_CREAT flags](https://linux.die.net/man/3/open), and several tools exist to simplify this process with examples given [below](#creating-the-lockfile).

### Location of the lockfile

In supervisor v4.0.0 and higher, the lock is located at `/tmp/resin/resin-updates.lock`. This lock is cleared automatically when the device reboots, so the user app must take it every time it starts up.

Older supervisors have the lock at `/data/resin-updates.lock`. This lock is still supported on devices running resinOS 1.X. In this case, newer supervisors will try to take *both* locks before killing the application.

The old lock has the problem that the supervisor has to clear whenever it starts up to avoid deadlocks. If the user app
has taken the lock before the supervisor starts up, the lock will be cleared and the app can operate under the false
assumption that updates are locked (see [issue #20](https://github.com/resin-io/resin-supervisor/issues/20)). We therefore strongly recommend switching to the new lock location as soon as possible.

For supervisors >= v4.0.0 and any OS that is not resinOS 1.x, the old lock location is completely ignored.

### Creating the lockfile

There are many different tools and libraries to provide proper lockfile functionality and a few common examples are shown below.

__Note:__ Just creating the lockfile, for example by using `touch /tmp/resin/resin-updates.lock`, is not adequate to prevent updates. A file created in this way won't have the exclusive access flag set, and thus does not provide reliable locking.

#### Shell

One simple way to create a lockfile is using [lockfile](https://linux.die.net/man/1/lockfile) (available for example in Debian from the `procmail` package):

```shell
lockfile /tmp/resin/resin-updates.lock
# ... (do things)
rm -f /tmp/resin/resin-updates.lock
```

Another tool is [flock](https://linux.die.net/man/1/flock) (available for example in Debian from the `linux-utils` package):

```shell
flock /tmp/resin/resin-updates.lock -c '... (command to run while locked)'
```

For more examples and explanation of the functionality, check the links to the specific tools above.

#### Javascript and Coffeescript

Using the [`lockfile` library](https://www.npmjs.com/package/lockfile), the lock can be acquired like in this CoffeeScript example:
```coffeescript
lockFile = require 'lockfile'

lockFile.lock '/tmp/resin/resin-updates.lock', (err) ->
	# A non-null err probably means the supervisor is about to kill us
	throw new Error('Could not acquire lock: ', err) if err?

	# Here we have the lock, so we can do critical stuff:
	doTheHarlemShake()

	# Now we release the lock, and we can be killed again
	lockFile.unlock '/tmp/resin/resin-updates.lock', (err) ->
		# If err is not null here, something went really wrong
		throw err if err?
```

#### Python

In Python you can use the [`lockfile` library](http://pythonhosted.org/lockfile/lockfile.html#examples)
```python
from lockfile import LockFile
lock = LockFile("/tmp/resin/resin-updates.lock")
with lock:
    print lock.path, 'is locked.'
```
Check the link for more examples and other Python libraries that provide locking.

### Overriding the lock

The update lock can be overriden in case you need to force an update, for instance, if your app has hung in a critical section.

The way to do this is hitting the `/v1/update` endpoint of the [supervisor HTTP API](./API.md), with `{ "force": true }` as body.

The lock can also be overriden by setting the app's `RESIN_SUPERVISOR_OVERRIDE_LOCK` configuration variable to "1".
