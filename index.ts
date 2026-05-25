/**
 * index.ts — AeroMesh entry point.
 *
 * IMPORTANT: `./src/lib/backgroundTask` MUST be imported before
 * `registerRootComponent` so that `TaskManager.defineTask()` runs at module
 * load time, before the React component tree is mounted. The OS requires the
 * task to be defined synchronously before it can be registered or invoked.
 *
 * Requirements: 1.1, 8.4, 9.1
 */

// Step 1: Define the background task synchronously at module load time.
// This import triggers TaskManager.defineTask(AEROMESH_SENSOR_TASK, ...) as a
// top-level side-effect inside backgroundTask.ts.
import './src/lib/backgroundTask';

// Step 2: Register the root React component.
import { registerRootComponent } from 'expo';
import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App).
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately.
registerRootComponent(App);
