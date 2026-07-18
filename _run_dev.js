const { spawn } = require('child_process');
const cleanEnv = {
  HOME: process.env.HOME,
  USER: process.env.USER,
  PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  SHELL: '/bin/bash',
  TERM: 'xterm',
  PWD: '/Users/konalo/projects/comic-app',
  NODE_ENV: 'development'
};
const child = spawn('npm', ['run', 'dev'], {
  cwd: '/Users/konalo/projects/comic-app',
  stdio: 'inherit',
  env: cleanEnv
});
child.on('error', (err) => {
  console.error('Failed to start:', err);
});
child.on('exit', (code) => {
  console.log('Process exited with code:', code);
});