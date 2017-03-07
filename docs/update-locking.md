## Update locking

Locking updates means that the Supervisor will not be able to kill your application. This is meant to be used at critical sections of your code where you don't want to be interrupted, or to control that updates are only installed at certain times.

In order to do this, users can create a file called `resin-updates.lock` that will prevent the Supervisor from killing and restarting the app. As any other lockfile, the Supervisor itself will create such file before killing the app, so you should only create it in exclusive mode. This means: only create the lockfile if it doesn't already exist. Several tools exist to simplify this process, for example [npm/lockfile](https://github.com/npm/lockfile).

### Location of the lockfile

In supervisor v4.0.0 and higher, the lock is located at `/tmp/resin/resin-updates.lock`. This lock is cleared automatically when the device reboots, so the user app must take it every time it starts up.

Older supervisors have the lock at `/data/resin-updates.lock`. This lock is still supported on devices running ResinOS 1.X. In this case, newer supervisors will try to take *both* locks before killing the application.

The old lock has the problem that the supervisor has to clear whenever it starts up to avoid deadlocks. If the user app
has taken the lock before the supervisor starts up, the lock will be cleared and the app can operate under the false
assumption that updates are locked (see [issue #20](https://github.com/resin-io/resin-supervisor/issues/20)). We therefore strongly recommend switching to the new lock location as soon as possible.

In supervisors >= v4.0.0 and any OS that is not Resin OS 1.X, the old lock location is completely ignored.

### Taking the lock

Using the above-mentioned library, the lock can be acquired like in this CoffeeScript example:
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

There are other libraries you can use in different languages, for example [this Python library](http://pythonhosted.org/lockfile/lockfile.html#examples).

### Overriding the lock

The update lock can be overriden in case you need to force an update, for instance, if your app has hung in a critical section.

The way to do this is hitting the `/v1/update` endpoint of the [supervisor HTTP API](./API.md), with `{ "force": true }` as body.

The lock can also be overriden by setting the app's `RESIN_OVERRIDE_LOCK` environment variable to "1".
