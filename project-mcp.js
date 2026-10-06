import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const PROJECT_ROOT = process.cwd();

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "out",
]);

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".py",
]);
const JS_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESULTS = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a user-supplied relative path against PROJECT_ROOT and rejects
 * anything that escapes the project directory (path traversal).
 */
function resolveSafe(relativePath) {
  const resolved = path.resolve(PROJECT_ROOT, relativePath || ".");
  const relative = path.relative(PROJECT_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Path "${relativePath}" resolves outside the project directory.`
    );
  }
  return resolved;
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function rel(file) {
  return path.relative(PROJECT_ROOT, file).split(path.sep).join("/");
}

/** Recursively collects files under `dir` whose extension is in `extensions`. */
function walk(dir, extensions, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), extensions, out);
    } else if (entry.isFile()) {
      if (extensions.has(path.extname(entry.name))) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  return out;
}

/** Reads a text file, returning null if missing, unreadable, or too large. */
function readSafe(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function git(cmd) {
  return execSync(`git ${cmd}`, {
    cwd: PROJECT_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

const server = new McpServer({
  name: "project-context-mcp",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Tool 1: get_project_summary
// ---------------------------------------------------------------------------
server.registerTool(
  "get_project_summary",
  {
    title: "Get Project Summary",
    description:
      "Returns a structured overview of the current project: name, version, scripts, dependencies, detected framework/tooling (from package.json), the README headings and intro, and the last 5 git commits. Call this FIRST at the start of a session, when onboarding to an unfamiliar codebase, or when the user asks 'what is this project?', 'what stack does this use?', or 'what changed recently?'. Do not use it to read arbitrary files.",
    inputSchema: {},
  },
  async () => {
    try {
      const summary = {};

      const pkgRaw = readSafe(path.join(PROJECT_ROOT, "package.json"));
      if (pkgRaw) {
        try {
          const pkg = JSON.parse(pkgRaw);
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          const has = (n) => n in deps;
          const frameworks = [
            ["next", "Next.js"],
            ["react", "React"],
            ["vue", "Vue"],
            ["svelte", "Svelte"],
            ["@angular/core", "Angular"],
            ["express", "Express"],
            ["fastify", "Fastify"],
            ["@nestjs/core", "NestJS"],
            ["vite", "Vite"],
            ["typescript", "TypeScript"],
            ["tailwindcss", "Tailwind CSS"],
            ["prisma", "Prisma"],
            ["@supabase/supabase-js", "Supabase"],
            ["jest", "Jest"],
            ["vitest", "Vitest"],
          ]
            .filter(([n]) => has(n))
            .map(([, label]) => label);
          summary.package = {
            name: pkg.name,
            version: pkg.version,
            description: pkg.description,
            type: pkg.type ?? "commonjs",
            scripts: pkg.scripts ?? {},
            dependencies: Object.keys(pkg.dependencies ?? {}),
            devDependencies: Object.keys(pkg.devDependencies ?? {}),
            detectedStack: frameworks,
          };
        } catch {
          summary.package = { error: "package.json is not valid JSON" };
        }
      } else {
        summary.package = null;
      }

      const readmeName = fs
        .readdirSync(PROJECT_ROOT)
        .find((f) => /^readme(\.md|\.txt)?$/i.test(f));
      if (readmeName) {
        const text = readSafe(path.join(PROJECT_ROOT, readmeName)) ?? "";
        const lines = text.split("\n");
        summary.readme = {
          file: readmeName,
          headings: lines.filter((l) => /^#{1,3}\s/.test(l)).slice(0, 30),
          intro: lines.slice(0, 40).join("\n"),
        };
      } else {
        summary.readme = null;
      }

      try {
        const log = git('log -5 --pretty=format:"%h|%an|%ad|%s" --date=short');
        summary.recentCommits = log
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [hash, author, date, ...subject] = l
              .replace(/^"|"$/g, "")
              .split("|");
            return { hash, author, date, subject: subject.join("|") };
          });
      } catch {
        summary.recentCommits = null;
        summary.gitNote = "Not a git repository, or git is unavailable.";
      }

      summary.projectRoot = PROJECT_ROOT;
      return jsonResult(summary);
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 2: find_todo_comments
// ---------------------------------------------------------------------------
server.registerTool(
  "find_todo_comments",
  {
    title: "Find TODO Comments",
    description:
      "Scans every source file (js/jsx/ts/tsx/vue/svelte/py) for TODO, FIXME and HACK comments and returns file path, line number, tag and comment text, plus counts per tag. Call this when the user asks what is unfinished, what tech debt exists, what to work on next, or before declaring a feature complete or preparing a release/handoff. Does not search markdown or config files.",
    inputSchema: {
      tags: z
        .array(z.enum(["TODO", "FIXME", "HACK", "XXX", "BUG"]))
        .optional()
        .describe("Comment tags to search for. Defaults to TODO, FIXME, HACK."),
      directory: z
        .string()
        .optional()
        .describe("Subdirectory to limit the scan to, relative to project root."),
    },
  },
  async ({ tags, directory }) => {
    try {
      const wanted = tags?.length ? tags : ["TODO", "FIXME", "HACK"];
      const root = resolveSafe(directory);
      const re = new RegExp(
        `(?://|#|/\\*+|\\*|<!--)\\s*(${wanted.join("|")})\\b[:\\s(-]*(.*)$`
      );

      const results = [];
      const counts = Object.fromEntries(wanted.map((t) => [t, 0]));
      let truncated = false;

      for (const file of walk(root, CODE_EXTENSIONS)) {
        const text = readSafe(file);
        if (text === null) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const m = re.exec(lines[i]);
          if (!m) continue;
          counts[m[1]]++;
          if (results.length >= MAX_RESULTS) {
            truncated = true;
            continue;
          }
          results.push({
            file: rel(file),
            line: i + 1,
            tag: m[1],
            comment: m[2].replace(/\*\/.*$|-->.*$/, "").trim(),
          });
        }
      }

      return jsonResult({
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        counts,
        truncated,
        results,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 3: check_env_variables
// ---------------------------------------------------------------------------
function parseEnvFile(file) {
  const text = readSafe(file);
  if (text === null) return null;
  const keys = new Set();
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

server.registerTool(
  "check_env_variables",
  {
    title: "Check Environment Variables",
    description:
      "Compares environment variables referenced in code (process.env.X, process.env['X'], destructured process.env, import.meta.env.X) against the keys defined in the .env file, and flags variables used in code but missing from .env (and, separately, defined but never used). Reports variable NAMES and the files using them, never values. Call this when the app fails with 'undefined' config/keys, when setting up the project on a new machine, after adding code that reads new config, or before deployment.",
    inputSchema: {
      envFile: z
        .string()
        .optional()
        .describe("Env file to compare against, relative to project root. Defaults to .env."),
    },
  },
  async ({ envFile }) => {
    try {
      const envPath = resolveSafe(envFile || ".env");
      const defined = parseEnvFile(envPath);

      const usage = new Map(); // name -> Set(files)
      const add = (name, file) => {
        if (!usage.has(name)) usage.set(name, new Set());
        usage.get(name).add(rel(file));
      };

      for (const file of walk(PROJECT_ROOT, JS_EXTENSIONS)) {
        const text = readSafe(file);
        if (text === null) continue;
        for (const m of text.matchAll(
          /(?:process\.env|import\.meta\.env)\.([A-Za-z_][A-Za-z0-9_]*)/g
        ))
          add(m[1], file);
        for (const m of text.matchAll(
          /(?:process\.env|import\.meta\.env)\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g
        ))
          add(m[1], file);
        for (const m of text.matchAll(
          /\{([^}]*)\}\s*=\s*(?:process\.env|import\.meta\.env)\b/g
        )) {
          for (const part of m[1].split(",")) {
            const name = part.trim().split(/[\s:=]/)[0];
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) add(name, file);
          }
        }
      }

      // Built-in vars that don't belong in .env.
      const builtin = new Set(["NODE_ENV", "PWD", "HOME", "PATH", "CI", "MODE", "DEV", "PROD", "SSR", "BASE_URL"]);

      const used = [...usage.keys()].sort();
      const missing = defined
        ? used.filter((n) => !defined.has(n) && !builtin.has(n))
        : used.filter((n) => !builtin.has(n));
      const unused = defined ? [...defined].filter((n) => !usage.has(n)).sort() : [];

      const exampleKeys = parseEnvFile(path.join(PROJECT_ROOT, ".env.example"));

      return jsonResult({
        envFile: rel(envPath),
        envFileFound: defined !== null,
        ...(defined === null && {
          warning: `${rel(envPath)} not found — every referenced variable is reported as missing.`,
        }),
        missingFromEnv: missing.map((name) => ({
          name,
          usedIn: [...usage.get(name)],
          inEnvExample: exampleKeys ? exampleKeys.has(name) : null,
        })),
        definedButUnused: unused,
        totalReferenced: used.length,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 4: get_component_list
// ---------------------------------------------------------------------------
const COMPONENT_PATTERNS = [
  /export\s+default\s+function\s+([A-Z][A-Za-z0-9_]*)/g,
  /(?:export\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(/g,
  /(?:export\s+)?(?:const|let)\s+([A-Z][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:React\.)?(?:memo\(|forwardRef\(|\(|async\s*\(|[A-Za-z_]+\s*=>)/g,
  /class\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+(?:React\.)?(?:Pure)?Component/g,
];

function groupKey(file) {
  const parts = rel(file).split("/");
  parts.pop();
  const roots = new Set(["src", "app", "components", "pages", "client", "frontend", "web"]);
  while (parts.length && roots.has(parts[0]) && parts.length > 1) parts.shift();
  return parts.length ? parts.join("/") : "(root)";
}

server.registerTool(
  "get_component_list",
  {
    title: "Get React Component List",
    description:
      "Lists every React component (function, arrow, memo/forwardRef, and class components in .jsx/.tsx/.js/.ts files that contain JSX) grouped by folder / feature area, with the file path of each. Call this before creating a new component (to avoid duplicates and follow existing structure), when asked 'where is the X component?' or 'what UI exists?', or when mapping out a frontend feature. Not for API routes or non-React code.",
    inputSchema: {
      directory: z
        .string()
        .optional()
        .describe("Subdirectory to limit the scan to, relative to project root."),
    },
  },
  async ({ directory }) => {
    try {
      const root = resolveSafe(directory);
      const groups = {};
      let total = 0;

      for (const file of walk(root, JS_EXTENSIONS)) {
        if (/\.(test|spec|stories)\.[jt]sx?$/.test(file)) continue;
        const text = readSafe(file);
        if (text === null) continue;
        // Must plausibly contain JSX or createElement.
        const ext = path.extname(file);
        const hasJsx =
          /<[A-Za-z][A-Za-z0-9.]*[\s/>]/.test(text) && /return\s*\(?\s*<|=>\s*\(?\s*<|React\.createElement/.test(text);
        if (!hasJsx && ext !== ".jsx" && ext !== ".tsx") continue;
        if (!hasJsx) continue;

        const names = new Set();
        for (const re of COMPONENT_PATTERNS) {
          for (const m of text.matchAll(re)) names.add(m[1]);
        }
        if (!names.size) continue;

        const key = groupKey(file);
        (groups[key] ??= []).push({
          file: rel(file),
          components: [...names].sort(),
        });
        total += names.size;
      }

      const sorted = Object.fromEntries(
        Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
      );
      return jsonResult({ totalComponents: total, groups: sorted });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ---------------------------------------------------------------------------
// Tool 5: analyze_api_routes
// ---------------------------------------------------------------------------
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const AUTH_SIGNALS =
  /getServerSession|getSession|\bauth\s*\(|authenticate|authorize|isAuthenticated|requireAuth|verifyToken|jwt\.|jsonwebtoken|req\.user|request\.user|currentUser|getUser\s*\(|supabase\.auth|authorization|clerk|passport|withAuth|middleware/i;
const ERROR_SIGNALS = /\btry\s*\{|\.catch\s*\(|catch\s*\(|asyncHandler|errorHandler/;
const VALIDATION_SIGNALS = /\bz\.|zod|joi|yup|ajv|safeParse|\.parse\s*\(|express-validator|validate\s*\(/i;

function nextAppEndpoint(file) {
  const parts = rel(file).split("/");
  const idx = parts.indexOf("app");
  const segs = parts
    .slice(idx + 1, -1)
    .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  return "/" + segs.join("/");
}

function nextPagesEndpoint(file) {
  const parts = rel(file).split("/");
  const idx = parts.indexOf("pages");
  const p = parts.slice(idx + 1).join("/").replace(/\.[jt]sx?$/, "").replace(/\/index$/, "");
  return "/" + p;
}

server.registerTool(
  "analyze_api_routes",
  {
    title: "Analyze API Routes",
    description:
      "Finds all backend API route definitions (Next.js app/**/route.ts and pages/api/**, plus Express/Fastify/Koa-style app.get('/x') and router.post('/x') calls), lists each HTTP method + endpoint + file + line, and flags routes whose file shows no error handling (try/catch) or no auth check, and notes missing input validation. Heuristic, file-level analysis — verify flagged routes manually. Call this when adding or modifying an endpoint, during a security or code review, when debugging 500/401 errors, or when the user asks 'what endpoints exist?' or 'which routes are unprotected?'.",
    inputSchema: {
      directory: z
        .string()
        .optional()
        .describe("Subdirectory to limit the scan to, relative to project root."),
    },
  },
  async ({ directory }) => {
    try {
      const root = resolveSafe(directory);
      const routes = [];
      const findings = [];

      for (const file of walk(root, JS_EXTENSIONS)) {
        const text = readSafe(file);
        if (text === null) continue;
        const relPath = rel(file);
        const found = [];

        if (/(^|\/)app\/(.*\/)?route\.[jt]s$/.test(relPath)) {
          for (const method of HTTP_METHODS) {
            const m = new RegExp(
              `export\\s+(?:async\\s+)?(?:function\\s+${method}\\b|const\\s+${method}\\b)`
            ).exec(text);
            if (m) found.push({ method, endpoint: nextAppEndpoint(file), line: lineOf(text, m.index) });
          }
        } else if (/(^|\/)pages\/api\//.test(relPath)) {
          found.push({ method: "ANY", endpoint: nextPagesEndpoint(file), line: 1 });
        } else {
          const re =
            /\b(app|router|server|fastify|api|routes?)\.(get|post|put|patch|delete|all|use)\s*\(\s*(['"`])(\/[^'"`]*)\3/g;
          for (const m of text.matchAll(re)) {
            if (m[2] === "use" && m[4] === "/") continue;
            found.push({
              method: m[2].toUpperCase(),
              endpoint: m[4],
              line: lineOf(text, m.index),
            });
          }
        }

        if (!found.length) continue;

        const hasError = ERROR_SIGNALS.test(text);
        const hasAuth = AUTH_SIGNALS.test(text);
        const hasValidation = VALIDATION_SIGNALS.test(text);
        const mutating = found.some((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method));

        for (const r of found) routes.push({ ...r, file: relPath });

        const issues = [];
        if (!hasError) issues.push("no error handling (try/catch or .catch) found in file");
        if (!hasAuth) issues.push("no auth check found in file");
        if (mutating && !hasValidation) issues.push("mutating route without visible input validation");
        if (issues.length) {
          findings.push({
            file: relPath,
            endpoints: found.map((r) => `${r.method} ${r.endpoint}`),
            issues,
          });
        }
      }

      routes.sort((a, b) => a.endpoint.localeCompare(b.endpoint) || a.method.localeCompare(b.method));

      return jsonResult({
        totalRoutes: routes.length,
        routes,
        potentialIssues: findings,
        note: "Heuristic: checks are file-level pattern matches. Auth may be applied via global middleware not visible here.",
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
