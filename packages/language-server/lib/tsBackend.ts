import type { LanguageServer } from '@volar/language-server';
import type * as vscode from '@volar/language-server/node';
import type { Requests } from '@vue/typescript-plugin/lib/requests';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import type * as ts from 'typescript';
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
} from 'vscode-jsonrpc/node';
import { URI } from 'vscode-uri';

const tsgoSupportedExtensions = new Set([
	'.ts',
	'.tsx',
	'.mts',
	'.cts',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.d.ts',
]);

export type TsBackendMode = 'tsserver' | 'tsgo-lsp';
export type TsBackendPreference = TsBackendMode | 'auto';

interface SyncedTextDocument {
	uri: string;
	languageId: string;
	version: number;
	getText(): string;
}

type RequestReturn<K extends keyof Requests> = ReturnType<Requests[K]>;
type RequestValue<K extends keyof Requests> = Awaited<RequestReturn<K>>;

export interface TsBackendClient extends Requests {
	readonly mode: TsBackendMode;
	warmup(): Promise<void>;
	awaitReadyForHover(timeoutMs: number): Promise<boolean>;
	getProjectInfo(fileName: string): Promise<{ configFileName: string } | null>;
	dispose(): Promise<void>;
}

type TsServerFallbackClient = Pick<TsBackendClient, keyof Requests | 'warmup' | 'getProjectInfo' | 'dispose'>;

export interface CreateTsBackendOptions {
	preference?: TsBackendPreference;
	tsgoPath?: string;
	ts: typeof import('typescript');
	connection: vscode.Connection;
	server: LanguageServer;
}

export function createTsBackendClient(options: CreateTsBackendOptions): TsBackendClient {
	const preference = options.preference ?? 'tsserver';
	let client: TsBackendClient;
	if (preference === 'tsgo-lsp') {
		const tsserverFallback = createTsgoFallbackClient(options);
		client = new TsgoLspBackendClient(options.connection, options.server, options.ts, options.tsgoPath, tsserverFallback);
	}
	else if (preference === 'auto') {
		const tsgoPath = options.tsgoPath ?? process.env.VUE_LANGUAGE_SERVER_TSGO_PATH ?? 'tsgo';
		if (canStartTsgo(tsgoPath)) {
			const tsserverFallback = createTsgoFallbackClient(options);
			client = new TsgoLspBackendClient(options.connection, options.server, options.ts, tsgoPath, tsserverFallback);
		}
		else {
			client = new TsServerBackendClient(options.connection, options.ts);
		}
	}
	else {
		client = new TsServerBackendClient(options.connection, options.ts);
	}
	return bindClientMethods(client);
}

function createTsgoFallbackClient(options: CreateTsBackendOptions): TsServerFallbackClient {
	const requestTimeoutMs = 10_000;
	try {
		return new TsServerProcessBackendClient(options.connection, options.server, options.ts, {
			requestTimeoutMs,
		});
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		options.connection.console.warn(
			`[vue-ls][tsgo] failed to start internal tsserver fallback; using client bridge: ${message}`,
		);
		return new TsServerBackendClient(options.connection, options.ts, {
			requestTimeoutMs,
		});
	}
}

abstract class AbstractTsServerBackendClient implements TsBackendClient {
	readonly mode = 'tsserver' as const;

	constructor(protected readonly ts: typeof import('typescript')) {}

	async warmup() {}

	async awaitReadyForHover(_timeoutMs: number) {
		return true;
	}

	async getProjectInfo(fileName: string) {
		return await this.sendTsServerRequest<ts.server.protocol.ProjectInfo>(
			'_vue:' + this.ts.server.protocol.CommandTypes.ProjectInfo,
			{
				file: fileName,
				needFileNameList: false,
			} satisfies ts.server.protocol.ProjectInfoRequestArgs,
		);
	}

