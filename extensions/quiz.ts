import { completeSimple, type ThinkingLevel } from "@mariozechner/pi-ai";
import {
	BorderedLoader,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@mariozechner/pi-tui";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

type ScopeKind = "workset" | "session" | "repo" | "file";
type SourceKind = "conversation" | "file" | "readme" | "tree";
type Lens = "abstraction" | "usage" | "mechanism" | "assumption" | "change" | "debugging";
type Depth = "foundational" | "intermediate" | "subtle" | "transfer";

type SessionBranchEntry = {
	type?: string;
	details?: unknown;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
		details?: unknown;
	};
};

interface ResolvedScope {
	kind: ScopeKind;
	label: string;
	path?: string;
	absPath?: string;
}

interface SourceItem {
	id: string;
	kind: SourceKind;
	title: string;
	content: string;
	fingerprint: string;
	path?: string;
	language?: string;
}

interface QuizCardSnippet {
	sourceId?: string;
	title?: string;
	path?: string;
	startLine?: number;
	endLine?: number;
	language?: string;
	code?: string;
}

interface QuizCard {
	id: string;
	question: string;
	lens: Lens;
	depth: Depth;
	sourceIds: string[];
	snippet?: QuizCardSnippet;
	hint?: string;
	idealAnswer: string;
	whyMatters?: string;
	misconception?: string;
}

interface QuizPacket {
	version: 1;
	scope: {
		kind: ScopeKind;
		label: string;
		path?: string;
	};
	generatedAt: string;
	sourceSummary: string;
	sourceRefs: Array<Pick<SourceItem, "id" | "kind" | "title" | "path" | "fingerprint" | "language">>;
	cards: QuizCard[];
}

interface QuizRunAnswer {
	cardId: string;
	answer?: string;
	viewedHint?: boolean;
	skipped?: boolean;
}

interface QuizRunRecord {
	completedAt: string;
	quitEarly: boolean;
	answers: QuizRunAnswer[];
	packet: QuizPacket;
}

type QuestionStageAction = "answer" | "reveal" | "skip" | "quit";
type RevealStageAction = "next" | "quit";

const MAX_CONVERSATION_MESSAGES = 8;
const MAX_TRACKED_FILES = 3;
const MAX_FILE_LINES = 220;
const MAX_FILE_BYTES = 40_000;
const MAX_REPO_TREE_FILES = 200;
const CARD_COUNT = 4;

const LENS_VALUES = new Set<Lens>(["abstraction", "usage", "mechanism", "assumption", "change", "debugging"]);
const DEPTH_VALUES = new Set<Depth>(["foundational", "intermediate", "subtle", "transfer"]);

const CODE_FILE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".jl",
	".r",
	".java",
	".c",
	".cc",
	".cpp",
	".h",
	".hpp",
	".rs",
	".go",
	".hs",
	".sql",
]);

const SYSTEM_PROMPT = `You are an active code-reading tutor that creates short, high-value quizzes.

Audience and intent:
- The user is often more scientist / applied mathematician / engineer than conventional software developer.
- They want a tactile, operational feel for code: core abstractions, how to use them, what assumptions matter, what changes under perturbation, and where the conceptual seams are.
- They do NOT want generic software-process trivia unless it is truly central.

Your job:
- Create a short quiz that forces active engagement rather than passive recognition.
- Ask questions that probe real understanding and push the user toward better mental models.
- Use real source snippets as evidence when possible, but only in service of a question.
- Prefer questions about abstraction, usage/interface, mechanism/flow, assumptions/invariants, change impact, and debugging/failure modes.
- Include a mix of foundational and subtle questions.

Avoid:
- trivia about tests, CI, file layout, naming conventions, tooling, or line-number memory
- shallow \"what is the function name\" prompts
- questions that can be answered without reasoning about the provided sources

Output requirements:
- Return STRICT JSON only.
- Do not use markdown fences.
- Keep snippets short: ideally <= 20 lines.
- If you include snippet code, copy it from the provided sources rather than inventing it.
`;

