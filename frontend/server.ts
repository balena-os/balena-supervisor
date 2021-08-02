import path from 'path';
import express from 'express';

const app = express();
const PORT = 48485;
const buildPath = path.resolve(__dirname, 'build');

app.use(express.static(buildPath));
app.use(express.json());

app.get('*', (_req, res) => {
	res.send('GOT TO PORT 48485');
});

app.listen(PORT, () => {
	console.log(`Local UI server listening on port ${PORT}`);
});
