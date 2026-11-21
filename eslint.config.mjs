import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
export default defineConfig([
  globalIgnores(["node_modules", "out", "main.js", "release", "esbuild.config.mjs", "eslint.config.mjs", "test/**", "tools/**", "docs/**"]),
  ...obsidianmd.configs.recommended,
  { languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["eslint.config.*"] }, tsconfigRootDir: import.meta.dirname } } },
]);
