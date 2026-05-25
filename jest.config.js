/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Only run tests in src/ — avoids picking up Expo/RN test infra
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { strict: true } }],
  },
  // The payload module only uses Node's built-in Buffer — no RN mocks needed
  moduleNameMapper: {},
};
