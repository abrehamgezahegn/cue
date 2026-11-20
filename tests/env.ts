// Imported first by tests that touch providers. The DeepInfra calls are mocked, so the tests need
// a key to exist but must never use a real one. process.loadEnvFile does not override this value.
process.env.DEEPINFRA_API_KEY = 'test-key';
process.env.DEEPINFRA_MODEL = 'Qwen/Qwen3-32B';
