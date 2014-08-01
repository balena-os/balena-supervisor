if [ $NODE_ENV == 'production' ]; then
	node ./node_modules/coffee-script/bin/coffee -c ./src
	rm -rf /root/.ssh/* /build/app/deploy_key /app/deploy_key /build/app/Makefile /app/Makefile /app/src/*.coffee
	npm uninstall coffee-script
fi
