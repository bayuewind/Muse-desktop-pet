#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
if [[ ! -x node_modules/.bin/electron ]]; then
  print '请先在本目录运行 npm ci，安装桌宠依赖。'
  read -r '?按回车退出'
  exit 1
fi
exec ./node_modules/.bin/electron .
