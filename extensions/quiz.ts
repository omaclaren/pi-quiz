import { completeSimple, type ThinkingLevel } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import hljs from "highlight.js";
import { jsonrepair } from "jsonrepair";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

type ScopeKind = "workset" | "session" | "repo" | "file";
type SourceKind = "conversation" | "file" | "readme" | "manifest" | "tree";
type Lens = "abstraction" | "usage" | "mechanism" | "assumption" | "change" | "debugging";
type Depth = "foundational" | "intermediate" | "subtle" | "transfer";
type QuizAudience = "general" | "scientist" | "developer";

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

interface FileActivity {
	absPath: string;
	relPath: string;
	score: number;
	readCount: number;
	modifiedCount: number;
	mentionCount: number;
	lastSeenDistance: number;
}

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
	audience: QuizAudience;
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

interface QuizCompletionStats {
	answered: number;
	skipped: number;
	questionSetsCompleted: number;
}

interface QuizDiscussionMessage {
	role: "user" | "assistant";
	text: string;
	timestamp: string;
}

interface QuizRunAnswer {
	cardId: string;
	answer?: string;
	viewedHint?: boolean;
	skipped?: boolean;
	feedback?: QuizAnswerFeedback;
	discussion?: QuizDiscussionMessage[];
}

interface QuizRunRecord {
	completedAt: string;
	quitEarly: boolean;
	answers: QuizRunAnswer[];
	packet: QuizPacket;
	packets?: QuizPacket[];
}

interface QuizAnswerFeedback {
	assessment: "good" | "partial" | "miss";
	feedback: string;
	gotRight?: string[];
	missed?: string[];
	nextFocus?: string;
}

interface GlimpseQuizState {
	stage: "loading" | "question" | "evaluating" | "reveal" | "loading-more" | "complete";
	draftAnswer?: string;
	showHint?: boolean;
	feedback?: QuizAnswerFeedback;
	discussionOpen?: boolean;
	discussionDraft?: string;
	discussionPending?: boolean;
	discussionMessages?: QuizDiscussionMessage[];
	completionStats?: QuizCompletionStats;
}

interface GlimpseQuizLaunchResult {
	packet?: QuizPacket;
	run?: QuizRunRecord;
	error?: string;
}

type QuizThinkingLevel = "off" | ThinkingLevel;

interface ParsedQuizCommandArgs {
	scope?: ResolvedScope;
	thinkingLevel?: QuizThinkingLevel;
	audience: QuizAudience;
	error?: string;
}

let activeQuizClose: (() => void) | null = null;

let glimpseModulePromise: Promise<any> | null = null;

const MAX_CONVERSATION_MESSAGES = 8;
const MAX_TRACKED_FILES = 3;
const MAX_FILE_LINES = 220;
const MAX_FILE_BYTES = 40_000;
const MAX_REPO_TREE_FILES = 200;
const CARD_COUNT = 4;
const CODE_PREVIEW_HEAD_LINES = 60;
const CODE_PREVIEW_BLOCK_LINES = 18;
const CODE_PREVIEW_TAIL_LINES = 24;
const CODE_PREVIEW_MAX_BLOCKS = 4;
const SEGMENT_MERGE_GAP = 2;

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

const MANIFEST_FILE_NAMES = new Set([
	"package.json",
	"pyproject.toml",
	"project.toml",
	"cargo.toml",
	"go.mod",
	"requirements.txt",
	"setup.py",
	"setup.cfg",
	"environment.yml",
	"environment.yaml",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"cmakelists.txt",
	"makefile",
]);

const ROOT_MANIFEST_PRIORITY = [
	"package.json",
	"pyproject.toml",
	"Project.toml",
	"Cargo.toml",
	"go.mod",
	"requirements.txt",
	"setup.py",
	"setup.cfg",
	"environment.yml",
	"environment.yaml",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"CMakeLists.txt",
	"Makefile",
];

const SYSTEM_PROMPT = `You are an active code-reading tutor that creates short, high-value quizzes.

Audience and intent:
- The user is often more scientist / applied mathematician / engineer than conventional software developer.
- They want a tactile, operational feel for code: what is being represented, how it is used, how values move through the code, what assumptions matter, what changes under perturbation, and where the conceptual seams are.
- They do NOT want generic software-process trivia unless it is truly central.

Your job:
- Create a short quiz that forces active engagement rather than passive recognition.
- Ask questions that probe real understanding and push the user toward better mental models.
- Use real source snippets as evidence when possible, but only in service of a question.
- Prefer questions about abstraction, usage/interface, mechanism/flow, assumptions/invariants, change impact, and debugging/failure modes.
- Phrase questions in plain, direct language, like a thoughtful supervisor checking whether someone really understands the code.

Style requirements for questions:
- Prefer one clear conceptual probe per card.
- If a second clause is included, it should directly support the same idea rather than introduce a separate mini-question.
- Prefer concrete wording over abstract CS jargon.
- If you need to ask about an invariant or assumption, restate it in plain language.
- Use the actual names from the code when they clarify meaning; do not replace a named quantity with vague phrases like "the second variable".
- Favor operational prompts such as "how is this split?", "what comes back out?", "what decides X vs Y?", or "what would change if...".
- If a card includes a snippet, the question must be answerable from that displayed snippet. Do not ask about a second type, function, or quantity unless it is actually visible in the snippet.

Avoid:
- trivia about tests, CI, file layout, naming conventions, tooling, or line-number memory
- shallow \"what is the function name\" prompts
- questions that can be answered without reasoning about the provided sources
- awkwardly formal wording like \"What invariant must hold between A and B?\" when a clearer plain-language version is possible
- double-barrelled prompts that combine two distinct ideas into one question

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
	"/quiz repo --thinking off",
	"/quiz file src/foo.ts --thinking low",
	"/quiz repo --audience scientist",
	"/quiz repo --mode sci",
	"/quiz file src/foo.ts --audience developer --thinking low",
].join("\n");

const QUIZ_THINKING_LEVELS: QuizThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_QUIZ_AUDIENCE: QuizAudience = "general";
const QUIZ_GENERATION_MAX_ATTEMPTS = 2;
const QUIZ_AUDIENCE_ALIASES: Record<string, QuizAudience> = {
	general: "general",
	gen: "general",
	scientist: "scientist",
	sci: "scientist",
	developer: "developer",
	dev: "developer",
};

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function toReasoning(level: QuizThinkingLevel): ThinkingLevel | undefined {
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

const HIGHLIGHT_LANGUAGE_ALIASES: Record<string, string> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	md: "markdown",
	html: "xml",
	text: "plaintext",
};

function normalizeHighlightLanguage(language?: string): string | undefined {
	if (!language) return undefined;
	return HIGHLIGHT_LANGUAGE_ALIASES[language.toLowerCase()] || language.toLowerCase();
}

function stripLineNumberPrefix(line: string): string {
	return line.replace(/^\s*\d+\s\|\s?/, "");
}

function stripLineNumberPrefixes(text: string): string {
	return text
		.split("\n")
		.map((line) => stripLineNumberPrefix(line))
		.join("\n");
}

function looksLikeDefinitionLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return false;
	return [
		/^(export\s+)?(async\s+)?function\b/,
		/^(export\s+)?class\b/,
		/^(export\s+)?interface\b/,
		/^(export\s+)?type\b/,
		/^(export\s+)?enum\b/,
		/^(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/,
		/^def\b/,
		/^class\b/,
		/^function\b/,
		/^\w+\s*(<-|=)\s*function\b/,
		/^(struct|mutable struct|abstract type|module)\b/,
	].some((pattern) => pattern.test(trimmed));
}

function mergeSegments(segments: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
	const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: Array<{ start: number; end: number }> = [];
	for (const segment of sorted) {
		const last = merged[merged.length - 1];
		if (!last || segment.start > last.end + SEGMENT_MERGE_GAP) {
			merged.push({ ...segment });
		} else {
			last.end = Math.max(last.end, segment.end);
		}
	}
	return merged;
}

function renderLineSegments(lines: string[], segments: Array<{ start: number; end: number }>, maxLines: number): string {
	const merged = mergeSegments(segments);
	const rendered: string[] = [];
	let previousEnd = 0;
	for (const segment of merged) {
		if (segment.start > previousEnd + 1) {
			rendered.push(`${String(segment.start).padStart(4, " ")} | ...`);
		}
		for (let lineNumber = segment.start; lineNumber <= segment.end; lineNumber++) {
			rendered.push(`${String(lineNumber).padStart(4, " ")} | ${lines[lineNumber - 1]}`);
		}
		previousEnd = segment.end;
	}
	if (previousEnd < lines.length) {
		rendered.push(`${String(lines.length).padStart(4, " ")} | ... [truncated for quiz generation]`);
	}
	if (rendered.length > maxLines) {
		return [...rendered.slice(0, maxLines - 1), `${String(lines.length).padStart(4, " ")} | ... [truncated for quiz generation]`].join(
			"\n",
		);
	}
	return rendered.join("\n");
}

function buildCodePreviewContent(raw: string, maxLines: number): string {
	const lines = raw.split("\n");
	if (lines.length <= maxLines) {
		return lines.map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`).join("\n");
	}

	const segments: Array<{ start: number; end: number }> = [
		{ start: 1, end: Math.min(lines.length, CODE_PREVIEW_HEAD_LINES) },
	];

	let blocksAdded = 0;
	for (let i = 0; i < lines.length && blocksAdded < CODE_PREVIEW_MAX_BLOCKS; i++) {
		if (!looksLikeDefinitionLine(lines[i])) continue;
		const segment = {
			start: Math.max(1, i + 1 - 2),
			end: Math.min(lines.length, i + 1 + CODE_PREVIEW_BLOCK_LINES - 3),
		};
		const overlaps = segments.some(
			(existing) => !(segment.end < existing.start - SEGMENT_MERGE_GAP || segment.start > existing.end + SEGMENT_MERGE_GAP),
		);
		if (overlaps) continue;
		segments.push(segment);
		blocksAdded++;
	}

	if (lines.length > CODE_PREVIEW_TAIL_LINES) {
		segments.push({
			start: Math.max(1, lines.length - CODE_PREVIEW_TAIL_LINES + 1),
			end: lines.length,
		});
	}

	return renderLineSegments(lines, segments, maxLines);
}

