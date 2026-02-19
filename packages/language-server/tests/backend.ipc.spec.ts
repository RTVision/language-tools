import { launchServer } from '@typescript/server-harness';
import { afterEach, expect, test } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMessageConnection, IPCMessageReader, IPCMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import { URI } from 'vscode-uri';

const testWorkspacePath = path.resolve(__dirname, '../../../test-workspace');
const tsserverPath = path.join(__dirname, '..', '..', '..', 'node_modules', 'typescript', 'lib', 'tsserver.js');
const tsgoBinaryPath = process.env.VUE_LS_TSGO_PATH;

interface TestHarness {
	connection: MessageConnection;
	child: childProcess.ChildProcess;
	tsserver?: import('@typescript/server-harness').Server;
	initializeResult: {
		serverInfo?: {
			name?: string;
			version?: string;
		};
	};
	dispose(): Promise<void>;
}

const harnesses: TestHarness[] = [];

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map(harness => harness.dispose()));
});

test('tsserver backend rename smoke', async () => {
	const harness = await startIpcHarness({
		tsBackend: 'tsserver',
	});
	harnesses.push(harness);

	const uri = URI.file(path.join(testWorkspacePath, 'fixture.vue')).toString();
	harness.connection.sendNotification('textDocument/didOpen', {
		textDocument: {
			uri,
			languageId: 'vue',
			version: 1,
			text: '<template><h1></h1></template>',
		},
	});

	const edit = await harness.connection.sendRequest('textDocument/rename', {
		textDocument: { uri },
		position: { line: 0, character: 11 },
		newName: 'h2',
	});

	const changes = edit?.changes?.[uri];
	expect(changes).toBeDefined();
	expect(changes).toHaveLength(2);
	expect(changes.every((change: { newText: string }) => change.newText === 'h2')).toBe(true);
});

test('auto backend falls back when tsgo probe fails', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ls-tsgo-fail-'));
	const fakeTsgo = path.join(tempDir, process.platform === 'win32' ? 'tsgo.cmd' : 'tsgo');

	try {
		if (process.platform === 'win32') {
			fs.writeFileSync(fakeTsgo, '@echo off\r\nexit /b 1\r\n');
		}
		else {
			fs.writeFileSync(fakeTsgo, '#!/bin/sh\nexit 1\n');
			fs.chmodSync(fakeTsgo, 0o755);
		}

		const harness = await startIpcHarness({
			tsBackend: 'auto',
			tsgoPath: fakeTsgo,
		});
		harnesses.push(harness);

		expect(harness.initializeResult.serverInfo?.name).toContain('[tsserver]');
	}
	finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

const tsgoTest = tsgoBinaryPath ? test : test.skip;

tsgoTest('tsgo backend initializes and accepts documentHighlight requests', async () => {
	const harness = await startIpcHarness({
		tsBackend: 'tsgo-lsp',
		tsgoPath: tsgoBinaryPath,
	});
	harnesses.push(harness);

	expect(harness.initializeResult.serverInfo?.name).toContain('[tsgo-lsp]');

	const uri = URI.file(path.join(testWorkspacePath, 'fixture.ts')).toString();
	harness.connection.sendNotification('textDocument/didOpen', {
		textDocument: {
			uri,
			languageId: 'typescript',
			version: 1,
			text: 'const foo = 1;\nfoo;\n',
		},
	});

	const highlights = await harness.connection.sendRequest('textDocument/documentHighlight', {
		textDocument: { uri },
		position: { line: 1, character: 1 },
	});

	expect(Array.isArray(highlights)).toBe(true);
});

tsgoTest('tsgo backend provides vue hover without client tsserver bridge', async () => {
	const harness = await startIpcHarness({
		tsBackend: 'tsgo-lsp',
		tsgoPath: tsgoBinaryPath,
		bridgeTsserver: false,
	});
	harnesses.push(harness);

	const uri = URI.file(path.join(testWorkspacePath, 'tsconfigProject', 'fixture.vue')).toString();
	const sourceText = [
		'<script setup lang="ts">',
		'const msg = "hello";',
		'msg;',
		'</script>',
		'',
	].join('\n');
	harness.connection.sendNotification('textDocument/didOpen', {
		textDocument: {
			uri,
			languageId: 'vue',
			version: 1,
			text: sourceText,
		},
	});

	const hover = await harness.connection.sendRequest('textDocument/hover', {
		textDocument: { uri },
		position: { line: 2, character: 1 },
	});
	const hoverText = JSON.stringify(hover?.contents ?? '');
	expect(hoverText).toContain('msg');
});

async function startIpcHarness(options: {
	tsBackend: 'tsserver' | 'auto' | 'tsgo-lsp';
	tsgoPath?: string;
	bridgeTsserver?: boolean;
}): Promise<TestHarness> {
	let seq = 1;
	const bridgeTsserver = options.bridgeTsserver ?? true;
	const childArgs = [
		'--node-ipc',
		`--ts-backend=${options.tsBackend}`,
	];
	if (options.tsgoPath) {
		childArgs.push(`--tsgo=${options.tsgoPath}`);
	}

	const tsserver = bridgeTsserver
		? launchServer(
			tsserverPath,
			[
				'--disableAutomaticTypingAcquisition',
				'--globalPlugins',
				'@vue/typescript-plugin',
				'--suppressDiagnosticEvents',
				'--useNodeIpc',
			],
		)
		: undefined;

	const child = childProcess.fork(require.resolve('../index.js'), childArgs, {
		cwd: testWorkspacePath,
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		execArgv: ['--nolazy'],
		env: process.env,
	});

	const connection = createMessageConnection(
		new IPCMessageReader(child),
		new IPCMessageWriter(child),
	);
	connection.listen();

	connection.onRequest('workspace/configuration', ({ items }) => {
		return items.map(() => null);
	});
	connection.onNotification('textDocument/publishDiagnostics', () => {});
	if (tsserver) {
		connection.onNotification('tsserver/request', ([id, command, args]) => {
			tsserver.message({
				seq: seq++,
				type: 'request',
				command: command,
				arguments: args,
			}).then(
				res => connection.sendNotification('tsserver/response', [id, res?.body]),
				() => connection.sendNotification('tsserver/response', [id, undefined]),
			);
		});
	}

	const initializeResult = await connection.sendRequest('initialize', {
		processId: process.pid,
		rootUri: URI.file(testWorkspacePath).toString(),
		workspaceFolders: null,
		initializationOptions: {},
		capabilities: {
			workspace: {
				configuration: true,
			},
		},
		locale: 'en',
	});
	connection.sendNotification('initialized', {});

	return {
		connection,
		child,
		tsserver,
		initializeResult,
		async dispose() {
			try {
				await connection.sendRequest('shutdown');
			}
			catch {}
			try {
				connection.sendNotification('exit');
			}
			catch {}
			connection.dispose();
			tsserver?.kill();
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
		},
	};
}
