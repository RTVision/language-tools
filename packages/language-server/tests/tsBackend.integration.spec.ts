import { afterEach, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { URI } from 'vscode-uri';
import { launchServer } from '@typescript/server-harness';
import { createTsBackendClient } from '../lib/tsBackend';

const tsgoBinaryPath = process.env.VUE_LS_TSGO_PATH;
const runTsgoTest = tsgoBinaryPath ? test : test.skip;
const tempDirs: string[] = [];

interface MockTextDocument {
	uri: string;
	languageId: string;
	version: number;
	getText(): string;
}

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('auto backend keeps tsserver when tsgo probe fails', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ls-tsgo-probe-'));
	tempDirs.push(tempDir);
	const fakeTsgoPath = path.join(tempDir, process.platform === 'win32' ? 'tsgo.cmd' : 'tsgo');

	if (process.platform === 'win32') {
		fs.writeFileSync(fakeTsgoPath, '@echo off\r\nexit /b 1\r\n');
	}
	else {
		fs.writeFileSync(fakeTsgoPath, '#!/bin/sh\nexit 1\n');
		fs.chmodSync(fakeTsgoPath, 0o755);
	}

	const backend = createTsBackendClient({
		preference: 'auto',
		tsgoPath: fakeTsgoPath,
		ts,
		connection: createMockConnection(),
		server: {
			documents: createMockDocumentsStore(),
		} as any,
	});

	expect(backend.mode).toBe('tsserver');
	await backend.dispose();
});

runTsgoTest('tsgo backend returns quick info and highlights for ts files', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ls-tsgo-backend-'));
	tempDirs.push(tempDir);

	const filePath = path.join(tempDir, 'sample.ts');
	const fileUri = URI.file(filePath).toString();
	const sourceText = [
		'const foo = 1;',
		'foo + foo;',
		'',
	].join('\n');

	fs.writeFileSync(filePath, sourceText);

	const documents = createMockDocumentsStore();
	const backend = createTsBackendClient({
		preference: 'tsgo-lsp',
		tsgoPath: tsgoBinaryPath,
		ts,
		connection: createMockConnection(),
		server: {
			documents,
		} as any,
	});

	documents.open({
		uri: fileUri,
		languageId: 'typescript',
		version: 1,
		getText() {
			return sourceText;
		},
	});

	const symbolOffset = sourceText.indexOf('foo +');
	const line = sourceText.slice(0, symbolOffset).split('\n').length - 1;
	const character = symbolOffset - sourceText.lastIndexOf('\n', symbolOffset - 1) - 1;

	const quickInfo = await backend.getQuickInfoAtPosition(filePath, { line, character });
	expect(quickInfo).toContain('foo');

	const highlights = await backend.getDocumentHighlights(filePath, symbolOffset);
	expect(highlights?.[0]?.fileName).toBe(filePath);
	expect((highlights?.[0]?.highlightSpans?.length ?? 0)).toBeGreaterThanOrEqual(3);

	await backend.dispose();
	documents.close(fileUri);
});

runTsgoTest('tsgo backend falls back to internal tsserver process for vue quick info', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ls-tsgo-vue-process-fallback-'));
	tempDirs.push(tempDir);

	const filePath = path.join(tempDir, 'App.vue');
	const fileUri = URI.file(filePath).toString();
	const sourceText = [
		'<script setup lang="ts">',
		'const msg = "hello";',
		'msg;',
		'</script>',
		'',
	].join('\n');
	fs.writeFileSync(filePath, sourceText);
	fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			target: 'ESNext',
			module: 'ESNext',
			moduleResolution: 'Bundler',
			allowJs: true,
			jsx: 'Preserve',
		},
		include: ['**/*'],
	}));

	const documents = createMockDocumentsStore();
	const backend = createTsBackendClient({
		preference: 'tsgo-lsp',
		tsgoPath: tsgoBinaryPath,
		ts,
		connection: createMockConnection(),
		server: {
			documents,
		} as any,
	});

	documents.open({
		uri: fileUri,
		languageId: 'vue',
		version: 1,
		getText() {
			return sourceText;
		},
	});

	const symbolOffset = sourceText.indexOf('msg;');
	const line = sourceText.slice(0, symbolOffset).split('\n').length - 1;
	const character = symbolOffset - sourceText.lastIndexOf('\n', symbolOffset - 1) - 1;

	try {
		const quickInfo = await backend.getQuickInfoAtPosition(filePath, { line, character });
		expect(quickInfo).toContain('msg');
	}
	finally {
		await backend.dispose();
		documents.close(fileUri);
	}
});