function buildHeadPreviewContent(raw: string, maxLines: number, truncated: boolean): string {
	const lines = raw.split("\n");
	const rendered = lines.slice(0, maxLines).map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`);
	if (truncated) rendered.push(`${String(lines.length).padStart(4, " ")} | ... [truncated for quiz generation]`);
	return rendered.join("\n");
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

function detailsFileLists(details: unknown): { readFiles: string[]; modifiedFiles: string[] } {
	if (!details || typeof details !== "object") return { readFiles: [], modifiedFiles: [] };
	const candidate = details as { readFiles?: unknown; modifiedFiles?: unknown };
	return {
		readFiles: Array.isArray(candidate.readFiles)
			? candidate.readFiles.filter((value): value is string => typeof value === "string")
			: [],
		modifiedFiles: Array.isArray(candidate.modifiedFiles)
			? candidate.modifiedFiles.filter((value): value is string => typeof value === "string")
			: [],
	};
}

function isManifestLikePath(path: string): boolean {
	return MANIFEST_FILE_NAMES.has(basename(path).toLowerCase());
}

function isInterestingQuizFilePath(path: string): boolean {
	const lower = path.toLowerCase();
	return isLikelyCodeFile(path) || isManifestLikePath(path) || lower === "readme" || lower === "readme.md";
}

function resolveExistingFilePath(token: string, cwd: string, repoRoot: string): string | undefined {
	const cleaned = token.replace(/^[\s"'`(\[]+|[\s"'`),:;\]]+$/g, "");
	if (!cleaned) return undefined;
	const candidates = [resolve(cwd, cleaned), resolve(repoRoot, cleaned)];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Ignore unreadable files.
		}
	}
	return undefined;
}

