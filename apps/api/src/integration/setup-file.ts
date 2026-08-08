import { loadDotenv } from '@acct/config';
import { applyTestEnvironment } from './global-setup';

// Runs inside each worker, before any test module is imported — which matters
// because `loadApiEnv()` reads process.env once, at module load.
loadDotenv();
applyTestEnvironment();
