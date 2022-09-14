# IMPORTANT: Do **not** use this Dockerfile.
# This Dockerfile only exists to allow flowzone to run docker-compose.test.yml 
# but without the CI needing to do extra work building a throwaway image. 
# The real build happens in the balena builder so for testing we just want 
# to build up to the test stage.
FROM alpine