function extractPathMentions(text: string, cwd: string, repoRoot: string): string[] {
	const matches = new Set<string>();
	const regex = /(?:^|[\s"'`(\[])([A-Za-z0-9_./-]+(?:\.[A-Za-z0-9_.-]+)+)(?=$|[\s"'`),:;\]])/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		const token = match[1];
		const lowerBase = basename(token).toLowerCase();
		if (!(token.includes("/") || CODE_FILE_EXTENSIONS.has(extname(token).toLowerCase()) || MANIFEST_FILE_NAMES.has(lowerBase))) {
			continue;
		}
		const resolvedPath = resolveExistingFilePath(token, cwd, repoRoot);
		if (resolvedPath) matches.add(resolvedPath);
	}
	return [...matches];
}

function collectFileActivity(branch: SessionBranchEntry[], cwd: string, repoRoot: string): FileActivity[] {
	const activity = new Map<string, FileActivity>();

	const addActivity = (
		absPath: string,
		{
			scoreDelta,
			readDelta = 0,
			modifiedDelta = 0,
			mentionDelta = 0,
			distance,
		}: { scoreDelta: number; readDelta?: number; modifiedDelta?: number; mentionDelta?: number; distance: number },
	) => {
		if (!existsSync(absPath)) return;
		try {
			if (!statSync(absPath).isFile()) return;
		} catch {
			return;
		}
		const relPath = displayPath(relative(repoRoot, absPath));
		const entry = activity.get(absPath) ?? {
			absPath,
			relPath,
			score: 0,
			readCount: 0,
			modifiedCount: 0,
			mentionCount: 0,
			lastSeenDistance: distance,
		};
		entry.score += scoreDelta;
		entry.readCount += readDelta;
		entry.modifiedCount += modifiedDelta;
		entry.mentionCount += mentionDelta;
		entry.lastSeenDistance = Math.min(entry.lastSeenDistance, distance);
		activity.set(absPath, entry);
	};

	for (let i = branch.length - 1, distance = 0; i >= 0; i--, distance++) {
		const entry = branch[i];
		const recencyBoost = Math.max(0, 12 - distance);

		for (const details of [entry.details, entry.message?.details]) {
			const { readFiles, modifiedFiles } = detailsFileLists(details);
			for (const file of modifiedFiles) {
				addActivity(resolve(cwd, file), { scoreDelta: 20 + recencyBoost * 2, modifiedDelta: 1, distance });
			}
			for (const file of readFiles) {
				addActivity(resolve(cwd, file), { scoreDelta: 10 + recencyBoost, readDelta: 1, distance });
			}
		}

		const text = extractTextParts(entry.message?.content).join("\n");
		for (const mentionedPath of extractPathMentions(text, cwd, repoRoot)) {
			addActivity(mentionedPath, { scoreDelta: 6 + recencyBoost, mentionDelta: 1, distance });
		}
	}

	return [...activity.values()].sort(
		(a, b) =>
			b.score - a.score ||
			a.lastSeenDistance - b.lastSeenDistance ||
			b.modifiedCount - a.modifiedCount ||
			b.readCount - a.readCount ||
			a.relPath.localeCompare(b.relPath),
	);
}

function pushUniquePath(target: string[], candidate: string | undefined, limit: number): void {
	if (!candidate || target.includes(candidate)) return;
	target.push(candidate);
	if (target.length > limit) target.length = limit;
}

function listWorkingTreeFiles(repoRoot: string): string[] {
	try {
		const output = execSync("git status --porcelain --untracked-files=normal", {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output
			.split("\n")
			.map((line) => line.trimEnd())
			.filter(Boolean)
			.map((line) => {
				const payload = line.slice(3).trim();
				const path = payload.includes(" -> ") ? payload.split(" -> ").pop() || payload : payload;
				return resolve(repoRoot, path);
			})
			.filter((absPath) => existsSync(absPath));
	} catch {
		return [];
	}
}

function selectSessionFiles(activity: FileActivity[], limit = MAX_TRACKED_FILES): string[] {
	const selected: string[] = [];
	for (const item of activity) {
		if (!isInterestingQuizFilePath(item.relPath)) continue;
		pushUniquePath(selected, item.absPath, limit);
		if (selected.length >= limit) break;
	}
	return selected;
}

function selectWorksetFiles(repoRoot: string, activity: FileActivity[], limit = MAX_TRACKED_FILES): string[] {
	const selected = selectSessionFiles(activity, limit);
	for (const absPath of listWorkingTreeFiles(repoRoot)) {
		const relPath = displayPath(relative(repoRoot, absPath));
		if (!isInterestingQuizFilePath(relPath)) continue;
		pushUniquePath(selected, absPath, limit);
		if (selected.length >= limit) break;
	}
	if (selected.length < limit) {
		for (const relPath of representativeRepoFiles(repoRoot, activity.map((item) => item.absPath), limit * 2)) {
			pushUniquePath(selected, join(repoRoot, relPath), limit);
			if (selected.length >= limit) break;
		}
	}
	return selected;
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
		const wasTruncatedByBytes = raw.length > MAX_FILE_BYTES;
		if (wasTruncatedByBytes) raw = raw.slice(0, MAX_FILE_BYTES);
		const relPath = displayPath(relative(repoRoot, absPath));
		const ext = extname(relPath).toLowerCase();
		const allLines = raw.split("\n");
		const truncated = wasTruncatedByBytes || allLines.length > maxLines || size > MAX_FILE_BYTES;
		const content = CODE_FILE_EXTENSIONS.has(ext)
			? buildCodePreviewContent(raw, maxLines)
			: buildHeadPreviewContent(raw, maxLines, truncated);
		return {
			id: "",
			kind: relPath.toLowerCase().startsWith("readme") ? "readme" : isManifestLikePath(relPath) ? "manifest" : "file",
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

function findRootManifest(repoRoot: string): string | undefined {
	for (const name of ROOT_MANIFEST_PRIORITY) {
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
			if (file.includes("main")) score += 2;
			if (file.includes("core")) score += 2;
			if (file.includes("test") || file.includes("spec")) score -= 10;
			return { file, score };
		})
		.sort((a, b) => b.score - a.score || a.file.length - b.file.length || a.file.localeCompare(b.file));
	return scored.slice(0, limit).map((item) => item.file);
}

function selectRepoFiles(repoRoot: string, activity: FileActivity[], limit = MAX_TRACKED_FILES + 1): string[] {
	const selected: string[] = [];
	pushUniquePath(selected, findRootManifest(repoRoot), limit);
	for (const item of activity) {
		if (!isLikelyCodeFile(item.relPath)) continue;
		pushUniquePath(selected, item.absPath, limit);
		if (selected.length >= limit) break;
	}
	if (selected.length < limit) {
		for (const relPath of representativeRepoFiles(repoRoot, activity.map((item) => item.absPath), limit * 2)) {
			pushUniquePath(selected, join(repoRoot, relPath), limit);
			if (selected.length >= limit) break;
		}
	}
	return selected;
}

function addSource(sources: SourceItem[], source: Omit<SourceItem, "id">): void {
	sources.push({ ...source, id: `s${sources.length + 1}` });
}

function gatherSources(scope: ResolvedScope, ctx: ExtensionCommandContext, cwd: string, repoRoot: string): SourceItem[] {
	const branch = ctx.sessionManager.getBranch() as SessionBranchEntry[];
	const recentConversation = buildRecentConversationText(branch);
	const fileActivity = collectFileActivity(branch, cwd, repoRoot);
	const sources: SourceItem[] = [];

	if (recentConversation) {
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
		const selectedFiles = scope.kind === "workset" ? selectWorksetFiles(repoRoot, fileActivity) : selectSessionFiles(fileActivity);
		for (const file of selectedFiles) {
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

		for (const file of selectRepoFiles(repoRoot, fileActivity)) {
			const source = filePreview(file, repoRoot);
			if (source) addSource(sources, source);
		}
	}

	return sources;
}

function isQuizThinkingLevel(value: string): value is QuizThinkingLevel {
	return QUIZ_THINKING_LEVELS.includes(value as QuizThinkingLevel);
}

function normalizeQuizAudience(value: string): QuizAudience | undefined {
	return QUIZ_AUDIENCE_ALIASES[value.toLowerCase()];
}

function audienceLabel(audience: QuizAudience): string {
	switch (audience) {
		case "scientist":
			return "scientist";
		case "developer":
			return "developer";
		default:
			return "general";
	}
}

function audiencePromptGuidance(audience: QuizAudience): string[] {
	switch (audience) {
		case "scientist":
			return [
				"Audience profile: scientist / applied mathematician / engineer.",
				"Bias toward what quantities or states are being represented, what the pieces mean physically or mathematically, how values are packed/unpacked or transformed, what assumptions matter for the model, and what changes under perturbation.",
				"Prefer questions that help the user form an intuitive model of the system rather than software-architecture trivia.",
				"Avoid purely software-contract questions like constructor invariants unless they clearly express something physically or mathematically meaningful about the model.",
			];
		case "developer":
			return [
				"Audience profile: software developer.",
				"Bias toward interfaces, control flow, contracts, invariants, extension points, edge cases, and likely debugging or refactoring consequences.",
				"Direct wording still matters, but moderate software-engineering language is acceptable.",
			];
		default:
			return [
				"Audience profile: general.",
				"Blend conceptual meaning with code mechanics. Keep wording accessible. Do not assume deep domain expertise or advanced software jargon.",
				"Prefer straightforward, operational questions that a broadly technical user can answer from the code.",
			];
	}
}

function parseQuizCommandArgs(args: string, cwd: string, repoRoot: string): ParsedQuizCommandArgs {
	let remaining = args.trim();
	let thinkingLevel: QuizThinkingLevel | undefined;
	let audience = DEFAULT_QUIZ_AUDIENCE;

	const explicitMatch = /(?:^|\s)--thinking\s+(off|minimal|low|medium|high|xhigh)(?=\s|$)/i.exec(remaining);
	if (explicitMatch) {
		thinkingLevel = explicitMatch[1]!.toLowerCase() as QuizThinkingLevel;
		remaining = `${remaining.slice(0, explicitMatch.index)} ${remaining.slice(explicitMatch.index + explicitMatch[0].length)}`.trim();
	} else {
		const malformedThinking = /(?:^|\s)--thinking(?:\s+(\S+))?/i.exec(remaining);
		if (malformedThinking) {
			const attempted = malformedThinking[1] || "<missing>";
			return {
				audience,
				error: `Invalid thinking level: ${attempted}. Use one of: ${QUIZ_THINKING_LEVELS.join(", ")}\n\nUsage:\n${USAGE}`,
			};
		}
	}

	if (!thinkingLevel) {
		const leadingThinking = /^(off|minimal|low|medium|high|xhigh)(?=\s|$)/i.exec(remaining);
		if (leadingThinking) {
			thinkingLevel = leadingThinking[1]!.toLowerCase() as QuizThinkingLevel;
			remaining = remaining.slice(leadingThinking[0].length).trim();
		}
	}

	const explicitAudience = /(?:^|\s)--(?:audience|mode)\s+(\S+)(?=\s|$)/i.exec(remaining);
	if (explicitAudience) {
		const normalized = normalizeQuizAudience(explicitAudience[1]!);
		if (!normalized) {
			return {
				audience,
				error: `Invalid audience: ${explicitAudience[1]}. Use one of: general (gen), scientist (sci), developer (dev)\n\nUsage:\n${USAGE}`,
			};
		}
		audience = normalized;
		remaining = `${remaining.slice(0, explicitAudience.index)} ${remaining.slice(explicitAudience.index + explicitAudience[0].length)}`.trim();
	} else {
		const malformedAudience = /(?:^|\s)--(?:audience|mode)(?:\s+(\S+))?/i.exec(remaining);
		if (malformedAudience) {
			const attempted = malformedAudience[1] || "<missing>";
			return {
				audience,
				error: `Invalid audience: ${attempted}. Use one of: general (gen), scientist (sci), developer (dev)\n\nUsage:\n${USAGE}`,
			};
		}
	}

	const parsedScope = parseScopeArgs(remaining, cwd, repoRoot);
	return { ...parsedScope, thinkingLevel, audience };
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

function buildQuizPrompt(
	scope: ResolvedScope,
	sources: SourceItem[],
	audience: QuizAudience,
	previousCards: QuizCard[] = [],
): string {
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
		audience === "scientist"
			? scope.kind === "repo"
				? "Bias toward the repo's main modelling pieces, what quantities or states they represent, how values move through them, and which files carry the main conceptual load."
				: scope.kind === "file"
					? "Bias toward what this file represents, what quantities or structures it manipulates, how values are transformed, and what assumptions matter for the model."
					: "Bias toward the modelling ideas and data transformations the user is actively touching or has recently reasoned about."
			: audience === "developer"
				? scope.kind === "repo"
					? "Bias toward architecture, boundaries, extension points, and how the codebase is meant to be used, while using any recent conversation context to prioritize what matters now."
					: scope.kind === "file"
						? "Bias toward the file's core abstraction, how to use it, key mechanism, and subtle assumptions."
						: "Bias toward what the user is actively touching or has recently reasoned about."
				: scope.kind === "repo"
					? "Bias toward the repo's main abstractions, how parts fit together, how the codebase is meant to be used, and what current conversation context makes most important right now."
					: scope.kind === "file"
						? "Bias toward the file's core abstraction, what it is for, how to use it, and the main mechanism it implements."
						: "Bias toward what the user is actively touching or has recently reasoned about.";

	return [
		`Scope: ${scope.kind}`,
		`Scope label: ${scope.label}`,
		scope.path ? `Scope path: ${scope.path}` : undefined,
		`Audience: ${audienceLabel(audience)}`,
		"",
		scopeGuidance,
		...audiencePromptGuidance(audience),
		"",
		`Create ${CARD_COUNT} quiz cards.`,
		"Default stance: the user is still orienting to the code and needs a gentle ramp, not an oral exam or a trap-heavy critique.",
		"Use a balanced mix, but skew basic by default. Aim for something like:",
		"- Card 1: foundational abstraction or concrete usage question",
		"- Card 2: foundational or intermediate mechanism / interface question",
		"- Card 3: intermediate mechanism / assumption / flow question",
		"- Card 4: optional subtle or change-impact question only if clearly warranted",
		"",
		"At least 2 cards should be foundational or intermediate.",
		"At most 1 card should be subtle or transfer.",
		"Avoid opening with a gotcha, hidden-assumption, or failure-mode question unless the user explicitly asked for a hard challenge.",
		"Each card should be answerable from the provided sources and should help the user build a durable mental model.",
		"If a card includes a snippet, the user should be able to answer from that snippet without needing hidden off-screen lines.",
		"Do not ask about a second type, function, or quantity unless it is actually visible in the displayed snippet. If you want to compare two things, include both in snippet.code or ask a narrower question.",
		"Keep questions direct and natural. One card should usually target one main idea.",
		"Prefer plain-language probes over formal wording. If you ask about an invariant, state it concretely in terms of what must stay the same or what round-trip should work.",
		"Use actual names from the code when they clarify meaning. For example, prefer 'temperature or concentration' over 'the second variable' when the code makes that explicit.",
		"Bad question style: 'What invariant must hold between stack_state and unstack_state?'",
		"Better question style: 'If you stack a state and then unstack it, what should come back unchanged, and how can you see that from the slicing?'",
		"Bad question style: 'How does this code decide which half is pressure and which half is the second variable?'",
		"Better question style: 'When rebuilding a PTState or PCState from solver vector x, how does the code split the vector, and where does it decide whether the second block means temperature or concentration?'",
		"Bad question style: showing only a PTState snippet but asking 'Why are PTState and PCState structurally the same?'",
		"Better question style: either show both definitions in the snippet, or ask only about PTState from the visible lines.",
		"If file, manifest, or readme sources are available, prefer snippet-backed cards and include real snippets for at least 2 cards when helpful.",
		"When writing snippet.code from numbered sources, strip the leading line-number prefixes like '  12 | ' and return only the actual code text.",
		previousCards.length > 0 ? "Avoid repeating or lightly paraphrasing cards already asked in this quiz session. Prefer different files, different snippets, or a genuinely different conceptual angle." : undefined,
		previousCards.length > 0
			? [
				"Already asked:",
				...previousCards.slice(-16).map((card, index) => {
					const where = [card.snippet?.path, card.snippet?.title].filter(Boolean).join(" · ");
					return `- ${index + 1}. ${card.question}${where ? ` [${where}]` : ""}`;
				}),
			  ].join("\n")
			: undefined,
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

function compactPreview(text: string, max = 320): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return "[empty text response]";
	return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function formatQuizParseError(
	error: Error,
	responseText: string,
	responsePartTypes: string[],
	modelLabel: string,
	scopeLabel: string,
	attempt: number,
): Error {
	const typesLabel = responsePartTypes.length > 0 ? responsePartTypes.join(", ") : "none";
	const preview = compactPreview(responseText);
	return new Error(
		[
			`Quiz generation failed for ${modelLabel} on ${scopeLabel} (attempt ${attempt}).`,
			`Parse error: ${error.message}`,
			`Response part types: ${typesLabel}`,
			`Raw response preview: ${preview}`,
		].join("\n"),
	);
}

function isThinkingOnlyResponse(responseText: string, responsePartTypes: string[]): boolean {
	return responseText.trim().length === 0 && responsePartTypes.length > 0 && responsePartTypes.every((type) => type === "thinking");
}

function parseJsonPayloadText(text: string, label: string): { data: unknown; repaired: boolean } {
	const payload = extractJsonPayload(text);
	try {
		return { data: JSON.parse(payload), repaired: false };
	} catch (parseError) {
		try {
			return { data: JSON.parse(jsonrepair(payload)), repaired: true };
		} catch (repairError) {
			const parseMessage = parseError instanceof Error ? parseError.message : String(parseError);
			const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
			throw new Error(`Failed to parse ${label} JSON (${parseMessage}; repair failed: ${repairMessage})`);
		}
	}
}

function fallbackSnippet(source?: SourceItem): QuizCardSnippet | undefined {
	if (!source || (source.kind !== "file" && source.kind !== "readme" && source.kind !== "manifest")) return undefined;
	const code = stripLineNumberPrefixes(source.content.split("\n").slice(0, 12).join("\n"));
	return {
		sourceId: source.id,
		title: source.title,
		path: source.path,
		language: source.language,
		code,
	};
}

function defaultSourceSummary(scope: ResolvedScope, sources: SourceItem[]): string {
	const labels = sources
		.map((source) => source.title)
		.filter((title): title is string => typeof title === "string" && title.trim().length > 0)
		.slice(0, 4);
	return labels.length > 0 ? `${scope.label}: ${labels.join(", ")}` : scope.label;
}

function normalizePacket(raw: unknown, scope: ResolvedScope, sources: SourceItem[], audience: QuizAudience): QuizPacket {
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
			const snippetCode = safeString(rawSnippet?.code);
			const snippet: QuizCardSnippet | undefined = rawSnippet
				? {
						sourceId: safeString(rawSnippet.sourceId) || sourceIds[0],
						title: safeString(rawSnippet.title) || primarySource?.title,
						path: safeString(rawSnippet.path) || primarySource?.path,
						startLine: typeof rawSnippet.startLine === "number" ? rawSnippet.startLine : undefined,
						endLine: typeof rawSnippet.endLine === "number" ? rawSnippet.endLine : undefined,
						language: safeString(rawSnippet.language) || primarySource?.language,
						code: snippetCode ? stripLineNumberPrefixes(snippetCode) : undefined,
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

	const depthRank: Record<Depth, number> = {
		foundational: 0,
		intermediate: 1,
		subtle: 2,
		transfer: 3,
	};
	cards.sort((a, b) => depthRank[a.depth] - depthRank[b.depth]);

	return {
		version: 1,
		audience,
		scope: {
			kind: scope.kind,
			label: scope.label,
			path: scope.path,
		},
		generatedAt: new Date().toISOString(),
		sourceSummary: safeString(candidate.sourceSummary) || defaultSourceSummary(scope, sources),
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

function withPacketSequence(packet: QuizPacket, sequence: number): QuizPacket {
	return {
		...packet,
		cards: packet.cards.map((card, index) => ({
			...card,
			id: `set${sequence}:${safeString(card.id) || `q${index + 1}`}`,
		})),
	};
}

function mergeQuizPackets(packets: QuizPacket[]): QuizPacket {
	if (packets.length === 0) throw new Error("No quiz packets to merge");
	if (packets.length === 1) return packets[0]!;
	const first = packets[0]!;
	const last = packets[packets.length - 1]!;
	const sourceRefs = Array.from(
		new Map(
			packets
				.flatMap((packet) => packet.sourceRefs)
				.map((sourceRef) => [`${sourceRef.id}|${sourceRef.path || ""}|${sourceRef.fingerprint}`, sourceRef]),
		).values(),
	);
	return {
		version: 1,
		audience: first.audience,
		scope: first.scope,
		generatedAt: last.generatedAt,
		sourceSummary: first.sourceSummary,
		sourceRefs,
		cards: packets.flatMap((packet) => packet.cards),
	};
}

async function generateQuizPacket(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	scope: ResolvedScope,
	sources: SourceItem[],
	audience: QuizAudience,
	signal: AbortSignal,
	thinkingOverride?: QuizThinkingLevel,
	previousCards: QuizCard[] = [],
): Promise<QuizPacket> {
	if (!ctx.model) throw new Error("No active model selected");
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	const basePrompt = buildQuizPrompt(scope, sources, audience, previousCards);
	const reasoning = ctx.model.reasoning ? toReasoning(thinkingOverride ?? pi.getThinkingLevel()) : undefined;
	let lastError: Error | undefined;
	let retryWithoutThinking = false;

	for (let attempt = 1; attempt <= QUIZ_GENERATION_MAX_ATTEMPTS; attempt++) {
		const attemptReasoning = retryWithoutThinking ? undefined : reasoning;
		const prompt =
			attempt === 1
				? basePrompt
				: [
						basePrompt,
						retryWithoutThinking
							? "The previous attempt returned only thinking content and no final text response. Regenerate the full payload as plain JSON text."
							: "The previous attempt returned malformed JSON.",
						"Regenerate the full payload from scratch.",
						"Before answering, ensure the JSON is complete, syntactically valid, and contains all closing brackets and quotes.",
						"Return JSON only.",
				  ].join("\n\n");

		const response = await completeSimple(
			ctx.model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			},
			{
				apiKey,
				reasoning: attemptReasoning,
				maxTokens: 5000,
				signal,
			},
		);

		const responsePartTypes = response.content
			.map((part) => (typeof part?.type === "string" ? part.type : "unknown"))
			.filter((type, index, array) => array.indexOf(type) === index);
		const responseText = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");

		try {
			const { data, repaired } = parseJsonPayloadText(responseText, "quiz");
			if (repaired && ctx.hasUI) {
				ctx.ui.notify("Quiz JSON was malformed; repaired automatically", "info");
			}
			if (attempt > 1 && ctx.hasUI) {
				ctx.ui.notify("Retried quiz generation after malformed JSON", "info");
			}
			return normalizePacket(data, scope, sources, audience);
		} catch (error) {
			const parseError = error instanceof Error ? error : new Error(String(error));
			lastError = formatQuizParseError(
				parseError,
				responseText,
				responsePartTypes,
				ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model",
				scope.label,
				attempt,
			);
			if (signal.aborted) throw lastError;
			if (attempt < QUIZ_GENERATION_MAX_ATTEMPTS) {
				if (isThinkingOnlyResponse(responseText, responsePartTypes) && attemptReasoning !== undefined) {
					retryWithoutThinking = true;
					if (ctx.hasUI) {
						ctx.ui.notify("Quiz model returned thinking without final text; retrying with thinking off", "info");
					}
					continue;
				}
				if (ctx.hasUI) {
					ctx.ui.notify(`Quiz generation parse failed: ${parseError.message}; retrying once`, "info");
				}
				continue;
			}
		}
	}

	throw lastError || new Error("Quiz generation failed");
}

const ANSWER_FEEDBACK_SYSTEM_PROMPT = `You are a concise, supportive code tutor.

Given a quiz question, an ideal answer, and the user's answer, evaluate the user's answer briefly and constructively.

Requirements:
- Be supportive, not adversarial.
- Prefer short, concrete feedback over long essays.
- Point out what the user got right and what they missed.
- Respect the intended audience profile when judging what counts as a good answer.
- Do not nitpick wording if the conceptual understanding is correct.
- Return STRICT JSON only.

JSON shape:
{
  "assessment": "good" | "partial" | "miss",
  "feedback": "2-4 concise sentences",
  "gotRight": ["..."],
  "missed": ["..."],
  "nextFocus": "optional one-line suggestion"
}
`;

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
	return items.length > 0 ? items : undefined;
}

function normalizeAnswerFeedback(raw: unknown): QuizAnswerFeedback {
	if (!raw || typeof raw !== "object") {
		return {
			assessment: "partial",
			feedback: "The tutor could not structure feedback cleanly, but the ideal answer is shown below.",
		};
	}
	const candidate = raw as Record<string, unknown>;
	const assessment = safeString(candidate.assessment);
	return {
		assessment:
			assessment === "good" || assessment === "partial" || assessment === "miss"
				? assessment
				: "partial",
		feedback:
			safeString(candidate.feedback) ||
			"Your answer was compared with the ideal answer. Use the notes below to refine your understanding.",
		gotRight: stringArray(candidate.gotRight),
		missed: stringArray(candidate.missed),
		nextFocus: safeString(candidate.nextFocus),
	};
}

async function evaluateQuizAnswer(
	ctx: ExtensionCommandContext,
	card: QuizCard,
	answer: string,
	audience: QuizAudience,
	thinkingOverride?: QuizThinkingLevel,
	signal?: AbortSignal,
): Promise<QuizAnswerFeedback> {
	if (!ctx.model) throw new Error("No active model selected");
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	const reasoning = ctx.model.reasoning ? toReasoning(thinkingOverride ?? "off") : undefined;
	const snippetText = card.snippet?.code
		? `Evidence snippet (${card.snippet.path || card.snippet.title || "snippet"}):\n${card.snippet.code}`
		: "No snippet provided.";
	const prompt = [
		`Audience: ${audienceLabel(audience)}`,
		`Question: ${card.question}`,
		snippetText,
		card.hint ? `Hint shown to user: ${card.hint}` : undefined,
		card.whyMatters ? `Why this matters: ${card.whyMatters}` : undefined,
		card.misconception ? `Common trap: ${card.misconception}` : undefined,
		`Ideal answer: ${card.idealAnswer}`,
		`User answer: ${answer}`,
	].filter(Boolean).join("\n\n");

	const response = await completeSimple(
		ctx.model,
		{
			systemPrompt: ANSWER_FEEDBACK_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		},
		{
			apiKey,
			reasoning,
			maxTokens: 1200,
			signal,
		},
	);

	const responseText = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");

	const { data, repaired } = parseJsonPayloadText(responseText, "answer-feedback");
	if (repaired && ctx.hasUI) {
		ctx.ui.notify("Answer feedback JSON was malformed; repaired automatically", "info");
	}
	return normalizeAnswerFeedback(data);
}

const DISCUSSION_SYSTEM_PROMPT = `You are continuing a code-understanding discussion for a single quiz card.

Requirements:
- Stay anchored to the current question, evidence snippet, answer feedback, and ideal answer.
- Answer the user's follow-up directly and concisely in plain language.
- Respect the intended audience profile.
- Prefer 2-6 sentences unless the user explicitly asks for more detail.
- Use actual names from the code when they clarify meaning.
- If helpful, connect back to the user's earlier misunderstanding or to the key code slice.
- Do not drift into unrelated repo-wide discussion unless the user explicitly asks.
`;

async function discussQuizCard(
	ctx: ExtensionCommandContext,
	packet: QuizPacket,
	card: QuizCard,
	answer: string | undefined,
	feedback: QuizAnswerFeedback | undefined,
	audience: QuizAudience,
	thread: QuizDiscussionMessage[],
	thinkingOverride?: QuizThinkingLevel,
	signal?: AbortSignal,
): Promise<string> {
	if (!ctx.model) throw new Error("No active model selected");
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	const reasoning = ctx.model.reasoning ? toReasoning(thinkingOverride ?? "off") : undefined;
	const snippetText = card.snippet?.code
		? `Evidence snippet (${card.snippet.path || card.snippet.title || "snippet"}):\n${card.snippet.code}`
		: "No snippet provided.";
	const contextPrompt = [
		`Scope: ${packet.scope.label}`,
		`Quiz summary: ${packet.sourceSummary}`,
		`Audience: ${audienceLabel(audience)}`,
		`Question: ${card.question}`,
		snippetText,
		answer ? `User's original answer: ${answer}` : "User revealed the answer without entering an answer first.",
		feedback ? `Tutor feedback: ${feedback.feedback}` : undefined,
		feedback?.gotRight?.length ? `What the user got right: ${feedback.gotRight.join("; ")}` : undefined,
		feedback?.missed?.length ? `What to tighten up: ${feedback.missed.join("; ")}` : undefined,
		feedback?.nextFocus ? `Suggested next focus: ${feedback.nextFocus}` : undefined,
		`Ideal answer: ${card.idealAnswer}`,
		card.whyMatters ? `Why this matters: ${card.whyMatters}` : undefined,
		card.misconception ? `Common trap: ${card.misconception}` : undefined,
		"Continue a short, focused follow-up discussion about this single quiz question.",
	].filter(Boolean).join("\n\n");

	const threadTranscript = thread
		.slice(-10)
		.map((message) => `${message.role === "user" ? "User" : "Tutor"}: ${message.text}`)
		.join("\n\n");
	const prompt = [contextPrompt, threadTranscript ? `Discussion so far:\n\n${threadTranscript}` : undefined].filter(Boolean).join("\n\n");

	const response = await completeSimple(
		ctx.model,
		{
			systemPrompt: DISCUSSION_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		},
		{
			apiKey,
			reasoning,
			maxTokens: 1400,
			signal,
		},
	);

	const responseText = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();

	return safeString(responseText) || "I couldn't add much to that yet, but we can keep probing this question from another angle.";
}

async function loadGlimpseModule(): Promise<any> {
	if (!glimpseModulePromise) {
		glimpseModulePromise = import("glimpseui");
	}
	return glimpseModulePromise;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function highlightCodeHtml(code: string, language?: string): string {
	const normalized = normalizeHighlightLanguage(language);
	try {
		if (normalized && hljs.getLanguage(normalized)) {
			return hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value;
		}
		return hljs.highlightAuto(code).value;
	} catch {
		return escapeHtml(code);
	}
}

function renderFeedbackList(title: string, items?: string[]): string {
	if (!items || items.length === 0) return "";
	return `
		<div class="feedback-block">
		  <div class="feedback-title">${escapeHtml(title)}</div>
		  <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
		</div>
	`;
}

function renderRichText(text?: string, fallback = ""): string {
	const value = safeString(text) || fallback;
	return escapeHtml(value).replace(/\n/g, "<br>");
}

function discussionPlaceholder(audience: QuizAudience): string {
	switch (audience) {
		case "scientist":
			return "Ask for a more intuitive explanation, the meaning of the quantities, or what changes under a perturbation…";
		case "developer":
			return "Ask about control flow, contracts, edge cases, or refactor/debug consequences…";
		default:
			return "Ask for a more intuitive explanation, a concrete example, or what would change if something changed…";
	}
}

function renderDiscussionThread(messages: QuizDiscussionMessage[] | undefined, pending: boolean | undefined): string {
	const items = messages || [];
	if (items.length === 0 && !pending) {
		return `<div class="footer-note">This thread stays anchored to the current question. Ask for a more intuitive explanation, a concrete example, or what would change if some assumption changed.</div>`;
	}
	const renderedMessages = items
		.map(
			(message) => `
				<div class="chat-message ${message.role === "user" ? "chat-user" : "chat-assistant"}">
				  <div class="chat-role">${message.role === "user" ? "You" : "Tutor"}</div>
				  <div>${renderRichText(message.text)}</div>
				</div>
			`,
		)
		.join("");
	const pendingMessage = pending
		? `
			<div class="chat-message chat-assistant chat-pending">
			  <div class="chat-role">Tutor</div>
			  <div class="loading-inline"><span class="mini-spinner"></span><span>Thinking about this follow-up…</span></div>
			</div>
		`
		: "";
	return `<div class="chat-thread">${renderedMessages}${pendingMessage}</div>`;
}

function renderGlimpseLoadingHtml(scopeLabel: string, sourceSummary: string, message: string): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Code Quiz</title>
<style>
:root {
  color-scheme: light dark;
  --panel: rgba(255,255,255,0.94);
  --text: #19202a;
  --muted: #637086;
  --border: #d5dbe8;
  --accent: #0b84a5;
  --accent-strong: #076a84;
  --shadow: 0 18px 50px rgba(12, 18, 28, 0.18);
}
@media (prefers-color-scheme: dark) {
  :root {
    --panel: rgba(28,32,39,0.94);
    --text: #e9eef5;
    --muted: #97a3b6;
    --border: #394252;
    --accent: #4cc9f0;
    --accent-strong: #67d6f6;
    --shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; color: var(--text); }
body { padding: 18px; }
.window {
  background: var(--panel);
  border: 2px solid var(--border);
  border-radius: 18px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(12px);
  overflow: hidden;
}
.header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(255,255,255,0.08), transparent);
}
.title { font-size: 13px; font-weight: 700; letter-spacing: 0.12em; color: var(--accent); text-transform: uppercase; }
.meta { font-size: 13px; color: var(--muted); }
.body { padding: 22px 18px; display: grid; gap: 16px; }
.kicker { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.headline { font-size: 24px; line-height: 1.3; font-weight: 650; }
.summary {
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px;
  background: rgba(255,255,255,0.45);
  color: var(--muted);
}
@media (prefers-color-scheme: dark) {
  .summary { background: rgba(255,255,255,0.03); }
}
.loading-row { display: flex; align-items: center; gap: 12px; }
.spinner {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  border: 3px solid color-mix(in srgb, var(--accent) 22%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
  flex: 0 0 auto;
}
button {
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  padding: 10px 16px;
  font: inherit;
  cursor: pointer;
}
button:hover { border-color: var(--accent); }
.footer-note { font-size: 12px; color: var(--muted); }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="window">
    <div class="header">
      <div>
        <div class="title">Code Quiz</div>
        <div class="meta">Preparing questions</div>
      </div>
      <div class="meta">${escapeHtml(scopeLabel)}</div>
    </div>
    <div class="body">
      <div class="kicker">Loading</div>
      <div class="headline">Starting quiz…</div>
      <div class="loading-row">
        <div class="spinner"></div>
        <div>${escapeHtml(message)}</div>
      </div>
      <div class="summary">${escapeHtml(sourceSummary)}</div>
      <div>
        <button onclick="closeQuiz()">Close</button>
      </div>
      <div class="footer-note">Leave this window open to see the quiz when it is ready. Close to cancel.</div>
    </div>
  </div>
<script>
  function closeQuiz() { window.glimpse.send({ type: 'close' }); }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeQuiz(); }
  });
</script>
</body>
</html>`;
}

function renderGlimpseQuizHtml(
	packet: QuizPacket,
	card: QuizCard,
	index: number,
	state: GlimpseQuizState,
): string {
	const snippetMeta = [card.snippet?.title, card.snippet?.path].filter(Boolean).join(" · ");
	const lineRange =
		typeof card.snippet?.startLine === "number" && typeof card.snippet?.endLine === "number"
			? ` lines ${card.snippet.startLine}-${card.snippet.endLine}`
			: "";
	const snippetLanguage = normalizeHighlightLanguage(card.snippet?.language || languageFromPath(card.snippet?.path));
	const snippetSection = card.snippet?.code
		? `
		<div class="section-label">Evidence${snippetMeta ? ` · ${escapeHtml(snippetMeta)}` : ""}${escapeHtml(lineRange)}</div>
		<pre class="code"><code class="hljs${snippetLanguage ? ` language-${escapeHtml(snippetLanguage)}` : ""}">${highlightCodeHtml(card.snippet.code, snippetLanguage)}</code></pre>
		`
		: "";
	const answer = state.draftAnswer ?? "";
	const assessmentClass = state.feedback ? `assessment-${state.feedback.assessment}` : "";
	const assessmentLabel = state.feedback
		? state.feedback.assessment === "good"
			? "Strong"
			: state.feedback.assessment === "miss"
				? "Missed core point"
				: "Partial"
		: "";
	const discussionOpen = Boolean(state.discussionOpen);
	const discussionSection = discussionOpen
		? `
			<div class="discussion-card">
			  <div class="section-label">Discuss further</div>
			  <div class="footer-note">Stay anchored to this question — ask for a more intuitive explanation, a concrete example, or what would change if some assumption changed.</div>
			  ${renderDiscussionThread(state.discussionMessages, state.discussionPending)}
			  <div>
			    <textarea id="discussion-input" class="discussion-input" placeholder="${escapeHtml(discussionPlaceholder(packet.audience))}">${escapeHtml(state.discussionDraft ?? "")}</textarea>
			  </div>
			  <div class="actions">
			    <button class="primary" onclick="sendFollowUp()" ${state.discussionPending ? "disabled" : ""}>Ask follow-up</button>
			    <button onclick="hideDiscussion()">Hide discussion</button>
			  </div>
			  <div class="footer-note">⌘/Ctrl+Enter sends follow-up</div>
			</div>
		`
		: "";
	const completionStats = state.completionStats;
	const completionSection = completionStats
		? `
			<div class="completion-card">
			  <div class="section-label">Quiz complete</div>
			  <div class="question completion-title">Finished this question set.</div>
			  <div class="footer-note">Answered ${completionStats.answered} · skipped ${completionStats.skipped} · sets completed ${completionStats.questionSetsCompleted}</div>
			  <div class="actions">
			    <button class="primary" onclick="moreQuestions()">More questions</button>
			    <button class="ghost" onclick="closeQuiz()">Close</button>
			  </div>
			</div>
		`
		: "";

	const questionActions = `
		<div class="actions">
		  <button class="primary" onclick="submitAnswer()">Submit answer</button>
		  <button onclick="toggleHint()">${state.showHint ? "Hide hint" : "Show hint"}</button>
		  <button onclick="revealAnswer()">Reveal</button>
		  <button onclick="skipQuestion()">Skip</button>
		  <button class="ghost" onclick="closeQuiz()">Close</button>
		</div>
	`;

	const revealActions = `
		<div class="actions">
		  <button onclick="${discussionOpen ? "hideDiscussion()" : "openDiscussion()"}">${discussionOpen ? "Hide discussion" : "Discuss further"}</button>
		  <button class="primary" onclick="nextQuestion()">${index < packet.cards.length ? "Next question" : "Finish set"}</button>
		  <button class="ghost" onclick="closeQuiz()">Close</button>
		</div>
	`;

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Code Quiz</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f6f7fb;
  --panel: rgba(255,255,255,0.92);
  --text: #19202a;
  --muted: #637086;
  --border: #d5dbe8;
  --accent: #0b84a5;
  --accent-strong: #076a84;
  --warning: #c17d00;
  --success: #0d7a3f;
  --danger: #b42318;
  --code-bg: #f0f3fa;
  --shadow: 0 18px 50px rgba(12, 18, 28, 0.18);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #11151b;
    --panel: rgba(28,32,39,0.94);
    --text: #e9eef5;
    --muted: #97a3b6;
    --border: #394252;
    --accent: #4cc9f0;
    --accent-strong: #67d6f6;
    --warning: #f0b64d;
    --success: #47d68c;
    --danger: #ff7b72;
    --code-bg: #171c24;
    --shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; color: var(--text); }
body { padding: 18px; }
.window {
  background: var(--panel);
  border: 2px solid var(--border);
  border-radius: 18px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(12px);
  overflow: hidden;
}
.header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(255,255,255,0.08), transparent);
}
.title { font-size: 13px; font-weight: 700; letter-spacing: 0.12em; color: var(--accent); text-transform: uppercase; }
.meta { font-size: 13px; color: var(--muted); }
.body { padding: 18px; display: grid; gap: 16px; }
.scope { font-size: 13px; color: var(--muted); }
.question { font-size: 20px; line-height: 1.4; font-weight: 600; }
.section-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 8px; }
.code {
  margin: 0;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.45;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.hljs { color: inherit; background: transparent; }
.hljs-comment,
.hljs-quote { color: #6a737d; font-style: italic; }
.hljs-keyword,
.hljs-selector-tag,
.hljs-subst,
.hljs-name,
.hljs-literal { color: #d73a49; }
.hljs-number,
.hljs-variable,
.hljs-template-variable,
.hljs-regexp,
.hljs-link { color: #005cc5; }
.hljs-string,
.hljs-doctag,
.hljs-symbol,
.hljs-bullet { color: #032f62; }
.hljs-title,
.hljs-section,
.hljs-type,
.hljs-class .hljs-title { color: #6f42c1; }
.hljs-built_in,
.hljs-builtin-name,
.hljs-attr,
.hljs-attribute { color: #e36209; }
.hljs-meta,
.hljs-meta .hljs-keyword,
.hljs-selector-class,
.hljs-selector-id { color: #22863a; }
.hljs-addition { color: #22863a; }
.hljs-deletion { color: #b31d28; }
@media (prefers-color-scheme: dark) {
  .hljs-comment,
  .hljs-quote { color: #8b949e; }
  .hljs-keyword,
  .hljs-selector-tag,
  .hljs-subst,
  .hljs-name,
  .hljs-literal { color: #ff7b72; }
  .hljs-number,
  .hljs-variable,
  .hljs-template-variable,
  .hljs-regexp,
  .hljs-link { color: #79c0ff; }
  .hljs-string,
  .hljs-doctag,
  .hljs-symbol,
  .hljs-bullet { color: #a5d6ff; }
  .hljs-title,
  .hljs-section,
  .hljs-type,
  .hljs-class .hljs-title { color: #d2a8ff; }
  .hljs-built_in,
  .hljs-builtin-name,
  .hljs-attr,
  .hljs-attribute { color: #ffa657; }
  .hljs-meta,
  .hljs-meta .hljs-keyword,
  .hljs-selector-class,
  .hljs-selector-id,
  .hljs-addition { color: #7ee787; }
  .hljs-deletion { color: #ffa198; }
}
textarea {
  width: 100%;
  min-height: 150px;
  resize: vertical;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.72);
  color: var(--text);
  padding: 14px;
  font: inherit;
  line-height: 1.45;
}
@media (prefers-color-scheme: dark) {
  textarea { background: rgba(10, 12, 16, 0.55); }
}
textarea:focus { outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent); outline-offset: 2px; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; }
button {
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  padding: 10px 16px;
  font: inherit;
  cursor: pointer;
}
button.primary { background: var(--accent); color: white; border-color: var(--accent); }
button.primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); }
button.ghost { color: var(--muted); }
button:hover { border-color: var(--accent); }
button:disabled { opacity: 0.65; cursor: default; }
.hint, .feedback-card, .answer-card, .discussion-card {
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px;
  background: rgba(255,255,255,0.48);
}
@media (prefers-color-scheme: dark) {
  .hint, .feedback-card, .answer-card, .discussion-card { background: rgba(255,255,255,0.03); }
}
.feedback-card.assessment-good { border-color: color-mix(in srgb, var(--success) 45%, var(--border)); }
.feedback-card.assessment-partial { border-color: color-mix(in srgb, var(--warning) 45%, var(--border)); }
.feedback-card.assessment-miss { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.assessment {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--muted);
}
.assessment strong { color: var(--text); }
.feedback-title { font-size: 13px; font-weight: 700; color: var(--muted); margin-bottom: 6px; }
.feedback-block ul { margin: 8px 0 0 18px; padding: 0; }
.footer-note { font-size: 12px; color: var(--muted); }
.completion-card { display: grid; gap: 12px; }
.completion-title { font-size: 24px; }
.discussion-input { min-height: 110px; }
.chat-thread {
  display: grid;
  gap: 10px;
  max-height: 280px;
  overflow: auto;
  padding-right: 4px;
}
.chat-message {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
}
.chat-user {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
}
.chat-assistant {
  background: rgba(255,255,255,0.32);
}
@media (prefers-color-scheme: dark) {
  .chat-assistant { background: rgba(255,255,255,0.02); }
}
.chat-role {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin-bottom: 6px;
}
.loading-inline {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.mini-spinner {
  width: 12px;
  height: 12px;
  border-radius: 999px;
  border: 2px solid color-mix(in srgb, var(--accent) 22%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
  flex: 0 0 auto;
}
.loading {
  display: grid;
  gap: 12px;
  place-items: start;
  min-height: 220px;
  align-content: center;
}
.spinner {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  border: 3px solid color-mix(in srgb, var(--accent) 22%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="window">
    <div class="header">
      <div>
        <div class="title">Code Quiz</div>
        <div class="meta">${escapeHtml(state.stage === "complete" ? "Set complete" : `Question ${index}/${packet.cards.length}`)}</div>
      </div>
      <div class="meta">${escapeHtml(packet.scope.label)}</div>
    </div>
    <div class="body">
      ${state.stage === "loading" || state.stage === "evaluating" || state.stage === "loading-more" ? `
        <div class="loading">
          <div class="spinner"></div>
          <div class="question">${escapeHtml(state.stage === "evaluating" ? "Evaluating your answer…" : state.stage === "loading-more" ? "Generating more questions…" : "Generating your quiz…")}</div>
          <div class="footer-note">${escapeHtml(state.stage === "evaluating" ? "Comparing your answer with the ideal answer." : state.stage === "loading-more" ? "Looking for new angles without repeating the same questions." : "Preparing a gentle, code-anchored set of questions.")}</div>
        </div>
        <div class="actions"><button class="ghost" onclick="closeQuiz()">Close</button></div>
      ` : state.stage === "complete" ? `
        <div class="scope">${escapeHtml(packet.sourceSummary)}</div>
        ${completionSection}
      ` : `
        <div class="scope">${escapeHtml(packet.sourceSummary)}</div>
        ${snippetSection}
        <div>
          <div class="section-label">Question</div>
          <div class="question">${escapeHtml(card.question)}</div>
        </div>
        ${state.stage === "question" ? `
          <div>
            <div class="section-label">Your answer</div>
            <textarea id="answer" placeholder="Write your best explanation here…">${escapeHtml(answer)}</textarea>
          </div>
          ${state.showHint && card.hint ? `<div class="hint"><div class="section-label">Hint</div>${escapeHtml(card.hint)}</div>` : ""}
          ${questionActions}
          <div class="footer-note">⌘/Ctrl+Enter submits · Esc closes</div>
        ` : `
          <div class="answer-card">
            <div class="section-label">Your answer</div>
            <div>${answer ? renderRichText(answer) : "<em>No answer recorded.</em>"}</div>
          </div>
          <div class="feedback-card ${assessmentClass}">
            ${state.feedback ? `<div class="assessment"><strong>${escapeHtml(assessmentLabel)}</strong></div>` : ""}
            <div class="section-label">Tutor feedback</div>
            <div>${renderRichText(state.feedback?.feedback, "No evaluation provided.")}</div>
            ${renderFeedbackList("What you got right", state.feedback?.gotRight)}
            ${renderFeedbackList("What to tighten up", state.feedback?.missed)}
            ${state.feedback?.nextFocus ? `<div class="feedback-block"><div class="feedback-title">Next focus</div><div>${renderRichText(state.feedback.nextFocus)}</div></div>` : ""}
          </div>
          <div class="answer-card">
            <div class="section-label">Ideal answer</div>
            <div>${renderRichText(card.idealAnswer)}</div>
          </div>
          ${card.whyMatters ? `<div class="answer-card"><div class="section-label">Why this matters</div><div>${renderRichText(card.whyMatters)}</div></div>` : ""}
          ${discussionSection}
          ${revealActions}
        `}
      `}
    </div>
  </div>
<script>
  const answerEl = () => document.getElementById('answer');
  const discussionEl = () => document.getElementById('discussion-input');
  function currentAnswer() { return answerEl() ? answerEl().value : ${JSON.stringify(answer)}; }
  function currentDiscussion() { return discussionEl() ? discussionEl().value : ${JSON.stringify(state.discussionDraft ?? "")}; }
  function send(payload) { window.glimpse.send(payload); }
  function submitAnswer() { send({ type: 'submit', answer: currentAnswer() }); }
  function revealAnswer() { send({ type: 'reveal', answer: currentAnswer() }); }
  function toggleHint() { send({ type: 'toggle-hint', answer: currentAnswer() }); }
  function skipQuestion() { send({ type: 'skip' }); }
  function nextQuestion() { send({ type: 'next' }); }
  function moreQuestions() { send({ type: 'more-questions' }); }
  function openDiscussion() { send({ type: 'open-discussion', answer: currentAnswer(), discussion: currentDiscussion() }); }
  function hideDiscussion() { send({ type: 'hide-discussion', answer: currentAnswer(), discussion: currentDiscussion() }); }
  function sendFollowUp() { send({ type: 'send-follow-up', answer: currentAnswer(), discussion: currentDiscussion() }); }
  function closeQuiz() { send({ type: 'close' }); }
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (discussionEl()) {
        e.preventDefault();
        sendFollowUp();
      } else if (answerEl()) {
        e.preventDefault();
        submitAnswer();
      }
    }
    if (e.key === 'Escape') { e.preventDefault(); closeQuiz(); }
  });
  if (discussionEl()) discussionEl().focus();
  else if (answerEl()) answerEl().focus();
</script>
</body>
</html>`;
}

async function runGlimpseQuizFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	scope: ResolvedScope,
	sources: SourceItem[],
	audience: QuizAudience,
	thinkingOverride?: QuizThinkingLevel,
): Promise<GlimpseQuizLaunchResult> {
	const { open } = await loadGlimpseModule();
	const effectiveThinkingLevel = thinkingOverride ?? pi.getThinkingLevel();
	const thinkingLabel = ctx.model?.reasoning ? ` · thinking ${effectiveThinkingLevel}` : "";
	const audienceSuffix = audience === DEFAULT_QUIZ_AUDIENCE ? "" : ` · ${audienceLabel(audience)}`;
	const loadingMessage = `Generating quiz with ${ctx.model?.id || "current model"}${thinkingLabel}${audienceSuffix}...`;
	const loadingSummary = defaultSourceSummary(scope, sources);

	return await new Promise<GlimpseQuizLaunchResult>((resolve) => {
		let finished = false;
		let generationError: string | undefined;
		let packet: QuizPacket | undefined;
		const packets: QuizPacket[] = [];
		const answers: QuizRunAnswer[] = [];
		let index = 0;
		let state: GlimpseQuizState = {
			stage: "loading",
			draftAnswer: "",
			showHint: false,
			discussionOpen: false,
			discussionDraft: "",
			discussionPending: false,
			discussionMessages: [],
		};
		let currentRecord: QuizRunAnswer | null = null;
		let currentPersisted = false;
		const generationAbort = new AbortController();
		let pendingRequestAbort: AbortController | null = null;
		const windowHandle = open(renderGlimpseLoadingHtml(scope.label, loadingSummary, loadingMessage), {
			width: 920,
			height: 860,
			title: `Code Quiz · ${scope.label}`,
			floating: true,
			openLinks: true,
		});

		const card = () => packet?.cards[index];
		const abortPendingRequest = () => {
			if (pendingRequestAbort) {
				pendingRequestAbort.abort();
				pendingRequestAbort = null;
			}
		};
		const snapshotCurrentRecord = (cardId: string, answerText?: string, overrides: Partial<QuizRunAnswer> = {}): QuizRunAnswer => {
			const record: QuizRunAnswer = {
				cardId,
				viewedHint: Boolean(state.showHint),
			};
			const normalizedAnswer = safeString(answerText);
			if (normalizedAnswer) record.answer = normalizedAnswer;
			if (state.feedback) record.feedback = state.feedback;
			if (state.discussionMessages && state.discussionMessages.length > 0) {
				record.discussion = state.discussionMessages.map((message) => ({ ...message }));
			}
			return { ...record, ...overrides };
		};
		const syncCurrentRecord = (cardId: string, answerText?: string, overrides: Partial<QuizRunAnswer> = {}) => {
			currentRecord = snapshotCurrentRecord(cardId, answerText, overrides);
			currentPersisted = false;
		};
		const persistCurrentRecord = () => {
			if (currentRecord && !currentPersisted) {
				answers.push(currentRecord);
				currentPersisted = true;
			}
		};
		const resetQuestionState = () => {
			state = {
				stage: "question",
				draftAnswer: "",
				showHint: false,
				discussionOpen: false,
				discussionDraft: "",
				discussionPending: false,
				discussionMessages: [],
				completionStats: undefined,
			};
			currentRecord = null;
			currentPersisted = false;
		};
		const showCompletionState = () => {
			state = {
				stage: "complete",
				completionStats: {
					answered: answers.filter((entry) => !entry.skipped).length,
					skipped: answers.filter((entry) => entry.skipped).length,
					questionSetsCompleted: packets.length,
				},
				draftAnswer: "",
				showHint: false,
				discussionOpen: false,
				discussionDraft: "",
				discussionPending: false,
				discussionMessages: [],
			};
			currentRecord = null;
			currentPersisted = true;
		};
		const activatePacket = (generatedPacket: QuizPacket) => {
			const sequencedPacket = withPacketSequence(generatedPacket, packets.length + 1);
			packet = sequencedPacket;
			packets.push(sequencedPacket);
			index = 0;
			pi.appendEntry("code-quiz.packet", sequencedPacket);
			resetQuestionState();
		};
		const rerender = () => {
			if (finished) return;
			if (!packet) {
				windowHandle.setHTML(renderGlimpseLoadingHtml(scope.label, loadingSummary, loadingMessage));
				return;
			}
			const currentCard = card();
			if (!currentCard) return;
			windowHandle.setHTML(renderGlimpseQuizHtml(packet, currentCard, index + 1, state));
		};
		const finish = () => {
			if (finished) return;
			finished = true;
			generationAbort.abort();
			abortPendingRequest();
			activeQuizClose = null;
			if (packets.length > 0) {
				const mergedPacket = mergeQuizPackets(packets);
				resolve({
					packet: mergedPacket,
					run: {
						completedAt: new Date().toISOString(),
						quitEarly: state.stage !== "complete",
						answers,
						packet: mergedPacket,
						packets: packets.length > 1 ? packets.map((entry) => ({ ...entry })) : undefined,
					},
				});
				return;
			}
			resolve({ error: generationError || "Quiz generation cancelled" });
		};

		activeQuizClose = () => {
			persistCurrentRecord();
			generationAbort.abort();
			abortPendingRequest();
			windowHandle.close();
		};

		windowHandle.on("message", async (message: unknown) => {
			if (finished || !message || typeof message !== "object") return;
			const payload = message as { type?: string; answer?: unknown; discussion?: unknown };
			if (payload.type === "close") {
				persistCurrentRecord();
				generationAbort.abort();
				abortPendingRequest();
				windowHandle.close();
				return;
			}
			if (!packet) return;

			const currentCard = card();
			if (!currentCard) return;
			const answer = typeof payload.answer === "string" ? payload.answer : state.draftAnswer || "";
			const discussionDraft = typeof payload.discussion === "string" ? payload.discussion : state.discussionDraft || "";

			switch (payload.type) {
				case "toggle-hint":
					state = { ...state, draftAnswer: answer, showHint: !state.showHint };
					rerender();
					return;
				case "skip":
					abortPendingRequest();
					answers.push(snapshotCurrentRecord(currentCard.id, answer, { skipped: true }));
					if (index >= packet.cards.length - 1) {
						showCompletionState();
					} else {
						index++;
						resetQuestionState();
					}
					rerender();
					return;
				case "reveal":
					state = {
						stage: "reveal",
						draftAnswer: answer,
						showHint: Boolean(state.showHint),
						discussionOpen: false,
						discussionDraft: "",
						discussionPending: false,
						discussionMessages: [],
					};
					syncCurrentRecord(currentCard.id, answer);
					rerender();
					return;
				case "submit": {
					abortPendingRequest();
					state = {
						stage: "evaluating",
						draftAnswer: answer,
						showHint: Boolean(state.showHint),
						discussionOpen: false,
						discussionDraft: "",
						discussionPending: false,
						discussionMessages: [],
					};
					syncCurrentRecord(currentCard.id, answer);
					rerender();
					const requestAbort = new AbortController();
					pendingRequestAbort = requestAbort;
					try {
						const feedback = await evaluateQuizAnswer(ctx, currentCard, answer, audience, thinkingOverride, requestAbort.signal);
						if (finished || requestAbort.signal.aborted || !packet || card()?.id !== currentCard.id) return;
						state = {
							stage: "reveal",
							draftAnswer: answer,
							showHint: Boolean(state.showHint),
							feedback,
							discussionOpen: false,
							discussionDraft: "",
							discussionPending: false,
							discussionMessages: [],
						};
						syncCurrentRecord(currentCard.id, answer);
						rerender();
					} catch (error) {
						if (finished || requestAbort.signal.aborted) return;
						state = {
							stage: "reveal",
							draftAnswer: answer,
							showHint: Boolean(state.showHint),
							feedback: {
								assessment: "partial",
								feedback:
									error instanceof Error
										? `Could not evaluate the answer cleanly: ${error.message}`
										: "Could not evaluate the answer cleanly.",
							},
							discussionOpen: false,
							discussionDraft: "",
							discussionPending: false,
							discussionMessages: [],
						};
						syncCurrentRecord(currentCard.id, answer);
						rerender();
					} finally {
						if (pendingRequestAbort === requestAbort) pendingRequestAbort = null;
					}
					return;
				}
				case "open-discussion":
					state = { ...state, draftAnswer: answer, discussionOpen: true, discussionDraft };
					rerender();
					return;
				case "hide-discussion":
					state = { ...state, draftAnswer: answer, discussionOpen: false, discussionDraft };
					rerender();
					return;
				case "send-follow-up": {
					const userPrompt = safeString(discussionDraft);
					state = { ...state, draftAnswer: answer, discussionOpen: true, discussionDraft };
					if (!userPrompt) {
						rerender();
						return;
					}
					abortPendingRequest();
					const thread: QuizDiscussionMessage[] = [
						...(state.discussionMessages || []),
						{ role: "user", text: userPrompt, timestamp: new Date().toISOString() },
					];
					state = {
						...state,
						draftAnswer: answer,
						discussionOpen: true,
						discussionDraft: "",
						discussionPending: true,
						discussionMessages: thread,
					};
					syncCurrentRecord(currentCard.id, answer);
					rerender();
					const requestAbort = new AbortController();
					pendingRequestAbort = requestAbort;
					try {
						const reply = await discussQuizCard(
							ctx,
							packet,
							currentCard,
							safeString(answer),
							state.feedback,
							audience,
							thread,
							thinkingOverride,
							requestAbort.signal,
						);
						if (finished || requestAbort.signal.aborted || !packet || card()?.id !== currentCard.id) return;
						state = {
							...state,
							draftAnswer: answer,
							discussionOpen: true,
							discussionDraft: "",
							discussionPending: false,
							discussionMessages: [...thread, { role: "assistant", text: reply, timestamp: new Date().toISOString() }],
						};
						syncCurrentRecord(currentCard.id, answer);
						rerender();
					} catch (error) {
						if (finished || requestAbort.signal.aborted) return;
						state = {
							...state,
							draftAnswer: answer,
							discussionOpen: true,
							discussionDraft: "",
							discussionPending: false,
							discussionMessages: [
								...thread,
								{
									role: "assistant",
									text:
										error instanceof Error
											? `I couldn't continue the discussion cleanly: ${error.message}`
											: "I couldn't continue the discussion cleanly.",
									timestamp: new Date().toISOString(),
								},
							],
						};
						syncCurrentRecord(currentCard.id, answer);
						rerender();
					} finally {
						if (pendingRequestAbort === requestAbort) pendingRequestAbort = null;
					}
					return;
				}
				case "more-questions": {
					if (state.stage !== "complete") return;
					abortPendingRequest();
					const previousCards = packets.flatMap((entry) => entry.cards);
					const previousCompletionStats = state.completionStats;
					state = {
						...state,
						stage: "loading-more",
						discussionOpen: false,
						discussionPending: false,
						completionStats: previousCompletionStats,
					};
					rerender();
					const requestAbort = new AbortController();
					pendingRequestAbort = requestAbort;
					try {
						const generatedPacket = await generateQuizPacket(
							pi,
							ctx,
							scope,
							sources,
							audience,
							requestAbort.signal,
							thinkingOverride,
							previousCards,
						);
						if (finished || requestAbort.signal.aborted) return;
						activatePacket(generatedPacket);
						rerender();
					} catch (error) {
						if (finished || requestAbort.signal.aborted) return;
						state = {
							...state,
							stage: "complete",
							completionStats: previousCompletionStats,
						};
						rerender();
						ctx.ui.notify(
							error instanceof Error ? `Failed to generate more questions: ${error.message}` : "Failed to generate more questions",
							"error",
						);
					} finally {
						if (pendingRequestAbort === requestAbort) pendingRequestAbort = null;
					}
					return;
				}
				case "next":
					abortPendingRequest();
					persistCurrentRecord();
					if (index >= packet.cards.length - 1) {
						showCompletionState();
					} else {
						index++;
						resetQuestionState();
					}
					rerender();
					return;
			}
		});

		windowHandle.on("closed", () => {
			persistCurrentRecord();
			finish();
		});

		generateQuizPacket(pi, ctx, scope, sources, audience, generationAbort.signal, thinkingOverride)
			.then((generatedPacket) => {
				if (finished) return;
				activatePacket(generatedPacket);
				rerender();
			})
			.catch((err) => {
				if (finished) return;
				generationError = generationAbort.signal.aborted ? "Quiz generation cancelled" : err instanceof Error ? err.message : String(err);
				windowHandle.close();
			});
	});
}

async function handleGlimpseQuizCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
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
	const { scope, thinkingLevel, audience, error } = parseQuizCommandArgs(args || "", cwd, repoRoot);
	if (!scope) {
		ctx.ui.notify(error || "Failed to resolve quiz scope", "error");
		return;
	}

	const sources = gatherSources(scope, ctx, cwd, repoRoot);
	if (sources.length === 0) {
		ctx.ui.notify(`No usable sources found for ${scope.label}`, "warning");
		return;
	}

	if (activeQuizClose) activeQuizClose();

	try {
		const { packet, run, error: quizError } = await runGlimpseQuizFlow(pi, ctx, scope, sources, audience, thinkingLevel);
		if (quizError) {
			ctx.ui.notify(quizError, quizError === "Quiz generation cancelled" ? "info" : "error");
			return;
		}
		if (!packet || !run) return;

		pi.appendEntry("code-quiz.run", run);
		const answered = run.answers.filter((answer) => !answer.skipped).length;
		const skipped = run.answers.filter((answer) => answer.skipped).length;
		const summary = run.quitEarly
			? `Quiz stopped early · answered ${answered} · skipped ${skipped}`
			: `Quiz complete · answered ${answered} · skipped ${skipped}`;
		ctx.ui.notify(summary, "info");
	} catch (glimpseError) {
		ctx.ui.notify(
			glimpseError instanceof Error ? `Failed to open Glimpse quiz: ${glimpseError.message}` : "Failed to open Glimpse quiz",
			"error",
		);
	}
}

export default function activeCodeTutor(pi: ExtensionAPI) {
	pi.registerCommand("quiz", {
		description: "Open an active code-understanding quiz in a native Glimpse window",
		handler: async (args, ctx) => {
			await handleGlimpseQuizCommand(pi, args || "", ctx);
		},
	});

	pi.registerCommand("quiz-close", {
		description: "Close the active quiz window",
		handler: async (_args, ctx) => {
			if (!activeQuizClose) {
				ctx.ui.notify("No code quiz is open", "info");
				return;
			}
			activeQuizClose();
			ctx.ui.notify("Code quiz closed", "info");
		},
	});
}
