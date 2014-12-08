#!/bin/bash
SOCKET_NAME=test-${1}-${2}-${3}
HOST_DATA_PATH=/resin-data/resin-supervisor
HOST_SOCKET=${HOST_DATA_PATH}/${SOCKET_NAME}
SUPERVISOR_SOCKET_PATH=/data
COMMAND_SOCKET=${SUPERVISOR_SOCKET_PATH}/host

if [ ! -S ${COMMAND_SOCKET} ]; then
	read -p 'TTY mode not supported on this image, please update.'
else
        echo "
                rm -f ${HOST_SOCKET}
                socat UNIX-LISTEN:${HOST_SOCKET} EXEC:'${HOST_DATA_PATH}/enter.sh ${1}',pty,setsid,setpgid,stderr,ctty &
                exit
        " | socat UNIX:${COMMAND_SOCKET} - >& /dev/null
        socat UNIX:${SUPERVISOR_SOCKET_PATH}/${SOCKET_NAME} -,raw,echo=0
fi
