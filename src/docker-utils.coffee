Docker = require 'dockerode'
Promise = require 'bluebird'
config = require './config'

docker = Promise.promisifyAll(new Docker(socketPath: config.dockerSocket))
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(docker.getImage().__proto__)
Promise.promisifyAll(docker.getContainer().__proto__)

exports.docker = docker
