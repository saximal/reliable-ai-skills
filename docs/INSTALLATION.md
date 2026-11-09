# Installation and client integration

## Use directly from a checkout

Keep the repository beside your project and give the agent an absolute or workspace-relative path to one `SKILL.md`. Ask it to load the references selected by that skill. Preserve the folder layout so scripts and references resolve consistently.

```text
Read /path/to/reliable-ai-skills/skills/safe-llm-failover/SKILL.md.
Use it to review our existing LLM client and prepare a fallback policy.
Start with the offline acceptance examples before changing application code.
```

The agent should reconcile the skill with your task, repository instructions, available tools and existing permissions. Actual deployment and external mutations require their own authorization.

## Install for discovery

Consult your client's current skill discovery documentation. `.agents/skills/` is a cross-client convention, while some clients also scan native locations such as `.claude/skills/` or `.codex/skills/`. The Agent Skills format defines the package contents. Directory discovery is implemented by each client. [Client integration guide](https://agentskills.io/client-implementation/adding-skills-support)

The installer copies selected packages into a directory you provide. Preview the operation first.

```sh
python scripts/install.py --target /path/to/your/project/.agents/skills --dry-run
python scripts/install.py --target /path/to/your/project/.agents/skills
```

On Windows, quote paths containing spaces.

```powershell
python scripts/install.py --target "C:\My Project\.agents\skills" --dry-run
python scripts/install.py --target "C:\My Project\.agents\skills"
```

Install only a particular package by adding `--skill pdf-rag-source-repair`. Repeat `--skill` to select several. Existing destinations cause the installer to stop before copying any selected package. For upgrades, compare your installed changes and use your normal package-update process.

Restart or reload the client if it discovers skills only at session startup. Where supported, invoke a skill with its name, for example `$safe-llm-failover`. Explicitly pointing to the file works with clients that support file reading but have no skill discovery.

## Use with chat-only models

Attach the selected `SKILL.md`, its relevant reference and sanitized input reports. Ask the model to state which inputs it still needs. Execute the tutorial commands on your machine and provide their JSON output. Include script output and exit status when asking it to interpret a failed check.

For a PDF diagnosis, page statistics and layer-quality flags may suffice for the first pass. Confirm permission before sharing actual document text or images. For release planning, sanitized digests and manifests provide evidence without uploading application secrets.

## Adapting a tool-enabled agent

Map file reading to the client's read capability, local commands to its terminal runner, and browser/network operations to its permitted HTTP tools. Resolve script paths relative to the installed skill directory. Provide referenced assets alongside the entry point when using a remote sandbox.

The packages do not require a specific MCP server, proprietary model ID, memory store or orchestration API. Multi-agent evaluation is optional and should remain within the user's authorized scope.
