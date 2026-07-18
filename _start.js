const { spawn } = require('child_process');
process.env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const child = spawn('npm', ['run', 'dev'], {
  cwd: '/Users/konalo/projects/comic-app',
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development'
  }
});
child.on('exit', (code) => {
  console.log('Child exited with code', code);
});