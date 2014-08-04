SOCKET_NAME=test-${1}-${2}-${3}
HOST_DATA_PATH=/resin-data/resin-supervisor
HOST_SOCKET=${HOST_DATA_PATH}/${SOCKET_NAME}
SUPERVISOR_SOCKET_PATH=/data

echo "
	rm -f ${HOST_SOCKET}
	socat UNIX-LISTEN:${HOST_SOCKET} EXEC:'${HOST_DATA_PATH}/enter.sh ${1}',pty,setsid,setpgid,stderr,ctty &
	exit
" | socat UNIX:${SUPERVISOR_SOCKET_PATH}/host -
socat UNIX:${SUPERVISOR_SOCKET_PATH}/${SOCKET_NAME} -,raw,echo=0