	collectExtractProps(...args: Parameters<Requests['collectExtractProps']>): RequestReturn<'collectExtractProps'> {
		return this.sendVueRequest('collectExtractProps', '_vue:collectExtractProps', args);
	}
	getComponentDirectives(...args: Parameters<Requests['getComponentDirectives']>): RequestReturn<'getComponentDirectives'> {
		return this.sendVueRequest('getComponentDirectives', '_vue:getComponentDirectives', args);
	}
	getComponentNames(...args: Parameters<Requests['getComponentNames']>): RequestReturn<'getComponentNames'> {
		return this.sendVueRequest('getComponentNames', '_vue:getComponentNames', args);
	}
	getComponentMeta(...args: Parameters<Requests['getComponentMeta']>): RequestReturn<'getComponentMeta'> {
		return this.sendVueRequest('getComponentMeta', '_vue:getComponentMeta', args);
	}
	getComponentSlots(...args: Parameters<Requests['getComponentSlots']>): RequestReturn<'getComponentSlots'> {
		return this.sendVueRequest('getComponentSlots', '_vue:getComponentSlots', args);
	}
	getElementAttrs(...args: Parameters<Requests['getElementAttrs']>): RequestReturn<'getElementAttrs'> {
		return this.sendVueRequest('getElementAttrs', '_vue:getElementAttrs', args);
	}
	getElementNames(...args: Parameters<Requests['getElementNames']>): RequestReturn<'getElementNames'> {
		return this.sendVueRequest('getElementNames', '_vue:getElementNames', args);
	}
	getImportPathForFile(...args: Parameters<Requests['getImportPathForFile']>): RequestReturn<'getImportPathForFile'> {
		return this.sendVueRequest('getImportPathForFile', '_vue:getImportPathForFile', args);
	}
	getAutoImportSuggestions(...args: Parameters<Requests['getAutoImportSuggestions']>): RequestReturn<'getAutoImportSuggestions'> {
		return this.sendVueRequest('getAutoImportSuggestions', '_vue:getAutoImportSuggestions', args);
	}
	resolveAutoImportCompletionEntry(
		...args: Parameters<Requests['resolveAutoImportCompletionEntry']>
	): RequestReturn<'resolveAutoImportCompletionEntry'> {
		return this.sendVueRequest('resolveAutoImportCompletionEntry', '_vue:resolveAutoImportCompletionEntry', args);
	}
	isRefAtPosition(...args: Parameters<Requests['isRefAtPosition']>): RequestReturn<'isRefAtPosition'> {
		return this.sendVueRequest('isRefAtPosition', '_vue:isRefAtPosition', args);
	}
	resolveModuleName(...args: Parameters<Requests['resolveModuleName']>): RequestReturn<'resolveModuleName'> {
		return this.sendVueRequest('resolveModuleName', '_vue:resolveModuleName', args);
	}
	getDocumentHighlights(fileName: string, position: number): RequestReturn<'getDocumentHighlights'> {
		return this.sendTsServerRequest<RequestValue<'getDocumentHighlights'>>(
			'_vue:documentHighlights-full',
			{
				file: fileName,
				...{ position } as unknown as { line: number; offset: number },
				filesToSearch: [fileName],
			} satisfies ts.server.protocol.DocumentHighlightsRequestArgs,
		) as RequestReturn<'getDocumentHighlights'>;
	}
	getEncodedSemanticClassifications(
		fileName: string,
		span: ts.TextSpan,
	): RequestReturn<'getEncodedSemanticClassifications'> {
		return this.sendTsServerRequest<RequestValue<'getEncodedSemanticClassifications'>>(
			'_vue:encodedSemanticClassifications-full',
			{
				file: fileName,
				...span,
				format: this.ts.SemanticClassificationFormat.TwentyTwenty,
			} satisfies ts.server.protocol.EncodedSemanticClassificationsRequestArgs,
		) as RequestReturn<'getEncodedSemanticClassifications'>;
	}
	async getQuickInfoAtPosition(
		fileName: string,
		{ line, character }: ts.LineAndCharacter,
	): Promise<RequestValue<'getQuickInfoAtPosition'>> {
		const result = await this.sendTsServerRequest<ts.server.protocol.QuickInfoResponseBody>(
			'_vue:' + this.ts.server.protocol.CommandTypes.Quickinfo,
			{
				file: fileName,
				line: line + 1,
				offset: character + 1,
			} satisfies ts.server.protocol.FileLocationRequestArgs,
		);
		return result?.displayString;
	}

	abstract dispose(): Promise<void>;

	protected abstract sendTsServerRequest<T>(command: string, args: any): Promise<T | null>;

	protected sendVueRequest<K extends keyof Requests>(
		_method: K,
		command: string,
		args: Parameters<Requests[K]>,
	): RequestReturn<K> {
		return this.sendTsServerRequest<RequestValue<K>>(command, args) as RequestReturn<K>;
	}
}

class TsServerBackendClient extends AbstractTsServerBackendClient {
	private requestId = 0;
	private readonly requestHandlers = new Map<number, { resolve: (res: any) => void; timer: NodeJS.Timeout }>();
	private readonly disposeResponseListener: vscode.Disposable;
	private readonly requestTimeoutMs: number;

	constructor(
		private readonly connection: vscode.Connection,
		ts: typeof import('typescript'),
		options?: {
			requestTimeoutMs?: number;
		},
	) {
		super(ts);
		this.requestTimeoutMs = options?.requestTimeoutMs ?? 30_000;
		this.disposeResponseListener = this.connection.onNotification('tsserver/response', ([id, res]: [number, any]) => {
			const pending = this.requestHandlers.get(id);
			if (!pending) {
				return;
			}
			clearTimeout(pending.timer);
			this.requestHandlers.delete(id);
			pending.resolve(res);
		});
	}

	async dispose() {
		this.disposeResponseListener.dispose();
		for (const pending of this.requestHandlers.values()) {
			clearTimeout(pending.timer);
			pending.resolve(undefined);
		}
		this.requestHandlers.clear();
	}

	protected async sendTsServerRequest<T>(command: string, args: any): Promise<T | null> {
		return await new Promise<T | null>(resolve => {
			const requestId = ++this.requestId;
			const timer = setTimeout(() => {
				this.requestHandlers.delete(requestId);
				resolve(null);
			}, this.requestTimeoutMs);
			this.requestHandlers.set(requestId, {
				resolve,
				timer,
			});
			this.connection.sendNotification('tsserver/request', [requestId, command, args]);
		});
	}
}

class TsServerProcessBackendClient extends AbstractTsServerBackendClient {
	private requestId = 0;
	private disposed = false;
	private readonly requestTimeoutMs: number;
	private readonly requestHandlers = new Map<number, { resolve: (res: any) => void; timer: NodeJS.Timeout }>();
	private readonly openDocumentVersions = new Map<string, number>();
	private readonly tsserverPath: string;
	private readonly tsserverArgs: string[];
	private tsserverProcess: childProcess.ChildProcess | undefined;
	private startPromise: Promise<void> | undefined;

