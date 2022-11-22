import request from 'supertest';

const BALENA_SUPERVISOR_ADDRESS =
	process.env.BALENA_SUPERVISOR_ADDRESS || 'http://balena-supervisor:48484';

describe('supervisor app', () => {
	it('the supervisor app runs and the API responds with a healthy status', async () => {
		await request(BALENA_SUPERVISOR_ADDRESS).get('/v1/healthy').expect(200);
	});
});
