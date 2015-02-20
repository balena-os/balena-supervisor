set -o errexit
set -o pipefail

if [[ $NODE_ENV == 'production' ]]; then
	# Remove node-gyp cache
	rm -rf ~/.node-gyp/
	# Remove cached git deps
	rm -rf /tmp/*
	# Remove the c files we no longer need (the sqlite3 node module has a massive ~5M c file)
	find . -name '*.c' -delete
	# And the tar files (sqlite3 module again)
	find . -name '*.tar.*' -delete
	# Who needs tests and docs? Pffft! - Ignoring errors because find isn't a fan of us deleting directories whilst it's trying to search within them.
	find . -type d -name 'test' -exec rm -rf '{}' \; 2> /dev/null || true
	find . -type d -name 'doc' -exec rm -rf '{}' \; 2> /dev/null || true
	find . -type d -name 'man' -exec rm -rf '{}' \; 2> /dev/null || true
	# And any benchmark results (ttyjs->socket.io->socket.io-client->active-x-obfuscator->zeparser has an 8MB benchmark.html)
	find . -type d -name 'benchmark*' -exec rm -rf '{}' \; 2> /dev/null || true
	find . -name 'benchmark*' -delete
fi
