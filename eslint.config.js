import globals from 'globals';

/**
 * The application ships as plain ES modules with no build step, so linting is
 * about catching real mistakes (unused bindings, accidental globals, fallthrough)
 * rather than enforcing a formatting dialect.
 */
export default [
  {
    ignores: [
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'sample-pieces/**'
    ]
  },
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.worker
      }
    },
    linterOptions: {
      reportUnusedDisableDirectives: true
    },
    rules: {
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
        // Omitting a key by destructuring it into a discarded binding is the
        // clearest way to copy an object without one field.
        ignoreRestSiblings: true
      }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-implicit-globals': 'error',
      'no-fallthrough': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'multi-line'],
      'no-throw-literal': 'error',
      'no-return-await': 'error',
      'no-promise-executor-return': 'error',
      'require-atomic-updates': 'off'
    }
  },
  {
    files: ['tests/**/*.js', 'tools/**/*.js', 'e2e/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-console': 'off',
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }]
    }
  },
  {
    // The service worker runs in its own global scope.
    files: ['service-worker.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.serviceworker
      }
    },
    rules: {
      'no-console': 'off'
    }
  }
];
