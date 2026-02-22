import React from "react"
import { GitCommit } from "lucide-react"

import { cn } from "@src/lib/utils"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { StandardTooltip } from "@src/components/ui"

interface CommitButtonProps {
	className?: string
}

export const CommitButton: React.FC<CommitButtonProps> = ({ className }) => {
	const { t } = useAppTranslation()

	const handleCommitClick = () => {
		vscode.postMessage({
			type: "generateCommitMessage",
		})
	}

	return (
		<StandardTooltip content={t("chat:commitButton.tooltip")}>
			<button
				onClick={handleCommitClick}
				aria-label={t("chat:commitButton.label")}
				className={cn(
					"relative inline-flex items-center justify-center",
					"bg-transparent border-none p-1.5",
					"rounded-md min-w-[28px] min-h-[28px]",
					"text-vscode-foreground opacity-85",
					"transition-all duration-150",
					"hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)]",
					"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
					"active:bg-[rgba(255,255,255,0.1)]",
					"cursor-pointer",
					className,
				)}>
				<GitCommit className="w-4 h-4" />
			</button>
		</StandardTooltip>
	)
}
