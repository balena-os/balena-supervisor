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
fi
