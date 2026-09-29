import { defineConfig } from "eslint/config";
import globals from 'globals';
import pluginJs from '@eslint/js';

export default defineConfig([
  { files: ["**/*.js"], languageOptions: { sourceType: "commonjs" } },
  { languageOptions: { globals: globals.node } },
  { languageOptions: { globals: globals.jest } },
  pluginJs.configs.recommended
]);
