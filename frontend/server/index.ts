import path from 'path';
import express from 'express';

import { PORT } from './lib/constants';

import { networkRouter } from './routes/network';

const app = express();
const buildPath = path.resolve(__dirname, 'build');

app.use(express.static(buildPath));
app.use(express.json());

app.use('/network', networkRouter);

app.listen(PORT, () => {
	console.log(`Local UI server listening on port ${PORT}`);
});