const USAGE = [
	"/quiz",
	"/quiz workset",
	"/quiz session",
	"/quiz repo",
	"/quiz file <path>",
	"/quiz <path-to-file>",
].join("\n");

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function toReasoning(level: ReturnType<ExtensionAPI["getThinkingLevel"]>): ThinkingLevel | undefined {
	return level === "off" ? undefined : level;
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function trimText(text: string, max = 1400): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function displayPath(path: string): string {
	return path.split("\\").join("/");
}

function languageFromPath(path?: string): string | undefined {
	if (!path) return undefined;
	const ext = extname(path).toLowerCase();
	return (
		{
			".ts": "ts",
			".tsx": "tsx",
			".js": "js",
			".jsx": "jsx",
			".mjs": "js",
			".cjs": "js",
			".py": "python",
			".jl": "julia",
			".r": "r",
			".md": "md",
			".json": "json",
			".yaml": "yaml",
			".yml": "yaml",
			".toml": "toml",
			".sh": "bash",
			".zsh": "bash",
			".bash": "bash",
			".html": "html",
			".css": "css",
			".java": "java",
			".c": "c",
			".cc": "cpp",
			".cpp": "cpp",
			".h": "c",
			".hpp": "cpp",
			".rs": "rust",
			".go": "go",
			".hs": "haskell",
			".sql": "sql",
		} as Record<string, string>
	)[ext];
}

function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as { type?: string; text?: string };
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts;
}

function buildRecentConversationText(branch: SessionBranchEntry[]): string {
	const recentMessages = branch
		.filter((entry) => entry.type === "message" && entry.message?.role)
		.slice(-MAX_CONVERSATION_MESSAGES);

	const sections: string[] = [];
	for (const entry of recentMessages) {
		const role = entry.message?.role;
		if (!role) continue;
		const text = extractTextParts(entry.message?.content).join("\n").trim();
		if (!text) continue;
		if (role === "user") sections.push(`User: ${trimText(text, 1800)}`);
		else if (role === "assistant") sections.push(`Assistant: ${trimText(text, 1800)}`);
		else if (role === "toolResult") {
			const toolName = safeString(entry.message?.toolName) || "tool";
			sections.push(`Tool result (${toolName}): ${trimText(text, 900)}`);
		}
	}
	return sections.join("\n\n");
}

function trackedFilesFromDetails(details: unknown): string[] {
	if (!details || typeof details !== "object") return [];
	const candidate = details as { readFiles?: unknown; modifiedFiles?: unknown };
	const values = [candidate.modifiedFiles, candidate.readFiles].flatMap((value) => (Array.isArray(value) ? value : []));
	return values.filter((value): value is string => typeof value === "string");
}

function collectRecentTrackedFiles(branch: SessionBranchEntry[], cwd: string, limit = MAX_TRACKED_FILES): string[] {
	const seen = new Set<string>();
	const files: string[] = [];

	for (let i = branch.length - 1; i >= 0 && files.length < limit; i--) {
		const entry = branch[i];
		for (const details of [entry.details, entry.message?.details]) {
			for (const file of trackedFilesFromDetails(details)) {
				const absPath = resolve(cwd, file);
				if (seen.has(absPath)) continue;
				seen.add(absPath);
				if (!existsSync(absPath)) continue;
				try {
					if (!statSync(absPath).isFile()) continue;
					files.push(absPath);
					if (files.length >= limit) return files;
				} catch {
					// Ignore unreadable files.
				}
			}
		}
	}

	return files;
}

function getRepoRoot(cwd: string): string {
	try {
		return execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return cwd;
	}
}

function listTrackedFiles(repoRoot: string): string[] {
	try {
		const output = execSync("git ls-files", {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		const files: string[] = [];
		const visit = (dir: string, depth: number) => {
			if (depth > 4 || files.length >= MAX_REPO_TREE_FILES) return;
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") {
					continue;
				}
				const abs = join(dir, entry.name);
				if (entry.isDirectory()) visit(abs, depth + 1);
				else files.push(displayPath(relative(repoRoot, abs)));
				if (files.length >= MAX_REPO_TREE_FILES) return;
			}
		};
		visit(repoRoot, 0);
		return files;
	}
}

function isProbablyText(content: string): boolean {
	return !content.includes("\u0000");
}

