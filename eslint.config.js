// ESLint flat config (ESLint 9+). Replaces .eslintrc + .eslintignore —
// ignores live inside this file's `ignores` field. Goal of this initial
// pass: enforce CLAUDE.md conventions (no console.log, no var, ===) +
// catch obvious bugs via the unicorn recommended subset.

import js from '@eslint/js';
import unicorn from 'eslint-plugin-unicorn';

export default [
  js.configs.recommended,
  {
    ignores: [
      'app/web/static/js/chrome/**', // pure DOM init modules — eslint
                                     // catches little useful here.
      'storage/**',
      'models/**',
      'node_modules/**',
      '.git/**',
    ],
  },
  {
    files: ['app/web/static/js/**/*.js'],
    plugins: {
      unicorn,
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        // Browser runtime
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Event: 'readonly',
        AbortController: 'readonly',
        CustomEvent: 'readonly',
        FormData: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        XMLHttpRequest: 'readonly',
        Blob: 'readonly',
        WebSocket: 'readonly',
        EventSource: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        MutationObserver: 'readonly',
        performance: 'readonly',
        // Timers
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        queueMicrotask: 'readonly',
        // Misc browser globals consumed by the project
        CSS: 'readonly',
        DOMParser: 'readonly',
        Path2D: 'readonly',
        L: 'readonly',          // Leaflet (loaded via <script> in index.html)
        console: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
      },
    },
    rules: {
      // Project conventions (CLAUDE.md):
      //   "JavaScript: kein console.log() im Produktionscode."
      // Warnings + errors stay legal — those are real diagnostic
      // signals, not log spam.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // `eqeqeq` enforces ===/!== EXCEPT for `x == null` / `x != null` —
      // those are the canonical JS one-shot null+undefined check and
      // converting them to `x === null || x === undefined` is just noise.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'warn',

      // Bugs catch:
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // ESLint 9's default caughtErrors='all' lints every catch
        // binding; pair it with the same `_` opt-out the args/vars
        // patterns use so `catch (_)` and `catch (_err)` stay silent
        // without weakening the rule for everything else.
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-undef': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],

      // Unicorn — cherry-pick the rules that pay off without forcing a
      // mass rewrite. Skip the noisy "prevent abbreviations" / "no-null"
      // family.
      'unicorn/prefer-module': 'off',     // ES modules already enforced via type=module
      'unicorn/no-array-callback-reference': 'off', // codebase uses .map(esc) idiomatically
      'unicorn/prefer-query-selector': 'warn',
      'unicorn/prefer-string-replace-all': 'warn',
      'unicorn/no-instanceof-array': 'warn',
    },
  },
  // Service worker runs in a separate global scope — `self`, `caches`,
  // and `clients` aren't browser-window globals. Adding them here so
  // the SW source lints cleanly without dragging service-worker
  // globals into every UI module's namespace.
  {
    files: ['app/web/static/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        self:    'readonly',
        caches:  'readonly',
        clients: 'readonly',
        fetch:   'readonly',
        URL:     'readonly',
        Promise: 'readonly',
        Response:'readonly',
      },
    },
  },
];
