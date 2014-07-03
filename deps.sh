# Deploy key for private npm modules
mkdir -p /root/.ssh
cp deploy_key /root/.ssh/id_rsa
chmod 400 /root/.ssh/id_rsa
cp ssh_config /root/.ssh/config

# System dependencies
apt-get update
apt-get install -y openvpn libsqlite3-dev python
