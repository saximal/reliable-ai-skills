# Reliable AI Skills

Four focused skills for AI coding agents working on document retrieval, LLM reliability and software delivery. Each skill combines an English `SKILL.md` entry point with small executable tools, synthetic examples and tests.

The workflows address failures that can survive a successful build or a superficially complete answer.

| Skill | When to use it | Result |
| --- | --- | --- |
| [PDF RAG Source Repair](skills/pdf-rag-source-repair/SKILL.md) | A PDF uploads successfully, but search misses visible content or extracted text contains glyph codes | A page-level diagnosis and a bounded recovery plan across text, OCR, index and model input |
| [Safe LLM Failover](skills/safe-llm-failover/SKILL.md) | Add fallback models while preserving streaming, cancellation and usage accounting | An explicit error policy and an offline HTTP/SSE test harness |
| [Verified APK Release](skills/verified-apk-release/SKILL.md) | Publish an Android APK with verifiable identity, version and delivered bytes | A candidate release manifest backed by metadata, signer and delivery checks |
| [Production Delta Release](skills/production-delta-release/SKILL.md) | Ship a narrow reviewed patch from a checkout containing unrelated work | Exact artifact-delta verification and a coordinated activation/recovery plan |

## Start with one skill

Clone this repository and ask your agent to read the relevant `SKILL.md`.

```sh
git clone https://github.com/saximal/reliable-ai-skills.git
cd reliable-ai-skills
```

Example request for a coding agent with workspace access

> Read `skills/pdf-rag-source-repair/SKILL.md` and follow its relevant references. Diagnose why this PDF's visible text is missing from our RAG results. Start with a page-level report and identify the first broken stage before proposing changes.

Skills-aware clients can discover the same folders after installation in a directory they scan. For a chat-only model, attach the skill and the specific references it asks for, then provide sanitized reports. Run the commands yourself when the client has no execution tools.

## Install and run

See [installation and client integration](docs/INSTALLATION.md) for copying skills into a client's discovery directory, invoking them by name and using them in an ordinary chat. Installation is local and explicit.

Each skill contains a runnable tutorial under `references/`. Start there for dependencies, commands and expected output. The tools accept configuration through files or arguments and use synthetic data in their examples.

| Runtime | Skills using it |
| --- | --- |
| Python 3.10+ | PDF diagnostics, artifact inventories, repository validation and installation |
| Node.js 20+ | LLM fault injection and APK verification |
| Optional `pypdf` | Reading real PDFs in the PDF diagnostic helper |
| Android SDK Build Tools and Java | Verifying an actual APK's metadata and signing certificate |

## Portability and evidence

The packages follow the open Agent Skills directory and frontmatter format. Their instructions use ordinary file, terminal and HTTP concepts. Model selection and permission handling belong to the host client. The helpers run independently of an LLM. [Agent Skills specification](https://agentskills.io/specification)

The acceptance suite uses synthetic inputs and local fault servers. It checks observable behavior such as rejected unapproved deltas and a stream remaining with its selected model after visible output. Read [validation scope](docs/VALIDATION.md) for exact commands, tested environments and remaining integration work.

Compatibility with every model and client requires individual integration testing. An AI assistant needs enough context to follow the instructions, and executable workflows need the listed tools. A diagnostic report supplies technical evidence for the specific input it examined.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local checks and the expected scope of a change. Improvements should include a reproducible example when correcting behavior.

Original files in this repository are available under the [MIT license](LICENSE). Third-party tools retain their respective licenses.
