import type { Hover, LanguageServicePlugin, MarkupContent } from '@volar/language-service';
import { resolveEmbeddedCode } from '../utils';

export function create(
	{ getQuickInfoAtPosition }: import('@vue/typescript-plugin/lib/requests').Requests,
): LanguageServicePlugin {
	return {
		name: 'vue-script-hover',
		capabilities: {
			hoverProvider: true,
		},
		create(context) {
			return {
				async provideHover(document, position) {
					const info = resolveEmbeddedCode(context, document.uri);
					if (!info?.code.id.startsWith('script_')) {
						return;
					}

					const sourceDocument = context.documents.get(info.script.id, info.script.languageId, info.script.snapshot);
					const map = context.language.maps.get(info.code, info.script);
					const offset = document.offsetAt(position);

					for (const [sourceOffset] of map.toSourceLocation(offset)) {
						const quickInfo = await getQuickInfoAtPosition(
							info.root.fileName,
							sourceDocument.positionAt(sourceOffset),
						);
						if (quickInfo) {
							return quickInfoToHover(quickInfo);
						}
					}
				},
			};
		},
	};
}

function quickInfoToHover(quickInfo: string): Hover {
	return {
		contents: {
			kind: 'markdown',
			value: `\`\`\`ts\n${quickInfo}\n\`\`\``,
		} satisfies MarkupContent,
	};
}
