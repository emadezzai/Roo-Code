declare module "chrome-launcher" {
	export interface Options {
		startingUrl?: string
		startPage?: string
		port?: number
		chromePath?: string
		enableExtensions?: boolean
		verbose?: boolean
		ignoreDefaultFlags?: boolean
		killOnParentExit?: boolean
		envVars?: { [key: string]: string }
		handleSIGINT?: boolean
		handleSIGTERM?: boolean
		handleSIGHUP?: boolean
		outputPath?: string
		chromeFlags?: string[]
		logLevel?: "verbose" | "error" | "silent"
		prefs?: Record<string, unknown>
	}

	export interface LaunchedChrome {
		pid: number
		port: number
		process: {
			pid: number
			kill: (signal?: string) => boolean
			on: (event: string, callback: () => void) => void
		}
		kill: () => Promise<void>
	}

	export function launch(options?: Options): Promise<LaunchedChrome>

	export function killAll(): Promise<void>

	export function getChromePath(): string

	export function getChromeExecutablePath(): Promise<string>

	export class Launcher {
		constructor(opts?: Options)
		launch(): Promise<LaunchedChrome>
		kill(): Promise<void>
		getFlags(): string[]
		static getChromePath(): string
		static getChromeExecutablePath(): Promise<string>
		static defaultFlags(): string[]
		static getFirstInstallation(): Promise<string>
	}
}
