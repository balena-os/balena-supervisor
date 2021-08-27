import path from 'path';
import express from 'express';

import { PORT } from './constants';

const app = express();
const buildPath = path.resolve(__dirname, 'build');

app.use(express.static(buildPath));
app.use(express.json());

app.get('*', (_req, res) => {
	res.send(`GOT TO PORT ${PORT}`);
});

app.listen(PORT, () => {
	console.log(`Local UI server listening on port ${PORT}`);
});
