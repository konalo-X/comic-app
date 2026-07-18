#!/usr/bin/env python3
import os
import subprocess
import sys

os.environ['PATH'] = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
os.chdir('/Users/konalo/projects/comic-app')

print('=' * 50)
print('  Comic APP 打包脚本')
print('=' * 50)

steps = [
    ('安装依赖', ['npm', 'install']),
    ('构建前端', ['npx', 'vite', 'build']),
    ('打包 APP', ['npx', 'electron-builder']),
]

for name, cmd in steps:
    print(f'\n▶ {name}...')
    print(f'  命令: {" ".join(cmd)}')
    try:
        result = subprocess.run(cmd, env=os.environ, cwd=os.getcwd())
        if result.returncode != 0:
            print(f'❌ {name} 失败 (退出码: {result.returncode})')
            sys.exit(result.returncode)
        print(f'✅ {name} 完成')
    except Exception as e:
        print(f'❌ {name} 异常: {e}')
        sys.exit(1)

print('\n' + '=' * 50)
print('  打包完成！输出目录: release/')
print('=' * 50)