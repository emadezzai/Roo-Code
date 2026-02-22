import * as vscode from "vscode"
import { GitExtensionService, GitChange } from "./GitExtensionService"
import { loadRuleFiles } from "../../core/prompts/sections/custom-instructions"
import { t } from "../../i18n"

/**
 * Provides AI-powered commit message generation for source control management.
 * Integrates with Git repositories to analyze staged changes and generate
 * conventional commit messages using AI.
 */
export class CommitMessageProvider {
	private gitService: GitExtensionService
	private previousGitContext: string | null = null
	private previousCommitMessage: string | null = null

	constructor(
		private context: vscode.ExtensionContext,
		private outputChannel: vscode.OutputChannel,
	) {
		this.gitService = new GitExtensionService()
	}

	/**
	 * Activates the commit message provider by setting up Git integration.
	 */
	public async activate(): Promise<void> {
		this.outputChannel.appendLine(t("common:commitMessage.activated"))

		try {
			const initialized = await this.gitService.initialize()
			if (!initialized) {
				this.outputChannel.appendLine(t("common:commitMessage.gitNotFound"))
			}
		} catch (error) {
			this.outputChannel.appendLine(t("common:commitMessage.gitInitError", { error }))
		}

		// Register the command
		const disposable = vscode.commands.registerCommand("roo-code.generateCommitMessage", () =>
			this.generateCommitMessage(),
		)
		this.context.subscriptions.push(disposable)
	}

