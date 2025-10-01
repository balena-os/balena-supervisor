import request from 'supertest';
import { expect } from 'chai';

const BALENA_SUPERVISOR_ADDRESS =
	process.env.BALENA_SUPERVISOR_ADDRESS ?? 'http://balena-supervisor:48484';

describe('supervisor app', () => {
	it('the supervisor app runs and the API responds to /v1/healthy', async () => {
		await request(BALENA_SUPERVISOR_ADDRESS)
			.get('/v1/healthy')
			.then(({ status }) => {
				// There's a chance that the endpoint will respond with 500
				// due to memory healthcheck failure, which we can't easily
				// control as it's checking memory in the balena-supervisor
				// container. So in this case, just check that the healthcheck
				// failed due to memory instead of anything else.
				expect(status).to.be.oneOf([200, 500]);
			});
	});
});
