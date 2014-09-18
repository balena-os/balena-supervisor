set -o errexit
set -o pipefail

if [ $NODE_ENV == 'production' ]; then
	# Deploy key for private npm modules
	mkdir -p /root/.ssh
	cp deploy_key /root/.ssh/id_rsa
	chmod 400 /root/.ssh/id_rsa
	cp ssh_config /root/.ssh/config
fi
