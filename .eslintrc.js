module.exports = {
    root: true,
    env: {
        es6: true,
        node: true,
        mocha: true
    },
    extends: [
        'eslint:recommended'
    ],
    parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module'
    },
    rules: {
        'indent': [
            'error',
            4
        ],
        'no-console': 'off',
        'no-unused-vars': [
            'error',
            { 'ignoreRestSiblings': true, 'argsIgnorePattern': '^_' }
        ],
        'no-var': 'error',
        'no-trailing-spaces': 'error',
        'prefer-const': 'error',
        'quotes': [
            'error',
            'single',
            {
                'avoidEscape': true,
                'allowTemplateLiterals': true
            }
        ],
        'semi': [
            'error',
            'always'
        ]
    }
};