#!/bin/bash
set -e
cd "$(dirname "$0")"

APP_NAME="漫快"
BUNDLE_ID="com.konalo.comicapp"
EXEC_NAME="ComicApp"
BUILD_DIR=".build/apple/Products/Release"
DIST_DIR="dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"

echo "==> 清理并构建 Release"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

if [ ! -f ".build/release/$EXEC_NAME" ]; then
    echo "运行 swift build -c release ..."
    swift build -c release
fi

EXEC_PATH=".build/release/$EXEC_NAME"
if [ ! -f "$EXEC_PATH" ]; then
    echo "❌ 可执行文件未找到: $EXEC_PATH"
    exit 1
fi

echo "==> 创建 App Bundle 结构"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

echo "==> 复制可执行文件"
cp "$EXEC_PATH" "$APP_BUNDLE/Contents/MacOS/$EXEC_NAME"
chmod +x "$APP_BUNDLE/Contents/MacOS/$EXEC_NAME"

echo "==> 复制 Info.plist"
cp Resources/Info.plist "$APP_BUNDLE/Contents/Info.plist"

echo "==> 创建 PkgInfo"
echo -n "APPL????" > "$APP_BUNDLE/Contents/PkgInfo"

echo "==> 复制 Swift 运行库 (如果有必要)"
if command -v swift-stdlib-tool &> /dev/null; then
    swift-stdlib-tool --copy --verbose \
        --bundle-executable-path "$APP_BUNDLE/Contents/MacOS/$EXEC_NAME" \
        --platform macosx \
        --destination "$APP_BUNDLE/Contents/Frameworks" 2>/dev/null || true
fi

echo "==> 复制依赖动态库"
mkdir -p "$APP_BUNDLE/Contents/Frameworks"
DEPENDENCIES=$(otool -L "$APP_BUNDLE/Contents/MacOS/$EXEC_NAME" 2>/dev/null | grep -v "/System/" | grep -v "/usr/lib/" | grep -v "@rpath" | grep -v ":$" | awk '{print $1}' || true)
for dep in $DEPENDENCIES; do
    if [ -f "$dep" ]; then
        cp -L "$dep" "$APP_BUNDLE/Contents/Frameworks/" 2>/dev/null || true
    fi
done

echo "==> 修复权限"
chmod -R 755 "$APP_BUNDLE/Contents/MacOS" 2>/dev/null || true
chmod -R u+w "$APP_BUNDLE" 2>/dev/null || true

echo "==> 制作 DMG (可选)"
DMG_PATH="$DIST_DIR/${APP_NAME}-macOS.dmg"
if command -v hdiutil &> /dev/null; then
    rm -f "$DMG_PATH"
    hdiutil create -volname "$APP_NAME" \
        -srcfolder "$APP_BUNDLE" \
        -ov -format UDZO \
        "$DMG_PATH" 2>&1 | tail -3 || true
fi

echo ""
echo "✅ 打包完成！"
echo "App Bundle: $PWD/$APP_BUNDLE"
if [ -f "$DMG_PATH" ]; then
    echo "DMG:        $PWD/$DMG_PATH"
    DMG_SIZE=$(du -sh "$DMG_PATH" | cut -f1)
    echo "DMG 大小:   $DMG_SIZE"
fi
APP_SIZE=$(du -sh "$APP_BUNDLE" | cut -f1)
echo "App 大小:   $APP_SIZE"

ls -la "$DIST_DIR/"