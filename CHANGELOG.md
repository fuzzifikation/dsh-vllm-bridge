# Changelog

## 0.0.15

First public version. The bridge runs the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (dsh) entirely on your vLLM-Copilot registry: same models, servers, sampling configs, and personalities, no DeepSeek account and no vendor login. dsh itself stays 100% upstream.

- One supervised harness. The extension installs the pinned dsh runtime into its own directory, launches the web UI, and shares one instance across all editor windows: restored windows join the running harness instead of fighting over it.
- Your registry, honestly. The harness model list is your vLLM-Copilot registry with models your servers stopped serving hidden, and models are shown by their display names, never by ids containing server hostnames.
- The harness opens inside VS Code by default, in the built-in Browser area, or in the system browser by setting.
- Editor tools for the agent, over MCP: read open files and selections, read the problem panel, open files and diffs for your review, run commands visibly in your editor terminal, send you notifications, and ask you questions when a decision belongs to the human.
- Your token totals include harness traffic. Completed requests are folded into the vLLM-Copilot usage ledger exactly once, resets included.
- Config changes never cut a live turn. Registry edits and restarts wait for in-flight harness requests to finish, then say so if anything was cut.
- Privacy: dsh's telemetry, account, and DeepSeek-service rows are disabled in the generated config; the harness never phones DeepSeek.
