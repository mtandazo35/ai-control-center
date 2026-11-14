import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = { require: 'readonly', process: 'readonly', Buffer: 'readonly', __dirname: 'readonly', module: 'writable', console: 'readonly', setTimeout: 'readonly' };
const browserGlobals = { window: 'readonly', document: 'readonly', acquireVsCodeApi: 'readonly' };

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': 'error',
    },
  },
  {
    // Plain CommonJS scripts run by node (statusLine wrapper, test doubles).
    files: ['resources/**/*.js', 'test/fixtures/**/*.js', 'test-host/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: nodeGlobals },
    rules: { '@typescript-eslint/no-require-imports': 'off', 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    // Webview script (browser).
    files: ['media/**/*.js'],
    languageOptions: { sourceType: 'script', globals: browserGlobals },
  },
);
