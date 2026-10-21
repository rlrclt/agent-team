# Capability scoping: what you can and cannot set per seat

If you want each teammate to have different tools, MCP servers, or plugins,
read this first. Several obvious approaches silently do nothing, and one of them
is a trap that looks like it works.

Tested against Claude Code v2.1.302.

## Summary

| What you want to control | Mechanism that works | Scope |
|---|---|---|
| Tools available to a seat | `tools:` in the role file frontmatter | per seat |
| Model, effort, permission mode | role file frontmatter | per seat |
| Plugins, permission rules | `.claude/settings.json` or `--settings <file>` | per project / per launch |
| **MCP servers** | **launch flags only** — not the role file | per launch |
| Skills | by scope: `~/.claude/skills/`, project `.claude/skills/`, plugin | not per seat |

## The trap: `mcpServers` in a role file does nothing

An agent file may declare `mcpServers:`. When you start a session with
`claude --agent <name>`, that field is **not read**. It is only honoured when the
agent is spawned as a *subagent* by the Agent tool — which is the thing this
project exists to avoid.

This is a confirmed bug: [anthropics/claude-code#44183](https://github.com/anthropics/claude-code/issues/44183),
closed as a duplicate of #34698. The issue lists exactly which fields `--agent`
applies on the main thread:

| Property | Applied by `--agent`? |
|---|---|
| System prompt | yes |
| Model | yes |
| Tool allowlist / denylist | yes |
| Permission mode | yes |
| Hooks | yes |
| **MCP servers** | **no** |

To keep MCP out of a seat, do it at launch:

```sh
claude --agent web-team-reviewer --strict-mcp-config --mcp-config '{}'
```

Role files are installed prefixed with their team name (`<team>-<role>.md`), so
the `--agent` name always carries the prefix. Inside the role file, log commands
use the unprefixed role — see the team contract.

## The other trap: an empty `tools:` means *no* tools

Omitting the field entirely gives the seat every tool. Writing `tools:` with
nothing after it gives the seat **none** — the model will tell you it has "no
working tools". To grant everything, leave the line out.

Verified: after writing `tools:` with an empty value, a seat reported
"I have no Write or Edit tools; only read and shell". Removing the line restored
the full set.

## Read-only is a mechanism only when you remove the tool

`tools: Read, Grep, Glob` on a reviewer makes read-only **enforced** — the seat
physically has no Write tool to call.

Give the same reviewer the full tool set and read-only becomes **discipline**: an
instruction in the role file that the harness will not back up. Both are valid
choices. Know which one you picked, and do not describe the second as if it were
the first.

## Path deny rules on Windows

If you use permission rules to block writes to a directory, note the anchor forms
do not behave the way they look:

| Rule | Anchors at |
|---|---|
| `Edit(//c/Users/me/project/workspace/**)` | an absolute path (Windows: `C:\...` becomes `/c/...`) |
| `Edit(/workspace/**)` | the settings file's own directory |
| `Edit(workspace/**)` | the current working directory |

`Edit(/workspace/**)` written in a `--settings` file **did not block** a write to
`C:\Users\me\project\workspace\file.txt` in testing. The absolute `//c/...` form did.

Related, from the same investigation: file permission checks consult `Edit(path)`
and `Read(path)` rules only. A `Write(path)` rule is accepted and then never
checked — use `Edit(...)` for anything that must not be written.

## Plugin scope

`enabledPlugins` in `settings.json` is a per-project or per-user key. Under
`--settings` it **replaces** the key rather than merging, so a per-seat file must
list every plugin with an explicit `true`/`false` or the unlisted ones disappear.

Plugins contribute skill and agent *descriptions* to context in every session
where they are enabled, whether or not anything runs. Measure before enabling a
plugin everywhere:

```sh
claude plugin details <plugin-name>
```

MCP tool definitions are deferred by default — only tool names and server
instructions enter context until a tool is actually called. Plugin skill
descriptions are not deferred.

## Recommendation

Start with everything inherited globally. It is the simplest configuration and
the one this repository ships with: every seat runs `claude --agent
<team>-<role>` with no per-seat settings file at all.

Only narrow a seat when you have a concrete reason — a reviewer that must not
write, or a seat you do not want spending tokens on a large plugin. Each
narrowing is another file to keep in sync, and the failure modes above are quiet.
