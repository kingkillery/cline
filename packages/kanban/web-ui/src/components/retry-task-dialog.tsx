import { Pencil, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";

export type RetryMode = "fresh" | "worktree" | "edit";

interface RetryTaskDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	taskPrompt: string;
	onRetry: (mode: RetryMode, editedPrompt?: string) => void;
}

export function RetryTaskDialog({ open, onOpenChange, taskPrompt, onRetry }: RetryTaskDialogProps): React.ReactElement {
	const [isEditing, setIsEditing] = useState(false);
	const [editedPrompt, setEditedPrompt] = useState(taskPrompt);

	// Sync editedPrompt when the dialog opens with a new taskPrompt
	useEffect(() => {
		if (open) {
			setEditedPrompt(taskPrompt);
		}
	}, [open, taskPrompt]);

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) {
			setIsEditing(false);
			setEditedPrompt(taskPrompt);
		}
		onOpenChange(nextOpen);
	};

	if (isEditing) {
		return (
			<Dialog open={open} onOpenChange={handleOpenChange}>
				<DialogHeader title="Edit prompt & retry" />
				<DialogBody>
					<textarea
						className="w-full min-h-[120px] p-3 rounded-md bg-surface-2 border border-border text-text-primary text-sm resize-y focus:outline-none focus:border-border-focus"
						value={editedPrompt}
						onChange={(e) => setEditedPrompt(e.target.value)}
						autoFocus
					/>
				</DialogBody>
				<DialogFooter>
					<div className="flex gap-2 w-full">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setIsEditing(false);
								setEditedPrompt(taskPrompt);
							}}
						>
							Back
						</Button>
						<div className="flex-1" />
						<Button
							variant="default"
							size="sm"
							icon={<Play size={14} />}
							onClick={() => onRetry("fresh", editedPrompt)}
						>
							Fresh start
						</Button>
						<Button
							variant="primary"
							size="sm"
							icon={<RefreshCw size={14} />}
							onClick={() => onRetry("worktree", editedPrompt)}
						>
							On worktree
						</Button>
					</div>
				</DialogFooter>
			</Dialog>
		);
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogHeader title="Retry task" />
			<DialogBody>
				<p className="text-sm text-text-secondary m-0 mb-4">How do you want to retry this task?</p>
				<div className="flex flex-col gap-2">
					<button
						type="button"
						className="flex items-center gap-3 p-3 rounded-md bg-surface-2 hover:bg-surface-3 border border-border cursor-pointer text-left transition-colors"
						onClick={() => onRetry("fresh")}
					>
						<Play size={16} className="text-status-green shrink-0" />
						<div>
							<div className="text-sm font-medium text-text-primary">Play (fresh start)</div>
							<div className="text-xs text-text-secondary">
								Delete the worktree, create a new one, and rerun from scratch
							</div>
						</div>
					</button>
					<button
						type="button"
						className="flex items-center gap-3 p-3 rounded-md bg-surface-2 hover:bg-surface-3 border border-border cursor-pointer text-left transition-colors"
						onClick={() => onRetry("worktree")}
					>
						<RefreshCw size={16} className="text-status-blue shrink-0" />
						<div>
							<div className="text-sm font-medium text-text-primary">Play WT (keep worktree)</div>
							<div className="text-xs text-text-secondary">
								Rerun the task on the existing worktree with all current changes
							</div>
						</div>
					</button>
					<button
						type="button"
						className="flex items-center gap-3 p-3 rounded-md bg-surface-2 hover:bg-surface-3 border border-border cursor-pointer text-left transition-colors"
						onClick={() => setIsEditing(true)}
					>
						<Pencil size={16} className="text-status-orange shrink-0" />
						<div>
							<div className="text-sm font-medium text-text-primary">Edit & retry</div>
							<div className="text-xs text-text-secondary">Edit the prompt, then choose fresh or worktree</div>
						</div>
					</button>
				</div>
			</DialogBody>
		</Dialog>
	);
}