function filePreview(absPath: string, repoRoot: string, maxLines = MAX_FILE_LINES): SourceItem | undefined {
	try {
		const size = statSync(absPath).size;
		let raw = readFileSync(absPath, "utf8");
		if (!isProbablyText(raw)) return undefined;
		if (raw.length > MAX_FILE_BYTES) raw = raw.slice(0, MAX_FILE_BYTES);
		const lines = raw.split("\n");
		const numbered = lines.slice(0, maxLines).map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`);
		if (lines.length > maxLines || size > MAX_FILE_BYTES) {
			numbered.push(`${String(numbered.length + 1).padStart(4, " ")} | ... [truncated for quiz generation]`);
		}

		const relPath = displayPath(relative(repoRoot, absPath));
		const content = numbered.join("\n");
		return {
			id: "",
			kind: relPath.toLowerCase().startsWith("readme") ? "readme" : "file",
			title: relPath,
			content,
			fingerprint: hashText(content),
			path: relPath,
			language: languageFromPath(relPath),
		};
	} catch {
		return undefined;
	}
}

function findReadme(repoRoot: string): string | undefined {
	for (const name of ["README.md", "README", "readme.md", "readme"]) {
		const absPath = join(repoRoot, name);
		if (existsSync(absPath)) return absPath;
	}
	return undefined;
}

function isLikelyCodeFile(path: string): boolean {
	return CODE_FILE_EXTENSIONS.has(extname(path).toLowerCase());
}

function representativeRepoFiles(repoRoot: string, recentFiles: string[], limit = MAX_TRACKED_FILES): string[] {
	const resolvedRecent = recentFiles
		.filter((file) => file.startsWith(repoRoot))
		.map((file) => displayPath(relative(repoRoot, file)))
		.filter(isLikelyCodeFile);
	if (resolvedRecent.length > 0) return resolvedRecent.slice(0, limit);

	const tracked = listTrackedFiles(repoRoot).filter(isLikelyCodeFile);
	const scored = tracked
		.map((file) => {
			let score = 0;
			if (file.startsWith("src/")) score += 10;
			if (file.startsWith("lib/")) score += 8;
			if (file.startsWith("app/")) score += 8;
			if (file.includes("index")) score += 2;
			if (file.includes("test") || file.includes("spec")) score -= 10;
			return { file, score };
		})
		.sort((a, b) => b.score - a.score || a.file.length - b.file.length || a.file.localeCompare(b.file));
	return scored.slice(0, limit).map((item) => item.file);
}

function addSource(sources: SourceItem[], source: Omit<SourceItem, "id">): void {
	sources.push({ ...source, id: `s${sources.length + 1}` });
}

function gatherSources(scope: ResolvedScope, ctx: ExtensionCommandContext, cwd: string, repoRoot: string): SourceItem[] {
	const branch = ctx.sessionManager.getBranch() as SessionBranchEntry[];
	const recentConversation = buildRecentConversationText(branch);
	const recentFiles = collectRecentTrackedFiles(branch, cwd);
	const sources: SourceItem[] = [];

	if ((scope.kind === "workset" || scope.kind === "session" || scope.kind === "file") && recentConversation) {
		addSource(sources, {
			kind: "conversation",
			title: "Recent session context",
			content: recentConversation,
			fingerprint: hashText(recentConversation),
		});
	}

	if (scope.kind === "file") {
		if (!scope.absPath) return sources;
		const fileSource = filePreview(scope.absPath, repoRoot);
		if (fileSource) addSource(sources, fileSource);
		return sources;
	}

	if (scope.kind === "workset" || scope.kind === "session") {
		for (const file of recentFiles.slice(0, MAX_TRACKED_FILES)) {
			const source = filePreview(file, repoRoot);
			if (source) addSource(sources, source);
		}
		return sources;
	}

	if (scope.kind === "repo") {
		const readmePath = findReadme(repoRoot);
		if (readmePath) {
			const readmeSource = filePreview(readmePath, repoRoot, 180);
			if (readmeSource) addSource(sources, { ...readmeSource, kind: "readme" });
		}

		const treeFiles = listTrackedFiles(repoRoot).slice(0, MAX_REPO_TREE_FILES);
		if (treeFiles.length > 0) {
			const treeText = treeFiles.map((file) => `- ${file}`).join("\n");
			addSource(sources, {
				kind: "tree",
				title: "Repo tree summary",
				content: treeText,
				fingerprint: hashText(treeText),
			});
		}

		for (const relPath of representativeRepoFiles(repoRoot, recentFiles)) {
			const absPath = join(repoRoot, relPath);
			const source = filePreview(absPath, repoRoot);
			if (source) addSource(sources, source);
		}
	}

	return sources;
}

function parseScopeArgs(args: string, cwd: string, repoRoot: string): { scope?: ResolvedScope; error?: string } {
	const trimmed = args.trim();
	if (!trimmed) return { scope: { kind: "workset", label: "Current workset" } };

	const [head, ...restParts] = trimmed.split(/\s+/);
	const tail = restParts.join(" ").trim();
	if (head === "workset") return { scope: { kind: "workset", label: "Current workset" } };
	if (head === "session") return { scope: { kind: "session", label: "Current session" } };
	if (head === "repo" || head === "codebase") return { scope: { kind: "repo", label: "Repository" } };
	if (head === "file") {
		if (!tail) return { error: `Missing file path.\n\nUsage:\n${USAGE}` };
		const absPath = resolve(cwd, tail);
		if (!existsSync(absPath) || !statSync(absPath).isFile()) return { error: `File not found: ${tail}` };
		return {
			scope: {
				kind: "file",
				label: `File: ${displayPath(relative(repoRoot, absPath))}`,
				path: displayPath(relative(repoRoot, absPath)),
				absPath,
			},
		};
	}

	const maybePath = resolve(cwd, trimmed);
	if (existsSync(maybePath) && statSync(maybePath).isFile()) {
		return {
			scope: {
				kind: "file",
				label: `File: ${displayPath(relative(repoRoot, maybePath))}`,
				path: displayPath(relative(repoRoot, maybePath)),
				absPath: maybePath,
			},
		};
	}

	return { error: `Unrecognized quiz scope: ${trimmed}\n\nUsage:\n${USAGE}` };
}

function buildQuizPrompt(scope: ResolvedScope, sources: SourceItem[]): string {
	const sourceText = sources
		.map((source) => {
			const meta = [
				`id=${source.id}`,
				`kind=${source.kind}`,
				`title=${JSON.stringify(source.title)}`,
				source.path ? `path=${JSON.stringify(source.path)}` : undefined,
			]
				.filter(Boolean)
				.join(" | ");
			return [`=== SOURCE ${meta} ===`, source.content, `=== END SOURCE ${source.id} ===`].join("\n");
		})
		.join("\n\n");

	const scopeGuidance =
		scope.kind === "repo"
			? "Bias toward architecture, boundaries, extension points, and how the codebase is meant to be used."
			: scope.kind === "file"
				? "Bias toward the file's core abstraction, how to use it, key mechanism, and subtle assumptions."
				: "Bias toward what the user is actively touching or has recently reasoned about.";

	return [
		`Scope: ${scope.kind}`,
		`Scope label: ${scope.label}`,
		scope.path ? `Scope path: ${scope.path}` : undefined,
		"",
		scopeGuidance,
		"",
		`Create ${CARD_COUNT} quiz cards.`,
		"Use a balanced mix. Aim for something like:",
		"- 1 abstraction / big-picture question",
		"- 1 usage / interface / contract question",
		"- 1 mechanism / flow question",
		"- 1 subtle assumption / change impact / failure mode question",
		"",
		"Each card should be answerable from the provided sources and should help the user build a durable mental model.",
		"",
		"Return JSON of the form:",
		JSON.stringify(
			{
				sourceSummary: "one short paragraph about what the quiz covers",
				cards: [
					{
						id: "q1",
						question: "string",
						lens: "abstraction | usage | mechanism | assumption | change | debugging",
						depth: "foundational | intermediate | subtle | transfer",
						sourceIds: ["s1"],
						snippet: {
							sourceId: "s1",
							title: "optional short label",
							path: "optional path",
							startLine: 1,
							endLine: 12,
							language: "optional language",
							code: "short copied snippet",
						},
						hint: "optional hint",
						idealAnswer: "concise but meaningful answer",
						whyMatters: "why this question matters for understanding",
						misconception: "optional common trap",
					},
				],
			},
			null,
			2,
		),
		"",
		"Provided sources:",
		"",
		sourceText,
	]
		.filter(Boolean)
		.join("\n");
}

function extractJsonPayload(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
	const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fenceMatch?.[1]) return fenceMatch[1].trim();
	const first = trimmed.indexOf("{");
	const last = trimmed.lastIndexOf("}");
	if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
	throw new Error("Model did not return JSON");
}

function fallbackSnippet(source?: SourceItem): QuizCardSnippet | undefined {
	if (!source || (source.kind !== "file" && source.kind !== "readme")) return undefined;
	const code = source.content.split("\n").slice(0, 12).join("\n");
	return {
		sourceId: source.id,
		title: source.title,
		path: source.path,
		language: source.language,
		code,
	};
}

function normalizePacket(raw: unknown, scope: ResolvedScope, sources: SourceItem[]): QuizPacket {
	if (!raw || typeof raw !== "object") throw new Error("Quiz payload was not an object");

	const sourceMap = new Map(sources.map((source) => [source.id, source]));
	const candidate = raw as { sourceSummary?: unknown; cards?: unknown };
	const rawCards = Array.isArray(candidate.cards) ? candidate.cards : [];

	const cards = rawCards
		.map((value, index): QuizCard | undefined => {
			if (!value || typeof value !== "object") return undefined;
			const card = value as Record<string, unknown>;
			const question = safeString(card.question);
			const idealAnswer = safeString(card.idealAnswer);
			if (!question || !idealAnswer) return undefined;

			const lens = safeString(card.lens);
			const depth = safeString(card.depth);
			const sourceIds = Array.isArray(card.sourceIds)
				? card.sourceIds.filter((item): item is string => typeof item === "string" && sourceMap.has(item))
				: [];
			const primarySource = sourceIds.length > 0 ? sourceMap.get(sourceIds[0]) : undefined;
			const rawSnippet =
				card.snippet && typeof card.snippet === "object" ? (card.snippet as Record<string, unknown>) : undefined;
			const snippet: QuizCardSnippet | undefined = rawSnippet
				? {
						sourceId: safeString(rawSnippet.sourceId) || sourceIds[0],
						title: safeString(rawSnippet.title) || primarySource?.title,
						path: safeString(rawSnippet.path) || primarySource?.path,
						startLine: typeof rawSnippet.startLine === "number" ? rawSnippet.startLine : undefined,
						endLine: typeof rawSnippet.endLine === "number" ? rawSnippet.endLine : undefined,
						language: safeString(rawSnippet.language) || primarySource?.language,
						code: safeString(rawSnippet.code),
				  }
				: fallbackSnippet(primarySource);

			const normalized: QuizCard = {
				id: safeString(card.id) || `q${index + 1}`,
				question,
				lens: LENS_VALUES.has((lens || "") as Lens) ? (lens as Lens) : "mechanism",
				depth: DEPTH_VALUES.has((depth || "") as Depth) ? (depth as Depth) : "intermediate",
				sourceIds,
				idealAnswer,
			};
			if (snippet) normalized.snippet = snippet;
			const hint = safeString(card.hint);
			if (hint) normalized.hint = hint;
			const whyMatters = safeString(card.whyMatters);
			if (whyMatters) normalized.whyMatters = whyMatters;
			const misconception = safeString(card.misconception);
			if (misconception) normalized.misconception = misconception;
			return normalized;
		})
		.filter((card): card is QuizCard => card !== undefined);

	if (cards.length === 0) throw new Error("Model returned no usable quiz cards");

	return {
		version: 1,
		scope: {
			kind: scope.kind,
			label: scope.label,
			path: scope.path,
		},
		generatedAt: new Date().toISOString(),
		sourceSummary:
			safeString(candidate.sourceSummary) ||
			`${scope.label}: ${sources
				.map((source) => source.title)
				.slice(0, 4)
				.join(", ")}`,
		sourceRefs: sources.map((source) => ({
			id: source.id,
			kind: source.kind,
			title: source.title,
			path: source.path,
			fingerprint: source.fingerprint,
			language: source.language,
		})),
		cards,
	};
}

async function generateQuizPacket(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	scope: ResolvedScope,
	sources: SourceItem[],
	signal: AbortSignal,
): Promise<QuizPacket> {
	if (!ctx.model) throw new Error("No active model selected");
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	const prompt = buildQuizPrompt(scope, sources);
	const reasoning = ctx.model.reasoning ? toReasoning(pi.getThinkingLevel()) : undefined;

	const response = await completeSimple(
		ctx.model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		},
		{
			apiKey,
			reasoning,
			maxTokens: 4000,
			signal,
		},
	);

	const responseText = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");

	const payload = JSON.parse(extractJsonPayload(responseText));
	return normalizePacket(payload, scope, sources);
}

class QuizCardPanel {
	private container: Container;
	private showHint = false;

	constructor(
		private theme: Theme,
		private scopeLabel: string,
		private card: QuizCard,
		private index: number,
		private total: number,
		private phase: "question" | "reveal",
		private done: (value: { action: QuestionStageAction | RevealStageAction; viewedHint?: boolean }) => void,
		private userAnswer?: string,
	) {
		this.container = this.buildContainer();
	}

	private titleText(): string {
		return this.theme.fg(
			"accent",
			this.theme.bold(`Quiz ${this.index}/${this.total} · ${this.card.lens} · ${this.card.depth}`),
		);
	}

	private metaText(): string {
		return this.theme.fg("muted", `Scope: ${this.scopeLabel}`);
	}

	private footerText(): string {
		if (this.phase === "question") {
			return this.theme.fg(
				"dim",
				this.card.hint
					? "a answer  ·  h hint  ·  r reveal  ·  s skip  ·  q quit"
					: "a answer  ·  r reveal  ·  s skip  ·  q quit",
			);
		}
		return this.theme.fg("dim", "n next  ·  q quit");
	}

	private renderMarkdown(): string {
		const sections: string[] = [];
		const snippet = this.card.snippet;
		if (snippet?.code) {
			const labelParts = [snippet.title, snippet.path].filter(Boolean);
			const lineRange =
				typeof snippet.startLine === "number" && typeof snippet.endLine === "number"
					? ` lines ${snippet.startLine}-${snippet.endLine}`
					: "";
			const label = labelParts.length > 0 ? `**Evidence:** ${labelParts.join(" · ")}${lineRange}` : "**Evidence**";
			const lang = snippet.language || languageFromPath(snippet.path) || "text";
			sections.push(`${label}\n\n` + "```" + `${lang}\n${snippet.code}\n` + "```");
		}

		sections.push(`### Question\n\n${this.card.question}`);

		if (this.phase === "question" && this.showHint && this.card.hint) {
			sections.push(`### Hint\n\n${this.card.hint}`);
		}

		if (this.phase === "reveal") {
			sections.push(`### Your answer\n\n${this.userAnswer ? this.userAnswer : "_No answer recorded._"}`);
			sections.push(`### Ideal answer\n\n${this.card.idealAnswer}`);
			if (this.card.whyMatters) sections.push(`### Why this matters\n\n${this.card.whyMatters}`);
			if (this.card.misconception) sections.push(`### Common trap\n\n${this.card.misconception}`);
		}

		return sections.join("\n\n");
	}

	private buildContainer(): Container {
		const container = new Container();
		container.addChild(new Text(this.titleText(), 1, 0));
		container.addChild(new Text(this.metaText(), 1, 0));
		container.addChild(new Markdown(this.renderMarkdown(), 1, 1, getMarkdownTheme()));
		container.addChild(new Text(this.footerText(), 1, 0));
		return container;
	}

	private rebuild(): void {
		this.container = this.buildContainer();
	}

	render(width: number): string[] {
		return this.container.render(width);
	}

	invalidate(): void {
		this.container.invalidate();
	}

	handleInput(data: string): void {
		const lower = data.length === 1 ? data.toLowerCase() : undefined;
		if (this.phase === "question") {
			if (lower === "h" && this.card.hint) {
				this.showHint = !this.showHint;
				this.rebuild();
				return;
			}
			if (lower === "a") return this.done({ action: "answer", viewedHint: this.showHint });
			if (lower === "r") return this.done({ action: "reveal", viewedHint: this.showHint });
			if (lower === "s") return this.done({ action: "skip", viewedHint: this.showHint });
			if (lower === "q" || matchesKey(data, "escape")) return this.done({ action: "quit", viewedHint: this.showHint });
			return;
		}

		if (lower === "n" || matchesKey(data, "enter")) return this.done({ action: "next" });
		if (lower === "q" || matchesKey(data, "escape")) return this.done({ action: "quit" });
	}
}

