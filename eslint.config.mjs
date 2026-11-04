import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'spikes/**',
      'resources/**',
      '.vite/**'
    ]
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', 'scripts/**/*.mjs', '*.ts'],
    rules: {
      // 规格 §11 关键纪律：FFmpeg 仅允许异步 spawn，禁止同步子进程调用族。
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:child_process',
              importNames: ['exec', 'execSync', 'execFileSync', 'spawnSync'],
              message: '禁止同步子进程调用（规格 §11）：请使用 child_process.spawn。'
            },
            {
              name: 'child_process',
              importNames: ['exec', 'execSync', 'execFileSync', 'spawnSync'],
              message: '禁止同步子进程调用（规格 §11）：请使用 child_process.spawn。'
            }
          ]
        }
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='child_process'][callee.property.name=/^(exec|execSync|execFileSync|spawnSync)$/]",
          message: '禁止同步子进程调用（规格 §11）。'
        },
        {
          selector:
            "CallExpression[callee.name=/^(execSync|execFileSync|spawnSync)$/]",
          message: '禁止同步子进程调用（规格 §11）。'
        }
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  }
)
