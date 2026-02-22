import * as chromeLauncher from "chrome-launcher"
import { type Browser, connect, type Page } from "puppeteer-core"
import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider"

/**
 * ElementPickerBrowser opens a real Chrome browser window with an injected
 * element picker overlay. Users browse normally, pick elements, and send
 * them to the Roo Code chat.
 *
 * Features:
 * - Element picking with CSS/XPath selectors
 * - Element screenshots
 * - Action recording (clicks, form changes)
 * - Design mode (contentEditable)
 * - Style editor with CSS property editing
 * - Theme testing (light/dark mode)
 * - Full page screenshots
 * - Console output viewer
 * - Network traffic viewer
 */
export class ElementPickerBrowser {
	public static instance: ElementPickerBrowser | undefined
	private browser: Browser | undefined
	public page: Page | undefined
	private chromeProcess: chromeLauncher.LaunchedChrome | undefined
	private statusBarItem: vscode.StatusBarItem | undefined
	private capturedErrors: string[] = []
	private failedNetworkRequests: string[] = []
	private consoleLogs: string[] = []
	private networkRequests: string[] = []

	public static async launch() {
		// If already running, focus it
		if (ElementPickerBrowser.instance?.browser?.connected) {
			try {
				const page = ElementPickerBrowser.instance.page
				if (page) {
					await page.bringToFront()
				}
				return
			} catch {
				await ElementPickerBrowser.instance.dispose()
			}
		}

		const inst = new ElementPickerBrowser()
		ElementPickerBrowser.instance = inst

		try {
			await inst.start()
		} catch (error) {
			console.error("Failed to launch element picker browser:", error)
			vscode.window.showErrorMessage(
				`Failed to launch browser: ${error instanceof Error ? error.message : String(error)}`,
			)
			await inst.dispose()
		}
	}

	private async start() {
		const chromePath = await this.findChrome()
		if (!chromePath) {
			throw new Error("Could not find Chrome installation")
		}

		// Launch Chrome (non-headless) with remote debugging
		this.chromeProcess = await chromeLauncher.launch({
			chromePath,
			chromeFlags: ["--no-first-run", "--no-default-browser-check", "--window-size=1280,900"],
			startingUrl: "about:blank",
		})

		console.log(`Chrome launched on port ${this.chromeProcess.port}`)

		// Connect puppeteer to the launched Chrome via debugging port
		this.browser = await connect({
			browserURL: `http://localhost:${this.chromeProcess.port}`,
			defaultViewport: null,
		})

		// Get the blank page
		const pages = await this.browser.pages()
		this.page = pages[0] || (await this.browser.newPage())

		// Setup element picker on this page
		await this.setupPage(this.page)

		// Navigate to browser default URL or fallback to Google
		const provider = ClineProvider.getVisibleInstance()
		const state = provider ? await provider.getState() : undefined
		const startUrl = state?.browserDefaultUrl || "https://www.google.com"

		await this.page.goto(startUrl, { waitUntil: "domcontentloaded" })

		// Setup new tabs automatically
		this.browser.on("targetcreated", async (target) => {
			if (target.type() === "page") {
				try {
					const newPage = await target.page()
					if (newPage) {
						await this.setupPage(newPage)
						this.page = newPage
					}
				} catch (err) {
					console.error("Failed to setup new page:", err)
				}
			}
		})

		// Handle browser close
		this.browser.on("disconnected", () => {
			this.dispose()
		})

		this.showStatusBar()

		vscode.window.showInformationMessage(
			"Roo Code Element Picker is active! Use the 🎯 button in the browser to pick elements.",
		)
	}

	/**
	 * Setup a page: expose the callback function and auto-inject picker script
	 */
	private async setupPage(page: Page): Promise<void> {
		// Expose callback for sending elements to Roo Code
		try {
			await page.exposeFunction("__clineSendElements", async (json: string) => {
				try {
					const payload = JSON.parse(json) as {
						elements: Array<{
							selector: string
							xpath: string
							html: string
							tagName: string
							componentName?: string
							sourceFile?: string
						}>
						actions: string[]
						designEdits?: Array<{ selector: string; text: string; html: string }>
						styleEdits?: Array<{ selector: string; css: string }>
						addedCssRules?: string[]
						applyToCode?: boolean
						consoleLogs?: string[]
						networkRequests?: string[]
					}
					await this.sendElementsToChat(
						payload.elements,
						payload.actions,
						payload.designEdits || [],
						payload.styleEdits || [],
						payload.addedCssRules || [],
						payload.applyToCode || false,
						payload.consoleLogs || [],
						payload.networkRequests || [],
					)
				} catch (e) {
					console.error("Failed to handle elements:", e)
				}
			})
		} catch {
			// Already exposed on this page
		}

		// Expose callback for screenshots
		try {
			await page.exposeFunction("__clineRequestScreenshot", async () => {
				await this.takeFullPageScreenshot()
			})
		} catch {
			// Already exposed
		}

		// Expose callback for console logs
		try {
			await page.exposeFunction("__clineGetConsoleLogs", async () => {
				return this.consoleLogs.join("\n")
			})
		} catch {
			// Already exposed
		}

		// Expose callback for network requests
		try {
			await page.exposeFunction("__clineGetNetworkRequests", async () => {
				return this.networkRequests.join("\n")
			})
		} catch {
			// Already exposed
		}

		// Listen to console events
		page.on("console", (msg) => {
			const type = msg.type()
			const text = msg.text()
			const timestamp = new Date().toISOString().substr(11, 12)
			this.consoleLogs.push(`[${type.toUpperCase()}] ${timestamp}: ${text}`)
			// Keep last 500 logs
			if (this.consoleLogs.length > 500) {
				this.consoleLogs.shift()
			}
		})

		// Listen to page errors
		page.on("pageerror", (error) => {
			this.capturedErrors.push(error.message)
			this.consoleLogs.push(`[ERROR] ${error.message}`)
		})

		// Listen to request failures
		page.on("requestfailed", (request) => {
			this.failedNetworkRequests.push(`${request.method()} ${request.url()} - ${request.failure()?.errorText}`)
			this.networkRequests.push(`[FAILED] ${request.method()} ${request.url()}`)
		})

		// Listen to network requests
		page.on("request", (request) => {
			const timestamp = new Date().toISOString().substr(11, 12)
			this.networkRequests.push(`[${timestamp}] ${request.method()} ${request.url()}`)
			// Keep last 200 requests
			if (this.networkRequests.length > 200) {
				this.networkRequests.shift()
			}
		})

		// Listen to responses
		page.on("response", (response) => {
			const status = response.status()
			if (status >= 400) {
				this.networkRequests.push(`[HTTP ${status}] ${response.url()}`)
			}
		})

		// Inject the picker script on navigation
		page.on("framenavigated", async (frame) => {
			if (frame === page.mainFrame()) {
				try {
					await this.injectPickerScript(page)
				} catch {
					// Page might not be ready
				}
			}
		})

		// Initial injection
		try {
			await this.injectPickerScript(page)
		} catch {
			// Page might not be ready
		}
	}

