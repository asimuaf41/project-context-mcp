# project-context-mcp

An MCP server that gives Claude Code deep context about the codebase it is launched in: project summary, TODO comments, env variable gaps, React components, and API routes.

## Install

```bash
cd "/Users/asimali/development/mcp servers/project-context-mcp"
npm install
```

## Add to Claude Code

```bash
claude mcp add project-context -- node "/Users/asimali/development/mcp servers/project-context-mcp/project-mcp.js"
```

Or manually in your MCP config:

```json
{
  "mcpServers": {
    "project-context": {
      "command": "node",
      "args": ["/Users/asimali/development/mcp servers/project-context-mcp/project-mcp.js"]
    }
  }
}
```

The server uses `process.cwd()` as the project root, so run Claude Code from the client project's directory.

## Tools

| Tool | Description |
|---|---|
| `get_project_summary` | package.json (scripts, deps, detected stack), README headings/intro, last 5 git commits. |
| `find_todo_comments` | TODO/FIXME/HACK (optionally XXX/BUG) comments with file, line, text, and counts. |
| `check_env_variables` | Env vars used in code (`process.env`, `import.meta.env`) but missing from `.env`; also defined-but-unused. Names only, never values. |
| `get_component_list` | React components grouped by folder/feature area. |
| `analyze_api_routes` | Next.js (app/pages) and Express-style routes with method/endpoint/file, flagging missing error handling, auth, and input validation. |

`analyze_api_routes` is heuristic and file-level: auth applied through global middleware won't be seen, so verify flagged routes.
