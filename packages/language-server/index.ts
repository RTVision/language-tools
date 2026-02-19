import { startServer, type StartServerOptions } from './lib/server';

if (process.argv.includes('--version')) {
	console.log(require('./package.json').version);
}
else {
	let ts;
	let options: StartServerOptions = {
		tsBackend: parseTsBackend(process.env.VUE_LANGUAGE_SERVER_TS_BACKEND),
		tsgoPath: process.env.VUE_LANGUAGE_SERVER_TSGO_PATH,
	};
	for (const arg of process.argv) {
		if (arg.startsWith('--tsdk=')) {
			const tsdk = arg.substring('--tsdk='.length);
			const tsPath = require.resolve('./typescript.js', { paths: [tsdk] });
			ts = require(tsPath);
		}
		else if (arg.startsWith('--ts-backend=')) {
			const tsBackend = parseTsBackend(arg.substring('--ts-backend='.length));
			if (tsBackend) {
				options = {
					...options,
					tsBackend,
				};
			}
		}
		else if (arg.startsWith('--tsgo=')) {
			options = {
				...options,
				tsgoPath: arg.substring('--tsgo='.length),
			};
		}
	}
	ts ??= require('typescript');
	startServer(ts, options);
}

function parseTsBackend(value: string | undefined): StartServerOptions['tsBackend'] | undefined {
	if (value === 'auto' || value === 'tsserver' || value === 'tsgo-lsp') {
		return value;
	}
}
