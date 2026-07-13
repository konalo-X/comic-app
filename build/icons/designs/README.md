# Comic App 图标设计方案

本项目提供了 5 种不同风格的 APP 图标设计，均为 SVG 格式，可导出为各种尺寸的 PNG/ICO/ICNS。

## 设计方案

### Design 1: 现代扁平风 (Modern Flat)
- **文件**: `design-1-modern-flat.svg`
- **风格**: 紫色渐变背景，白色漫画书，简洁扁平
- **特点**: 清新现代，适合大多数用户
- **配色**: 紫蓝渐变 (#667eea → #764ba2) + 白色

### Design 2: 玻璃态暗色 (Glassmorphism Dark)
- **文件**: `design-2-glassmorphism.svg`
- **风格**: 深色背景，玻璃态半透明卡片，霓虹点缀
- **特点**: 科技感强，适合深色模式爱好者
- **配色**: 深蓝黑 (#1a1a2e) + 红色点缀 (#e94560)

### Design 3: 极简浅色 (Minimalist Light)
- **文件**: `design-3-minimalist.svg`
- **风格**: 浅色背景，深色书本，彩色方块
- **特点**: 极简干净，macOS 风格
- **配色**: 浅灰白 (#f8f9fa) + 深灰 (#212529) + 彩色点缀

### Design 4: 霓虹赛博 (Neon Cyberpunk)
- **文件**: `design-4-neon.svg`
- **风格**: 深色背景，霓虹线条，赛博朋克感
- **特点**: 炫酷个性，适合年轻用户
- **配色**: 深蓝黑 (#0c0c1d) + 青色 (#00f5ff) + 粉色 (#ff00ff)

### Design 5: 3D 立体风 (3D Style)
- **文件**: `design-5-3d-style.svg`
- **风格**: 紫色背景，3D 立体书本，阴影效果
- **特点**: 立体感强，视觉层次丰富
- **配色**: 紫蓝渐变 + 白色书本 + 彩色分镜

## 使用方法

### 1. 选择设计
选择你喜欢的 SVG 文件，复制为 `icon.svg`

### 2. 导出各种尺寸
使用工具（如 Figma、Sketch、Illustrator 或在线转换器）导出以下尺寸：

| 平台 | 格式 | 尺寸 |
|------|------|------|
| macOS | .icns | 16, 32, 64, 128, 256, 512, 1024 |
| Windows | .ico | 16, 32, 48, 256 |
| Linux | .png | 16, 32, 48, 64, 128, 256, 512, 1024 |

### 3. 替换现有图标
将导出的图标文件放入 `build/icons/` 目录，替换现有文件：
- `icon.png` (项目根目录)
- `build/icons/icon-16x16.png`
- `build/icons/icon-32x32.png`
- `build/icons/icon-48x48.png`
- `build/icons/icon-64x64.png`
- `build/icons/icon-128x128.png`
- `build/icons/icon-256x256.png`
- `build/icons/icon-512x512.png`
- `build/icons/icon-1024x1024.png`
- `build/icons/icon.ico`
- `build/icons/icon.icns`

### 4. 重新构建
```bash
npm run build
```

## 在线转换工具推荐

- [SVG to PNG](https://cloudconvert.com/svg-to-png)
- [PNG to ICO](https://cloudconvert.com/png-to-ico)
- [PNG to ICNS](https://cloudconvert.com/png-to-icns)
- [iConvert Icons](https://iconverticons.com/online/)

## 当前图标

当前使用的图标是 Design 1 的变体（紫色背景 + 漫画书）。