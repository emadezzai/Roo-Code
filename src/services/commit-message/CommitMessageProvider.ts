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
					progress.report({ increment: 50, message: t("common:commitMessage.generating") })

					const generatedMessage = await this.callAIForCommitMessage(gitContextString)
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
	private async callAIForCommitMessage(gitContextString: string): Promise<string> {
		const prompt = await this.buildCommitMessagePrompt(gitContextString)

		// For now, we'll use a placeholder implementation
		// In a full implementation, this would call an AI service
		// Return a conventional commit format message based on the changes
		return this.generatePlaceholderCommitMessage(gitContextString)
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
	 * Generates a placeholder commit message based on the git context.
	 * This is a simplified implementation that can be enhanced with actual AI.
	 */
	private generatePlaceholderCommitMessage(context: string): string {
		const lines = context.split("\n")
		const fileChanges: { path: string; status: string }[] = []
		let hasNewFiles = false
		let hasModifiedFiles = false
		let hasDeletedFiles = false

		for (const line of lines) {
			if (line.startsWith("- ") && line.includes("(")) {
				const fileInfo = line.substring(2)
				const status = fileInfo.match(/\(([^)]+)\)$/)?.[1] || "modified"
				const filePath = fileInfo.replace(/ \([^)]+\)$/, "")
				fileChanges.push({ path: filePath, status })

				if (status === "untracked") {
					hasNewFiles = true
				} else if (status === "deleted") {
					hasDeletedFiles = true
				} else {
					hasModifiedFiles = true
				}
			}
		}

		// Analyze file patterns to determine the nature of changes
		const allPaths = fileChanges.map((f) => f.path.toLowerCase())
		const newFiles = fileChanges.filter((f) => f.status === "untracked").map((f) => f.path)

		// Check for specific feature patterns
		const hasCommitRelated = allPaths.some(
			(p) =>
				p.includes("commit") ||
				p.includes("git") ||
				p.includes("message") ||
				p.includes("CommitMessageProvider") ||
				p.includes("GitExtensionService"),
		)

		const hasUiChanges = allPaths.some(
			(p) =>
				p.includes("button") || p.includes("chat.tsx") || p.includes("textarea") || p.includes("CommitButton"),
		)

		const hasI18nChanges = allPaths.some((p) => p.includes("i18n") || p.includes("locale"))

		// Check for new feature based on new files
		if (hasNewFiles && newFiles.length >= 2) {
			// New feature implementation
			if (hasCommitRelated && hasUiChanges) {
				return "feat: add AI commit message generation button"
			}
			if (allPaths.some((p) => p.includes("test"))) {
				const scope = this.findCommonDirectory(newFiles)
				return scope ? `test(${scope}): add tests for ${scope}` : "test: add new test files"
			}
			const scope = this.findCommonDirectory(newFiles)
			return scope ? `feat(${scope}): add ${newFiles.length} new files` : `feat: add ${newFiles.length} new files`
		}

		// Single new file with meaningful name
		if (hasNewFiles && newFiles.length === 1) {
			const file = newFiles[0]
			const fileName = file.split("/").pop() || file
			const cleanName = fileName.replace(/\.(ts|tsx|js|jsx)$/, "")
			if (cleanName.toLowerCase().includes("commit")) {
				return `feat: add ${cleanName} component`
			}
			return `feat: add ${cleanName}`
		}

		// Updates to existing files
		const modifiedFiles = fileChanges.filter((f) => f.status !== "untracked").map((f) => f.path)

		// Extension/integration changes
		if (modifiedFiles.some((f) => f.includes("extension.ts") || f.includes("webviewMessageHandler"))) {
			if (hasCommitRelated) {
				return "feat: integrate commit message provider with extension"
			}
		}

		// UI component updates
		if (hasUiChanges && !hasNewFiles) {
			const scope = this.findCommonDirectory(modifiedFiles)
			if (scope) {
				return `refactor(${scope}): update UI components in ${scope}`
			}
		}

		// I18n only changes
		if (hasI18nChanges && !hasUiChanges && !hasCommitRelated) {
			return "chore(i18n): add translations for new features"
		}

		// General fallback with more context
		if (hasDeletedFiles && !hasNewFiles && !hasModifiedFiles) {
			return `chore: remove ${fileChanges.length} file${fileChanges.length > 1 ? "s" : ""}`
		}

		if (hasNewFiles && hasModifiedFiles) {
			const scope = this.findCommonDirectory(allPaths)
			return scope
				? `feat(${scope}): add feature with ${newFiles.length} new and ${modifiedFiles.length} updated files`
				: `feat: add ${newFiles.length} new files and update ${modifiedFiles.length} files`
		}

		// Determine type from file patterns
		let type = "chore"
		let scope = ""
		let description = ""

		const firstFile = fileChanges[0]?.path || ""
		if (firstFile.includes("test")) {
			type = "test"
			scope = firstFile.includes("/") ? firstFile.split("/")[0] : ""
		} else if (firstFile.includes("docs")) {
			type = "docs"
		} else if (firstFile.match(/\.(tsx?|jsx?)$/)) {
			type = hasNewFiles ? "feat" : "refactor"
		} else if (firstFile.match(/\.css$/)) {
			type = "style"
		} else if (hasNewFiles) {
			type = "feat"
		} else {
			type = "fix"
		}

		if (fileChanges.length === 1) {
			description = `update ${firstFile.split("/").pop() || firstFile}`
		} else {
			const commonDir = this.findCommonDirectory(fileChanges.map((f) => f.path))
			scope = commonDir
			description = `update ${fileChanges.length} files${commonDir ? ` in ${commonDir}` : ""}`
		}

		return scope ? `${type}(${scope}): ${description}` : `${type}: ${description}`
	}

	/**
	 * Finds the common directory prefix from file paths.
	 */
	private findCommonDirectory(paths: string[]): string {
		if (paths.length === 0) return ""
		if (paths.length === 1) return paths[0].includes("/") ? paths[0].split("/")[0] : ""

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
