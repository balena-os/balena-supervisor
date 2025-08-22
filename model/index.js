const pinejs = require('@balena/pinejs');
const express = require('express');

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, _res, next) => {
	console.log(`${req.method} ${req.url}`);
	next();
});

pinejs.init(app).then(() => {
	app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
});
