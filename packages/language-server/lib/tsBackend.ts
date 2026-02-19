import type { LanguageServer } from '@volar/language-server/index.js';
import {
	createTypeScriptBackendClient,
	isTsgoSupportedFile,
	type TsBackendMode as VolarTsBackendMode,
	type TsBackendPreference as VolarTsBackendPreference,
	type TypeScriptBackendClient,
} from '@volar/language-server/node.js';
import type * as vscode from '@volar/language-server/node.js';
import * as path from 'node:path';
import type { Requests } from '@vue/typescript-plugin/lib/requests';
import type * as ts from 'typescript';

type RequestMethodKey = {
	[K in keyof Requests]-?: Requests[K] extends (...args: any[]) => any ? K : never;
}[keyof Requests];

type RequestReturn<K extends RequestMethodKey> = ReturnType<NonNullable<Requests[K]>>;
type RequestValue<K extends RequestMethodKey> = Awaited<RequestReturn<K>>;

export type TsBackendMode = VolarTsBackendMode;
export type TsBackendPreference = VolarTsBackendPreference;

export interface TsBackendClient extends Requests {
	readonly mode: TsBackendMode;
	warmup(): Promise<void>;
	awaitReadyForHover(timeoutMs: number): Promise<boolean>;
	notifyHoverRequested(): void;
	getProjectInfo(fileName: string): Promise<{ configFileName: string } | null>;
	dispose(): Promise<void>;
}

export interface CreateTsBackendOptions {
	preference?: TsBackendPreference;
	tsgoPath?: string;
	ts: typeof import('typescript');
	connection: vscode.Connection;
	server: LanguageServer;
}

export function createTsBackendClient(options: CreateTsBackendOptions): TsBackendClient {
	const pluginProbeLocation = resolveVueTypescriptPluginProbeLocation();
	const tsBackendCore = createTypeScriptBackendClient({
		...options,
		tsserverGlobalPlugins: ['@vue/typescript-plugin'],
		tsserverPluginProbeLocations: pluginProbeLocation ? [pluginProbeLocation] : undefined,
	});
	const client = new VueTsBackendClient(tsBackendCore, options.ts);
	return bindClientMethods(client);
}

class VueTsBackendClient implements TsBackendClient {
	get mode() {
		return this.core.mode;
	}

	constructor(
		private readonly core: TypeScriptBackendClient,
		private readonly ts: typeof import('typescript'),
	) {}

	async warmup() {
		await this.core.warmup();
	}

	async awaitReadyForHover(timeoutMs: number) {
		return await this.core.awaitReadyForHover(timeoutMs);
	}

	async getProjectInfo(fileName: string) {
		return await this.core.getProjectInfo(fileName);
	}

	notifyHoverRequested() {
		this.core.notifyHoverRequested();
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

	async resolveModuleName(fileName: string, moduleName: string): Promise<RequestValue<'resolveModuleName'>> {
		if (isTsgoSupportedFile(fileName)) {
			const resolvedByTsgo = await this.core.resolveModuleName(fileName, moduleName);
			if (resolvedByTsgo) {
				return resolvedByTsgo;
			}
		}
		return await this.sendTsServerRequest<RequestValue<'resolveModuleName'>>(
			'_vue:resolveModuleName',
			[fileName, moduleName],
		) ?? undefined;
	}

	async getDocumentHighlights(fileName: string, position: number): Promise<RequestValue<'getDocumentHighlights'>> {
		if (isTsgoSupportedFile(fileName)) {
			const result = await this.core.getDocumentHighlights(fileName, position);
			if (result) {
				return result;
			}
		}
		return await this.sendTsServerRequest<RequestValue<'getDocumentHighlights'>>(
			'_vue:documentHighlights-full',
			{
				file: fileName,
				...{ position } as unknown as { line: number; offset: number },
				filesToSearch: [fileName],
			} satisfies ts.server.protocol.DocumentHighlightsRequestArgs,
		) ?? undefined;
	}

	async getEncodedSemanticClassifications(
		fileName: string,
		span: ts.TextSpan,
	): Promise<RequestValue<'getEncodedSemanticClassifications'>> {
		return await this.sendTsServerRequest<RequestValue<'getEncodedSemanticClassifications'>>(
			'_vue:encodedSemanticClassifications-full',
			{
				file: fileName,
				...span,
				format: this.ts.SemanticClassificationFormat.TwentyTwenty,
			} satisfies ts.server.protocol.EncodedSemanticClassificationsRequestArgs,
		) ?? undefined;
	}

	async getQuickInfoAtPosition(
		fileName: string,
		position: ts.LineAndCharacter,
	): Promise<RequestValue<'getQuickInfoAtPosition'>> {
		const quickInfoByCore = await this.core.getQuickInfoAtPosition(fileName, position);
		if (quickInfoByCore) {
			return quickInfoByCore;
		}
		const fallbackQuickInfo = await this.sendTsServerRequest<ts.server.protocol.QuickInfoResponseBody>(
			'_vue:' + this.ts.server.protocol.CommandTypes.Quickinfo,
			{
				file: fileName,
				line: position.line + 1,
				offset: position.character + 1,
			} satisfies ts.server.protocol.FileLocationRequestArgs,
		);
		return fallbackQuickInfo?.displayString;
	}

	async dispose() {
		await this.core.dispose();
	}

	private sendVueRequest<K extends RequestMethodKey>(
		_method: K,
		command: string,
		args: Parameters<NonNullable<Requests[K]>>,
	): RequestReturn<K> {
		return this.sendTsServerRequest<RequestValue<K>>(command, args) as RequestReturn<K>;
	}

	private async sendTsServerRequest<T>(command: string, args: any): Promise<T | null> {
		return await this.core.sendTsServerRequest<T>(command, args);
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

function resolveVueTypescriptPluginProbeLocation() {
	try {
		return path.dirname(require.resolve('@vue/typescript-plugin/package.json'));
	}
	catch {
		return undefined;
	}
}
