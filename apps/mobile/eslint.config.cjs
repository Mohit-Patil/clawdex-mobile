const tsPlugin = require('@typescript-eslint/eslint-plugin');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', '.expo/**']
  },
  ...tsPlugin.configs['flat/recommended'],
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true
        }
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }]
    }
  }
];
