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
cd /home/haki && git clone git@bitbucket.org:rulemotion/$REPO.git
cd /home/haki && chown -R haki:haki $REPO
cd /home/haki/$REPO && sudo -u haki npm install

# system service setup
cp /home/haki/$REPO/scripts/haki.service /etc/systemd/system/haki.service
systemctl enable haki
systemctl start haki

# config fstab && mount
echo "/dev/mmcblk0p3 /mnt ext3 defaults 0 0" >> /etc/fstab
mount /mnt