runTsgoTest('tsgo backend can still fallback through client tsserver bridge for vue quick info', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ls-tsgo-vue-fallback-'));
	tempDirs.push(tempDir);

	const filePath = path.join(tempDir, 'App.vue');
	const fileUri = URI.file(filePath).toString();
	const sourceText = [
		'<script setup lang="ts">',
		'const msg = "hello";',
		'msg;',
		'</script>',
		'',
	].join('\n');
	fs.writeFileSync(filePath, sourceText);
	fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			target: 'ESNext',
			module: 'ESNext',
			moduleResolution: 'Bundler',
			allowJs: true,
			jsx: 'Preserve',
		},
		include: ['**/*'],
	}));

	const tsserver = launchServer(
		path.join(__dirname, '..', '..', '..', 'node_modules', 'typescript', 'lib', 'tsserver.js'),
		[
			'--disableAutomaticTypingAcquisition',
			'--globalPlugins',
			'@vue/typescript-plugin',
			'--suppressDiagnosticEvents',
			'--useNodeIpc',
		],
	);

	const documents = createMockDocumentsStore();
	const bridgeConnection = createTsServerBridgeConnection(tsserver);
	const backend = createTsBackendClient({
		preference: 'tsgo-lsp',
		tsgoPath: tsgoBinaryPath,
		ts,
		connection: bridgeConnection,
		server: {
			documents,
		} as any,
	});

	documents.open({
		uri: fileUri,
		languageId: 'vue',
		version: 1,
		getText() {
			return sourceText;
		},
	});

	const symbolOffset = sourceText.indexOf('msg;');
	const line = sourceText.slice(0, symbolOffset).split('\n').length - 1;
	const character = symbolOffset - sourceText.lastIndexOf('\n', symbolOffset - 1) - 1;

	try {
		const quickInfo = await backend.getQuickInfoAtPosition(filePath, { line, character });
		expect(quickInfo).toContain('msg');
	}
	finally {
		await backend.dispose();
		documents.close(fileUri);
		tsserver.kill();
	}
});

function createMockConnection() {
	return {
		console: {
			info() {},
			warn() {},
			error() {},
			log() {},
		},
		onNotification() {
			return {
				dispose() {},
			};
		},
		sendNotification() {},
	} as any;
}

function createTsServerBridgeConnection(tsserver: import('@typescript/server-harness').Server) {
	let seq = 1;
	const responseListeners = new Set<(payload: [number, any]) => void>();
	const openedFiles = new Set<string>();

	async function ensureFileOpened(fileName: string) {
		if (openedFiles.has(fileName)) {
			return;
		}
		if (!fs.existsSync(fileName)) {
			return;
		}
		const fileContent = fs.readFileSync(fileName, 'utf8');
		const result = await tsserver.message({
			seq: seq++,
			type: 'request',
			command: 'updateOpen',
			arguments: {
				changedFiles: [],
				closedFiles: [],
				openFiles: [
					{
						file: fileName,
						fileContent,
					},
				],
			},
		});
		if (result.success) {
			openedFiles.add(fileName);
		}
	}

	return {
		console: {
			info() {},
			warn() {},
			error() {},
			log() {},
		},
		onNotification(method: string, cb: (payload: [number, any]) => void) {
			if (method === 'tsserver/response') {
				responseListeners.add(cb);
				return {
					dispose() {
						responseListeners.delete(cb);
					},
				};
			}
			return {
				dispose() {},
			};
		},
		sendNotification(method: string, payload: any) {
			if (method !== 'tsserver/request') {
				return;
			}
			const [id, command, args] = payload as [number, string, any];
			void (async () => {
				const fileName = typeof args?.file === 'string' ? args.file : undefined;
				if (fileName) {
					await ensureFileOpened(fileName);
				}
				return await tsserver.message({
					seq: seq++,
					type: 'request',
					command,
					arguments: args,
				});
			})().then(
				res => {
					for (const listener of responseListeners) {
						listener([id, res?.body]);
					}
				},
				() => {
					for (const listener of responseListeners) {
						listener([id, undefined]);
					}
				},
			);
		},
	} as any;
}

function createMockDocumentsStore() {
	const documents = new Map<string, MockTextDocument>();
	const openCallbacks = new Set<(event: { document: MockTextDocument }) => void>();
	const changeCallbacks = new Set<(event: { document: MockTextDocument }) => void>();
	const closeCallbacks = new Set<(event: { document: MockTextDocument }) => void>();

	return {
		onDidOpen(cb: (event: { document: MockTextDocument }) => void) {
			openCallbacks.add(cb);
			return {
				dispose() {
					openCallbacks.delete(cb);
				},
			};
		},
		onDidChangeContent(cb: (event: { document: MockTextDocument }) => void) {
			changeCallbacks.add(cb);
			return {
				dispose() {
					changeCallbacks.delete(cb);
				},
			};
		},
		onDidClose(cb: (event: { document: MockTextDocument }) => void) {
			closeCallbacks.add(cb);
			return {
				dispose() {
					closeCallbacks.delete(cb);
				},
			};
		},
		get(uri: string | { toString(): string }) {
			const key = typeof uri === 'string' ? uri : uri.toString();
			return documents.get(key);
		},
		all() {
			return [...documents.values()];
		},
		open(document: MockTextDocument) {
			documents.set(document.uri, document);
			for (const callback of openCallbacks) {
				callback({ document });
			}
			for (const callback of changeCallbacks) {
				callback({ document });
			}
		},
		close(uri: string) {
			const document = documents.get(uri);
			if (!document) {
				return;
			}
			documents.delete(uri);
			for (const callback of closeCallbacks) {
				callback({ document });
			}
		},
	};
}
