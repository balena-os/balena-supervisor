if [ $NODE_ENV == 'production' ]; then
	node ./node_modules/coffee-script/bin/coffee -c ./src
	# We don't need coffee-script at runtime
	npm uninstall coffee-script
	# Empty the apt and npm caches of the packages we installed
	npm cache clean
	apt-get clean
	# Remove deploy key
	rm -rf /root/.ssh/* deploy_key
	# Remove unnecessary source files
	rm -rf Makefile src/*.coffee
	# Remove the git repo info
	rm -rf .git
	# Remove the c files we no longer need (the sqlite3 node module has a massive ~5M c file)
	find . -name '*.c' -delete
	# And the tar files (sqlite3 module again)
	find . -name '*.tar.*' -delete
	# Who needs tests and docs? Pffft! - Ignoring errors because find isn't a fan of us deleting directories whilst it's trying to search within them.
	find . -type d -name 'test' -exec rm -rf '{}' \; 2> /dev/null || true
	find . -type d -name 'doc' -exec rm -rf '{}' \; 2> /dev/null || true
	find . -type d -name 'man' -exec rm -rf '{}' \; 2> /dev/null || true
fi