async function showQuestionStage(
	ctx: ExtensionCommandContext,
	packet: QuizPacket,
	card: QuizCard,
	index: number,
): Promise<{ action: QuestionStageAction; viewedHint: boolean }> {
	return ctx.ui.custom<{ action: QuestionStageAction; viewedHint: boolean }>((_, theme, __, done) =>
		new QuizCardPanel(
			theme,
			packet.scope.label,
			card,
			index,
			packet.cards.length,
			"question",
			(result) => done({ action: result.action as QuestionStageAction, viewedHint: Boolean(result.viewedHint) }),
		),
	);
}

async function showRevealStage(
	ctx: ExtensionCommandContext,
	packet: QuizPacket,
	card: QuizCard,
	index: number,
	userAnswer?: string,
): Promise<{ action: RevealStageAction }> {
	return ctx.ui.custom<{ action: RevealStageAction }>((_, theme, __, done) =>
		new QuizCardPanel(
			theme,
			packet.scope.label,
			card,
			index,
			packet.cards.length,
			"reveal",
			(result) => done({ action: result.action as RevealStageAction }),
			userAnswer,
		),
	);
}

async function runQuiz(packet: QuizPacket, ctx: ExtensionCommandContext): Promise<QuizRunRecord> {
	const answers: QuizRunAnswer[] = [];
	let quitEarly = false;

	for (let i = 0; i < packet.cards.length; i++) {
		const card = packet.cards[i];
		const questionResult = await showQuestionStage(ctx, packet, card, i + 1);
		if (questionResult.action === "quit") {
			quitEarly = true;
			break;
		}
		if (questionResult.action === "skip") {
			answers.push({ cardId: card.id, skipped: true, viewedHint: questionResult.viewedHint });
			continue;
		}

		let answer: string | undefined;
		if (questionResult.action === "answer") {
			const raw = await ctx.ui.editor(`Answer ${i + 1}/${packet.cards.length}`, "");
			answer = safeString(raw);
		}

		answers.push({ cardId: card.id, answer, viewedHint: questionResult.viewedHint });
		const revealResult = await showRevealStage(ctx, packet, card, i + 1, answer);
		if (revealResult.action === "quit") {
			quitEarly = true;
			break;
		}
	}

	return {
		completedAt: new Date().toISOString(),
		quitEarly,
		answers,
		packet,
	};
}

