
exports.targetState = targetState = []
targetState[0] = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps: [
			{
				appId: '1234'
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				services: {
					'23': {
						appId: '1234'
						serviceName: 'aservice'
						commit: 'afafafa'
						imageId: '12345'
						image: 'registry2.resin.io/superapp/edfabc:latest'
						environment: {
							'FOO': 'bar'
						}
						privileged: false
						restartPolicy: Name: 'unless-stopped'
						volumes: []
						labels: {}
						running: true
					},
					'24': {
						appId: '1234'
						serviceName: 'anotherService'
						commit: 'afafafa'
						imageId: '12346'
						image: 'registry2.resin.io/superapp/afaff:latest'
						environment: {
							'FOO': 'bro'
						}
						volumes: []
						privileged: false
						restart: 'unless-stopped'
						labels: {}
						running: true
					}
				}
				volumes: {}
				networks: {}
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

targetState[1] = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps: [
			{
				appId: '1234'
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				services: {
					'23': {
						appId: '1234'
						serviceName: 'aservice'
						commit: 'afafafa'
						imageId: '12345'
						image: 'registry2.resin.io/superapp/edfabc:latest'
						environment: {
							'FOO': 'bar'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						privileged: false
						restart: 'unless-stopped'
						volumes: []
						labels: {}
						running: true
					}
				}
				volumes: {}
				networks: {}
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

targetState[2] = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps: [
			{
				appId: '1234'
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				services: {
					'23': {
						appId: '1234'
						serviceName: 'aservice'
						commit: 'afafafa'
						imageId: '12345'
						image: 'registry2.resin.io/superapp/edfabc:latest'
						environment: {
							'FOO': 'bar'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						privileged: false
						restart: 'unless-stopped'
						volumes: []
						labels: {}
						running: true
					},
					'24': {
						appId: '1234'
						serviceName: 'anotherService'
						commit: 'afafafa'
						imageId: '12347'
						image: 'registry2.resin.io/superapp/foooo:latest'	
						depends_on: [ 'aservice' ]
						environment: {
							'FOO': 'bro'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						volumes: []
						privileged: false
						restart: 'unless-stopped'
						labels: {}
						running: true
					}
				}
				volumes: {}
				networks: {}
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

targetState[3] = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps: [
			{
				appId: '1234'
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				services: {
					'23': {
						appId: '1234'
						serviceName: 'aservice'
						commit: 'afafafa'
						imageId: '12345'
						image: 'registry2.resin.io/superapp/edfabc:latest'
						environment: {
							'FOO': 'bar'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						privileged: false
						restartPolicy: 'unless-stopped'
						volumes: []
						labels: {}
						running: true
					},
					'24': {
						appId: '1234'
						serviceName: 'anotherService'
						commit: 'afafafa'
						imageId: '12347'
						image: 'registry2.resin.io/superapp/foooo:latest'
						environment: {
							'FOO': 'bro'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						volumes: []
						privileged: false
						restartPolicy: 'unless-stopped'
						labels: {
							'io.resin.update.strategy': 'kill-then-download'
						}
						running: true
					}
				}
				volumes: {}
				networks: {}
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

targetState[4] = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps: [
			{
				appId: '1234'
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				services: {
					'23': {
						appId: '1234'
						serviceName: 'aservice'
						commit: 'afafafa'
						imageId: '12345'
						image: 'registry2.resin.io/superapp/edfabc:latest'
						environment: {
							'FOO': 'THIS VALUE CHANGED'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						privileged: false
						restart: 'unless-stopped'
						volumes: []
						labels: {}
						running: true
					},
					'24': {
						appId: '1234'
						serviceName: 'anotherService'
						commit: 'afafafa'
						imageId: '12347'
						image: 'registry2.resin.io/superapp/foooo:latest'
						depends_on: [ 'aservice' ]
						environment: {
							'FOO': 'bro'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						volumes: []
						privileged: false
						restart: 'unless-stopped'
						labels: {}
						running: true
					}
				}
				volumes: {}
				networks: {}
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

targetState[5] = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps: [
			{
				appId: '1234'
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				services: {
					'23': {
						appId: '1234'
						serviceName: 'aservice'
						commit: 'afafafa'
						imageId: '12345'
						image: 'registry2.resin.io/superapp/edfabc:latest'
						environment: {
							'FOO': 'THIS VALUE CHANGED'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						privileged: false
						restart: 'unless-stopped'
						volumes: []
						labels: {}
						running: true
					},
					'24': {
						appId: '1234'
						serviceName: 'anotherService'
						commit: 'afafafa'
						imageId: '12347'
						image: 'registry2.resin.io/superapp/foooo:latest'
						environment: {
							'FOO': 'bro'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						volumes: []
						privileged: false
						restart: 'unless-stopped'
						labels: {}
						running: true
					}
				}
				volumes: {}
				networks: {}
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

exports.currentState = currentState = []
currentState[0] = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps: [
			{
				appId: '1234'
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				services: [
					{
						appId: '1234'
						serviceId: '23'
						releaseId: '2'
						commit: 'afafafa'
						serviceName: 'aservice'
						imageId: '12345'
						image: 'registry2.resin.io/superapp/edfabc:latest'
						environment: {
							'FOO': 'bar'
							'ADDITIONAL_ENV_VAR': 'foo'

						}
						privileged: false
						restartPolicy:
							Name: 'unless-stopped'
							MaximumRetryCount: 0
						volumes: [
							'/tmp/resin-supervisor/services/1234/aservice:/tmp/resin'
						]
						labels: {
							'io.resin.app_id': '1234'
							'io.resin.service_id': '23'
							'io.resin.image_id': '12345'
							'io.resin.supervised': 'true'
							'io.resin.service_name': 'aservice'
							'io.resin.commit': 'afafafa'
						}
						running: true
						createdAt: new Date()
						containerId: '1'
					},
					{
						appId: '1234'
						serviceId: '24'
						releaseId: '2'
						commit: 'afafafa'
						serviceName: 'anotherService'
						imageId: '12346'
						image: 'registry2.resin.io/superapp/afaff:latest'
						environment: {
							'FOO': 'bro'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						volumes: [
							'/tmp/resin-supervisor/services/1234/anotherService:/tmp/resin'
						]
						privileged: false
						restartPolicy:
							Name: 'unless-stopped'
							MaximumRetryCount: 0
						labels: {
							'io.resin.app_id': '1234'
							'io.resin.service_id': '24'
							'io.resin.image_id': '12346'
							'io.resin.supervised': 'true'
							'io.resin.service_name': 'anotherService'
							'io.resin.commit': 'afafafa'
						}
						running: false
						createdAt: new Date()
						containerId: '2'
					}
				]
				volumes: {}
				networks: { '1234': {} }
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

currentState[1] = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps: [
			{
				appId: '1234'
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				services: []
				volumes: {}
				networks: { '1234': {} }
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

currentState[2] = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps: [
			{
				appId: '1234'
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				services: [
					{
						appId: '1234'
						serviceId: '23'
						releaseId: '2'
						commit: 'afafafa'
						expose: []
						ports: []
						serviceName: 'aservice'
						imageId: '12345'
						image: 'registry2.resin.io/superapp/edfabc:latest'		
						environment: {
							'FOO': 'THIS VALUE CHANGED'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						privileged: false
						restartPolicy:
							Name: 'unless-stopped'
							MaximumRetryCount: 0
						volumes: [
							'/tmp/resin-supervisor/services/1234/aservice:/tmp/resin'
						]
						labels: {
							'io.resin.app_id': '1234'
							'io.resin.service_id': '23'
							'io.resin.image_id': '12345'
							'io.resin.supervised': 'true'
							'io.resin.service_name': 'aservice'
							'io.resin.commit': 'afafafa'
						}
						running: true
						createdAt: new Date()
						containerId: '1'
					}
				]
				volumes: {}
				networks: { '1234': {} }
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

currentState[3] = {
	local: {
		name: 'aDeviceWithDifferentName'
		config: {
			'RESIN_HOST_CONFIG_gpu_mem': '512'
			'RESIN_HOST_LOG_TO_DISPLAY': '1'
		}
		apps: [
			{
				appId: '1234'
				name: 'superapp'
				commit: 'afafafa'
				releaseId: '2'
				services: [
					{
						appId: '1234'
						serviceId: '23'
						serviceName: 'aservice'
						imageId: '12345'
						releaseId: '2'
						commit: 'afafafa'
						expose: []
						ports: []
						image: 'registry2.resin.io/superapp/edfabc:latest'
						environment: {
							'FOO': 'THIS VALUE CHANGED'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						privileged: false
						restartPolicy:
							Name: 'unless-stopped'
							MaximumRetryCount: 0
						volumes: [
							'/tmp/resin-supervisor/services/1234/aservice:/tmp/resin'
						]
						labels: {
							'io.resin.app_id': '1234'
							'io.resin.service_id': '23'
							'io.resin.image_id': '12345'
							'io.resin.supervised': 'true'
							'io.resin.service_name': 'aservice'
							'io.resin.commit': 'afafafa'
						}
						running: true
						createdAt: new Date(0)
						containerId: '1'
					},
					{
						appId: '1234'
						serviceId: '23'
						serviceName: 'aservice'
						imageId: '12345'
						releaseId: '2'
						commit: 'afafafa'
						expose: []
						ports: []
						image: 'registry2.resin.io/superapp/edfabc:latest'
						
						environment: {
							'FOO': 'THIS VALUE CHANGED'
							'ADDITIONAL_ENV_VAR': 'foo'
						}
						privileged: false
						restartPolicy:
							Name: 'unless-stopped'
							MaximumRetryCount: 0
						volumes: [
							'/tmp/resin-supervisor/services/1234/aservice:/tmp/resin'
						]
						labels: {
							'io.resin.app_id': '1234'
							'io.resin.service_id': '23'
							'io.resin.image_id': '12345'
							'io.resin.supervised': 'true'
							'io.resin.service_name': 'aservice'
							'io.resin.commit': 'afafafa'
						}
						running: true
						createdAt: new Date(1)
						containerId: '2'
					}
				]
				volumes: {}
				networks: { '1234': {} }
			}
		]
	}
	dependent: { apps: [], devices: [] }
}

exports.availableImages = availableImages = []
availableImages[0] = [
	{
		name: 'registry2.resin.io/superapp/afaff:latest'
		appId: '1234'
		serviceId: '24'
		serviceName: 'anotherService'
		imageId: '12346'
		releaseId: '2'
		dependent: 0
	},
	{
		name: 'registry2.resin.io/superapp/edfabc:latest'
		appId: '1234'
		serviceId: '23'
		serviceName: 'aservice'
		imageId: '12345'
		releaseId: '2'
		dependent: 0
	}
]
availableImages[1] = [
	{
		name: 'registry2.resin.io/superapp/foooo:latest'
		appId: '1234'
		serviceId: '24'
		serviceName: 'anotherService'
		imageId: '12347'
		releaseId: '2'
		dependent: 0
	},
	{
		name: 'registry2.resin.io/superapp/edfabc:latest'
		appId: '1234'
		serviceId: '23'
		serviceName: 'aservice'
		imageId: '12345'
		releaseId: '2'
		dependent: 0
	}
]
