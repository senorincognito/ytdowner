// Starts Electron with ELECTRON_RUN_AS_NODE cleared (VS Code's terminal sets it,
// which makes Electron behave like plain Node and crash on startup).
const { spawn } = require('child_process');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(require('electron'), ['.'], { stdio: 'inherit', env }).on('exit', (c) => process.exit(c ?? 0));
