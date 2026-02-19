import type { LanguageServer } from '@volar/language-server';
import { createLanguageServiceEnvironment } from '@volar/language-server/lib/project/simpleProject';
import { createConnection, createServer } from '@volar/language-server/node';
import {
	createLanguage,
	createParsedCommandLine,
	createParsedCommandLineByJson,
	createVueLanguagePlugin,
} from '@vue/language-core';
import {
	createLanguageService,
	createUriMap,
	createVueLanguageServicePlugins,
	type LanguageService,
} from '@vue/language-service';
import { URI } from 'vscode-uri';
import { createTsBackendClient, type TsBackendPreference } from './tsBackend';

export interface StartServerOptions {
	tsBackend?: TsBackendPreference;
	tsgoPath?: string;
}

export function startServer(ts: typeof import('typescript'), options: StartServerOptions = {}) {
	const connection = createConnection();
	const server = createServer(connection);
	const tsBackend = createTsBackendClient({
		ts,
		connection,
		server,
		preference: options.tsBackend,
		tsgoPath: options.tsgoPath,
	});
	let tsBackendWarmupTask: Promise<void> | undefined;
	const ensureTsBackendWarmup = () => {
		tsBackendWarmupTask ??= warmupTsBackend(connection, tsBackend);
		return tsBackendWarmupTask;
	};

	connection.listen();

	connection.onInitialize(params => {
		const tsconfigProjects = createUriMap<LanguageService>();
		const file2ProjectInfo = new Map<string, Promise<{ configFileName: string } | null>>();

		server.fileWatcher.onDidChangeWatchedFiles(({ changes }) => {
			for (const change of changes) {
				const changeUri = URI.parse(change.uri);
				if (tsconfigProjects.has(changeUri)) {
					tsconfigProjects.get(changeUri)!.dispose();
					tsconfigProjects.delete(changeUri);
					file2ProjectInfo.clear();
				}
			}
		});

		let simpleLanguageService: LanguageService | undefined;

		const result = server.initialize(
			params,
			{
				setup() {},
				async getLanguageService(uri) {
					if (uri.scheme === 'file') {
						const fileName = uri.fsPath.replace(/\\/g, '/');
						let projectInfoPromise = file2ProjectInfo.get(fileName);
						if (!projectInfoPromise) {
							projectInfoPromise = tsBackend.getProjectInfo(fileName);
							file2ProjectInfo.set(fileName, projectInfoPromise);
						}
						const projectInfo = await projectInfoPromise;
						if (projectInfo) {
							const { configFileName } = projectInfo;
							const configUri = URI.file(configFileName);
							let languageService = tsconfigProjects.get(configUri);
							if (!languageService) {
								languageService = createProjectLanguageService(server, ts, configFileName);
								tsconfigProjects.set(configUri, languageService);
							}
							return languageService;
						}
					}
					return simpleLanguageService ??= createProjectLanguageService(server, ts, undefined);
				},
				getExistingLanguageServices() {
					const projects = [...tsconfigProjects.values()];
					if (simpleLanguageService) {
						projects.push(simpleLanguageService);
					}
					return projects;
				},
				reload() {
					for (const languageService of tsconfigProjects.values()) {
						languageService.dispose();
					}
					tsconfigProjects.clear();
					file2ProjectInfo.clear();
					if (simpleLanguageService) {
						simpleLanguageService.dispose();
						simpleLanguageService = undefined;
					}
				},
			},
			createVueLanguageServicePlugins(ts, tsBackend),
		);

		const packageJson = require('../package.json');
		result.serverInfo = {
			name: `${packageJson.name} [${tsBackend.mode}]`,
			version: packageJson.version,
		};

		connection.console.info(`[vue-ls] active backend: ${tsBackend.mode}`);
		setTimeout(() => {
			void ensureTsBackendWarmup();
		}, 0);
		return result;
	});

	connection.onInitialized(() => {
		void ensureTsBackendWarmup();
		server.initialized();
	});

	connection.onShutdown(async () => {
		await tsBackend.dispose();
		server.shutdown();
	});
}

async function warmupTsBackend(
	connection: ReturnType<typeof createConnection>,
	tsBackend: ReturnType<typeof createTsBackendClient>,
) {
	if (tsBackend.mode !== 'tsgo-lsp') {
		return;
	}

	const warmupPromise = tsBackend.warmup()
		.then(() => true)
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			connection.console.warn(`[vue-ls] tsgo backend warmup failed: ${message}`);
			return false;
		});
	const progressPromise = createProgressWithRetry(connection, 2_000)
		.then(progress => {
			if (!progress) {
				return undefined;
			}
			progress.begin('Vue TypeScript Backend', undefined, 'Starting tsgo backend');
			return progress;
		})
		.catch(() => {
			// Clients may decline or not support server-driven progress.
			return undefined;
		});

	try {
		const readyForHover = await tsBackend.awaitReadyForHover(8_000);
		if (readyForHover) {
			connection.console.info('[vue-ls] tsgo backend ready');
			return;
		}

		const warmupCompleted = await warmupPromise;
		if (warmupCompleted) {
			connection.console.info('[vue-ls] tsgo backend warm; hover readiness timed out');
		}
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		connection.console.warn(`[vue-ls] tsgo backend readiness wait failed: ${message}`);
	}
	finally {
		void progressPromise.then(progress => {
			progress?.done();
		});
}

async function createProgressWithRetry(
	connection: ReturnType<typeof createConnection>,
	maxWaitMs: number,
) {
	const deadline = Date.now() + Math.max(0, maxWaitMs);
	while (true) {
		try {
			return await connection.window.createWorkDoneProgress();
		}
		catch {
			if (Date.now() >= deadline) {
				return undefined;
			}
			await sleep(50);
		}
	}
}

function sleep(ms: number) {
	return new Promise<void>(resolve => setTimeout(resolve, ms));
}
}

function createProjectLanguageService(
	server: LanguageServer,
	ts: typeof import('typescript'),
	tsconfig: string | undefined,
) {
	const commonLine = tsconfig && !ts.server.isInferredProjectName(tsconfig)
		? createParsedCommandLine(ts, ts.sys, tsconfig)
		: createParsedCommandLineByJson(ts, ts.sys, ts.sys.getCurrentDirectory(), {});
	const language = createLanguage<URI>(
		[
			{
				getLanguageId: uri => server.documents.get(uri)?.languageId,
			},
			createVueLanguagePlugin(
				ts,
				commonLine.options,
				commonLine.vueOptions,
				uri => uri.fsPath.replace(/\\/g, '/'),
			),
		],
		createUriMap(),
		uri => {
			const document = server.documents.get(uri);
			if (document) {
				language.scripts.set(uri, document.getSnapshot(), document.languageId);
			}
			else {
				language.scripts.delete(uri);
			}
		},
	);
	return createLanguageService(
		language,
		server.languageServicePlugins,
		createLanguageServiceEnvironment(server, [...server.workspaceFolders.all]),
		{},
	);
}