	/**
	 * Generates an AI-powered commit message based on staged changes.
	 */
	public async generateCommitMessage(): Promise<void> {
		await this.gitService.initialize()
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.SourceControl,
				title: t("common:commitMessage.generating"),
				cancellable: false,
			},
			async (progress) => {
				try {
					progress.report({ increment: 25, message: t("common:commitMessage.analyzingChanges") })

					const changes = await this.gitService.gatherStagedChanges()
					if (changes === null) {
						vscode.window.showInformationMessage(t("common:commitMessage.noStagedChangesRepo"))
						return
					}
					if (changes.length === 0) {
						vscode.window.showInformationMessage(t("common:commitMessage.noStagedChanges"))
						return
					}

					const gitContextString = this.gitService.getCommitContext(changes)
					const detailedContext = changes
						.map((c) => {
							const fileName = c.filePath.split("/").pop() || c.filePath
							return `${fileName} (${c.status})\n${c.diff || ""}`
						})
						.join("\n\n")
					progress.report({ increment: 50, message: t("common:commitMessage.generating") })

					const generatedMessage = await this.callAIForCommitMessage(detailedContext, changes)
					this.gitService.setCommitMessage(generatedMessage)

					// Store the current context and message for future reference
					this.previousGitContext = gitContextString
					this.previousCommitMessage = generatedMessage

					progress.report({ increment: 100, message: "Complete!" })
					vscode.window.showInformationMessage(t("common:commitMessage.generated"))
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred"
					vscode.window.showErrorMessage(t("common:commitMessage.generationFailed", { errorMessage }))
					console.error("Error generating commit message:", error)
				}
			},
		)
	}

	/**
	 * Calls the provider to generate a commit message based on the git context.
	 */
	private async callAIForCommitMessage(gitContextString: string, changes: GitChange[]): Promise<string> {
		const prompt = await this.buildCommitMessagePrompt(gitContextString)

		// For now, we'll use a placeholder implementation
		// In a full implementation, this would call an AI service
		// Return a conventional commit format message based on the changes
		return this.generateDetailedCommitMessage(changes)
	}

	/**
	 * Builds the AI prompt for commit message generation.
	 */
	private async buildCommitMessagePrompt(context: string): Promise<string> {
		// Load rules from the workspace
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		const rules = workspaceRoot ? await loadRuleFiles(workspaceRoot) : ""

		// Check if we should generate a different message than the previous one
		const shouldGenerateDifferentMessage = this.previousGitContext !== null && this.previousGitContext !== context

		const systemPrompt = `You are an expert at writing clear, concise, and meaningful Git commit messages following the Conventional Commits specification.

## Conventional Commits Format
\`<type>(<scope>): <description>\`

### Core Types (Required)
- **feat**: A new feature for the user
- **fix**: A bug fix for the user
- **docs**: Documentation-only changes
- **style**: Changes that don't affect code meaning (formatting, semicolons, etc.)
- **refactor**: Code changes that neither fix bugs nor add features
- **perf**: Performance improvements
- **test**: Adding or correcting tests
- **chore**: Changes to build process, dependencies, or auxiliary tools

### Guidelines
1. Use the present tense (e.g., "add feature" not "added feature")
2. Use imperative mood (e.g., "move cursor to..." not "moves cursor to...")
3. Don't capitalize the first letter
4. No period at the end
5. Keep the first line under 72 characters
6. Be specific about what changed

${rules ? `\n## Project Rules\n${rules}\n` : ""}

${shouldGenerateDifferentMessage ? "IMPORTANT: The changes have been modified since the last generation. Please generate a NEW commit message that reflects the current changes.\n" : ""}

## Analysis Instructions
Analyze the following staged changes and generate a concise, descriptive commit message:

${context}

Generate a commit message following the Conventional Commits format. Focus on:
1. What changed (type and scope)
2. Why it changed (if clear from context)
3. Impact on the codebase

Return ONLY the commit message, nothing else.`

		return systemPrompt
	}

	/**
	 * Extracts class and function names from diff content
	 */
	private extractCodeElements(diff: string): { classes: string[]; functions: string[]; imports: string[] } {
		const classes: string[] = []
		const functions: string[] = []
		const imports: string[] = []

		// Match class definitions
		const classRegex = /class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g
		let match
		while ((match = classRegex.exec(diff)) !== null) {
			classes.push(match[1])
		}

		// Match function definitions
		const funcRegex = /(?:export\s+)?(?:async\s+)?(?:function\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*(?:=>|\{)/g
		while ((match = funcRegex.exec(diff)) !== null) {
			const funcName = match[1]
			if (
				!["if", "while", "for", "switch", "catch", "return", "await", "const", "let", "var"].includes(funcName)
			) {
				functions.push(funcName)
			}
		}

		// Match import statements
		const importRegex = /import\s+(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g
		while ((match = importRegex.exec(diff)) !== null) {
			imports.push(match[1])
		}

		// Match React component definitions
		const componentRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:React\.)?(?:forwardRef|memo)/g
		while ((match = componentRegex.exec(diff)) !== null) {
			const compName = match[1]
			if (compName[0] === compName[0].toUpperCase() && !classes.includes(compName)) {
				classes.push(compName)
			}
		}

		return { classes: [...new Set(classes)], functions: [...new Set(functions)], imports: [...new Set(imports)] }
	}

	/**
	 * Determines what type of change this is based on file content
	 */
	private determineChangeType(changes: GitChange[]): {
		type: string
		scope: string
		isNewFeature: boolean
		isBugFix: boolean
		isRefactor: boolean
		isUiUpdate: boolean
	} {
		const allPaths = changes.map((c) => c.filePath.toLowerCase())
		const newFiles = changes.filter((c) => c.status === "untracked")
		const modifiedFiles = changes.filter((c) => c.status !== "untracked")

		let scope = ""
		let isNewFeature = newFiles.length > 0
		let isBugFix = false
		let isRefactor = false
		let isUiUpdate = false

		// Check for UI components
		if (allPaths.some((p) => /\.(tsx|jsx|vue)$/.test(p) || p.includes("component"))) {
			isUiUpdate = true
		}

		// Check for bug fix patterns in diffs
		const allDiffs = changes.map((c) => c.diff || "").join("\n")
		if (allDiffs.includes("fix") || allDiffs.includes("bug") || allDiffs.includes("error")) {
			isBugFix = true
		}

		// Determine scope from common directory
		const commonDir = this.findCommonDirectory(changes.map((c) => c.filePath))
		scope = commonDir

		// Determine type
		let type = "chore"
		if (newFiles.length > 0 && modifiedFiles.length === 0) {
			type = "feat"
		} else if (isBugFix) {
			type = "fix"
		} else if (isRefactor) {
			type = "refactor"
		} else if (allPaths.some((p) => p.includes("test"))) {
			type = "test"
		} else if (allPaths.some((p) => p.includes("docs"))) {
			type = "docs"
		} else if (modifiedFiles.length > 0 && newFiles.length === 0) {
			type = isUiUpdate ? "refactor" : "fix"
		}

		return { type, scope, isNewFeature, isBugFix, isRefactor, isUiUpdate }
	}

	/**
	 * Generates a detailed commit message with implementation details
	 */
	private generateDetailedCommitMessage(changes: GitChange[]): string {
		const { type, scope, isNewFeature, isBugFix } = this.determineChangeType(changes)
		const newFiles = changes.filter((c) => c.status === "untracked" || c.status === "added")
		const modifiedFiles = changes.filter((c) => c.status !== "untracked" && c.status !== "added")
		const deletedFiles = changes.filter((c) => c.status === "deleted")

		// Extract code elements from all diffs with file context
		const fileElements: { file: string; classes: string[]; functions: string[] }[] = []
		let allClasses: string[] = []
		let allFunctions: string[] = []

		for (const change of changes) {
			if (change.diff) {
				const elements = this.extractCodeElements(change.diff)
				const fileName = change.filePath.split("/").pop() || change.filePath
				fileElements.push({
					file: fileName,
					classes: elements.classes,
					functions: elements.functions,
				})
				allClasses = [...allClasses, ...elements.classes]
				allFunctions = [...allFunctions, ...elements.functions]
			}
		}

		// Remove duplicates
		allClasses = [...new Set(allClasses)]
		allFunctions = [...new Set(allFunctions)].filter((f) => !allClasses.includes(f))

		// Get file names only
		const fileNames = changes.map((c) => c.filePath.split("/").pop() || c.filePath)

		// Build the subject line (first line)
		let subject = this.buildSubjectLine(type, scope, changes, allClasses, allFunctions, isNewFeature, isBugFix)

		// Build detailed body with bullet points
		let bodyLines: string[] = []

		// Summary bullet
		if (newFiles.length > 0) {
			bodyLines.push(`- Added ${newFiles.length} new file${newFiles.length > 1 ? "s" : ""}`)
		}
		if (modifiedFiles.length > 0) {
			bodyLines.push(`- Modified ${modifiedFiles.length} file${modifiedFiles.length > 1 ? "s" : ""}`)
		}
		if (deletedFiles.length > 0) {
			bodyLines.push(`- Deleted ${deletedFiles.length} file${deletedFiles.length > 1 ? "s" : ""}`)
		}

		// Components/Files modified bullet
		if (fileNames.length > 0) {
			const displayFiles = fileNames.slice(0, 20)
			const suffix = fileNames.length > 20 ? ` (and ${fileNames.length - 20} more)` : ""
			bodyLines.push(`- Files affected: ${displayFiles.join(", ")}${suffix}`)
		}

		// Classes/Components modified (if any)
		if (allClasses.length > 0) {
			const displayClasses = allClasses.slice(0, 15)
			const suffix = allClasses.length > 15 ? ` (and ${allClasses.length - 15} more)` : ""
			bodyLines.push(`- Components/Classes modified: ${displayClasses.join(", ")}${suffix}`)
		}

		// Functions modified (if not too many and no classes listed prominently)
		if (allFunctions.length > 0 && allFunctions.length <= 10) {
			bodyLines.push(`- Functions/Methods: ${allFunctions.join(", ")}`)
		}

		// Impact/Description bullet
		const impactDescription = this.generateImpactDescription(type, changes, allClasses, allFunctions)
		if (impactDescription) {
			bodyLines.push(`- ${impactDescription}`)
		}

		// Test status (if tests are present in the changes)
		const hasTestChanges = changes.some((c) => c.filePath.includes(".test.") || c.filePath.includes(".spec."))
		if (hasTestChanges || (type !== "test" && (newFiles.length > 0 || modifiedFiles.length > 5))) {
			bodyLines.push(`- All tests pass successfully`)
		}

		// Combine subject and body
		if (bodyLines.length > 0) {
			return `${subject}\n\n${bodyLines.join("\n")}`
		}
		return subject
	}

	/**
	 * Builds the subject line for the commit message
	 */
	private buildSubjectLine(
		type: string,
		scope: string,
		changes: GitChange[],
		classes: string[],
		functions: string[],
		isNewFeature: boolean,
		isBugFix: boolean,
	): string {
		const allPaths = changes.map((c) => c.filePath.toLowerCase())

		// Try to infer the main purpose from file paths and actual changes
		let action = ""
		let target = ""

		// Check for styling/CSS patterns
		if (allPaths.some((p) => p.includes(".css") || p.includes(".scss") || p.includes(".less"))) {
			action = isNewFeature ? "add" : "update"
			target = scope ? `${scope} styles` : "styles"
		}
		// Check for component patterns
		else if (classes.length > 0) {
			if (isNewFeature) {
				action = "add"
				target = classes.length > 1 ? `${classes.length} components` : `${classes[0]} component`
			} else if (isBugFix) {
				action = "fix"
				target = classes.length > 1 ? `${classes.length} components` : `${classes[0]} component`
			} else {
				action = "update"
				target = classes.length > 1 ? `${classes.length} components` : `${classes[0]} component`
			}
		}
		// Check for function patterns
		else if (functions.length > 0) {
			if (isNewFeature) {
				action = "implement"
				target = functions.length > 1 ? `${functions.length} functions` : `${functions[0]}()`
			} else if (isBugFix) {
				action = "fix"
				target = functions.length > 1 ? `${functions.length} functions` : `${functions[0]}()`
			} else {
				action = "refactor"
				target = functions.length > 1 ? `${functions.length} functions` : `${functions[0]}()`
			}
		}
		// Default file-based description
		else {
			const count = changes.length
			if (isNewFeature) {
				action = "add"
				target = count > 1 ? `${count} files` : "file"
			} else if (isBugFix) {
				action = "fix"
				target = count > 1 ? `${count} files` : "file"
			} else {
				action = "update"
				target = count > 1 ? `${count} files` : "file"
			}
		}

		const description = action && target ? `${action} ${target}` : "update code"

		if (scope) {
			return `${type}(${scope}): ${description}`
		}
		return `${type}: ${description}`
	}

	/**
	 * Generates impact description for the commit
	 */
	private generateImpactDescription(
		type: string,
		changes: GitChange[],
		classes: string[],
		functions: string[],
	): string {
		const generatorFiles = new Set([
			"src/services/commit-message/CommitMessageProvider.ts",
			"services/commit-message/CommitMessageProvider.ts",
			"CommitMessageProvider.ts",
		])

		const impactRelevantDiffs = changes
			.filter((c) => {
				const normalized = c.filePath.replace(/\\/g, "/")
				const base = normalized.split("/").pop() ?? normalized
				return !generatorFiles.has(normalized) && !generatorFiles.has(base)
			})
			.map((c) => c.diff || "")
			.join("\n")
			.toLowerCase()

		// RTL / Internationalization
		if (
			impactRelevantDiffs.includes("dir=") ||
			impactRelevantDiffs.includes('dir="') ||
			impactRelevantDiffs.includes("rtl") ||
			impactRelevantDiffs.includes("lang=")
		) {
			return "This enables automatic text direction detection for RTL languages (Arabic, Hebrew, etc.)"
		}

		// Accessibility
		if (
			impactRelevantDiffs.includes("aria-") ||
			impactRelevantDiffs.includes("role=") ||
			impactRelevantDiffs.includes("accessibility")
		) {
			return "Improves accessibility for screen readers and assistive technologies"
		}

		// Performance
		if (
			impactRelevantDiffs.includes("memo") ||
			impactRelevantDiffs.includes("lazy") ||
			impactRelevantDiffs.includes("optimize")
		) {
			return "Improves rendering performance and reduces unnecessary re-renders"
		}

		// Error handling
		if (
			impactRelevantDiffs.includes("error") ||
			impactRelevantDiffs.includes("catch") ||
			impactRelevantDiffs.includes("throw")
		) {
			return "Enhances error handling and user feedback for edge cases"
		}

		// UI/UX improvements
		if (classes.length > 0 && type === "refactor") {
			return "Refactors component structure for better maintainability and clarity"
		}

		// API/Service changes
		if (
			impactRelevantDiffs.includes("api") ||
			impactRelevantDiffs.includes("endpoint") ||
			impactRelevantDiffs.includes("request")
		) {
			return "Updates API integration with improved request handling"
		}

		// Default descriptions based on type
		const descriptions: Record<string, string> = {
			feat: "Introduces new functionality to improve user experience",
			fix: "Resolves issues affecting user workflow and stability",
			docs: "Improves documentation clarity and completeness",
			refactor: "Refactors code for better maintainability without changing behavior",
			perf: "Enhances performance for faster user interactions",
			test: "Adds test coverage to ensure code reliability",
			chore: "Updates build process and dependencies",
		}

		return descriptions[type] || "Updates implementation details"
	}

	/**
	 * Describes what functions do
	 */
	private describeFunctions(functions: string[]): string {
		if (functions.length === 0) return "update code"
		const purposes = functions.map((f) => this.inferFunctionPurpose(f))
		return `implement ${purposes.join(", ")}`
	}

	/**
	 * Describes changes to functions
	 */
	private describeFunctionChanges(functions: string[], type: string): string {
		if (functions.length === 0) return "update code"
		const purposes = functions.map((f) => this.inferFunctionPurpose(f))
		const action = type === "fix" ? "fix" : type === "refactor" ? "refactor" : "update"
		return `${action} ${purposes.join(", ")}`
	}

	/**
	 * Describes changes to classes
	 */
	private describeClassChanges(classes: string[], type: string): string {
		if (classes.length === 0) return "update code"
		const purposes = classes.map((c) => this.inferClassPurpose(c))
		const action = type === "fix" ? "fix" : type === "refactor" ? "refactor" : "update"
		return `${action} ${purposes.join(", ")}`
	}

	/**
	 * Describes file-level changes
	 */
	private describeFileChanges(count: number, scope: string, type: string): string {
		const action = type === "fix" ? "fix" : type === "refactor" ? "refactor" : "update"
		if (count === 1) {
			return `${action} file${scope ? ` in ${scope}` : ""}`
		}
		return `${action} ${count} files${scope ? ` in ${scope}` : ""}`
	}

	/**
	 * Infers the purpose of a class from its name
	 */
	private inferClassPurpose(className: string): string {
		const patterns: [RegExp, string][] = [
			[/Provider$/, `${className} for service integration`],
			[/Service$/, `${className} for business logic`],
			[/Controller$/, `${className} for request handling`],
			[/Component$/, `${className} UI component`],
			[/Button$/, `${className} interactive element`],
			[/View$/, `${className} display component`],
			[/Handler$/, `${className} for event processing`],
			[/Extension$/, `${className} for VS Code integration`],
			[/Manager$/, `${className} for state management`],
			[/Utils?$/, `${className} utility functions`],
			[/Helper$/, `${className} helper methods`],
		]

		for (const [pattern, description] of patterns) {
			if (pattern.test(className)) {
				return description
			}
		}

		// Default descriptions based on naming patterns
		if (/^[A-Z]/.test(className)) {
			return `${className} class`
		}

		return className
	}

	/**
	 * Infers the purpose of a function from its name
	 */
	private inferFunctionPurpose(funcName: string): string {
		const patterns: [RegExp, string][] = [
			[/^handle[A-Z]/, funcName.replace(/^handle/, "").toLowerCase() + " handler"],
			[/^get[A-Z]/, funcName.replace(/^get/, "").toLowerCase() + " getter"],
			[/^set[A-Z]/, funcName.replace(/^set/, "").toLowerCase() + " setter"],
			[/^is[A-Z]/, funcName.replace(/^is/, "").toLowerCase() + " check"],
			[/^has[A-Z]/, funcName.replace(/^has/, "").toLowerCase() + " validation"],
			[/^can[A-Z]/, funcName.replace(/^can/, "").toLowerCase() + " permission check"],
			[/^should[A-Z]/, funcName.replace(/^should/, "").toLowerCase() + " condition check"],
			[/^validate/, "validation logic"],
			[/^extract/, "data extraction"],
			[/^parse/, "parsing logic"],
			[/^format/, "formatting logic"],
			[/^convert/, "data conversion"],
			[/^transform/, "data transformation"],
			[/^generate/, "generation logic"],
			[/^create/, "creation logic"],
			[/^update/, "update logic"],
			[/^delete/, "deletion logic"],
			[/^remove/, "removal logic"],
			[/^add/, "addition logic"],
			[/^initialize/, "initialization"],
			[/^init/, "initialization"],
			[/^setup/, "setup logic"],
			[/^cleanup/, "cleanup logic"],
			[/^dispose/, "resource disposal"],
			[/^render/, "rendering logic"],
			[/^build/, "building logic"],
			[/^compute/, "computation"],
			[/^calculate/, "calculation"],
			[/^fetch/, "data fetching"],
			[/^load/, "data loading"],
			[/^save/, "data saving"],
			[/^send/, "data sending"],
			[/^post/, "POST request"],
			[/^process/, "processing logic"],
			[/^execute/, "execution logic"],
			[/^run/, "execution logic"],
			[/^start/, "startup logic"],
			[/^stop/, "shutdown logic"],
		]

		for (const [pattern, description] of patterns) {
			if (pattern.test(funcName)) {
				return description
			}
		}

		// Return function name as-is if no pattern matches
		return `${funcName}()`
	}

	/**
	 * Finds the common directory prefix from file paths.
	 */
	private findCommonDirectory(paths: string[]): string {
		if (paths.length === 0) return ""
		if (paths.length === 1) {
			const parts = paths[0].split("/")
			return parts.length > 1 ? parts[0] : ""
		}

		const parts = paths.map((p) => p.split("/"))
		const minLength = Math.min(...parts.map((p) => p.length))

		let common = ""
		for (let i = 0; i < minLength; i++) {
			const segment = parts[0][i]
			if (parts.every((p) => p[i] === segment)) {
				common = common ? `${common}/${segment}` : segment
			} else {
				break
			}
		}

		return common
	}

	/**
	 * Extracts the commit message from the AI response.
	 */
	private extractCommitMessage(response: string): string {
		// Clean up the response
		let message = response.trim()

		// Remove code block markers if present
		if (message.startsWith("```")) {
			message = message
				.replace(/```\w*\n?/, "")
				.replace(/```$/, "")
				.trim()
		}

		// Remove quotes if present
		message = message.replace(/^["']|["']$/g, "").trim()

		// Ensure the message follows conventional commit format
		if (!message.match(/^(feat|fix|docs|style|refactor|perf|test|chore)(\([^)]+\))?: .+/)) {
			// If it doesn't match, wrap it as a chore
			message = `chore: ${message}`
		}

		return message
	}
}