	constructor(
		private readonly connection: vscode.Connection,
		private readonly server: LanguageServer,
		ts: typeof import('typescript'),
		options?: {
			requestTimeoutMs?: number;
			tsserverPath?: string;
		},
	) {
		super(ts);
		this.requestTimeoutMs = options?.requestTimeoutMs ?? 30_000;

		const resolvedTsserverPath = options?.tsserverPath ?? resolveTsServerPath(this.ts);
		if (!resolvedTsserverPath) {
			throw new Error('unable to resolve TypeScript tsserver.js path');
		}
		this.tsserverPath = resolvedTsserverPath;

		this.tsserverArgs = [
			'--useNodeIpc',
			'--disableAutomaticTypingAcquisition',
			'--suppressDiagnosticEvents',
			'--globalPlugins',
			'@vue/typescript-plugin',
		];
		const pluginProbeLocation = resolveVueTypescriptPluginProbeLocation();
		if (pluginProbeLocation) {
			this.tsserverArgs.push('--pluginProbeLocations', pluginProbeLocation);
		}
	}

	async warmup() {
		await this.ensureProcessStarted();
	}

	async dispose() {
		this.disposed = true;
		const trackedFiles = [...this.openDocumentVersions.keys()];
		this.openDocumentVersions.clear();
		if (trackedFiles.length) {
			await this.sendRawTsServerRequest(this.ts.server.protocol.CommandTypes.UpdateOpen, {
				openFiles: [],
				changedFiles: [],
				closedFiles: trackedFiles,
			} satisfies ts.server.protocol.UpdateOpenRequestArgs);
		}
		for (const pending of this.requestHandlers.values()) {
			clearTimeout(pending.timer);
			pending.resolve(undefined);
		}
		this.requestHandlers.clear();
		if (this.tsserverProcess
			&& this.tsserverProcess.exitCode === null
			&& this.tsserverProcess.signalCode === null) {
			this.tsserverProcess.kill();
		}
		this.tsserverProcess = undefined;
		this.startPromise = undefined;
	}

	protected async sendTsServerRequest<T>(command: string, args: any): Promise<T | null> {
		const fileName = fileNameFromTsServerArgs(args);
		if (fileName) {
			await this.syncOpenDocument(fileName);
		}
		return await this.sendRawTsServerRequest<T>(command, args);
	}

	private async syncOpenDocument(fileName: string) {
		const normalizedFileName = normalizeFileName(fileName);
		const document = this.server.documents.get(URI.file(normalizedFileName));
		if (!document) {
			if (!this.openDocumentVersions.has(normalizedFileName)) {
				return;
			}
			await this.sendRawTsServerRequest(this.ts.server.protocol.CommandTypes.UpdateOpen, {
				openFiles: [],
				changedFiles: [],
				closedFiles: [normalizedFileName],
			} satisfies ts.server.protocol.UpdateOpenRequestArgs);
			this.openDocumentVersions.delete(normalizedFileName);
			return;
		}

		const currentVersion = document.version;
		const trackedVersion = this.openDocumentVersions.get(normalizedFileName);
		if (trackedVersion === currentVersion) {
			return;
		}

		await this.sendRawTsServerRequest(this.ts.server.protocol.CommandTypes.UpdateOpen, {
			openFiles: [
				{
					file: normalizedFileName,
					fileContent: document.getText(),
				},
			],
			changedFiles: [],
			closedFiles: trackedVersion !== undefined ? [normalizedFileName] : [],
		} satisfies ts.server.protocol.UpdateOpenRequestArgs);
		this.openDocumentVersions.set(normalizedFileName, currentVersion);
	}

	private async sendRawTsServerRequest<T>(command: string, args: any): Promise<T | null> {
		await this.ensureProcessStarted();
		const tsserverProcess = this.tsserverProcess;
		if (!tsserverProcess?.connected || !tsserverProcess.send) {
			return null;
		}
		return await new Promise<T | null>(resolve => {
			const requestId = ++this.requestId;
			const timer = setTimeout(() => {
				this.requestHandlers.delete(requestId);
				resolve(null);
			}, this.requestTimeoutMs);
			this.requestHandlers.set(requestId, {
				resolve,
				timer,
			});
			tsserverProcess.send(
				{
					seq: requestId,
					type: 'request',
					command,
					arguments: args,
				} satisfies ts.server.protocol.Request,
				error => {
					if (!error) {
						return;
					}
					const pending = this.requestHandlers.get(requestId);
					if (!pending) {
						return;
					}
					clearTimeout(pending.timer);
					this.requestHandlers.delete(requestId);
					pending.resolve(null);
				},
			);
		});
	}

	private async ensureProcessStarted() {
		if (this.disposed) {
			return;
		}
		if (!this.startPromise) {
			this.startPromise = this.startProcess().catch(error => {
				this.startPromise = undefined;
				throw error;
			});
		}
		await this.startPromise;
	}

