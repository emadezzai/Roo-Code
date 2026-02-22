import * as vscode from "vscode"
import * as path from "path"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

export interface GitChange {
	filePath: string
	status: string
	diff: string
}

/**
 * Service for interacting with the Git extension and repository.
 * Provides methods for gathering staged changes and setting commit messages.
 */
export class GitExtensionService {
	private gitExtension: any | undefined
	private gitApi: any | undefined

	/**
	 * Initializes the Git extension service by getting the Git extension API.
	 * @returns Promise<boolean> True if initialization succeeded, false otherwise.
	 */
	public async initialize(): Promise<boolean> {
		try {
			this.gitExtension = vscode.extensions.getExtension("vscode.git")?.exports
			if (!this.gitExtension) {
				return false
			}

			this.gitApi = this.gitExtension.getAPI(1)
			return !!this.gitApi
		} catch (error) {
			console.error("Failed to initialize Git extension:", error)
			return false
		}
	}

	/**
	 * Gets the first Git repository in the workspace.
	 * @returns The Git repository or undefined if not found.
	 */
	private getRepository(): any | undefined {
		if (!this.gitApi) {
			return undefined
		}
		return this.gitApi.repositories[0]
	}

	/**
	 * Gathers staged changes from the Git repository.
	 * @returns Promise<GitChange[] | null> Array of staged changes or null if no repository found.
	 */
	public async gatherStagedChanges(): Promise<GitChange[] | null> {
		const repo = this.getRepository()
		if (!repo) {
			return null
		}

		const changes: GitChange[] = []
		const stagedFiles: string[] = []

		// Get staged file paths
		for (const group of repo.state.workingTreeChanges) {
			// staged changes have status 1 (index) != status 2 (working tree)
			// For staged changes, we check if the file is in the index
			if (group.status !== 0) {
				stagedFiles.push(group.uri.fsPath)
			}
		}

		// Also check indexChanges for explicitly staged files
		for (const change of repo.state.indexChanges) {
			stagedFiles.push(change.uri.fsPath)
		}

		if (stagedFiles.length === 0) {
			return []
		}

		// Get workspace root
		const workspaceRoot = repo.rootUri.fsPath

		// Get diff for staged changes
		try {
			const { stdout } = await execAsync("git diff --cached", { cwd: workspaceRoot })
			const diffOutput = stdout

			// Parse the diff output to extract individual file diffs
			const fileDiffs = this.parseDiffOutput(diffOutput, stagedFiles)

			for (const filePath of stagedFiles) {
				const relativePath = path.relative(workspaceRoot, filePath)
				changes.push({
					filePath: relativePath,
					status: this.getFileStatus(repo, filePath),
					diff: fileDiffs[relativePath] || "",
				})
			}
		} catch (error) {
			console.error("Error getting staged diff:", error)
			// Still return changes even if diff fails
			for (const filePath of stagedFiles) {
				const relativePath = path.relative(workspaceRoot, filePath)
				changes.push({
					filePath: relativePath,
					status: this.getFileStatus(repo, filePath),
					diff: "",
				})
			}
		}

		return changes
	}

	/**
	 * Gets the status of a file in the repository.
	 */
	private getFileStatus(repo: any, filePath: string): string {
		const relativePath = path.relative(repo.rootUri.fsPath, filePath)

		// Check index changes
		for (const change of repo.state.indexChanges) {
			const changePath = path.relative(repo.rootUri.fsPath, change.uri.fsPath)
			if (changePath === relativePath) {
				return this.mapGitStatus(change.status)
			}
		}

		// Check working tree changes
		for (const change of repo.state.workingTreeChanges) {
			const changePath = path.relative(repo.rootUri.fsPath, change.uri.fsPath)
			if (changePath === relativePath) {
				return this.mapGitStatus(change.status)
			}
		}

		return "modified"
	}

	/**
	 * Maps Git status codes to human-readable strings.
	 */
	private mapGitStatus(status: number): string {
		switch (status) {
			case 1:
				return "index"
			case 2:
				return "working tree"
			case 3:
				return "untracked"
			case 4:
				return "conflict"
			case 5:
				return "ignored"
			default:
				return "modified"
		}
	}

	/**
	 * Parses the diff output and maps diffs to file paths.
	 */
	private parseDiffOutput(diffOutput: string, filePaths: string[]): Record<string, string> {
		const fileDiffs: Record<string, string> = {}
		const lines = diffOutput.split("\n")
		let currentFile = ""
		let currentDiff: string[] = []

		for (const line of lines) {
			// Check for diff --git line which indicates a new file
			const match = line.match(/^diff --git a\/(.+) b\/(.+)$/)
			if (match) {
				// Save previous file's diff
				if (currentFile && currentDiff.length > 0) {
					fileDiffs[currentFile] = currentDiff.join("\n")
				}
				// Start new file
				currentFile = match[2] // Use b/ path (new path)
				currentDiff = [line]
			} else if (currentFile) {
				currentDiff.push(line)
			}
		}

		// Save the last file's diff
		if (currentFile && currentDiff.length > 0) {
			fileDiffs[currentFile] = currentDiff.join("\n")
		}

		return fileDiffs
	}

	/**
	 * Sets the commit message in the Source Control input box.
	 */
	public setCommitMessage(message: string): void {
		const repo = this.getRepository()
		if (repo && repo.inputBox) {
			repo.inputBox.value = message
		}
	}

	/**
	 * Gets the commit context string from staged changes.
	 */
	public getCommitContext(changes: GitChange[]): string {
		if (changes.length === 0) {
			return ""
		}

		const context: string[] = []
		context.push("Files changed:")

		for (const change of changes) {
			context.push(`- ${change.filePath} (${change.status})`)
		}

		context.push("\nDetailed changes:")

		for (const change of changes) {
			if (change.diff) {
				context.push(`\n--- ${change.filePath} ---`)
				context.push(change.diff)
			}
		}

		return context.join("\n")
	}
}
