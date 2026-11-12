/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@bodo/contracts$': '<rootDir>/../../../packages/contracts/src/index.ts',
    '^@bodo/contracts/(.*)$': '<rootDir>/../../../packages/contracts/src/$1',
    '^@bodo/utils$': '<rootDir>/../../../packages/utils/src/index.ts',
    '^@bodo/utils/(.*)$': '<rootDir>/../../../packages/utils/src/$1',
  },
};