export default function activeCodeTutor(pi: ExtensionAPI) {
	pi.registerCommand("quiz", {
		description: "Generate an active code-understanding quiz for the current workset, session, repo, or file",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/quiz requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No active model selected", "error");
				return;
			}

			const cwd = process.cwd();
			const repoRoot = getRepoRoot(cwd);
			const { scope, error } = parseScopeArgs(args || "", cwd, repoRoot);
			if (!scope) {
				ctx.ui.notify(error || "Failed to resolve quiz scope", "error");
				return;
			}

			const sources = gatherSources(scope, ctx, cwd, repoRoot);
			if (sources.length === 0) {
				ctx.ui.notify(`No usable sources found for ${scope.label}`, "warning");
				return;
			}

			let generationError: string | undefined;
			const packet = await ctx.ui.custom<QuizPacket | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Generating quiz with ${ctx.model!.id} for ${scope.label}...`);
				loader.onAbort = () => done(null);

				generateQuizPacket(pi, ctx, scope, sources, loader.signal)
					.then(done)
					.catch((err) => {
						generationError = err instanceof Error ? err.message : String(err);
						done(null);
					});

				return loader;
			});

			if (!packet) {
				ctx.ui.notify(generationError || "Quiz generation cancelled", generationError ? "error" : "info");
				return;
			}

			pi.appendEntry("code-quiz.packet", packet);
			ctx.ui.notify(`Generated ${packet.cards.length} quiz cards for ${packet.scope.label}`, "info");

			const run = await runQuiz(packet, ctx);
			pi.appendEntry("code-quiz.run", run);

			const answered = run.answers.filter((answer) => !answer.skipped).length;
			const skipped = run.answers.filter((answer) => answer.skipped).length;
			const summary = run.quitEarly
				? `Quiz stopped early · answered ${answered} · skipped ${skipped}`
				: `Quiz complete · answered ${answered} · skipped ${skipped}`;
			ctx.ui.notify(summary, "info");
		},
	});
}
