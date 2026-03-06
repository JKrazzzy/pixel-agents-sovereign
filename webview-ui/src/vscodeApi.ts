declare global {
	function acquireVsCodeApi(): { postMessage(msg: unknown): void }
}

const globalObject = globalThis as typeof globalThis & {
	acquireVsCodeApi?: () => { postMessage(msg: unknown): void }
}

export const IS_VSCODE_API_AVAILABLE = typeof globalObject.acquireVsCodeApi === 'function'

const browserFallbackApi = {
	postMessage(msg: unknown): void {
		// Browser-hosted builds have no extension bridge; keep calls safe and traceable.
		console.debug('[PixelAgents] VS Code API unavailable, dropping message:', msg)
	},
}

export const vscode = IS_VSCODE_API_AVAILABLE && globalObject.acquireVsCodeApi
	? globalObject.acquireVsCodeApi()
	: browserFallbackApi
