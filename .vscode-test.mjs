/**
 * @vscode/test-cli configuration for the extension-host rail. Downloads a
 * throwaway VS Code stable, loads THIS extension from the repo (extension
 * development path), installs the stand-in vLLM-Copilot built by
 * `node scripts/e2e-stand-in.mjs` through --extensions-dir, and runs the
 * compiled scenarios in out-e2e inside the real extension host with a fresh
 * profile under .vscode-test/. Kept out of `npm run build` on purpose.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default {
  tests: [
    {
      label: 'bridge-host',
      files: 'out-e2e/**/*.e2e.js',
      // Empty scratch folder, not the repo: the suite opens a real window and
      // must not drag the entire workspace through the extension host.
      workspaceFolder: path.join(root, 'temp', 'e2e-workspace'),
      // Absolute paths: the launch process cwd is nobody's promise.
      launchArgs: [
        '--disable-workspace-trust',
        '--disable-updates',
        '--extensions-dir',
        path.join(root, 'temp', 'e2e-extensions'),
      ],
      // ui MUST be stated: the runner defaults to 'tdd' (suite/test) and a bdd
      // file then dies with "describe is not defined".
      mocha: { ui: 'bdd', timeout: 240000 },
    },
  ],
}