	private async startProcess() {
		const tsserverProcess = childProcess.fork(this.tsserverPath, this.tsserverArgs, {
			cwd: this.ts.sys.getCurrentDirectory(),
			stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
			env: process.env,
			execArgv: [],
		});
		if (!tsserverProcess.send) {
			tsserverProcess.kill();
			throw new Error('tsserver process does not expose IPC messaging');
		}
		this.tsserverProcess = tsserverProcess;

		tsserverProcess.on('message', message => {
			this.handleTsServerMessage(message);
		});
		tsserverProcess.on('error', (error: Error) => {
			this.connection.console.error(`[vue-ls][tsserver-fallback] process error: ${error.message}`);
		});
		tsserverProcess.on('exit', (code: number | null, signal: string | null) => {
			if (!this.disposed) {
				this.connection.console.warn(
					`[vue-ls][tsserver-fallback] process exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
				);
			}
			this.tsserverProcess = undefined;
			this.startPromise = undefined;
			for (const pending of this.requestHandlers.values()) {
				clearTimeout(pending.timer);
				pending.resolve(null);
			}
			this.requestHandlers.clear();
		});
		tsserverProcess.stderr?.on('data', (chunk: Buffer | string) => {
			const text = chunk.toString().trim();
			if (text) {
				this.connection.console.info(`[vue-ls][tsserver-fallback] ${text}`);
			}
		});
	}

	private handleTsServerMessage(message: unknown) {
		if (!message || typeof message !== 'object') {
			return;
		}
		const payload = message as ts.server.protocol.Message;
		if (payload.type !== 'response') {
			return;
		}
		const response = payload as ts.server.protocol.Response;
		const requestId = response.request_seq;
		if (typeof requestId !== 'number') {
			return;
		}
		const pending = this.requestHandlers.get(requestId);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		this.requestHandlers.delete(requestId);
		if (response.success === false) {
			pending.resolve(null);
			return;
		}
		pending.resolve(response.body ?? null);
	}
}

class TsgoLspBackendClient implements TsBackendClient {
	readonly mode = 'tsgo-lsp' as const;

	private connectionToTsgo: MessageConnection | undefined;
	private tsgoProcess: childProcess.ChildProcess | undefined;
	private initPromise: Promise<void> | undefined;
	private disposed = false;

	private readonly openDocumentVersions = new Map<string, number>();
	private readonly compilerOptionsCache = new Map<string, ts.CompilerOptions>();
	private readonly documentDisposables: vscode.Disposable[] = [];
	private hoverReady = false;
	private readonly hoverReadyWaiters = new Set<(ready: boolean) => void>();

	constructor(
		private readonly connection: vscode.Connection,
		private readonly server: LanguageServer,
		private readonly ts: typeof import('typescript'),
		private readonly tsgoPath: string | undefined,
		private readonly fallback: TsServerFallbackClient | undefined,
	) {
		this.documentDisposables.push(
			this.server.documents.onDidOpen(({ document }: { document: SyncedTextDocument }) => {
				void this.syncOpenDocument(document);
			}),
			this.server.documents.onDidChangeContent(({ document }: { document: SyncedTextDocument }) => {
				void this.syncOpenDocument(document);
			}),
			this.server.documents.onDidClose(({ document }: { document: SyncedTextDocument }) => {
				void this.syncClosedDocument(document.uri);
			}),
		);
	}

	async getProjectInfo(fileName: string) {
		const normalizedFileName = normalizeFileName(fileName);
		const configFileName = this.findClosestConfig(normalizedFileName);
		if (configFileName) {
			return { configFileName };
		}
		return await this.callFallbackProjectInfo(fileName);
	}

	async warmup() {
		await Promise.all([
			this.ensureStarted(),
			this.fallback?.warmup(),
		]);
		await this.primeOpenDocuments();
	}

	async awaitReadyForHover(timeoutMs: number) {
		if (this.hoverReady) {
			return true;
		}
		if (this.disposed) {
			return false;
		}
		if (timeoutMs <= 0) {
			return false;
		}
		return await new Promise<boolean>(resolve => {
			const finish = (ready: boolean) => {
				this.hoverReadyWaiters.delete(waiter);
				if (timer) {
					clearTimeout(timer);
				}
				resolve(ready);
			};
			const waiter = (ready: boolean) => finish(ready);
			const timer = setTimeout(() => finish(false), timeoutMs);
			this.hoverReadyWaiters.add(waiter);
		});
	}

	collectExtractProps(...args: Parameters<Requests['collectExtractProps']>): RequestReturn<'collectExtractProps'> {
		return this.callFallback('collectExtractProps', ...args);
	}
	getComponentDirectives(...args: Parameters<Requests['getComponentDirectives']>): RequestReturn<'getComponentDirectives'> {
		return this.callFallback('getComponentDirectives', ...args);
	}
	getComponentNames(...args: Parameters<Requests['getComponentNames']>): RequestReturn<'getComponentNames'> {
		return this.callFallback('getComponentNames', ...args);
	}
	getComponentMeta(...args: Parameters<Requests['getComponentMeta']>): RequestReturn<'getComponentMeta'> {
		return this.callFallback('getComponentMeta', ...args);
	}
	getComponentSlots(...args: Parameters<Requests['getComponentSlots']>): RequestReturn<'getComponentSlots'> {
		return this.callFallback('getComponentSlots', ...args);
	}
	getElementAttrs(...args: Parameters<Requests['getElementAttrs']>): RequestReturn<'getElementAttrs'> {
		return this.callFallback('getElementAttrs', ...args);
	}
	getElementNames(...args: Parameters<Requests['getElementNames']>): RequestReturn<'getElementNames'> {
		return this.callFallback('getElementNames', ...args);
	}
	getImportPathForFile(...args: Parameters<Requests['getImportPathForFile']>): RequestReturn<'getImportPathForFile'> {
		return this.callFallback('getImportPathForFile', ...args);
	}
	getAutoImportSuggestions(...args: Parameters<Requests['getAutoImportSuggestions']>): RequestReturn<'getAutoImportSuggestions'> {
		return this.callFallback('getAutoImportSuggestions', ...args);
	}
	resolveAutoImportCompletionEntry(
		...args: Parameters<Requests['resolveAutoImportCompletionEntry']>
	): RequestReturn<'resolveAutoImportCompletionEntry'> {
		return this.callFallback('resolveAutoImportCompletionEntry', ...args);
	}
	isRefAtPosition(...args: Parameters<Requests['isRefAtPosition']>): RequestReturn<'isRefAtPosition'> {
		return this.callFallback('isRefAtPosition', ...args);
	}
	async resolveModuleName(fileName: string, moduleName: string): Promise<RequestValue<'resolveModuleName'>> {
		if (supportsTsgoFile(fileName)) {
			const compilerOptions = this.getCompilerOptions(fileName);
			const resolved = this.ts.resolveModuleName(moduleName, fileName, compilerOptions, this.ts.sys)
				.resolvedModule?.resolvedFileName
				?.replace(/\\/g, '/');
			if (resolved) {
				return resolved;
			}
		}
		return await this.callFallbackValue('resolveModuleName', fileName, moduleName);
	}
	async getDocumentHighlights(fileName: string, position: number): Promise<RequestValue<'getDocumentHighlights'>> {
		if (supportsTsgoFile(fileName)) {
			const response = await this.sendLspRequest<vscode.DocumentHighlight[] | null>('textDocument/documentHighlight', {
				textDocument: { uri: URI.file(fileName).toString() },
				position: await this.offsetToPosition(fileName, position),
			});
			if (response?.length) {
				const text = this.getFileText(fileName);
				if (text !== undefined) {
					return [
						{
							fileName,
							highlightSpans: response.map(item => ({
								textSpan: rangeToTextSpan(text, item.range),
								kind: documentHighlightKindToTs(item.kind),
							})),
						},
					] as ts.DocumentHighlights[];
				}
			}
		}
		return await this.callFallbackValue('getDocumentHighlights', fileName, position);
	}
	getEncodedSemanticClassifications(
		...args: Parameters<Requests['getEncodedSemanticClassifications']>
	): RequestReturn<'getEncodedSemanticClassifications'> {
		return this.callFallback('getEncodedSemanticClassifications', ...args);
	}
	async getQuickInfoAtPosition(
		fileName: string,
		position: ts.LineAndCharacter,
	): Promise<RequestValue<'getQuickInfoAtPosition'>> {
		this.markHoverReady();
		if (supportsTsgoFile(fileName)) {
			const response = await this.sendLspRequest<vscode.Hover | null>('textDocument/hover', {
				textDocument: { uri: URI.file(fileName).toString() },
				position: {
					line: position.line,
					character: position.character,
				},
			});
			const display = hoverToDisplayString(response);
			if (display) {
				return display;
			}
		}
		const fallbackResponse = await this.callFallbackValue('getQuickInfoAtPosition', fileName, position);
		return fallbackResponse;
	}

	async dispose() {
		this.disposed = true;
		for (const disposable of this.documentDisposables) {
			disposable.dispose();
		}
		this.documentDisposables.length = 0;
		this.openDocumentVersions.clear();
		this.resolveHoverReadyWaiters(false);

		if (this.connectionToTsgo) {
			this.connectionToTsgo.dispose();
			this.connectionToTsgo = undefined;
		}
		if (this.tsgoProcess) {
			this.tsgoProcess.kill();
			this.tsgoProcess = undefined;
		}
		if (this.fallback) {
			await this.fallback.dispose();
		}
	}

	private callFallback(method: keyof Requests, ...args: any[]): any {
		if (!this.fallback) {
			return undefined;
		}
		return (this.fallback as any)[method](...args);
	}

	private async callFallbackValue(method: keyof Requests, ...args: any[]): Promise<any> {
		if (!this.fallback) {
			return undefined;
		}
		try {
			const result = await (this.fallback as any)[method](...args);
			return result ?? undefined;
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.connection.console.warn(`[vue-ls][tsgo] fallback request failed for ${String(method)}: ${message}`);
			return undefined;
		}
	}

	private async callFallbackProjectInfo(fileName: string): Promise<{ configFileName: string } | null> {
		if (!this.fallback) {
			return null;
		}
		try {
			return await this.fallback.getProjectInfo(fileName);
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.connection.console.warn(`[vue-ls][tsgo] fallback getProjectInfo failed: ${message}`);
			return null;
		}
	}

	private async primeOpenDocuments() {
		await this.waitForFirstOpenDocument(5_000);
		const shouldPrimeFallbackRequests = this.fallback instanceof TsServerProcessBackendClient;
		const deadline = Date.now() + 8_000;
		while (!this.disposed) {
			const attempt = await this.primeOpenDocumentsOnce(shouldPrimeFallbackRequests);
			const tsgoReady = !attempt.sawTsgo || attempt.tsgoReady;
			const fallbackReady = !attempt.sawFallback || attempt.fallbackReady;
			if (tsgoReady && fallbackReady) {
				return;
			}
			if (Date.now() >= deadline) {
				return;
			}
			await sleep(200);
		}
	}

	private async primeOpenDocumentsOnce(shouldPrimeFallbackRequests: boolean) {
		const tasks: Promise<{ bucket: 'tsgo' | 'fallback'; ready: boolean }>[] = [];
		let sawTsgo = false;
		let sawFallback = false;

		for (const document of this.server.documents.all()) {
			const uri = URI.parse(document.uri);
			if (uri.scheme !== 'file') {
				continue;
			}
			const fileName = normalizeFileName(uri.fsPath);
			const primePosition = this.findPrimePosition(fileName, document.getText());
			if (supportsTsgoFile(fileName)) {
				sawTsgo = true;
				tasks.push(
					this.primeTsgoHover(fileName, primePosition).then(ready => ({
						bucket: 'tsgo' as const,
						ready,
					})),
				);
			}
			else if (shouldPrimeFallbackRequests) {
				sawFallback = true;
				tasks.push(
					this.primeFallbackQuickInfo(fileName, primePosition).then(ready => ({
						bucket: 'fallback' as const,
						ready,
					})),
				);
			}
		}

		if (!tasks.length) {
			return {
				sawTsgo,
				tsgoReady: false,
				sawFallback,
				fallbackReady: false,
			};
		}

		const results = await Promise.all(tasks);
		return {
			sawTsgo,
			tsgoReady: results.some(result => result.bucket === 'tsgo' && result.ready),
			sawFallback,
			fallbackReady: results.some(result => result.bucket === 'fallback' && result.ready),
		};
	}

	private async primeTsgoHover(fileName: string, position: vscode.Position) {
		const response = await this.sendLspRequest<vscode.Hover | null>('textDocument/hover', {
			textDocument: { uri: URI.file(fileName).toString() },
			position,
		});
		const display = hoverToDisplayString(response);
		return !!display;
	}

	private async primeFallbackQuickInfo(fileName: string, position: ts.LineAndCharacter) {
		await this.callFallbackProjectInfo(fileName);
		const response = await this.callFallbackValue('getQuickInfoAtPosition', fileName, position);
		if (typeof response !== 'string') {
			return false;
		}
		return response.length > 0;
	}

	private markHoverReady() {
		if (this.hoverReady) {
			return;
		}
		this.hoverReady = true;
		this.resolveHoverReadyWaiters(true);
	}

	private resolveHoverReadyWaiters(ready: boolean) {
		if (!this.hoverReadyWaiters.size) {
			return;
		}
		const waiters = [...this.hoverReadyWaiters];
		this.hoverReadyWaiters.clear();
		for (const waiter of waiters) {
			waiter(ready);
		}
	}

	private findPrimePosition(fileName: string, text: string) {
		const vueScript = findVueScriptContent(fileName, text);
		if (vueScript) {
			const declarationOffset = findDeclarationIdentifierOffset(vueScript.text);
			if (declarationOffset !== undefined) {
				return offsetToPosition(text, vueScript.offset + declarationOffset);
			}
			const identifierOffset = findIdentifierOffset(vueScript.text);
			if (identifierOffset !== undefined) {
				return offsetToPosition(text, vueScript.offset + identifierOffset);
			}
		}

		const declarationOffset = findDeclarationIdentifierOffset(text);
		if (declarationOffset !== undefined) {
			return offsetToPosition(text, declarationOffset);
		}
		const identifierOffset = findIdentifierOffset(text);
		if (identifierOffset !== undefined) {
			return offsetToPosition(text, identifierOffset);
		}
		return { line: 0, character: 0 };
	}

	private async waitForFirstOpenDocument(timeoutMs: number) {
		if (this.hasOpenDocuments()) {
			return;
		}
		await new Promise<void>(resolve => {
			let finished = false;
			const finish = () => {
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(timer);
				disposable.dispose();
				resolve();
			};
			const timer = setTimeout(finish, timeoutMs);
			const disposable = this.server.documents.onDidOpen(() => {
				finish();
			});
			if (this.hasOpenDocuments()) {
				finish();
			}
		});
	}

	private hasOpenDocuments() {
		for (const _document of this.server.documents.all()) {
			return true;
		}
		return false;
	}

	private async sendLspRequest<T>(method: string, params: any): Promise<T | null> {
		try {
			await this.ensureStarted();
			if (!this.connectionToTsgo) {
				return null;
			}
			if (params?.textDocument?.uri) {
				await this.syncOpenDocumentByUri(params.textDocument.uri);
			}
			return await this.connectionToTsgo.sendRequest<T>(method, params);
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.connection.console.warn(`[vue-ls][tsgo] request failed for ${method}: ${message}`);
			return null;
		}
	}

	private async ensureStarted() {
		this.initPromise ??= this.start();
		await this.initPromise;
	}

	private async start() {
		if (this.disposed) {
			return;
		}
		const tsgoPath = this.tsgoPath ?? process.env.VUE_LANGUAGE_SERVER_TSGO_PATH ?? 'tsgo';
		const tsgoProcess = childProcess.spawn(tsgoPath, ['--lsp', '--stdio'], {
			cwd: this.ts.sys.getCurrentDirectory(),
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.tsgoProcess = tsgoProcess;

		tsgoProcess.on('error', (error: Error) => {
			this.connection.console.error(`[vue-ls] failed to start tsgo backend: ${error.message}`);
		});
		tsgoProcess.stderr?.on('data', (chunk: Buffer | string) => {
			const text = chunk.toString().trim();
			if (text) {
				this.connection.console.info(`[vue-ls][tsgo] ${text}`);
			}
		});

		const lspConnection = createMessageConnection(
			new StreamMessageReader(tsgoProcess.stdout!),
			new StreamMessageWriter(tsgoProcess.stdin!),
		);
		this.connectionToTsgo = lspConnection;
		lspConnection.listen();

		await lspConnection.sendRequest('initialize', {
			processId: process.pid,
			rootUri: null,
			capabilities: {},
			workspaceFolders: null,
			clientInfo: {
				name: '@vue/language-server',
			},
		});
		lspConnection.sendNotification('initialized', {});
		this.connection.console.info('[vue-ls] tsgo backend initialized');

		for (const document of this.server.documents.all()) {
			await this.syncOpenDocument(document);
		}
	}

	private async syncOpenDocumentByUri(uriString: string) {
		const document = this.server.documents.get(URI.parse(uriString));
		if (document) {
			await this.syncOpenDocument(document);
		}
	}

	private async syncOpenDocument(document: SyncedTextDocument) {
		if (!this.connectionToTsgo) {
			return;
		}
		const uri = URI.parse(document.uri);
		if (uri.scheme !== 'file') {
			return;
		}
		const fileName = normalizeFileName(uri.fsPath);
		if (!supportsTsgoFile(fileName)) {
			return;
		}
		const currentVersion = document.version;
		const trackedVersion = this.openDocumentVersions.get(fileName);
		if (trackedVersion === undefined) {
			this.connectionToTsgo.sendNotification('textDocument/didOpen', {
				textDocument: {
					uri: URI.file(fileName).toString(),
					languageId: languageIdForFile(fileName, document.languageId),
					version: currentVersion,
					text: document.getText(),
				},
			});
			this.openDocumentVersions.set(fileName, currentVersion);
			return;
		}
		if (trackedVersion !== currentVersion) {
			this.connectionToTsgo.sendNotification('textDocument/didChange', {
				textDocument: {
					uri: URI.file(fileName).toString(),
					version: currentVersion,
				},
				contentChanges: [
					{
						text: document.getText(),
					},
				],
			});
			this.openDocumentVersions.set(fileName, currentVersion);
		}
	}

	private async syncClosedDocument(uriString: string) {
		if (!this.connectionToTsgo) {
			return;
		}
		const uri = URI.parse(uriString);
		if (uri.scheme !== 'file') {
			return;
		}
		const fileName = normalizeFileName(uri.fsPath);
		if (!this.openDocumentVersions.has(fileName)) {
			return;
		}
		this.connectionToTsgo.sendNotification('textDocument/didClose', {
			textDocument: {
				uri: URI.file(fileName).toString(),
			},
		});
		this.openDocumentVersions.delete(fileName);
	}

	private findClosestConfig(fileName: string) {
		const normalized = normalizeFileName(fileName);
		const dir = path.dirname(normalized);
		const tsconfig = this.ts.findConfigFile(dir, this.ts.sys.fileExists, 'tsconfig.json');
		const jsconfig = this.ts.findConfigFile(dir, this.ts.sys.fileExists, 'jsconfig.json');
		const candidates = [tsconfig, jsconfig]
			.filter((entry): entry is string => !!entry)
			.map(entry => normalizeFileName(entry));
		if (!candidates.length) {
			return null;
		}
		const containing = candidates
			.filter(configPath => isFileInDirectory(normalized, path.dirname(configPath)))
			.sort((a, b) => path.dirname(b).length - path.dirname(a).length);
		return containing[0] ?? candidates.sort((a, b) => b.length - a.length)[0] ?? null;
	}

	private getCompilerOptions(fileName: string) {
		const configFileName = this.findClosestConfig(fileName);
		if (!configFileName) {
			return {} as ts.CompilerOptions;
		}
		const cached = this.compilerOptionsCache.get(configFileName);
		if (cached) {
			return cached;
		}
		const config = this.ts.readConfigFile(configFileName, this.ts.sys.readFile);
		if (config.error) {
			return {} as ts.CompilerOptions;
		}
		const parsed = this.ts.parseJsonConfigFileContent(
			config.config,
			this.ts.sys,
			path.dirname(configFileName),
			undefined,
			configFileName,
		);
		this.compilerOptionsCache.set(configFileName, parsed.options);
		return parsed.options;
	}

	private getFileText(fileName: string) {
		const uri = URI.file(fileName);
		const openDocument = this.server.documents.get(uri);
		if (openDocument) {
			return openDocument.getText();
		}
		return this.ts.sys.readFile(fileName);
	}

	private async offsetToPosition(fileName: string, offset: number) {
		const text = this.getFileText(fileName) ?? '';
		return offsetToPosition(text, offset);
	}
}

function fileNameFromTsServerArgs(args: any) {
	if (typeof args?.file === 'string') {
		return normalizeFileName(args.file);
	}
	if (Array.isArray(args) && typeof args[0] === 'string') {
		return normalizeFileName(args[0]);
	}
	return undefined;
}

function resolveTsServerPath(ts: typeof import('typescript')) {
	const candidates = new Set<string>();
	try {
		candidates.add(require.resolve('typescript/lib/tsserver.js'));
	}
	catch {}
	try {
		const fromDefaultRequire = require.resolve('typescript');
		candidates.add(path.join(path.dirname(fromDefaultRequire), 'tsserver.js'));
	}
	catch {}
	try {
		const fromCwdRequire = require.resolve('typescript', {
			paths: [ts.sys.getCurrentDirectory()],
		});
		candidates.add(path.join(path.dirname(fromCwdRequire), 'tsserver.js'));
	}
	catch {}
	const executingFilePath = (ts.sys as any).getExecutingFilePath?.();
	if (typeof executingFilePath === 'string' && executingFilePath.length) {
		const executingDir = path.dirname(executingFilePath);
		candidates.add(path.join(executingDir, 'tsserver.js'));
		candidates.add(path.join(executingDir, '_tsserver.js'));
	}
	for (const candidate of candidates) {
		if (ts.sys.fileExists(candidate)) {
			return candidate;
		}
	}
}

function resolveVueTypescriptPluginProbeLocation() {
	try {
		return path.dirname(require.resolve('@vue/typescript-plugin/package.json'));
	}
	catch {
		return undefined;
	}
}

function supportsTsgoFile(fileName: string) {
	const extname = path.extname(fileName).toLowerCase();
	if (tsgoSupportedExtensions.has(extname)) {
		return true;
	}
	return fileName.endsWith('.d.ts');
}

function languageIdForFile(fileName: string, fallbackLanguageId: string) {
	const extname = path.extname(fileName).toLowerCase();
	switch (extname) {
		case '.ts':
		case '.mts':
		case '.cts':
		case '.d.ts':
			return 'typescript';
		case '.tsx':
			return 'typescriptreact';
		case '.js':
		case '.mjs':
		case '.cjs':
			return 'javascript';
		case '.jsx':
			return 'javascriptreact';
		default:
			return fallbackLanguageId;
	}
}

function normalizeFileName(fileName: string) {
	return path.normalize(fileName).replace(/\\/g, '/');
}

function isFileInDirectory(fileName: string, directory: string) {
	const normalizedFileName = normalizeFileName(fileName);
	const normalizedDirectory = normalizeFileName(directory).replace(/\/+$/, '');
	if (normalizedFileName === normalizedDirectory) {
		return true;
	}
	return normalizedFileName.startsWith(normalizedDirectory + '/');
}

function hoverToDisplayString(hover: vscode.Hover | null): string | undefined {
	if (!hover) {
		return;
	}
	return markdownToDisplayString(contentsToText(hover.contents));
}

function contentsToText(contents: vscode.MarkupContent | vscode.MarkedString | vscode.MarkedString[]): string {
	if (typeof contents === 'string') {
		return contents;
	}
	if (Array.isArray(contents)) {
		return contents.map(contentsToText).filter(Boolean).join('\n');
	}
	if (typeof contents.value === 'string') {
		if ('language' in contents && contents.language) {
			return contents.value;
		}
		return contents.value;
	}
	return '';
}

function markdownToDisplayString(markdown: string) {
	const codeBlock = markdown.match(/```(?:\w+)?\n([\s\S]*?)```/);
	if (codeBlock?.[1]) {
		return codeBlock[1].trim();
	}
	return markdown.trim();
}

function documentHighlightKindToTs(kind: vscode.DocumentHighlightKind | undefined) {
	if (kind === 2) {
		return 'reference' as const;
	}
	if (kind === 3) {
		return 'writtenReference' as const;
	}
	return 'none' as const;
}

function rangeToTextSpan(text: string, range: vscode.Range) {
	const start = positionToOffset(text, range.start);
	const end = positionToOffset(text, range.end);
	return {
		start,
		length: Math.max(0, end - start),
	};
}

function positionToOffset(text: string, position: vscode.Position) {
	let line = 0;
	let index = 0;
	const targetLine = Math.max(0, position.line);
	while (index < text.length && line < targetLine) {
		if (text.charCodeAt(index) === 10) {
			line++;
		}
		index++;
	}
	return Math.min(text.length, index + Math.max(0, position.character));
}

function offsetToPosition(text: string, offset: number) {
	const targetOffset = Math.min(Math.max(offset, 0), text.length);
	let line = 0;
	let lineStart = 0;
	for (let i = 0; i < targetOffset; i++) {
		if (text.charCodeAt(i) === 10) {
			line++;
			lineStart = i + 1;
		}
	}
	return {
		line,
		character: targetOffset - lineStart,
	};
}

function findVueScriptContent(fileName: string, text: string) {
	if (!fileName.toLowerCase().endsWith('.vue')) {
		return;
	}
	const scriptMatch = text.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
	if (!scriptMatch || scriptMatch.index === undefined) {
		return;
	}
	const wholeMatch = scriptMatch[0];
	const startTagEnd = wholeMatch.indexOf('>');
	if (startTagEnd < 0) {
		return;
	}
	return {
		offset: scriptMatch.index + startTagEnd + 1,
		text: wholeMatch.slice(startTagEnd + 1, wholeMatch.length - '</script>'.length),
	};
}

function findDeclarationIdentifierOffset(text: string) {
	const declarationMatch = /\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(text);
	if (!declarationMatch || declarationMatch.index === undefined || !declarationMatch[1]) {
		return;
	}
	const identifierOffset = declarationMatch[0].lastIndexOf(declarationMatch[1]);
	if (identifierOffset < 0) {
		return;
	}
	return declarationMatch.index + identifierOffset;
}

function findIdentifierOffset(text: string) {
	const match = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/.exec(text);
	if (!match || match.index === undefined) {
		return;
	}
	return match.index;
}

function sleep(ms: number) {
	return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function canStartTsgo(tsgoPath: string) {
	try {
		const result = childProcess.spawnSync(tsgoPath, ['--version'], {
			stdio: 'ignore',
		});
		return result.error === undefined && result.signal === null && result.status === 0;
	}
	catch {
		return false;
	}
}

function bindClientMethods<T extends object>(client: T): T {
	return new Proxy(client, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value === 'function') {
				return value.bind(target);
			}
			return value;
		},
	});
}
