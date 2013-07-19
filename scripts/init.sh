#!/bin/bash

REPO=ewa-client-bootstrap

# system upgrade
pacman --noconfirm --sync --refresh --sysupgrade --quiet

# user configuration
useradd -m -G users,wheel -s /bin/bash haki

# sudo configuration
pacman --noconfirm --sync --needed --quiet sudo
echo "%wheel ALL=(ALL) ALL" >> /etc/sudoers
#echo "Defaults env_keep+=SSH_AUTH_SOCK" >> /etc/sudoers

# dependencies
pacman --noconfirm --sync --needed --quiet git nodejs openvpn yaourt
yaourt --noconfirm --sync heroku-toolbelt > /dev/null

# node app setup
cd /opt && git clone git@bitbucket.org:rulemotion/$REPO.git
cd /opt/$REPO && sudo -u haki npm install

# system service setup
cp /opt/$REPO/scripts/haki.service /etc/systemd/system/haki.service
systemctl enable haki
systemctl start haki

# config fstab && mount
echo "/dev/mmcblk0p3 /mnt ext3 defaults 0 0" >> /etc/fstab
mount /mnt

# initialize /etc/openvpn/client.conf 
sed -e 's,proto udp,;proto udp,' -e 's,;proto tcp,proto tcp,' -e 's,^remote.*,,' /usr/share/openvpn/examples/client.conf > /etc/openvpn/client.conf

# ssh configuration
if [ ! -d /home/haki/.ssh ] ; then sudo -u haki mkdir /home/haki/.ssh ; fi
echo "StrictHostKeyChecking on" | sudo -u haki tee /home/haki/.ssh/config >/dev/null
