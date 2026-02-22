import { useState, useMemo, useCallback } from "react"
import { Fzf } from "fzf"
import { ChevronDown, Image } from "lucide-react"

import { cn } from "@/lib/utils"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"

import type { ModelRecord } from "@roo-code/types"

interface ModelSelectorProps {
	models: ModelRecord
	currentModelId: string
	onSelect: (modelId: string) => void
	disabled?: boolean
}

export const ModelSelector = ({ models, currentModelId, onSelect, disabled = false }: ModelSelectorProps) => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)
	const [searchValue, setSearchValue] = useState("")
	const portalContainer = useRooPortal("roo-portal")

	// Convert models record to array for display
	const modelEntries = useMemo(() => {
		return Object.entries(models).map(([id, info]) => ({
			id,
			...info,
		}))
	}, [models])

	// Create searchable items for fuzzy search
	const searchableItems = useMemo(
		() =>
			modelEntries.map((model) => ({
				original: model,
				searchStr: model.id,
			})),
		[modelEntries],
	)

	// Create Fzf instance
	const fzfInstance = useMemo(
		() => new Fzf(searchableItems, { selector: (item) => item.searchStr }),
		[searchableItems],
	)

	// Filter models based on search
	const filteredModels = useMemo(() => {
		if (!searchValue) {
			return modelEntries
		}
		const matchingItems = fzfInstance.find(searchValue).map((result) => result.item.original)
		return matchingItems
	}, [modelEntries, searchValue, fzfInstance])

	const handleSelect = useCallback(
		(modelId: string) => {
			onSelect(modelId)
			setOpen(false)
			setSearchValue("")
		},
		[onSelect],
	)

	// Get current model info
	const currentModel = models[currentModelId]
	const displayName = currentModelId?.split("/").pop() || currentModelId || "Select Model"

	// Format context window for display
	const formatContextWindow = (contextWindow: number | undefined) => {
		if (!contextWindow) return ""
		if (contextWindow >= 1_000_000) {
			return `${(contextWindow / 1_000_000).toFixed(1)}M`
		}
		if (contextWindow >= 1_000) {
			return `${Math.round(contextWindow / 1_000)}K`
		}
		return contextWindow.toString()
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<StandardTooltip content={t("chat:selectModel")}>
				<PopoverTrigger
					disabled={disabled || modelEntries.length === 0}
					className={cn(
						"inline-flex items-center gap-1 px-2 py-1 text-xs",
						"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
						"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
						disabled || modelEntries.length === 0
							? "opacity-50 cursor-not-allowed"
							: "opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer",
					)}>
					<span className="truncate max-w-[120px]" title={currentModelId}>
						{displayName}
					</span>
					{currentModel?.supportsImages && <Image className="w-3 h-3 text-vscode-descriptionForeground" />}
					<ChevronDown className="w-3 h-3 text-vscode-descriptionForeground" />
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="p-0 overflow-hidden w-[400px]">
				<div className="flex flex-col w-full">
					{/* Search input */}
					<div className="relative p-2 border-b border-vscode-dropdown-border">
						<input
							aria-label={t("common:ui.search_placeholder")}
							value={searchValue}
							onChange={(e) => setSearchValue(e.target.value)}
							placeholder={t("common:ui.search_placeholder")}
							className="w-full h-8 px-2 py-1 text-xs bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded focus:outline-0"
							autoFocus
						/>
						{searchValue.length > 0 && (
							<div className="absolute right-4 top-0 bottom-0 flex items-center justify-center">
								<span
									className="codicon codicon-close text-vscode-input-foreground opacity-50 hover:opacity-100 text-xs cursor-pointer"
									onClick={() => setSearchValue("")}
								/>
							</div>
						)}
					</div>

					{/* Model list */}
					{filteredModels.length === 0 ? (
						<div className="py-2 px-3 text-sm text-vscode-foreground/70">{t("common:ui.no_results")}</div>
					) : (
						<div className="max-h-[300px] overflow-y-auto">
							{filteredModels.map((model) => {
								const isCurrentModel = model.id === currentModelId
								const contextWindow = formatContextWindow(model.contextWindow)

								return (
									<div
										key={model.id}
										onClick={() => handleSelect(model.id)}
										className={cn(
											"px-3 py-2 text-sm cursor-pointer flex items-center gap-2",
											"hover:bg-vscode-list-hoverBackground",
											isCurrentModel &&
												"bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground",
										)}>
										<div className="flex-1 min-w-0 flex flex-col gap-0.5">
											<div className="flex items-center gap-2">
												<span className="truncate font-medium">
													{model.id.split("/").pop() || model.id}
												</span>
												{model.supportsImages && (
													<span className="text-[10px] px-1 py-0.5 bg-vscode-badge-background text-vscode-badge-foreground rounded">
														img
													</span>
												)}
											</div>
											<div className="flex items-center gap-2 text-xs text-vscode-descriptionForeground">
												<span>ctx: {contextWindow}</span>
												{model.maxTokens && (
													<span>· max: {model.maxTokens.toLocaleString()}</span>
												)}
											</div>
										</div>
										{isCurrentModel && (
											<div className="size-5 p-1 flex items-center justify-center flex-shrink-0">
												<span className="codicon codicon-check text-xs" />
											</div>
										)}
									</div>
								)
							})}
						</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	)
}
