if [ $NODE_ENV == 'production' ]; then
	node ./node_modules/coffee-script/bin/coffee -c ./src
	# We don't need coffee-script at runtime
	npm uninstall coffee-script
	# Remove deploy key
	rm -rf /root/.ssh/* deploy_key
	# Remove unnecessary source files
	rm -rf Makefile src/*.coffee
fi