	/**
	 * Inject the element picker toolbar and scripts
	 */
	private async injectPickerScript(page: Page): Promise<void> {
		await page.evaluate(() => {
			// Avoid duplicate injection
			if (document.getElementById("roo-pick-element-toolbar-root")) {
				return
			}

			// CSS Styles for the toolbar
			const style = document.createElement("style")
			style.id = "roo-element-picker-styles"
			style.textContent = `
				/* Element Picker Toolbar Styles */
				.roo-bar {
					position: fixed;
					bottom: 0;
					left: 0;
					right: 0;
					height: 44px;
					background: linear-gradient(180deg, #1e1e2e 0%, #11111a 100%);
					border-top: 1px solid rgba(255,255,255,0.1);
					display: flex;
					align-items: center;
					justify-content: space-between;
					padding: 0 12px;
					z-index: 2147483647;
					font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
					box-shadow: 0 -4px 20px rgba(0,0,0,0.3);
				}
				.roo-bar.minimized { height: 32px; padding: 0 8px; }
				.roo-bar.minimized .roo-center,
				.roo-bar.minimized .roo-left button:not(.roo-btn-pick),
				.roo-bar.minimized .roo-right { display: none; }
				.roo-left { display: flex; align-items: center; gap: 6px; }
				.roo-center { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; overflow: hidden; padding: 0 12px; }
				.roo-right { display: flex; align-items: center; gap: 6px; }
				.roo-brand { font-size: 12px; font-weight: 600; color: #FF9800; margin-right: 8px; }
				.roo-btn {
					padding: 6px 10px;
					border: none;
					border-radius: 6px;
					cursor: pointer;
					font-size: 11px;
					font-weight: 600;
					background: rgba(255,255,255,0.1);
					color: #fff;
					transition: all 0.15s;
					display: flex;
					align-items: center;
					gap: 4px;
				}
				.roo-btn:hover { background: rgba(255,255,255,0.2); }
				.roo-btn.active { background: #FF9800; color: #000; }
				.roo-btn-pick.active { background: #4CAF50; color: #fff; }
				.roo-btn-record.active { background: #f44336; }
				.roo-btn-design.active { background: #9C27B0; }
				.roo-btn-style.active { background: #E91E63; }
				.roo-btn:disabled { opacity: 0.4; cursor: not-allowed; }
				.roo-btn-send { background: #4CAF50; }
				.roo-btn-send:hover:not(:disabled) { background: #66BB6A; }
				.roo-btn-clear { background: #f44336; }
				.roo-btn-clear:hover { background: #ef5350; }
				.roo-min {
					position: absolute;
					right: 8px;
					top: 8px;
					width: 20px;
					height: 20px;
					border: none;
					background: transparent;
					color: #888;
					cursor: pointer;
					font-size: 12px;
					border-radius: 4px;
				}
				.roo-min:hover { background: rgba(255,255,255,0.1); color: #fff; }
				.roo-tag {
					padding: 4px 8px;
					border-radius: 4px;
					font-size: 10px;
					font-weight: 500;
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
					max-width: 120px;
				}
				.roo-tag.element { background: rgba(76,175,80,0.2); color: #81C784; }
				.roo-tag.action { background: rgba(244,67,54,0.2); color: #E57373; }
				.roo-tag.design { background: rgba(156,39,176,0.2); color: #CE93D8; }
				.roo-tag.style { background: rgba(233,30,99,0.2); color: #F48FB1; }
				.roo-tag-x {
					margin-left: 4px;
					cursor: pointer;
					opacity: 0.6;
				}
				.roo-tag-x:hover { opacity: 1; }
				.roo-count { font-size: 11px; color: #888; }
				.roo-hover { outline: 2px solid #FF9800 !important; outline-offset: 2px !important; background-color: rgba(255,152,0,0.1) !important; }
				.roo-selected { outline: 2px solid #4CAF50 !important; outline-offset: 2px !important; background-color: rgba(76,175,80,0.1) !important; }
				
				/* Inspector Panel */
				.roo-inspector {
					position: fixed;
					top: 80px;
					right: 20px;
					width: 320px;
					max-height: 70vh;
					background: #1e1e2e;
					border: 1px solid rgba(255,255,255,0.1);
					border-radius: 12px;
					z-index: 2147483646;
					display: none;
					flex-direction: column;
					box-shadow: 0 8px 32px rgba(0,0,0,0.4);
					font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
				}
				.roo-inspector.active { display: flex; }
				.roo-inspector-header {
					padding: 12px 16px;
					border-bottom: 1px solid rgba(255,255,255,0.1);
					display: flex;
					justify-content: space-between;
					align-items: center;
					font-size: 13px;
					font-weight: 600;
					color: #fff;
				}
				.roo-inspector-header .close-btn {
					cursor: pointer;
					opacity: 0.6;
					font-size: 14px;
				}
				.roo-inspector-header .close-btn:hover { opacity: 1; }
				.roo-inspector-body {
					flex: 1;
					overflow-y: auto;
					padding: 12px;
				}
				.roo-inspector-target {
					padding: 8px;
					background: rgba(0,0,0,0.2);
					border-radius: 6px;
					font-family: monospace;
					font-size: 11px;
					color: #81C784;
					margin-bottom: 12px;
					word-break: break-all;
				}
				.roo-prop-group { margin-bottom: 12px; }
				.roo-prop-group label {
					display: block;
					font-size: 10px;
					color: #888;
					text-transform: uppercase;
					margin-bottom: 6px;
					letter-spacing: 0.5px;
				}
				.roo-prop-row {
					display: flex;
					gap: 6px;
					margin-bottom: 4px;
				}
				.roo-prop-row input {
					flex: 1;
					padding: 6px 8px;
					border: 1px solid rgba(255,255,255,0.1);
					border-radius: 4px;
					background: #11111a;
					color: #fff;
					font-size: 11px;
					font-family: monospace;
				}
				.roo-prop-row input:focus {
					outline: none;
					border-color: #FF9800;
				}
				.roo-panel-btn {
					padding: 6px 12px;
					border: none;
					border-radius: 4px;
					cursor: pointer;
					font-size: 11px;
					font-weight: 600;
					background: rgba(255,255,255,0.1);
					color: #fff;
					transition: all 0.15s;
				}
				.roo-panel-btn:hover { background: rgba(255,255,255,0.2); }
				.roo-panel-btn.primary { background: #FF9800; }
				.roo-panel-btn.primary:hover { background: #FFB74D; }

				/* Console Panel */
				.roo-console-panel {
					position: fixed;
					bottom: 44px;
					left: 0;
					right: 0;
					height: 200px;
					background: #11111a;
					border-top: 1px solid rgba(255,255,255,0.1);
					display: none;
					flex-direction: column;
					z-index: 2147483646;
				}
				.roo-console-panel.active { display: flex; }
				.roo-console-header {
					padding: 8px 12px;
					border-bottom: 1px solid rgba(255,255,255,0.1);
					display: flex;
					justify-content: space-between;
					align-items: center;
					font-size: 11px;
					font-weight: 600;
					color: #888;
				}
				.roo-console-body {
					flex: 1;
					overflow-y: auto;
					padding: 8px;
					font-family: monospace;
					font-size: 11px;
					color: #fff;
					white-space: pre-wrap;
				}
				.roo-console-body .error { color: #f44336; }
				.roo-console-body .warn { color: #FF9800; }
				.roo-console-body .info { color: #2196F3; }
				.roo-console-body .log { color: #fff; }

				/* Network Panel */
				.roo-network-panel {
					position: fixed;
					bottom: 44px;
					left: 0;
					right: 0;
					height: 200px;
					background: #11111a;
					border-top: 1px solid rgba(255,255,255,0.1);
					display: none;
					flex-direction: column;
					z-index: 2147483646;
				}
				.roo-network-panel.active { display: flex; }
				.roo-network-header {
					padding: 8px 12px;
					border-bottom: 1px solid rgba(255,255,255,0.1);
					display: flex;
					justify-content: space-between;
					align-items: center;
					font-size: 11px;
					font-weight: 600;
					color: #888;
				}
				.roo-network-body {
					flex: 1;
					overflow-y: auto;
					padding: 8px;
					font-family: monospace;
					font-size: 11px;
					color: #fff;
					white-space: pre-wrap;
				}

				/* Add CSS Rule Section */
				.roo-add-rule {
					padding: 12px;
					background: rgba(0,0,0,0.2);
					border-radius: 8px;
					margin-top: 12px;
				}
				.roo-add-rule-header {
					font-size: 11px;
					color: #888;
					margin-bottom: 8px;
					text-transform: uppercase;
					letter-spacing: 0.5px;
				}
				.roo-add-rule textarea {
					width: 100%;
					height: 80px;
					background: #11111a;
					border: 1px solid rgba(255,255,255,0.1);
					color: #fff;
					padding: 8px;
					border-radius: 6px;
					font-family: ui-monospace, monospace;
					font-size: 11px;
					resize: vertical;
				}
				.roo-add-rule textarea:focus { outline: none; border-color: #FF9800; }
				.roo-add-rule textarea::placeholder { color: #555; }
				.roo-btn-add-rule {
					margin-top: 8px;
					padding: 6px 12px;
					border: none;
					border-radius: 4px;
					cursor: pointer;
					font-size: 11px;
					font-weight: 600;
					background: #4CAF50;
					color: #fff;
				}
				.roo-btn-add-rule:hover { background: #66BB6A; }

				/* Apply to Code Button */
				.roo-btn-apply {
					width: 100%;
					padding: 10px;
					border: none;
					border-radius: 6px;
					cursor: pointer;
					font-size: 13px;
					font-weight: 600;
					background: linear-gradient(135deg, #4CAF50, #388E3C);
					color: #fff;
					transition: all 0.2s;
					box-shadow: 0 4px 12px rgba(76,175,80,0.3);
					margin-top: 8px;
					display: flex;
					justify-content: center;
					align-items: center;
					gap: 6px;
				}
				.roo-btn-apply:hover { background: linear-gradient(135deg, #66BB6A, #4CAF50); transform: translateY(-1px); }
			`
			document.head.appendChild(style)

			// Create toolbar root
			const root = document.createElement("div")
			root.id = "roo-pick-element-toolbar-root"
			root.innerHTML = `
				<div class="roo-bar" id="bar">
					<div class="roo-left">
						<span class="roo-brand">🎯 Roo Code</span>
						<button class="roo-btn roo-btn-pick" id="pickBtn">Pick</button>
						<button class="roo-btn roo-btn-record" id="recordBtn">⏺ Record</button>
						<button class="roo-btn roo-btn-design" id="designBtn">🎨 Design</button>
						<button class="roo-btn roo-btn-style" id="styleBtn">💅 Style</button>
						<button class="roo-btn roo-btn-theme" id="themeBtn" title="Toggle Dark/Light Mode">🌓 Theme</button>
						<button class="roo-btn roo-btn-screenshot" id="screenshotBtn" title="Full Page Screenshot">📷 Shot</button>
						<button class="roo-btn roo-btn-console" id="consoleBtn" title="View Console Logs">📋 Logs</button>
						<button class="roo-btn roo-btn-network" id="networkBtn" title="View Network Traffic">🌐 Net</button>
					</div>
					<div class="roo-center" id="tags">
						<span class="roo-count">Click a button to start</span>
					</div>
					<div class="roo-right">
						<button class="roo-btn roo-btn-clear" id="clearBtn" style="display:none">Clear</button>
						<button class="roo-btn roo-btn-send" id="sendBtn" disabled>Send to Chat</button>
					</div>
					<button class="roo-min" id="minBtn" title="Minimize">▾</button>
				</div>

				<!-- Style Editor Inspector Overlay -->
				<div class="roo-inspector" id="cssInspector">
					<div class="roo-inspector-header" id="inspectorHeader">
						<div class="roo-inspector-drag-handle" id="inspectorDragHandle">⋮⋮</div>
						<span class="close-btn" id="inspectorClose" title="Close">✕</span>
						CSS Editor
					</div>
					<div class="roo-inspector-body">
						<div class="roo-inspector-target" id="inspectorTarget">No element selected</div>
						
						<!-- Tabs -->
						<div class="roo-inspector-tabs">
							<button class="roo-tab active" data-tab="layout">Layout</button>
							<button class="roo-tab" data-tab="typography">Typography</button>
							<button class="roo-tab" data-tab="appearance">Appearance</button>
							<button class="roo-tab" data-tab="advanced">Advanced</button>
						</div>
						
						<!-- Layout Tab -->
						<div class="roo-tab-content active" data-tab="layout">
							<div class="roo-prop-group">
								<label>Dimensions</label>
								<div class="roo-prop-row">
									<input type="text" id="prop-width" placeholder="Width" title="Width (px, %, rem, etc.)" />
									<input type="text" id="prop-height" placeholder="Height" title="Height" />
								</div>
								<div class="roo-prop-row">
									<input type="text" id="prop-min-width" placeholder="Min W" title="Min Width" />
									<input type="text" id="prop-max-width" placeholder="Max W" title="Max Width" />
								</div>
								<div class="roo-prop-row">
									<input type="text" id="prop-min-height" placeholder="Min H" title="Min Height" />
									<input type="text" id="prop-max-height" placeholder="Max H" title="Max Height" />
								</div>
							</div>
							<div class="roo-prop-group">
								<label>Spacing</label>
								<div class="roo-prop-row">
									<input type="text" id="prop-margin" placeholder="Margin (T R B L)" title="Margin: top right bottom left" />
									<input type="text" id="prop-padding" placeholder="Padding" title="Padding" />
								</div>
							</div>
							<div class="roo-prop-group">
								<label>Layout</label>
								<div class="roo-prop-row">
									<select id="prop-display" title="Display">
										<option value="">Display</option>
										<option value="block">block</option>
										<option value="inline">inline</option>
										<option value="inline-block">inline-block</option>
										<option value="flex">flex</option>
										<option value="grid">grid</option>
										<option value="none">none</option>
										<option value="contents">contents</option>
										<option value="table">table</option>
									</select>
									<select id="prop-position" title="Position">
										<option value="">Position</option>
										<option value="static">static</option>
										<option value="relative">relative</option>
										<option value="absolute">absolute</option>
										<option value="fixed">fixed</option>
										<option value="sticky">sticky</option>
									</select>
								</div>
								<div class="roo-prop-row">
									<input type="text" id="prop-top" placeholder="Top" title="Top" />
									<input type="text" id="prop-right" placeholder="Right" title="Right" />
									<input type="text" id="prop-bottom" placeholder="Bottom" title="Bottom" />
									<input type="text" id="prop-left" placeholder="Left" title="Left" />
								</div>
								<div class="roo-prop-row">
									<input type="text" id="prop-z-index" placeholder="Z-Index" title="Z-Index" />
									<input type="text" id="prop-flex" placeholder="Flex" title="Flex shorthand" />
									<input type="text" id="prop-gap" placeholder="Gap" title="Gap" />
								</div>
							</div>
							<div class="roo-prop-group">
								<label>Overflow</label>
								<div class="roo-prop-row">
									<select id="prop-overflow" title="Overflow">
										<option value="">Overflow</option>
										<option value="visible">visible</option>
										<option value="hidden">hidden</option>
										<option value="scroll">scroll</option>
										<option value="auto">auto</option>
									</select>
									<select id="prop-overflow-x" title="Overflow X">
										<option value="">Overflow X</option>
										<option value="visible">visible</option>
										<option value="hidden">hidden</option>
										<option value="scroll">scroll</option>
										<option value="auto">auto</option>
									</select>
									<select id="prop-overflow-y" title="Overflow Y">
										<option value="">Overflow Y</option>
										<option value="visible">visible</option>
										<option value="hidden">hidden</option>
										<option value="scroll">scroll</option>
										<option value="auto">auto</option>
									</select>
								</div>
							</div>
						</div>
						
						<!-- Typography Tab -->
						<div class="roo-tab-content" data-tab="typography">
							<div class="roo-prop-group">
								<label>Font</label>
								<div class="roo-prop-row">
									<input type="text" id="prop-font-family" placeholder="Font Family" title="Font Family" />
									<input type="text" id="prop-font-size" placeholder="Font Size" title="Font Size" />
								</div>
								<div class="roo-prop-row">
									<select id="prop-font-weight" title="Font Weight">
										<option value="">Weight</option>
										<option value="100">100 Thin</option>
										<option value="200">200 Extra Light</option>
										<option value="300">300 Light</option>
										<option value="400">400 Normal</option>
										<option value="500">500 Medium</option>
										<option value="600">600 Semi Bold</option>
										<option value="700">700 Bold</option>
										<option value="800">800 Extra Bold</option>
										<option value="900">900 Black</option>
									</select>
									<select id="prop-font-style" title="Font Style">
										<option value="">Style</option>
										<option value="normal">normal</option>
										<option value="italic">italic</option>
										<option value="oblique">oblique</option>
									</select>
								</div>
							</div>
							<div class="roo-prop-group">
								<label>Text Styling</label>
								<div class="roo-prop-row">
									<input type="text" id="prop-line-height" placeholder="Line Height" title="Line Height" />
									<input type="text" id="prop-letter-spacing" placeholder="Letter Spacing" title="Letter Spacing" />
								</div>
								<div class="roo-prop-row">
									<input type="text" id="prop-text-align" placeholder="Align" title="Text Align" />
									<select id="prop-text-transform" title="Text Transform">
										<option value="">Transform</option>
										<option value="none">none</option>
										<option value="capitalize">capitalize</option>
										<option value="uppercase">uppercase</option>
										<option value="lowercase">lowercase</option>
									</select>
								</div>
								<div class="roo-prop-row">
									<select id="prop-text-decoration" title="Text Decoration">
										<option value="">Decoration</option>
										<option value="none">none</option>
										<option value="underline">underline</option>
										<option value="line-through">line-through</option>
										<option value="overline">overline</option>
									</select>
									<input type="color" id="prop-color" placeholder="Color" title="Text Color" />
								</div>
							</div>
						</div>
						
						<!-- Appearance Tab -->
						<div class="roo-tab-content" data-tab="appearance">
							<div class="roo-prop-group">
								<label>Background</label>
								<div class="roo-prop-row">
									<input type="color" id="prop-background-color" placeholder="BG Color" title="Background Color" />
									<input type="text" id="prop-background-image" placeholder="Image URL" title="Background Image URL" />
								</div>
								<div class="roo-prop-row">
									<select id="prop-background-size" title="Background Size">
										<option value="">Size</option>
										<option value="auto">auto</option>
										<option value="cover">cover</option>
										<option value="contain">contain</option>
									</select>
									<select id="prop-background-position" title="Background Position">
										<option value="">Position</option>
										<option value="center">center</option>
										<option value="top">top</option>
										<option value="bottom">bottom</option>
										<option value="left">left</option>
										<option value="right">right</option>
									</select>
								</div>
							</div>
							<div class="roo-prop-group">
								<label>Border & Shadow</label>
								<div class="roo-prop-row">
									<input type="text" id="prop-border" placeholder="Border" title="Border shorthand" />
									<input type="text" id="prop-border-radius" placeholder="Radius" title="Border Radius" />
								</div>
								<div class="roo-prop-row">
									<input type="color" id="prop-border-color" placeholder="Border Color" title="Border Color" />
									<input type="text" id="prop-box-shadow" placeholder="Box Shadow" title="Box Shadow" />
								</div>
							</div>
							<div class="roo-prop-group">
								<label>Opacity & Visibility</label>
								<div class="roo-prop-row">
									<input type="range" id="prop-opacity" min="0" max="1" step="0.01" placeholder="Opacity" title="Opacity" />
									<select id="prop-visibility" title="Visibility">
										<option value="">Visibility</option>
										<option value="visible">visible</option>
										<option value="hidden">hidden</option>
										<option value="collapse">collapse</option>
									</select>
								</div>
								<div class="roo-prop-row">
									<input type="text" id="prop-cursor" placeholder="Cursor" title="Cursor type" />
								</div>
							</div>
						</div>
						
						<!-- Advanced Tab -->
						<div class="roo-tab-content" data-tab="advanced">
							<div class="roo-prop-group">
								<label>Transform</label>
								<div class="roo-prop-row">
									<input type="text" id="prop-transform" placeholder="Transform" title="Transform: rotate, scale, translate, skew" />
								</div>
								<div class="roo-prop-row">
									<input type="text" id="prop-transform-origin" placeholder="Origin" title="Transform Origin" />
									<input type="text" id="prop-perspective" placeholder="Perspective" title="Perspective" />
								</div>
							</div>
							<div class="roo-prop-group">
								<label>Animation & Transition</label>
								<div class="roo-prop-row">
									<input type="text" id="prop-transition" placeholder="Transition" title="Transition: property duration timing-function" />
								</div>
								<div class="roo-prop-row">
									<input type="text" id="prop-animation" placeholder="Animation" title="Animation: name duration timing-function" />
									<input type="text" id="prop-animation-delay" placeholder="Delay" title="Animation Delay" />
								</div>
							</div>
							<div class="roo-prop-group">
								<label>Grid & Flex</label>
								<div class="roo-prop-row">
									<input type="text" id="prop-grid-template" placeholder="Grid Template" title="Grid Template Columns/Rows" />
								</div>
								<div class="roo-prop-row">
									<select id="prop-justify-content" title="Justify Content">
										<option value="">Justify Content</option>
										<option value="flex-start">flex-start</option>
										<option value="flex-end">flex-end</option>
										<option value="center">center</option>
										<option value="space-between">space-between</option>
										<option value="space-around">space-around</option>
										<option value="space-evenly">space-evenly</option>
									</select>
									<select id="prop-align-items" title="Align Items">
										<option value="">Align Items</option>
										<option value="flex-start">flex-start</option>
										<option value="flex-end">flex-end</option>
										<option value="center">center</option>
										<option value="stretch">stretch</option>
										<option value="baseline">baseline</option>
									</select>
								</div>
								<div class="roo-prop-row">
									<input type="text" id="prop-align-self" placeholder="Align Self" title="Align Self" />
								</div>
							</div>
							<div class="roo-prop-group">
								<label>Filter & Effects</label>
								<div class="roo-prop-row">
									<input type="text" id="prop-filter" placeholder="Filter" title="Filter: blur, brightness, contrast, etc." />
								</div>
								<div class="roo-prop-row">
									<input type="text" id="prop-backdrop-filter" placeholder="Backdrop Filter" title="Backdrop Filter" />
								</div>
							</div>
						</div>
						
						<button class="roo-panel-btn primary" id="inspectorSendBtn">Apply & Send</button>
						<div class="roo-add-rule">
							<div class="roo-add-rule-header">Add New CSS Rule</div>
							<textarea id="newCssRule" placeholder="selector { property: value; }"></textarea>
							<button class="roo-btn-add-rule" id="addRuleBtn">Add Rule</button>
						</div>
						<button class="roo-btn-apply" id="applyToCodeBtn">📝 Apply to Code</button>
					</div>
				</div>

				<!-- Console Panel -->
				<div class="roo-console-panel" id="consolePanel">
					<div class="roo-console-header">
						<span>Console Output</span>
						<div style="display: flex; gap: 8px; align-items: center;">
							<button class="roo-btn roo-btn-sm" id="consoleSendBtn" title="Send to Chat">📤 Send</button>
							<span class="close-btn" id="consoleClose">✕</span>
						</div>
					</div>
					<div class="roo-console-body" id="consoleBody">No console output yet.</div>
				</div>

				<!-- Network Panel -->
				<div class="roo-network-panel" id="networkPanel">
					<div class="roo-network-header">
						<span>Network Traffic</span>
						<div style="display: flex; gap: 8px; align-items: center;">
							<button class="roo-btn roo-btn-sm" id="networkSendBtn" title="Send to Chat">📤 Send</button>
							<span class="close-btn" id="networkClose">✕</span>
						</div>
					</div>
					<div class="roo-network-body" id="networkBody">No network traffic yet.</div>
				</div>
			`
			document.body.appendChild(root)

			// State
			let pickerOn = false
			let recordingOn = false
			let designOn = false
			let stylingOn = false
			let isDarkMode = false
			let selected: Array<{ selector: string; xpath: string; html: string; tagName: string }> = []
			let hovered: HTMLElement | null = null
			let isMin = false
			let recordedActions: string[] = []
			let designEdits: Array<{ selector: string; text: string; html: string }> = []
			let styleEdits: Array<{ selector: string; css: string }> = []
			let addedCssRules: string[] = []
			let currentStylingElement: HTMLElement | null = null
			let applyToCode = false

			// Load saved state
			function loadState() {
				try {
					const saved = localStorage.getItem("roo-picker-state")
					if (saved) {
						const state = JSON.parse(saved)
						selected = state.selected || []
						recordedActions = state.recordedActions || []
						designEdits = state.designEdits || []
						styleEdits = state.styleEdits || []
						addedCssRules = state.addedCssRules || []
						// Re-apply selected class
						selected.forEach((selObj) => {
							try {
								const el = document.querySelector(selObj.selector)
								if (el) el.classList.add("roo-selected")
							} catch {}
						})
						refreshUI()
					}
				} catch {}
			}

			function saveState() {
				try {
					localStorage.setItem(
						"roo-picker-state",
						JSON.stringify({ selected, recordedActions, designEdits, styleEdits, addedCssRules }),
					)
				} catch {}
			}

			// Helper: Generate CSS selector
			function cssPath(el: Element): string {
				if (el.id && !el.id.includes(" ") && !el.id.startsWith("_")) {
					return `#${CSS.escape(el.id)}`
				}

				// Check for data attributes
				for (const attr of ["data-testid", "data-cy", "data-test", "data-id"]) {
					const val = el.getAttribute(attr)
					if (val) {
						return `[${attr}="${val}"]`
					}
				}

				// Build path
				const parts: string[] = []
				let cur: Element | null = el
				while (cur && cur !== document.body && cur !== document.documentElement) {
					let sel = cur.tagName.toLowerCase()

					// Add unique class if available
					if (cur.classList.length > 0) {
						const uniqueClass = Array.from(cur.classList).find((c) => {
							if (c.startsWith("roo-")) return false
							try {
								return document.querySelectorAll(`.${CSS.escape(c)}`).length === 1
							} catch {
								return false
							}
						})
						if (uniqueClass) {
							sel += `.${CSS.escape(uniqueClass)}`
						}
					}

					// Add nth-child if needed
					const parent = cur.parentElement
					if (parent) {
						const siblings = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName)
						if (siblings.length > 1) {
							const idx = siblings.indexOf(cur) + 1
							sel += `:nth-child(${idx})`
						}
					}

					parts.unshift(sel)
					cur = cur.parentElement

					// Stop if selector becomes unique
					if (parts.length > 0) {
						try {
							if (document.querySelectorAll(parts.join(" > ")).length === 1) {
								break
							}
						} catch {}
					}
				}
				return parts.join(" > ")
			}

			// Helper: Generate XPath
			function getXPath(el: Element): string {
				if (el.id !== "") return `//*[@id="${el.id}"]`
				if (el === document.body) return "/html/body"

				let ix = 0
				const siblings = el.parentNode?.children
				if (siblings) {
					for (let i = 0; i < siblings.length; i++) {
						const sibling = siblings[i]
						if (sibling === el) {
							return (
								getXPath(el.parentNode as Element) +
								"/" +
								el.tagName.toLowerCase() +
								"[" +
								(ix + 1) +
								"]"
							)
						}
						if (sibling.nodeType === 1 && sibling.tagName === el.tagName) {
							ix++
						}
					}
				}
				return ""
			}

			// Elements
			const bar = document.getElementById("bar")!
			const pickBtn = document.getElementById("pickBtn")!
			const recordBtn = document.getElementById("recordBtn")!
			const designBtn = document.getElementById("designBtn")!
			const styleBtn = document.getElementById("styleBtn")!
			const themeBtn = document.getElementById("themeBtn")!
			const screenshotBtn = document.getElementById("screenshotBtn")!
			const consoleBtn = document.getElementById("consoleBtn")!
			const networkBtn = document.getElementById("networkBtn")!
			const tags = document.getElementById("tags")!
			const clearBtn = document.getElementById("clearBtn")!
			const sendBtn = document.getElementById("sendBtn")!
			const minBtn = document.getElementById("minBtn")!
			const cssInspector = document.getElementById("cssInspector")!
			const inspectorHeader = document.getElementById("inspectorHeader")!
			const inspectorDragHandle = document.getElementById("inspectorDragHandle")!
			const inspectorClose = document.getElementById("inspectorClose")!
			const inspectorTarget = document.getElementById("inspectorTarget")!
			const inspectorSendBtn = document.getElementById("inspectorSendBtn")!
			const addRuleBtn = document.getElementById("addRuleBtn")!
			const newCssRule = document.getElementById("newCssRule") as HTMLTextAreaElement
			const applyToCodeBtn = document.getElementById("applyToCodeBtn")!
			const consolePanel = document.getElementById("consolePanel")!
			const consoleClose = document.getElementById("consoleClose")!
			const consoleBody = document.getElementById("consoleBody")!
			const networkPanel = document.getElementById("networkPanel")!
			const networkClose = document.getElementById("networkClose")!
			const networkBody = document.getElementById("networkBody")!
			const consoleSendBtn = document.getElementById("consoleSendBtn")!
			const networkSendBtn = document.getElementById("networkSendBtn")!

			// Style editor inputs
			const propInputs = {
				width: document.getElementById("prop-width") as HTMLInputElement,
				height: document.getElementById("prop-height") as HTMLInputElement,
				minWidth: document.getElementById("prop-min-width") as HTMLInputElement,
				maxWidth: document.getElementById("prop-max-width") as HTMLInputElement,
				minHeight: document.getElementById("prop-min-height") as HTMLInputElement,
				maxHeight: document.getElementById("prop-max-height") as HTMLInputElement,
				top: document.getElementById("prop-top") as HTMLInputElement,
				right: document.getElementById("prop-right") as HTMLInputElement,
				bottom: document.getElementById("prop-bottom") as HTMLInputElement,
				left: document.getElementById("prop-left") as HTMLInputElement,
				zIndex: document.getElementById("prop-z-index") as HTMLInputElement,
				margin: document.getElementById("prop-margin") as HTMLInputElement,
				padding: document.getElementById("prop-padding") as HTMLInputElement,
				fontFamily: document.getElementById("prop-font-family") as HTMLInputElement,
				fontSize: document.getElementById("prop-font-size") as HTMLInputElement,
				fontWeight: document.getElementById("prop-font-weight") as HTMLSelectElement,
				fontStyle: document.getElementById("prop-font-style") as HTMLSelectElement,
				lineHeight: document.getElementById("prop-line-height") as HTMLInputElement,
				letterSpacing: document.getElementById("prop-letter-spacing") as HTMLInputElement,
				textAlign: document.getElementById("prop-text-align") as HTMLInputElement,
				textTransform: document.getElementById("prop-text-transform") as HTMLSelectElement,
				textDecoration: document.getElementById("prop-text-decoration") as HTMLSelectElement,
				color: document.getElementById("prop-color") as HTMLInputElement,
				backgroundColor: document.getElementById("prop-background-color") as HTMLInputElement,
				backgroundImage: document.getElementById("prop-background-image") as HTMLInputElement,
				backgroundSize: document.getElementById("prop-background-size") as HTMLSelectElement,
				backgroundPosition: document.getElementById("prop-background-position") as HTMLSelectElement,
				border: document.getElementById("prop-border") as HTMLInputElement,
				borderRadius: document.getElementById("prop-border-radius") as HTMLInputElement,
				borderColor: document.getElementById("prop-border-color") as HTMLInputElement,
				boxShadow: document.getElementById("prop-box-shadow") as HTMLInputElement,
				display: document.getElementById("prop-display") as HTMLSelectElement,
				position: document.getElementById("prop-position") as HTMLSelectElement,
				flex: document.getElementById("prop-flex") as HTMLInputElement,
				gap: document.getElementById("prop-gap") as HTMLInputElement,
				overflow: document.getElementById("prop-overflow") as HTMLSelectElement,
				overflowX: document.getElementById("prop-overflow-x") as HTMLSelectElement,
				overflowY: document.getElementById("prop-overflow-y") as HTMLSelectElement,
				opacity: document.getElementById("prop-opacity") as HTMLInputElement,
				visibility: document.getElementById("prop-visibility") as HTMLSelectElement,
				cursor: document.getElementById("prop-cursor") as HTMLInputElement,
				transform: document.getElementById("prop-transform") as HTMLInputElement,
				transformOrigin: document.getElementById("prop-transform-origin") as HTMLInputElement,
				perspective: document.getElementById("prop-perspective") as HTMLInputElement,
				transition: document.getElementById("prop-transition") as HTMLInputElement,
				animation: document.getElementById("prop-animation") as HTMLInputElement,
				animationDelay: document.getElementById("prop-animation-delay") as HTMLInputElement,
				gridTemplate: document.getElementById("prop-grid-template") as HTMLInputElement,
				justifyContent: document.getElementById("prop-justify-content") as HTMLSelectElement,
				alignItems: document.getElementById("prop-align-items") as HTMLSelectElement,
				alignSelf: document.getElementById("prop-align-self") as HTMLInputElement,
				filter: document.getElementById("prop-filter") as HTMLInputElement,
				backdropFilter: document.getElementById("prop-backdrop-filter") as HTMLInputElement,
			}

			// Load state on init
			loadState()

			// Pick mode handlers
			function onOver(e: Event) {
				const t = e.target as HTMLElement
				if (!t || root.contains(t) || cssInspector.contains(t)) return
				if (hovered) hovered.classList.remove("roo-hover")
				hovered = t
				t.classList.add("roo-hover")
			}

			function onOut(e: Event) {
				const t = e.target as HTMLElement
				if (t && t.classList) t.classList.remove("roo-hover")
				if (t === hovered) hovered = null
			}

			function onClick(e: Event) {
				const t = e.target as HTMLElement
				if (!t || root.contains(t) || cssInspector.contains(t)) return
				e.preventDefault()
				e.stopPropagation()

				t.classList.remove("roo-hover")
				const sel = cssPath(t)
				const xp = getXPath(t)
				const tag = t.tagName.toLowerCase()
				let html = t.outerHTML
				if (html.length > 5000) html = html.substring(0, 5000) + "\n<!-- truncated -->"

				const idx = selected.findIndex((s) => s.selector === sel)
				if (idx >= 0) {
					selected.splice(idx, 1)
					t.classList.remove("roo-selected")
				} else {
					selected.push({ selector: sel, xpath: xp, html, tagName: tag })
					t.classList.add("roo-selected")
				}
				refreshUI()
			}

			// Recording handlers
			function onRecordClick(e: Event) {
				const t = e.target as HTMLElement
				if (!t || root.contains(t) || cssInspector.contains(t)) return
				const sel = cssPath(t)
				const action = `Click on <${t.tagName.toLowerCase()}> (selector: ${sel})`
				recordedActions.push(action)
				refreshUI()
			}

			function onRecordChange(e: Event) {
				const t = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
				if (!t || root.contains(t) || cssInspector.contains(t)) return
				const sel = cssPath(t)
				const action = `Input change on <${t.tagName.toLowerCase()}> (selector: ${sel}): "${t.value}"`
				recordedActions.push(action)
				refreshUI()
			}

			// Design mode handlers
			function onDesignInput(e: Event) {
				const t = e.target as HTMLElement
				if (!t || root.contains(t) || cssInspector.contains(t)) return
				const sel = cssPath(t)
				const existingIdx = designEdits.findIndex((d) => d.selector === sel)
				const edit = { selector: sel, text: t.textContent || "", html: t.innerHTML }
				if (existingIdx >= 0) {
					designEdits[existingIdx] = edit
				} else {
					designEdits.push(edit)
				}
				refreshUI()
			}

			function preventLinksInDesign(e: Event) {
				const t = e.target as HTMLElement
				if (!t || root.contains(t) || cssInspector.contains(t)) return
				if (t.tagName.toLowerCase() === "a" || t.closest("a")) {
					e.preventDefault()
				}
			}

			// Enterprise Design Mode: Keyboard shortcuts
			function onDesignKeyDown(e: KeyboardEvent) {
				if (e.ctrlKey || e.metaKey) {
					// Ctrl/Cmd + S to send current edits
					if (e.key === "s") {
						e.preventDefault()
						if (designEdits.length > 0) {
							sendBtn.click()
						}
					}
					// Ctrl/Cmd + Z for undo
					if (e.key === "z") {
						e.preventDefault()
						document.execCommand("undo", false, undefined)
					}
					// Ctrl/Cmd + Y for redo
					if (e.key === "y") {
						e.preventDefault()
						document.execCommand("redo", false, undefined)
					}
				}
			}

			// Enterprise Design Mode: Selection change tracking
			function onDesignSelectionChange() {
				const selection = window.getSelection()
				if (selection && selection.toString().trim()) {
					// Track selection changes for formatting
					updateDesignToolbarState()
				}
			}

			// Enterprise Design Mode: Drag and drop
			let dragElement: HTMLElement | null = null

			function onDesignDragStart(e: DragEvent) {
				const t = e.target as HTMLElement
				if (!t || root.contains(t) || cssInspector.contains(t)) return
				dragElement = t
				e.dataTransfer?.setData("text/html", t.outerHTML)
				e.dataTransfer?.setData("selector", cssPath(t))
				t.style.opacity = "0.5"
			}

			function onDesignDragOver(e: DragEvent) {
				e.preventDefault()
				e.dataTransfer!.dropEffect = "move"
			}

			function onDesignDrop(e: DragEvent) {
				e.preventDefault()
				const t = e.target as HTMLElement
				if (!t || root.contains(t) || cssInspector.contains(t)) return
				if (dragElement) {
					dragElement.style.opacity = "1"
					// Record the move action
					const fromSel = cssPath(dragElement)
					const toSel = cssPath(t)
					const action = `Moved element from <${dragElement.tagName.toLowerCase()}> (${fromSel}) to <${t.tagName.toLowerCase()}> (${toSel})`
					recordedActions.push(action)
					refreshUI()
					dragElement = null
				}
			}

			// Enterprise Design Mode: Toolbar
			let designToolbar: HTMLElement | null = null

			function showDesignToolbar() {
				if (designToolbar) return
				designToolbar = document.createElement("div")
				designToolbar.id = "roo-design-toolbar"
				designToolbar.innerHTML = `
					<div style="position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 2147483647; background: #1e1e2e; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 8px 16px; display: flex; gap: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
						<button id="roo-design-bold" title="Bold (Ctrl+B)"><b>B</b></button>
						<button id="roo-design-italic" title="Italic (Ctrl+I)"><i>I</i></button>
						<button id="roo-design-underline" title="Underline (Ctrl+U)"><u>U</u></button>
						<button id="roo-design-strike" title="Strikethrough"><s>S</s></button>
						<div style="width: 1px; background: rgba(255,255,255,0.2); margin: 0 4px;"></div>
						<button id="roo-design-h1" title="Heading 1">H1</button>
						<button id="roo-design-h2" title="Heading 2">H2</button>
						<button id="roo-design-p" title="Paragraph">P</button>
						<div style="width: 1px; background: rgba(255,255,255,0.2); margin: 0 4px;"></div>
						<button id="roo-design-insert-img" title="Insert Image">🖼️</button>
						<button id="roo-design-insert-link" title="Insert Link">🔗</button>
						<button id="roo-design-insert-list" title="Insert List">📋</button>
					</div>
				`
				document.body.appendChild(designToolbar)

				// Style the buttons
				const buttons = designToolbar.querySelectorAll("button")
				buttons.forEach((btn) => {
					btn.style.cssText = `
						padding: 6px 10px;
						border: none;
						border-radius: 4px;
						background: rgba(255,255,255,0.1);
						color: #fff;
						cursor: pointer;
						font-size: 12px;
						transition: background 0.15s;
					`
					btn.addEventListener("mouseenter", () => {
						btn.style.background = "rgba(255,255,255,0.2)"
					})
					btn.addEventListener("mouseleave", () => {
						btn.style.background = "rgba(255,255,255,0.1)"
					})
				})

				// Add functionality
				document
					.getElementById("roo-design-bold")
					?.addEventListener("click", () => document.execCommand("bold"))
				document
					.getElementById("roo-design-italic")
					?.addEventListener("click", () => document.execCommand("italic"))
				document
					.getElementById("roo-design-underline")
					?.addEventListener("click", () => document.execCommand("underline"))
				document
					.getElementById("roo-design-strike")
					?.addEventListener("click", () => document.execCommand("strikeThrough"))
				document
					.getElementById("roo-design-h1")
					?.addEventListener("click", () => document.execCommand("formatBlock", false, "h1"))
				document
					.getElementById("roo-design-h2")
					?.addEventListener("click", () => document.execCommand("formatBlock", false, "h2"))
				document
					.getElementById("roo-design-p")
					?.addEventListener("click", () => document.execCommand("formatBlock", false, "p"))
				document.getElementById("roo-design-insert-img")?.addEventListener("click", () => {
					const url = prompt("Enter image URL:")
					if (url) document.execCommand("insertImage", false, url)
				})
				document.getElementById("roo-design-insert-link")?.addEventListener("click", () => {
					const url = prompt("Enter link URL:")
					if (url) document.execCommand("createLink", false, url)
				})
				document
					.getElementById("roo-design-insert-list")
					?.addEventListener("click", () => document.execCommand("insertUnorderedList"))
			}

			function hideDesignToolbar() {
				if (designToolbar) {
					designToolbar.remove()
					designToolbar = null
				}
			}

			function updateDesignToolbarState() {
				// Update toolbar button states based on current selection formatting
				const boldBtn = document.getElementById("roo-design-bold")
				const italicBtn = document.getElementById("roo-design-italic")
				if (boldBtn)
					boldBtn.style.background = document.queryCommandState("bold") ? "#FF9800" : "rgba(255,255,255,0.1)"
				if (italicBtn)
					italicBtn.style.background = document.queryCommandState("italic")
						? "#FF9800"
						: "rgba(255,255,255,0.1)"
			}

			// Style editor handlers
			function onStyleOver(e: Event) {
				const t = e.target as HTMLElement
				if (!t || root.contains(t) || cssInspector.contains(t)) return
				if (hovered) hovered.classList.remove("roo-hover")
				hovered = t
				t.classList.add("roo-hover")
			}

			function onStyleOut(e: Event) {
				const t = e.target as HTMLElement
				if (t && t.classList) t.classList.remove("roo-hover")
				if (t === hovered) hovered = null
			}

			function onStyleClick(e: Event) {
				const t = e.target as HTMLElement
				if (!t || root.contains(t) || cssInspector.contains(t)) return
				e.preventDefault()
				e.stopPropagation()

				currentStylingElement = t
				inspectorTarget.textContent = cssPath(t)

				// Get computed styles
				const computed = window.getComputedStyle(t)

				// Layout Tab
				propInputs.width.value = computed.width === "auto" ? "" : computed.width
				propInputs.height.value = computed.height === "auto" ? "" : computed.height
				propInputs.minWidth.value = computed.minWidth === "0px" ? "" : computed.minWidth
				propInputs.maxWidth.value = computed.maxWidth === "none" ? "" : computed.maxWidth
				propInputs.minHeight.value = computed.minHeight === "0px" ? "" : computed.minHeight
				propInputs.maxHeight.value = computed.maxHeight === "none" ? "" : computed.maxHeight
				propInputs.top.value = computed.top === "auto" ? "" : computed.top
				propInputs.right.value = computed.right === "auto" ? "" : computed.right
				propInputs.bottom.value = computed.bottom === "auto" ? "" : computed.bottom
				propInputs.left.value = computed.left === "auto" ? "" : computed.left
				propInputs.zIndex.value = computed.zIndex === "auto" ? "" : computed.zIndex
				propInputs.margin.value = computed.margin === "0px" ? "" : computed.margin
				propInputs.padding.value = computed.padding === "0px" ? "" : computed.padding
				propInputs.display.value = computed.display
				propInputs.position.value = computed.position
				propInputs.flex.value = computed.flex === "0 1 auto" ? "" : computed.flex
				propInputs.gap.value = computed.gap === "0px" ? "" : computed.gap
				propInputs.overflow.value = computed.overflow
				propInputs.overflowX.value = computed.overflowX
				propInputs.overflowY.value = computed.overflowY

				// Typography Tab
				propInputs.fontFamily.value = computed.fontFamily
				propInputs.fontSize.value = computed.fontSize
				propInputs.fontWeight.value = computed.fontWeight === "400" ? "" : computed.fontWeight
				propInputs.fontStyle.value = computed.fontStyle === "normal" ? "" : computed.fontStyle
				propInputs.lineHeight.value = computed.lineHeight === "normal" ? "" : computed.lineHeight
				propInputs.letterSpacing.value = computed.letterSpacing === "normal" ? "" : computed.letterSpacing
				propInputs.textAlign.value = computed.textAlign === "start" ? "" : computed.textAlign
				propInputs.textTransform.value = computed.textTransform === "none" ? "" : computed.textTransform
				propInputs.textDecoration.value =
					computed.textDecorationLine === "none" ? "" : computed.textDecorationLine
				// Convert rgb to hex for color inputs
				const rgbToHex = (rgb: string) => {
					if (!rgb || rgb === "rgba(0, 0, 0, 0)") return "#000000"
					const match = rgb.match(/\d+/g)
					if (!match) return rgb
					const [r, g, b] = match.slice(0, 3).map(Number)
					return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)
				}
				propInputs.color.value = rgbToHex(computed.color)

				// Appearance Tab
				propInputs.backgroundColor.value = rgbToHex(computed.backgroundColor)
				const bgImage = computed.backgroundImage
				propInputs.backgroundImage.value = bgImage === "none" ? "" : bgImage.replace(/url\(["']?|["']?\)/g, "")
				propInputs.backgroundSize.value = computed.backgroundSize
				propInputs.backgroundPosition.value = computed.backgroundPosition.split(" ")[0]
				propInputs.border.value = computed.border === "0px none rgb(0, 0, 0)" ? "" : computed.border
				propInputs.borderRadius.value = computed.borderRadius === "0px" ? "" : computed.borderRadius
				propInputs.borderColor.value = rgbToHex(computed.borderColor)
				const boxShadow = computed.boxShadow
				propInputs.boxShadow.value = boxShadow === "none" ? "" : boxShadow
				propInputs.opacity.value = computed.opacity
				propInputs.visibility.value = computed.visibility
				propInputs.cursor.value = computed.cursor === "auto" ? "" : computed.cursor

				// Advanced Tab
				const transform = computed.transform
				propInputs.transform.value = transform === "none" ? "" : transform
				propInputs.transformOrigin.value = computed.transformOrigin
				propInputs.perspective.value = computed.perspective === "none" ? "" : computed.perspective
				propInputs.transition.value = computed.transition === "all 0s ease 0s" ? "" : computed.transition
				propInputs.animation.value = computed.animationName === "none" ? "" : computed.animationName
				propInputs.gridTemplate.value =
					computed.gridTemplateColumns === "none" ? "" : computed.gridTemplateColumns
				propInputs.justifyContent.value = computed.justifyContent === "normal" ? "" : computed.justifyContent
				propInputs.alignItems.value = computed.alignItems === "normal" ? "" : computed.alignItems
				propInputs.alignSelf.value = computed.alignSelf === "auto" ? "" : computed.alignSelf
				const filter = computed.filter
				propInputs.filter.value = filter === "none" ? "" : filter
				const backdropFilter = (computed as any).backdropFilter || "none"
				propInputs.backdropFilter.value = backdropFilter === "none" ? "" : backdropFilter

				cssInspector.classList.add("active")
			}

			// Apply style changes
			function applyStyleChanges() {
				if (!currentStylingElement) return

				const t = currentStylingElement
				const sel = cssPath(t)

				// Build CSS string
				const cssProps: string[] = []

				// Layout Tab
				if (propInputs.width.value) cssProps.push(`width: ${propInputs.width.value}`)
				if (propInputs.height.value) cssProps.push(`height: ${propInputs.height.value}`)
				if (propInputs.minWidth.value) cssProps.push(`min-width: ${propInputs.minWidth.value}`)
				if (propInputs.maxWidth.value) cssProps.push(`max-width: ${propInputs.maxWidth.value}`)
				if (propInputs.minHeight.value) cssProps.push(`min-height: ${propInputs.minHeight.value}`)
				if (propInputs.maxHeight.value) cssProps.push(`max-height: ${propInputs.maxHeight.value}`)
				if (propInputs.top.value) cssProps.push(`top: ${propInputs.top.value}`)
				if (propInputs.right.value) cssProps.push(`right: ${propInputs.right.value}`)
				if (propInputs.bottom.value) cssProps.push(`bottom: ${propInputs.bottom.value}`)
				if (propInputs.left.value) cssProps.push(`left: ${propInputs.left.value}`)
				if (propInputs.zIndex.value) cssProps.push(`z-index: ${propInputs.zIndex.value}`)
				if (propInputs.margin.value) cssProps.push(`margin: ${propInputs.margin.value}`)
				if (propInputs.padding.value) cssProps.push(`padding: ${propInputs.padding.value}`)
				if (propInputs.display.value) cssProps.push(`display: ${propInputs.display.value}`)
				if (propInputs.position.value) cssProps.push(`position: ${propInputs.position.value}`)
				if (propInputs.flex.value) cssProps.push(`flex: ${propInputs.flex.value}`)
				if (propInputs.gap.value) cssProps.push(`gap: ${propInputs.gap.value}`)
				if (propInputs.overflow.value) cssProps.push(`overflow: ${propInputs.overflow.value}`)
				if (propInputs.overflowX.value) cssProps.push(`overflow-x: ${propInputs.overflowX.value}`)
				if (propInputs.overflowY.value) cssProps.push(`overflow-y: ${propInputs.overflowY.value}`)

				// Typography Tab
				if (propInputs.fontFamily.value) cssProps.push(`font-family: ${propInputs.fontFamily.value}`)
				if (propInputs.fontSize.value) cssProps.push(`font-size: ${propInputs.fontSize.value}`)
				if (propInputs.fontWeight.value) cssProps.push(`font-weight: ${propInputs.fontWeight.value}`)
				if (propInputs.fontStyle.value) cssProps.push(`font-style: ${propInputs.fontStyle.value}`)
				if (propInputs.lineHeight.value) cssProps.push(`line-height: ${propInputs.lineHeight.value}`)
				if (propInputs.letterSpacing.value) cssProps.push(`letter-spacing: ${propInputs.letterSpacing.value}`)
				if (propInputs.textAlign.value) cssProps.push(`text-align: ${propInputs.textAlign.value}`)
				if (propInputs.textTransform.value) cssProps.push(`text-transform: ${propInputs.textTransform.value}`)
				if (propInputs.textDecoration.value)
					cssProps.push(`text-decoration: ${propInputs.textDecoration.value}`)
				if (propInputs.color.value) cssProps.push(`color: ${propInputs.color.value}`)

				// Appearance Tab
				if (propInputs.backgroundColor.value)
					cssProps.push(`background-color: ${propInputs.backgroundColor.value}`)
				if (propInputs.backgroundImage.value)
					cssProps.push(`background-image: url(${propInputs.backgroundImage.value})`)
				if (propInputs.backgroundSize.value)
					cssProps.push(`background-size: ${propInputs.backgroundSize.value}`)
				if (propInputs.backgroundPosition.value)
					cssProps.push(`background-position: ${propInputs.backgroundPosition.value}`)
				if (propInputs.border.value) cssProps.push(`border: ${propInputs.border.value}`)
				if (propInputs.borderRadius.value) cssProps.push(`border-radius: ${propInputs.borderRadius.value}`)
				if (propInputs.borderColor.value) cssProps.push(`border-color: ${propInputs.borderColor.value}`)
				if (propInputs.boxShadow.value) cssProps.push(`box-shadow: ${propInputs.boxShadow.value}`)
				if (propInputs.opacity.value) cssProps.push(`opacity: ${propInputs.opacity.value}`)
				if (propInputs.visibility.value) cssProps.push(`visibility: ${propInputs.visibility.value}`)
				if (propInputs.cursor.value) cssProps.push(`cursor: ${propInputs.cursor.value}`)

				// Advanced Tab
				if (propInputs.transform.value) cssProps.push(`transform: ${propInputs.transform.value}`)
				if (propInputs.transformOrigin.value)
					cssProps.push(`transform-origin: ${propInputs.transformOrigin.value}`)
				if (propInputs.perspective.value) cssProps.push(`perspective: ${propInputs.perspective.value}`)
				if (propInputs.transition.value) cssProps.push(`transition: ${propInputs.transition.value}`)
				if (propInputs.animation.value) cssProps.push(`animation: ${propInputs.animation.value}`)
				if (propInputs.gridTemplate.value) cssProps.push(`grid-template: ${propInputs.gridTemplate.value}`)
				if (propInputs.justifyContent.value)
					cssProps.push(`justify-content: ${propInputs.justifyContent.value}`)
				if (propInputs.alignItems.value) cssProps.push(`align-items: ${propInputs.alignItems.value}`)
				if (propInputs.alignSelf.value) cssProps.push(`align-self: ${propInputs.alignSelf.value}`)
				if (propInputs.filter.value) cssProps.push(`filter: ${propInputs.filter.value}`)
				if (propInputs.backdropFilter.value)
					cssProps.push(`backdrop-filter: ${propInputs.backdropFilter.value}`)

				const css = cssProps.join("; ")

				// Apply inline style
				t.setAttribute("style", css)

				// Record style edit
				const existingIdx = styleEdits.findIndex((s) => s.selector === sel)
				if (existingIdx >= 0) {
					styleEdits[existingIdx] = { selector: sel, css }
				} else {
					styleEdits.push({ selector: sel, css })
				}

				refreshUI()
			}

			// Update console panel
			async function updateConsolePanel() {
				try {
					const logs = await (window as any).__clineGetConsoleLogs()
					consoleBody.textContent = logs || "No console output yet."
				} catch {
					consoleBody.textContent = "Console logs not available."
				}
			}

			// Update network panel
			async function updateNetworkPanel() {
				try {
					const requests = await (window as any).__clineGetNetworkRequests()
					networkBody.textContent = requests || "No network traffic yet."
				} catch {
					networkBody.textContent = "Network traffic not available."
				}
			}

			// Refresh UI
			function refreshUI() {
				let tagsHtml = ""
				selected.forEach((el, i) => {
					let lbl = el.selector
					if (lbl.length > 20) lbl = lbl.substring(0, 20) + "..."
					tagsHtml += `<span class="roo-tag element">${el.tagName} <span class="roo-tag-x" data-idx="${i}" data-type="element">&times;</span></span>`
				})

				recordedActions.forEach((x, i) => {
					tagsHtml += `<span class="roo-tag action">Action ${i + 1} <span class="roo-tag-x" data-idx="${i}" data-type="action">&times;</span></span>`
				})

				designEdits.forEach((x, i) => {
					tagsHtml += `<span class="roo-tag design">Edit ${i + 1} <span class="roo-tag-x" data-idx="${i}" data-type="design">&times;</span></span>`
				})

				styleEdits.forEach((x, i) => {
					let lbl = x.selector
					if (lbl.length > 20) lbl = lbl.substring(0, 20) + "..."
					tagsHtml += `<span class="roo-tag style">Style: ${lbl} <span class="roo-tag-x" data-idx="${i}" data-type="style">&times;</span></span>`
				})

				tags.innerHTML = tagsHtml
				sendBtn.removeAttribute("disabled")

				const total = selected.length + recordedActions.length + designEdits.length + styleEdits.length
				;(sendBtn as HTMLButtonElement).textContent = `Send (${total})`
				clearBtn.style.display = "block"

				tags.querySelectorAll(".roo-tag-x").forEach((btn) => {
					btn.addEventListener("click", (e) => {
						const bt = e.target as HTMLElement
						const idx = parseInt(bt.getAttribute("data-idx") || "0", 10)
						const type = bt.getAttribute("data-type")

						if (type === "element") {
							const selObj = selected[idx]
							if (selObj) {
								document.querySelectorAll(".roo-selected").forEach((node) => {
									if (cssPath(node as HTMLElement) === selObj.selector) {
										node.classList.remove("roo-selected")
									}
								})
								selected.splice(idx, 1)
							}
						} else if (type === "action") {
							recordedActions.splice(idx, 1)
						} else if (type === "design") {
							designEdits.splice(idx, 1)
						} else if (type === "style") {
							styleEdits.splice(idx, 1)
						}
						refreshUI()
					})
				})

				saveState()
			}

			// Event listeners
			pickBtn.addEventListener("click", () => {
				if (recordingOn) recordBtn.click()
				if (designOn) designBtn.click()
				if (stylingOn) styleBtn.click()
				pickerOn = !pickerOn
				pickBtn.classList.toggle("active", pickerOn)
				if (pickerOn) {
					document.addEventListener("mouseover", onOver, true)
					document.addEventListener("mouseout", onOut, true)
					document.addEventListener("click", onClick, true)
				} else {
					document.removeEventListener("mouseover", onOver, true)
					document.removeEventListener("mouseout", onOut, true)
					document.removeEventListener("click", onClick, true)
					if (hovered) {
						hovered.classList.remove("roo-hover")
						hovered = null
					}
				}
				saveState()
			})

			recordBtn.addEventListener("click", () => {
				if (pickerOn) pickBtn.click()
				if (designOn) designBtn.click()
				recordingOn = !recordingOn
				recordBtn.classList.toggle("active", recordingOn)
				recordBtn.textContent = recordingOn ? "⏹ Stop" : "⏺ Record"
				if (recordingOn) {
					document.addEventListener("click", onRecordClick, true)
					document.addEventListener("change", onRecordChange, true)
				} else {
					document.removeEventListener("click", onRecordClick, true)
					document.removeEventListener("change", onRecordChange, true)
				}
				saveState()
			})

			designBtn.addEventListener("click", () => {
				if (pickerOn) pickBtn.click()
				if (recordingOn) recordBtn.click()
				if (stylingOn) styleBtn.click()
				designOn = !designOn
				designBtn.classList.toggle("active", designOn)
				designBtn.textContent = designOn ? "⏹ Stop" : "🎨 Design"
				if (designOn) {
					document.designMode = "on"
					document.addEventListener("input", onDesignInput, true)
					document.addEventListener("click", preventLinksInDesign, true)
					// Enterprise features
					document.addEventListener("keydown", onDesignKeyDown, true)
					document.addEventListener("mouseup", onDesignSelectionChange, true)
					document.addEventListener("dragstart", onDesignDragStart, true)
					document.addEventListener("dragover", onDesignDragOver, true)
					document.addEventListener("drop", onDesignDrop, true)
					showDesignToolbar()
				} else {
					document.designMode = "off"
					document.removeEventListener("input", onDesignInput, true)
					document.removeEventListener("click", preventLinksInDesign, true)
					document.removeEventListener("keydown", onDesignKeyDown, true)
					document.removeEventListener("mouseup", onDesignSelectionChange, true)
					document.removeEventListener("dragstart", onDesignDragStart, true)
					document.removeEventListener("dragover", onDesignDragOver, true)
					document.removeEventListener("drop", onDesignDrop, true)
					hideDesignToolbar()
				}
				saveState()
			})

			styleBtn.addEventListener("click", () => {
				if (pickerOn) pickBtn.click()
				if (recordingOn) recordBtn.click()
				if (designOn) designBtn.click()
				stylingOn = !stylingOn
				styleBtn.classList.toggle("active", stylingOn)
				styleBtn.textContent = stylingOn ? "⏹ Stop" : "💅 Style"
				if (stylingOn) {
					document.addEventListener("mouseover", onStyleOver, true)
					document.addEventListener("mouseout", onStyleOut, true)
					document.addEventListener("click", onStyleClick, true)
					cssInspector.classList.add("active")
				} else {
					document.removeEventListener("mouseover", onStyleOver, true)
					document.removeEventListener("mouseout", onStyleOut, true)
					document.removeEventListener("click", onStyleClick, true)
					cssInspector.classList.remove("active")
					currentStylingElement = null
					if (hovered) {
						hovered.classList.remove("roo-hover")
						hovered = null
					}
				}
				saveState()
			})

			inspectorClose.addEventListener("click", () => {
				if (stylingOn) styleBtn.click()
			})

			// Make CSS inspector draggable
			let isDragging = false
			let dragOffsetX = 0
			let dragOffsetY = 0

			inspectorDragHandle.addEventListener("mousedown", (e) => {
				isDragging = true
				const rect = cssInspector.getBoundingClientRect()
				dragOffsetX = e.clientX - rect.left
				dragOffsetY = e.clientY - rect.top
				cssInspector.style.transition = "none"
			})

			document.addEventListener("mousemove", (e) => {
				if (!isDragging) return
				e.preventDefault()
				const x = e.clientX - dragOffsetX
				const y = e.clientY - dragOffsetY
				cssInspector.style.left = x + "px"
				cssInspector.style.top = y + "px"
				cssInspector.style.right = "auto"
				cssInspector.style.bottom = "auto"
			})

			document.addEventListener("mouseup", () => {
				if (isDragging) {
					isDragging = false
					cssInspector.style.transition = ""
				}
			})

			// Tab switching
			const inspectorTabs = cssInspector.querySelectorAll(".roo-tab")
			const inspectorTabContents = cssInspector.querySelectorAll(".roo-tab-content")

			inspectorTabs.forEach((tab) => {
				tab.addEventListener("click", () => {
					const tabName = tab.getAttribute("data-tab")

					// Update active tab
					inspectorTabs.forEach((t) => t.classList.remove("active"))
					tab.classList.add("active")

					// Update active content
					inspectorTabContents.forEach((content) => {
						if (content.getAttribute("data-tab") === tabName) {
							content.classList.add("active")
						} else {
							content.classList.remove("active")
						}
					})
				})
			})

			inspectorSendBtn.addEventListener("click", () => {
				applyStyleChanges()
				sendBtn.click()
			})

			// Auto-apply on input change - no need to click Apply button
			Object.values(propInputs).forEach((input) => {
				if (!input) return
				input.addEventListener("input", () => {
					if (currentStylingElement) {
						applyStyleChanges()
					}
				})
				input.addEventListener("change", () => {
					if (currentStylingElement) {
						applyStyleChanges()
					}
				})
			})

			// Add CSS rule
			addRuleBtn.addEventListener("click", () => {
				const rule = newCssRule.value.trim()
				if (rule) {
					// Apply to page
					const styleEl = document.createElement("style")
					styleEl.textContent = rule
					document.head.appendChild(styleEl)
					addedCssRules.push(rule)
					newCssRule.value = ""
					refreshUI()
				}
			})

			// Apply to code toggle
			applyToCodeBtn.addEventListener("click", () => {
				applyToCode = !applyToCode
				applyToCodeBtn.textContent = applyToCode ? "✓ Will Apply to Code" : "📝 Apply to Code"
				applyToCodeBtn.style.background = applyToCode
					? "linear-gradient(135deg, #66BB6A, #4CAF50)"
					: "linear-gradient(135deg, #4CAF50, #388E3C)"
			})

			// Theme toggle
			themeBtn.addEventListener("click", () => {
				isDarkMode = !isDarkMode
				themeBtn.textContent = isDarkMode ? "☀️" : "🌓"
				if (isDarkMode) {
					document.documentElement.style.filter = "invert(1) hue-rotate(180deg)"
					const fixStyle = document.createElement("style")
					fixStyle.id = "roo-dark-mode-fix"
					fixStyle.textContent = `
						img, video, svg, canvas, [style*="background-image"] {
							filter: invert(1) hue-rotate(180deg) !important;
						}
					`
					document.head.appendChild(fixStyle)
				} else {
					document.documentElement.style.filter = ""
					const fix = document.getElementById("roo-dark-mode-fix")
					if (fix) fix.remove()
				}
			})

			// Screenshot
			screenshotBtn.addEventListener("click", async () => {
				try {
					;(window as any).__clineRequestScreenshot()
				} catch (e) {
					console.error("Screenshot failed:", e)
				}
			})

			// Console panel
			consoleBtn.addEventListener("click", () => {
				consolePanel.classList.toggle("active")
				networkPanel.classList.remove("active")
				updateConsolePanel()
			})
			consoleClose.addEventListener("click", () => {
				consolePanel.classList.remove("active")
			})

			// Network panel
			networkBtn.addEventListener("click", () => {
				networkPanel.classList.toggle("active")
				consolePanel.classList.remove("active")
				updateNetworkPanel()
			})
			networkClose.addEventListener("click", () => {
				networkPanel.classList.remove("active")
			})

			// Send console logs to chat
			consoleSendBtn.addEventListener("click", async () => {
				try {
					const logs = await (window as any).__clineGetConsoleLogs()
					if (logs && logs.trim()) {
						await (window as any).__clineSendElements(
							JSON.stringify({
								elements: [],
								actions: [],
								designEdits: [],
								styleEdits: [],
								addedCssRules: [],
								applyToCode: false,
								consoleLogs: logs.split("\n"),
								networkRequests: [],
							}),
						)
						consolePanel.classList.remove("active")
					} else {
						consoleBody.textContent = "No console logs to send."
					}
				} catch (e) {
					console.error("Failed to send console logs:", e)
				}
			})

			// Send network traffic to chat
			networkSendBtn.addEventListener("click", async () => {
				try {
					const requests = await (window as any).__clineGetNetworkRequests()
					if (requests && requests.trim()) {
						await (window as any).__clineSendElements(
							JSON.stringify({
								elements: [],
								actions: [],
								designEdits: [],
								styleEdits: [],
								addedCssRules: [],
								applyToCode: false,
								consoleLogs: [],
								networkRequests: requests.split("\n"),
							}),
						)
						networkPanel.classList.remove("active")
					} else {
						networkBody.textContent = "No network traffic to send."
					}
				} catch (e) {
					console.error("Failed to send network traffic:", e)
				}
			})

			// Clear
			clearBtn.addEventListener("click", () => {
				document.querySelectorAll(".roo-selected").forEach((el) => el.classList.remove("roo-selected"))
				selected = []
				recordedActions = []
				designEdits = []
				styleEdits = []
				addedCssRules = []
				applyToCode = false
				applyToCodeBtn.textContent = "📝 Apply to Code"
				refreshUI()
			})

			// Send
			sendBtn.addEventListener("click", async () => {
				if (
					selected.length === 0 &&
					recordedActions.length === 0 &&
					designEdits.length === 0 &&
					styleEdits.length === 0 &&
					addedCssRules.length === 0
				)
					return

				const payload = {
					elements: selected,
					actions: recordedActions,
					designEdits,
					styleEdits,
					addedCssRules,
					applyToCode,
					consoleLogs: [],
					networkRequests: [],
				}

				try {
					await (window as any).__clineSendElements(JSON.stringify(payload))
					// Clear after sending
					document.querySelectorAll(".roo-selected").forEach((el) => el.classList.remove("roo-selected"))
					selected = []
					recordedActions = []
					designEdits = []
					styleEdits = []
					addedCssRules = []
					applyToCode = false
					applyToCodeBtn.textContent = "📝 Apply to Code"
					refreshUI()
				} catch (e) {
					console.error("Failed to send elements:", e)
				}
			})

			// Minimize
			minBtn.addEventListener("click", () => {
				isMin = !isMin
				bar.classList.toggle("minimized", isMin)
				minBtn.textContent = isMin ? "▴" : "▾"
			})
		})
	}

	/**
	 * Take a full page screenshot and send to chat
	 */
	private async takeFullPageScreenshot(): Promise<void> {
		if (!this.page) return

		try {
			const screenshot = await this.page.screenshot({ fullPage: true, encoding: "base64" })
			const image = `data:image/png;base64,${screenshot}`

			const provider = ClineProvider.getVisibleInstance()
			if (provider) {
				await provider.postMessageToWebview({
					type: "insertTextToChatArea",
					text: "### Full Page Screenshot",
					images: [image],
				})
			}
			vscode.window.showInformationMessage("Screenshot sent to Roo Code chat!")
		} catch (e) {
			console.error("Screenshot failed:", e)
			vscode.window.showErrorMessage("Failed to take screenshot")
		}
	}

	/**
	 * Send selected elements to the Roo Code chat
	 */
	private async sendElementsToChat(
		elements: Array<{
			selector: string
			xpath: string
			html: string
			tagName: string
			componentName?: string
			sourceFile?: string
		}>,
		actions: string[] = [],
		designEdits: Array<{ selector: string; text: string; html: string }> = [],
		styleEdits: Array<{ selector: string; css: string }> = [],
		addedCssRules: string[] = [],
		applyToCode: boolean = false,
		consoleLogs: string[] = [],
		networkRequests: string[] = [],
	): Promise<void> {
		if (
			elements.length === 0 &&
			actions.length === 0 &&
			designEdits.length === 0 &&
			styleEdits.length === 0 &&
			addedCssRules.length === 0 &&
			consoleLogs.length === 0 &&
			networkRequests.length === 0
		)
			return

		let parts: string[] = []

		if (applyToCode) {
			parts.push(
				`### 🎨 Apply to Code Request\nThe user wants these style changes applied to the source code files.`,
			)
		}

		if (elements.length > 0) {
			parts = elements.map((el, i) => {
				let msg = `### Element ${i + 1}: \`<${el.tagName}>\`\n**CSS**: \`${el.selector}\`\n**XPath**: \`${el.xpath}\``
				if (el.componentName) {
					msg += `\n**React Component**: \`<${el.componentName}>\``
				}
				if (el.sourceFile) {
					msg += `\n**Source File**: \`${el.sourceFile}\``
				}
				msg += `\n\n\`\`\`html\n${el.html}\n\`\`\``
				return msg
			})
		}

		if (actions.length > 0) {
			parts.push(`### Recorded Actions:\n` + actions.map((a, i) => `${i + 1}. ${a}`).join("\n"))
		}

		if (designEdits.length > 0) {
			parts.push(
				`### Design Mode Edits:\n` +
					designEdits
						.map((d, i) => {
							return `**Edit ${i + 1} on \`${d.selector}\`**\n**New Text Content:**\n\`\`\`text\n${d.text}\n\`\`\`\n**New HTML Content:**\n\`\`\`html\n${d.html}\n\`\`\``
						})
						.join("\n\n"),
			)
		}

		if (styleEdits.length > 0) {
			parts.push(
				`### Style Editor Edits:\n` +
					styleEdits
						.map((s, i) => {
							return `**Edit ${i + 1} on \`${s.selector}\`**\n**New CSS Properties:**\n\`\`\`css\n${s.css}\n\`\`\``
						})
						.join("\n\n"),
			)
		}

		if (addedCssRules.length > 0) {
			parts.push(
				`### Added CSS Rules:\n` +
					addedCssRules
						.map((rule, i) => {
							return `**Rule ${i + 1}:**\n\`\`\`css\n${rule}\n\`\`\``
						})
						.join("\n\n"),
			)
		}

		if (consoleLogs.length > 0) {
			parts.push(`### Console Output:\n\`\`\`\n` + consoleLogs.join("\n") + `\n\`\`\``)
		}

		if (networkRequests.length > 0) {
			parts.push(`### Network Traffic:\n\`\`\`\n` + networkRequests.join("\n") + `\n\`\`\``)
		}

		const message = `Browser Elements/Actions Selected:\n\n${parts.join("\n\n")}`
		const images: string[] = []

		// Take screenshots of selected elements
		if (this.page) {
			for (const el of elements) {
				try {
					const handle = await this.page.$(el.selector)
					if (handle) {
						// Scroll element into view
						await handle.evaluate((node) => node.scrollIntoView({ behavior: "instant", block: "center" }))
						await new Promise((resolve) => setTimeout(resolve, 100))

						const screenshot = await handle.screenshot({ encoding: "base64" })
						images.push(`data:image/png;base64,${screenshot}`)
					}
				} catch (e) {
					console.error("Failed to take screenshot for element:", el.selector, e)
				}
			}
		}

		try {
			const provider = ClineProvider.getVisibleInstance()
			if (provider) {
				await provider.postMessageToWebview({ type: "insertTextToChatArea", text: message, images })
			}
			vscode.window.showInformationMessage(`${elements.length} element(s) sent to Roo Code chat!`)
		} catch (error) {
			console.error("Failed to send elements to chat:", error)
			vscode.window.showErrorMessage("Failed to send elements to chat")
		}
	}

	/**
	 * Find Chrome installation
	 */
	private async findChrome(): Promise<string | undefined> {
		try {
			// Use chrome-launcher to find Chrome
			const chromePath = await chromeLauncher.Launcher.getFirstInstallation()
			return chromePath
		} catch {
			// Fallback paths
			const paths = [
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				"/Applications/Chromium.app/Contents/MacOS/Chromium",
				"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
				"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
				"/usr/bin/google-chrome",
				"/usr/bin/chromium-browser",
				"/usr/bin/chromium",
			]

			for (const p of paths) {
				try {
					if (require("fs").existsSync(p)) {
						return p
					}
				} catch {}
			}
		}
		return undefined
	}

	/**
	 * Show status bar item
	 */
	private showStatusBar() {
		if (this.statusBarItem) return

		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
		this.statusBarItem.text = "$(browser) Browser Panel"
		this.statusBarItem.tooltip = "Roo Code Element Picker is active"
		this.statusBarItem.command = "roo-code.openBrowserPanel"
		this.statusBarItem.show()
	}

	/**
	 * Dispose the browser and cleanup
	 */
	public async dispose() {
		try {
			if (this.browser) {
				await this.browser.disconnect()
			}
		} catch {}

		try {
			if (this.chromeProcess) {
				await this.chromeProcess.kill()
			}
		} catch {}

		if (this.statusBarItem) {
			this.statusBarItem.dispose()
			this.statusBarItem = undefined
		}

		this.browser = undefined
		this.page = undefined
		this.chromeProcess = undefined
		ElementPickerBrowser.instance = undefined
	}
}
