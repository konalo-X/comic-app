process.env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

const { execSync } = require('child_process');
const path = require('path');

const PROJECT_ROOT = __dirname;
process.chdir(PROJECT_ROOT);

function run(cmd) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: process.env });
}

try {
  console.log('========================================');
  console.log('  Comic APP 打包脚本');
  console.log('  项目目录: ' + PROJECT_ROOT);
  console.log('========================================');

  console.log('\n[1/2] 构建前端 (vite build)...');
  run('npx vite build');
  console.log('✅ 前端构建完成');

  console.log('\n[2/2] 打包 Electron APP (electron-builder)...');
  run('npx electron-builder');
  console.log('✅ 打包完成！');

  console.log('\n========================================');
  console.log('  输出目录: ' + path.join(PROJECT_ROOT, 'release'));
  console.log('========================================');
} catch (e) {
  console.error('\n❌ 打包失败:', e.message);
  process.exit(1);
}