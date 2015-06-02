# Running supervisor in the dev env

## Set up config
Edit `tools/dind/config.json` to contain the values for a staging config.json.

## Start the supervisor instance
```
make ARCH=i386 run-supervisor
```

## View the containers logs
```
logs supervisor -f
```

## View the supervisor logs
```
enter supervisor
tail /var/log/supervisor-log/resin_supervisor_stdout.log -f
```
