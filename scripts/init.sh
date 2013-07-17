#!/bin/bash

pacman --noconfirm --sync --refresh --sysupgrade --quiet

useradd -m -G users,wheel -s /bin/bash haki

pacman --noconfirm --sync --needed --quiet sudo
echo "%wheel ALL=(ALL) ALL" >> /etc/sudoers

pacman --noconfirm --sync --needed --quiet git nodejs openvpn yaourt
yaourt --noconfirm --sync heroku-toolbelt > /dev/null

cd /home/haki && sudo -u haki git clone git@bitbucket.org:rulemotion/ewa-client-bootstrap.git
ln -s /home/haki/ewa-client-bootstrap/haki.service /etc/systemd/system/haki.service

systemctl enable haki
